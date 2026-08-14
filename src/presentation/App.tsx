import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Box,
  Activity,
  Check,
  Circle,
  Copy,
  Cuboid,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Focus,
  FolderOpen,
  Grid3X3,
  Hammer,
  Import,
  Lock,
  Magnet,
  Palette,
  Move3D,
  Play,
  Redo2,
  RotateCw,
  Save,
  Scaling,
  ShieldCheck,
  Sparkles,
  Square,
  Pause,
  Trash2,
  Undo2,
  Unlock,
  X,
} from 'lucide-react';
import {
  ExportProfileId,
  ExportReport,
  buildExportReport,
  exportProfiles,
  getExportProfile,
  runExportPreflight,
} from '../application/exportCenter';
import { validateProject } from '../application/validation';
import { cloneSceneNode, createBoxNode, createCylinderNode, createEmptyProject, createPlaneNode, createSphereNode } from '../domain/factory';
import { clampGeneratorParams, createGeneratorNode, generatorDefinitions, getGeneratorDefinition } from '../domain/generators';
import {
  AssetDocument,
  EditorTool,
  GeometryDefinition,
  ImportedModelGeometry,
  JointMotionKind,
  MaterialDefinition,
  MotionAxis,
  PartEditMode,
  PartWarehouseAssemblyItem,
  PartWarehousePartItem,
  PartWarehouseItem,
  SceneNode,
  Transform,
  ValidatedJointMotion,
  ValidationIssue,
} from '../domain/model';
import type { KinematicGraph } from '../domain/kinematics';
import type { KinematicJoint, MechanicalPart } from '../domain/kinematics';
import type { FunctionalComponent } from '../domain/mechanics';
import {
  acceptJointCandidate,
  createHomeKinematicState,
  createJoint,
  rejectJointCandidate,
  removeJoint,
  resetKinematicState,
  normalizeAxis,
  setJointValue,
  updateJoint,
  validateKinematicGraph,
} from '../application/kinematics/kinematicAuthoring';
import {
  isDesktopRuntime,
  openProjectNative,
  saveBlobNative,
  saveJsonNative,
  saveProjectNative,
} from '../infrastructure/desktopFileSystem';
import { downloadBlob, exportDocumentAsGlb, exportJsonReport, renderDocumentPreview } from '../infrastructure/exportGlb';
import { createImportedModelNode } from '../infrastructure/importGlb';
import {
  downloadProjectFile,
  loadProjectAutosave,
  loadProjectFromBrowser,
  saveProjectAutosave,
  saveProjectToBrowser,
} from '../infrastructure/projectStorage';
import {
  deleteWarehouseItem as deletePersistentWarehouseItem,
  loadWarehouseItems,
  loadWarehouseItemsWithFallback,
  loadWarehouseStorageInfo,
  saveWarehouseGlbItem,
  saveWarehouseItems,
  saveWarehouseThumbnail,
  type WarehouseStorageInfo,
  warehouseItemKey,
} from '../infrastructure/warehouseRepository';
import { createIndependentWarehousePartGeometry } from '../infrastructure/warehouseParts';
import {
  ImportedPartSelection,
  KinematicAxisChangeEvent,
  KinematicEditTarget,
  KinematicPointPickEvent,
  MotionTrainingPreview,
  ThreeViewport,
  ViewportStats,
} from './components/ThreeViewport';
import { buildFunctionalAssembly, buildFunctionalComponent } from '../application/mechanics/functionalModel';

const makeStarterProject = () => {
  const project = createEmptyProject('Prototype Asset');
  const cube = createBoxNode();
  return {
    ...project,
    nodes: [cube],
    selectedNodeId: cube.id,
  };
};

const loadInitialProject = () => {
  try {
    return loadProjectFromBrowser() ?? makeStarterProject();
  } catch {
    return makeStarterProject();
  }
};

const touch = (document: AssetDocument): AssetDocument => ({
  ...document,
  metadata: {
    ...document.metadata,
    updatedAt: new Date().toISOString(),
  },
});

const selectedName = (geometry: GeometryDefinition) => {
  if ('generatorId' in geometry) return getGeneratorDefinition(geometry.generatorId)?.name ?? 'Unknown Generator';
  if (geometry.kind === 'imported-model') return `Imported ${geometry.sourceFormat.toUpperCase()}`;
  if (geometry.kind === 'serialized-object') return 'Stored Part';
  return geometry.kind.charAt(0).toUpperCase() + geometry.kind.slice(1);
};

const isStarterPlaceholderNode = (node: SceneNode) =>
  node.name === 'Game Box' &&
  node.geometry.kind === 'box' &&
  node.geometry.width === 2 &&
  node.geometry.height === 1.4 &&
  node.geometry.depth === 2 &&
  node.transform.position[0] === 0 &&
  node.transform.position[1] === 0.5 &&
  node.transform.position[2] === 0 &&
  node.transform.rotation.every((value) => value === 0) &&
  node.transform.scale.every((value) => value === 1);

const materialPresets: MaterialDefinition[] = [
  { name: 'Graphite PBR', color: '#3f4953', roughness: 0.52, metalness: 0.08 },
  { name: 'Industrial Steel', color: '#8b949e', roughness: 0.34, metalness: 0.78 },
  { name: 'Military Black', color: '#20262a', roughness: 0.72, metalness: 0.25 },
  { name: 'Safety Orange', color: '#d66b2c', roughness: 0.46, metalness: 0.12 },
  { name: 'Emissive Red Trim', color: '#34383d', roughness: 0.42, metalness: 0.35, emissive: '#e53935', emissiveIntensity: 1.8 },
  { name: 'Signal Blue', color: '#2874c8', roughness: 0.38, metalness: 0.18 },
  { name: 'Factory Yellow', color: '#d4a62a', roughness: 0.5, metalness: 0.16 },
  { name: 'Hydraulic Green', color: '#2f7d57', roughness: 0.56, metalness: 0.12 },
  { name: 'Ceramic White', color: '#d9dee2', roughness: 0.32, metalness: 0.04 },
  { name: 'Anodized Violet', color: '#6d4cc2', roughness: 0.3, metalness: 0.45 },
];

type MotionTrainingCandidate = {
  id: string;
  nodeId: string;
  jointName: string;
  jointLabel: string;
  label: string;
  motionKind: JointMotionKind;
  axis: MotionAxis;
  min: number;
  max: number;
  amplitude: number;
};

type MotionTrainerState = {
  nodeId: string;
  candidates: MotionTrainingCandidate[];
  index: number;
};

const motionAxes: MotionAxis[] = ['x', 'y', 'z'];

const motionKindText = (kind: JointMotionKind) => (kind === 'translation' ? 'Slide' : 'Rotate');

const axisIndexOf = (axis?: MotionAxis) => (axis === 'y' ? 1 : axis === 'z' ? 2 : 0);

const makeMotionRange = (kind: JointMotionKind, preferred: boolean, min?: number, max?: number, amplitude?: number) => {
  if (kind === 'translation') {
    return { min: -0.35, max: 0.35, amplitude: 0.22 };
  }

  const nextMin = preferred ? min ?? -1.2 : -1.2;
  const nextMax = preferred ? max ?? 1.2 : 1.2;
  const nextAmplitude = Math.min(Math.abs(nextMin), Math.abs(nextMax), amplitude ?? 0.65);
  return { min: nextMin, max: nextMax, amplitude: nextAmplitude };
};

const makeMotionTrainingCandidates = (node: SceneNode): MotionTrainingCandidate[] => {
  if (node.geometry.kind !== 'imported-model') return [];

  const candidates: MotionTrainingCandidate[] = [];
  const seen = new Set<string>();

  node.geometry.joints.forEach((joint) => {
    const primaryAxis = joint.axis ?? 'x';
    const primaryKind = joint.motionKind ?? 'rotation';
    const jointLabel = joint.label ?? joint.name;

    const addCandidate = (motionKind: JointMotionKind, axis: MotionAxis, preferred = false) => {
      const key = `${joint.name}:${motionKind}:${axis}`;
      if (seen.has(key)) return;
      seen.add(key);

      const range = makeMotionRange(motionKind, preferred, joint.min, joint.max, joint.demoAmplitude);
      candidates.push({
        id: key,
        nodeId: node.id,
        jointName: joint.name,
        jointLabel,
        label: `${jointLabel} - ${motionKindText(motionKind)} ${axis.toUpperCase()}`,
        motionKind,
        axis,
        ...range,
      });
    };

    addCandidate(primaryKind, primaryAxis, true);
    motionAxes.forEach((axis) => addCandidate('rotation', axis, axis === primaryAxis && primaryKind === 'rotation'));
    motionAxes.forEach((axis) => addCandidate('translation', axis, axis === primaryAxis && primaryKind === 'translation'));
  });

  return candidates;
};

const legacyAxisVector = (axis?: MotionAxis): [number, number, number] => {
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return [1, 0, 0];
};

const graphFromImportedGeometry = (geometry: ImportedModelGeometry): KinematicGraph => {
  if (geometry.kinematicGraph) return geometry.kinematicGraph;

  const rootPartId = 'part_source_model';
  const sourceBounds = {
    min: [0, 0, 0] as [number, number, number],
    max: geometry.originalBounds,
    size: geometry.originalBounds,
    center: [geometry.originalBounds[0] / 2, geometry.originalBounds[1] / 2, geometry.originalBounds[2] / 2] as [number, number, number],
  };

  return {
    rootPartId,
    parts: [
      {
        id: rootPartId,
        name: 'SOURCE MODEL',
        meshObjectIds: [],
        localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        bounds: sourceBounds,
        static: true,
        visible: true,
        source: 'imported',
        metadata: { migratedFromLegacyJoints: true },
      },
      ...geometry.joints.map((joint, index) => ({
        id: `part_${index + 1}_${joint.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`,
        name: joint.label ?? joint.name,
        meshObjectIds: [joint.name],
        localFrame: {
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        bounds: sourceBounds,
        static: false,
        visible: true,
        source: 'imported' as const,
        metadata: { legacyJointName: joint.name },
      })),
    ],
    joints: geometry.joints.map((joint, index) => ({
      id: `joint_${index + 1}_${joint.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`,
      name: joint.label ?? joint.name,
      parentPartId: rootPartId,
      childPartId: `part_${index + 1}_${joint.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`,
      type: joint.motionKind === 'translation' ? ('prismatic' as const) : ('revolute' as const),
      origin: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      axis: legacyAxisVector(joint.axis),
      limits: { lower: joint.min, upper: joint.max },
      source: 'name-heuristic' as const,
      confidence: 0.45,
      evidence: [{ type: 'semantic-name' as const, score: 0.45, message: 'Migrated from legacy articulation controls.' }],
      status: 'candidate' as const,
    })),
  };
};

const cleanPartToken = (value: string) =>
  value
    .replace(/\.(glb|fbx|dae|obj|3ds)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

const inferPartCategory = (assetName: string, objectName: string) => {
  const text = `${assetName} ${objectName}`.toLowerCase();
  if (/audi|car|vehicle|wheel|tire|door|hood|bonnet|trunk|bumper/.test(text)) return 'Vehicles';
  if (/robot|arm|axis|joint|grip|claw|wrist|elbow|shoulder/.test(text)) return 'Robot Arms';
  if (/belt|conveyor|roller|pulley|cinta/.test(text)) return 'Conveyors';
  if (/tree|branch|leaf|trunk/.test(text)) return 'Trees';
  if (/house|wall|door|window|roof/.test(text)) return 'Buildings';
  return 'General Parts';
};

const inferPartClassName = (objectName: string) => {
  const text = objectName.toLowerCase();
  if (/wheel|tire|tyre/.test(text)) return 'Wheel';
  if (/door|hood|bonnet|trunk|panel|cover/.test(text)) return 'Panel';
  if (/axis|joint|pivot|rotating|wrist|elbow|shoulder/.test(text)) return 'Joint';
  if (/arm|forearm|link|beam/.test(text)) return 'Arm Link';
  if (/grip|claw|finger|grasper/.test(text)) return 'End Effector';
  if (/base|frame|body|chassis/.test(text)) return 'Structure';
  if (/belt|roller|pulley/.test(text)) return 'Transmission';
  return 'Component';
};

const makePartCode = (category: string, className: string, index: number) =>
  `${category.slice(0, 3)}-${className.slice(0, 3)}-${String(index + 1).padStart(4, '0')}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');

const cloneGeometry = <T extends GeometryDefinition>(geometry: T): T => JSON.parse(JSON.stringify(geometry)) as T;

const cloneStoredNode = (node: SceneNode, index = 0): SceneNode => ({
  ...node,
  id: `node_${crypto.randomUUID().slice(0, 8)}`,
  name: index ? `${node.name} ${index + 1}` : node.name,
  geometry: cloneGeometry(node.geometry),
  material: { ...node.material },
  transform: {
    position: [node.transform.position[0] + index * 0.45, node.transform.position[1], node.transform.position[2] + index * 0.25],
    rotation: [...node.transform.rotation],
    scale: [...node.transform.scale],
  },
  locked: false,
  createdAt: new Date().toISOString(),
});

const cloneWarehouseItemForImport = (item: PartWarehouseItem, index: number): PartWarehouseItem => {
  const now = new Date().toISOString();
  const code = makePartCode(item.category, item.className, index);

  if (item.itemType === 'assembly') {
    return {
      ...item,
      id: `assembly_${crypto.randomUUID().slice(0, 8)}`,
      code,
      assemblyNodes: item.assemblyNodes.map((node, nodeIndex) => cloneStoredNode(node, nodeIndex)),
      metadata: { ...item.metadata, updatedAt: now },
    };
  }

  return {
    ...item,
    id: `part_${crypto.randomUUID().slice(0, 8)}`,
    code,
    geometry: cloneGeometry(item.geometry),
    material: { ...item.material },
    metadata: { ...item.metadata, updatedAt: now },
  };
};

const sceneAssemblyBounds = (nodes: SceneNode[]): [number, number, number] => {
  const importedBounds = nodes
    .map((node) => (node.geometry.kind === 'imported-model' || node.geometry.kind === 'serialized-object' ? node.geometry.normalizedBounds : undefined))
    .filter((bounds): bounds is [number, number, number] => Boolean(bounds));
  if (!importedBounds.length) return [1, 1, 1];
  return importedBounds.reduce<[number, number, number]>(
    (max, bounds) => [Math.max(max[0], bounds[0]), Math.max(max[1], bounds[1]), Math.max(max[2], bounds[2])],
    [0, 0, 0],
  );
};

const functionalComponentId = (sourceAssetName: string, objectName: string) =>
  `component_${sourceAssetName}_${objectName}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 72);

const instantiateFunctionalComponent = (component: FunctionalComponent, instanceId: string, transform: Transform): FunctionalComponent => ({
  ...component,
  id: instanceId,
  localTransform: transform,
  interfaces: component.interfaces.map((mechanicalInterface) => ({
    ...mechanicalInterface,
    id: `${mechanicalInterface.id}_${instanceId}`.slice(0, 96),
    componentId: instanceId,
  })),
  metadata: {
    ...component.metadata,
    sourceFunctionalComponentId: component.id,
  },
});

const mergeWarehouseItems = (currentItems: PartWarehouseItem[] = [], incomingItems: PartWarehouseItem[] = []) => {
  const indexByKey = new Map(currentItems.map((item, index) => [warehouseItemKey(item), index]));
  const merged = [...currentItems];
  incomingItems.forEach((item) => {
    const key = warehouseItemKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(item);
    } else {
      merged[existingIndex] = item;
    }
  });
  return merged;
};

const formatGigabytes = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(3)} GB`;

const functionalWarehouseSummary = (item: PartWarehouseItem) => {
  if (item.itemType === 'assembly' && item.functionalAssembly) {
    return `${item.functionalAssembly.components.length} components | ${item.functionalAssembly.connections.length} joints`;
  }
  if (item.itemType === 'part' && item.functionalComponent) {
    return `${item.functionalComponent.interfaces.length} interfaces | ${item.functionalComponent.mechanicalProperties.role}`;
  }
  return item.itemType === 'assembly' ? `${item.assemblyNodes.length} parts` : item.metadata.sourceFormat.toUpperCase();
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Preview conversion failed.'));
    reader.readAsDataURL(blob);
  });

export const App = () => {
  const [document, setDocument] = useState<AssetDocument>(loadInitialProject);
  const [past, setPast] = useState<AssetDocument[]>([]);
  const [future, setFuture] = useState<AssetDocument[]>([]);
  const [tool, setTool] = useState<EditorTool>('translate');
  const [partEditMode, setPartEditMode] = useState<PartEditMode>('free');
  const [selectedParts, setSelectedParts] = useState<ImportedPartSelection[]>([]);
  const [warehouseMenu, setWarehouseMenu] = useState<{ itemId: string; x: number; y: number } | undefined>();
  const [workspaceMenu, setWorkspaceMenu] = useState<{ nodeId: string; x: number; y: number } | undefined>();
  const [activeView, setActiveView] = useState<'workspace' | 'warehouse'>('workspace');
  const [pendingWorkspaceNodeIds, setPendingWorkspaceNodeIds] = useState<string[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>(() => validateProject(document));
  const [status, setStatus] = useState('Ready');
  const [stats, setStats] = useState<ViewportStats>({ fps: 0, objects: document.nodes.length, triangles: 0, cpuPercent: 0 });
  const [autosaveAvailable, setAutosaveAvailable] = useState(false);
  const [exportProfileId, setExportProfileId] = useState<ExportProfileId>('generic-glb');
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [desktopRuntime] = useState(isDesktopRuntime);
  const [nativeProjectPath, setNativeProjectPath] = useState<string | undefined>();
  const [demoMotionNodeId, setDemoMotionNodeId] = useState<string | undefined>();
  const [motionTrainer, setMotionTrainer] = useState<MotionTrainerState | undefined>();
  const [kinematicEditTarget, setKinematicEditTarget] = useState<KinematicEditTarget | undefined>();
  const [warehouseStorageInfo, setWarehouseStorageInfo] = useState<WarehouseStorageInfo>({ items: 0, usageBytes: 0, quotaBytes: 0, savedItems: [] });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const glbInputRef = useRef<HTMLInputElement | null>(null);
  const warehouseInputRef = useRef<HTMLInputElement | null>(null);

  const selectedNode = useMemo(
    () => document.nodes.find((node) => node.id === document.selectedNodeId),
    [document.nodes, document.selectedNodeId],
  );
  const selectedWarehouseItem = useMemo(
    () => document.partWarehouse?.find((item) => item.id === document.selectedWarehouseItemId),
    [document.partWarehouse, document.selectedWarehouseItemId],
  );
  const warehouseGroups = useMemo(() => {
    const groups = new Map<string, Map<string, PartWarehouseItem[]>>();
    (document.partWarehouse ?? []).forEach((item) => {
      const classes = groups.get(item.category) ?? new Map<string, PartWarehouseItem[]>();
      const items = classes.get(item.className) ?? [];
      items.push(item);
      classes.set(item.className, items);
      groups.set(item.category, classes);
    });
    return [...groups.entries()].map(([category, classes]) => ({
      category,
      classes: [...classes.entries()].map(([className, items]) => ({ className, items })),
    }));
  }, [document.partWarehouse]);
  const selectedPartsForSelectedNode = useMemo(
    () => (selectedNode ? selectedParts.filter((part) => part.nodeId === selectedNode.id) : []),
    [selectedNode, selectedParts],
  );
  const activeKinematicEditTarget = useMemo<KinematicEditTarget | undefined>(() => {
    if (!kinematicEditTarget) return undefined;
    const node = document.nodes.find((item) => item.id === kinematicEditTarget.nodeId);
    if (!node || node.geometry.kind !== 'imported-model') return undefined;
    const joint = graphFromImportedGeometry(node.geometry).joints.find((item) => item.id === kinematicEditTarget.jointId);
    if (!joint) return undefined;
    return {
      ...kinematicEditTarget,
      origin: joint.origin.position,
      axis: joint.axis,
    };
  }, [document.nodes, kinematicEditTarget]);

  const currentMotionCandidate = useMemo(() => {
    if (!motionTrainer) return undefined;
    return motionTrainer.candidates[motionTrainer.index];
  }, [motionTrainer]);

  const motionTrainingPreview: MotionTrainingPreview | undefined = currentMotionCandidate
    ? {
        nodeId: currentMotionCandidate.nodeId,
        jointName: currentMotionCandidate.jointName,
        motionKind: currentMotionCandidate.motionKind,
        axis: currentMotionCandidate.axis,
        min: currentMotionCandidate.min,
        max: currentMotionCandidate.max,
        amplitude: currentMotionCandidate.amplitude,
      }
    : undefined;

  const trainingProgress = motionTrainer
    ? {
        current: Math.min(motionTrainer.index + 1, motionTrainer.candidates.length),
        total: motionTrainer.candidates.length,
      }
    : undefined;

  const commit = useCallback(
    (nextDocument: AssetDocument, nextStatus = 'Edited') => {
      const updated = touch(nextDocument);
      setPast((items) => [...items.slice(-80), document]);
      setFuture([]);
      setDocument(updated);
      setIssues(validateProject(updated));
      setStatus(nextStatus);
    },
    [document],
  );

  const markWorkspaceNodesPending = useCallback((nodeIds: string[]) => {
    const cleanIds = nodeIds.filter(Boolean);
    if (!cleanIds.length) return;
    setPendingWorkspaceNodeIds((current) => [...new Set([...current, ...cleanIds])]);
  }, []);

  const clearPendingWorkspaceNodes = useCallback((nodeIds: string[]) => {
    const cleanIds = new Set(nodeIds);
    setPendingWorkspaceNodeIds((current) => current.filter((nodeId) => !cleanIds.has(nodeId)));
  }, []);

  const refreshWarehouseStorageInfo = useCallback(async () => {
    try {
      const info = await loadWarehouseStorageInfo(document.metadata.id);
      setWarehouseStorageInfo(info);
      return info;
    } catch {
      const emptyInfo: WarehouseStorageInfo = { items: 0, usageBytes: 0, quotaBytes: 0, savedItems: [] };
      setWarehouseStorageInfo(emptyInfo);
      return emptyInfo;
    }
  }, [document.metadata.id]);

  useEffect(() => {
    try {
      setAutosaveAvailable(Boolean(loadProjectAutosave()));
    } catch {
      setAutosaveAvailable(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveProjectAutosave(document);
      setAutosaveAvailable(true);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [document]);

  useEffect(() => {
    let cancelled = false;
    loadWarehouseItems(document.metadata.id)
      .then((items) => {
        if (cancelled || !items.length) return;
        setDocument((current) => {
          if (current.metadata.id !== document.metadata.id) return current;
          const mergedItems = mergeWarehouseItems(current.partWarehouse ?? [], items);
          if (mergedItems.length === (current.partWarehouse ?? []).length) return current;
          setStatus(`${items.length} permanent warehouse items loaded`);
          return touch({
            ...current,
            partWarehouse: mergedItems,
            selectedWarehouseItemId: current.selectedWarehouseItemId ?? mergedItems[0]?.id,
          });
        });
      })
      .catch(() => {
        if (!cancelled) setStatus('Permanent warehouse unavailable');
      });

    return () => {
      cancelled = true;
    };
  }, [document.metadata.id]);

  useEffect(() => {
    void refreshWarehouseStorageInfo();
  }, [refreshWarehouseStorageInfo]);

  useEffect(() => {
    const runtimeWindow = window as Window & {
      __assetForgeDocument?: AssetDocument;
      __assetForgeCreateLegacyWarehouseItem?: () => boolean;
    };
    runtimeWindow.__assetForgeDocument = document;
    runtimeWindow.__assetForgeCreateLegacyWarehouseItem = () => {
      const imported = document.nodes.find((node) => node.geometry.kind === 'imported-model');
      if (!imported || imported.geometry.kind !== 'imported-model') return false;
      const now = new Date().toISOString();
      const item: PartWarehousePartItem = {
        id: 'legacy_invisible_pivot',
        itemType: 'part',
        code: 'ROB-JOI-LEGACY',
        name: 'Legacy Pivot',
        category: 'Robot Arms',
        className: 'Joint',
        sourceNodeId: imported.id,
        sourceAssetName: imported.geometry.assetName,
        objectName: 'legacy_non_renderable_pivot',
        geometry: {
          ...imported.geometry,
          isolatedObjectNames: ['legacy_non_renderable_pivot'],
          partObjectNames: undefined,
          freePartTransforms: [],
          partMaterials: [],
        },
        material: imported.material,
        metadata: {
          sourceFormat: imported.geometry.sourceFormat,
          originalBounds: imported.geometry.originalBounds,
          storedAt: now,
          updatedAt: now,
        },
      };
      setDocument(touch({ ...document, partWarehouse: [item], selectedWarehouseItemId: item.id }));
      setStatus('Legacy warehouse item created');
      return true;
    };
  }, [document]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return;

      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        undo();
      } else if ((event.ctrlKey || event.metaKey) && (key === 'y' || (event.shiftKey && key === 'z'))) {
        event.preventDefault();
        redo();
      } else if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        save();
      } else if (key === 'w') {
        if (tool === 'parts') setPartEditMode('translate');
        else setTool('translate');
      } else if (key === 'e') {
        if (tool === 'parts') setPartEditMode('rotate');
        else setTool('rotate');
      } else if (key === 'r') {
        if (tool === 'parts') setPartEditMode('scale');
        else setTool('scale');
      } else if (key === 'v') {
        setTool('select');
      } else if (key === 'p') {
        setTool('parts');
        setPartEditMode('free');
      } else if (key === 'delete' || key === 'backspace') {
        removeSelected();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const activateTransformTool = (nextTool: Exclude<PartEditMode, 'free'>) => {
    if (tool === 'parts') {
      if (partEditMode === nextTool) {
        setPartEditMode('free');
        setStatus('Free part mode');
        return;
      }
      setPartEditMode(nextTool);
      setStatus(`Part ${nextTool} mode`);
      return;
    }
    if (tool === nextTool) {
      setTool('select');
      setStatus('Mode cleared');
      return;
    }
    setTool(nextTool);
  };

  const togglePartsTool = () => {
    if (tool === 'parts') {
      setTool('select');
      setPartEditMode('free');
      setSelectedParts([]);
      setStatus('Parts mode cleared');
      return;
    }
    setTool('parts');
    setPartEditMode('free');
    setStatus('Parts mode');
  };

  const selectNode = useCallback(
    (nodeId?: string) => {
      setDocument((current) => ({ ...current, selectedNodeId: nodeId }));
      setSelectedParts([]);
      setStatus(nodeId ? 'Object selected' : 'Selection cleared');
    },
    [],
  );

  const addNode = (node: SceneNode, nextStatus: string) => {
    commit(
      {
        ...document,
        nodes: [...document.nodes, node],
        selectedNodeId: node.id,
      },
      nextStatus,
    );
    markWorkspaceNodesPending([node.id]);
  };

  const updateSelectedNode = (updater: (node: SceneNode) => SceneNode, nextStatus = 'Object updated') => {
    if (!selectedNode) return;
    if (selectedNode.locked) {
      setStatus('Object is locked');
      return;
    }
    commit(
      {
        ...document,
        nodes: document.nodes.map((node) => (node.id === selectedNode.id ? updater(node) : node)),
      },
      nextStatus,
    );
    markWorkspaceNodesPending([selectedNode.id]);
  };

  const updateSelectedNodeLive = (updater: (node: SceneNode) => SceneNode, nextStatus = 'Object updated') => {
    if (!selectedNode) return;
    if (selectedNode.locked) {
      setStatus('Object is locked');
      return;
    }

    const selectedNodeId = selectedNode.id;
    setDocument((current) =>
      touch({
        ...current,
        nodes: current.nodes.map((node) => (node.id === selectedNodeId ? updater(node) : node)),
      }),
    );
    markWorkspaceNodesPending([selectedNodeId]);
    setStatus(nextStatus);
  };

  const finishOrAdvanceMotionTrainer = (statusWhenComplete = 'Motion tests complete') => {
    setMotionTrainer((current) => {
      if (!current) return undefined;
      const nextIndex = current.index + 1;
      if (nextIndex >= current.candidates.length) {
        setStatus(statusWhenComplete);
        return undefined;
      }
      return { ...current, index: nextIndex };
    });
  };

  const startMotionTrainer = () => {
    if (!selectedNode || selectedNode.geometry.kind !== 'imported-model' || !selectedNode.geometry.joints.length) return;
    const candidates = makeMotionTrainingCandidates(selectedNode);
    setDemoMotionNodeId(undefined);
    setMotionTrainer({ nodeId: selectedNode.id, candidates, index: 0 });
    setStatus(`Motion tests started (${candidates.length})`);
  };

  const stopMotionTrainer = () => {
    setMotionTrainer(undefined);
    setStatus('Motion tests stopped');
  };

  const acceptMotionTest = () => {
    const candidate = currentMotionCandidate;
    if (!candidate) return;

    const nextDocument = touch({
      ...document,
      nodes: document.nodes.map((node) => {
        if (node.id !== candidate.nodeId || node.geometry.kind !== 'imported-model') return node;
        const existing = node.geometry.validatedMotions ?? [];
        const duplicate = existing.some(
          (motion) => motion.jointName === candidate.jointName && motion.motionKind === candidate.motionKind && motion.axis === candidate.axis,
        );
        if (duplicate) return node;

        const nextMotion: ValidatedJointMotion = {
          id: `motion_${crypto.randomUUID().slice(0, 8)}`,
          jointName: candidate.jointName,
          label: candidate.label,
          motionKind: candidate.motionKind,
          axis: candidate.axis,
          min: candidate.min,
          max: candidate.max,
          amplitude: candidate.amplitude,
          order: existing.length,
        };

        return {
          ...node,
          geometry: {
            ...node.geometry,
            validatedMotions: [...existing, nextMotion],
          },
        };
      }),
    });

    setPast((items) => [...items.slice(-80), document]);
    setFuture([]);
    setDocument(nextDocument);
    setIssues(validateProject(nextDocument));
    finishOrAdvanceMotionTrainer('Motion tests complete');
    setStatus('Motion test validated');
  };

  const rejectMotionTest = () => {
    finishOrAdvanceMotionTrainer('Motion tests complete');
    setStatus('Motion test rejected');
  };

  const updateValidatedMotions = (nodeId: string, updater: (motions: ValidatedJointMotion[]) => ValidatedJointMotion[], nextStatus: string) => {
    const nextDocument = touch({
      ...document,
      nodes: document.nodes.map((node) => {
        if (node.id !== nodeId || node.geometry.kind !== 'imported-model') return node;
        const ordered = [...(node.geometry.validatedMotions ?? [])].sort((a, b) => a.order - b.order);
        const nextMotions = updater(ordered).map((motion, index) => ({ ...motion, order: index }));
        return {
          ...node,
          geometry: {
            ...node.geometry,
            validatedMotions: nextMotions,
          },
        };
      }),
    });
    commit(nextDocument, nextStatus);
  };

  const moveValidatedMotion = (nodeId: string, motionId: string, direction: -1 | 1) => {
    updateValidatedMotions(
      nodeId,
      (motions) => {
        const index = motions.findIndex((motion) => motion.id === motionId);
        const targetIndex = index + direction;
        if (index < 0 || targetIndex < 0 || targetIndex >= motions.length) return motions;
        const next = [...motions];
        [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
        return next;
      },
      'Motion order updated',
    );
  };

  const removeValidatedMotion = (nodeId: string, motionId: string) => {
    updateValidatedMotions(nodeId, (motions) => motions.filter((motion) => motion.id !== motionId), 'Motion removed');
  };

  const updateNodeTransform = useCallback(
    (nodeId: string, transform: Transform) => {
      const target = document.nodes.find((node) => node.id === nodeId);
      if (target?.locked) {
        setStatus('Object is locked');
        return;
      }

      commit(
        {
          ...document,
          nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, transform } : node)),
        },
        'Transform committed',
      );
      markWorkspaceNodesPending([nodeId]);
    },
    [commit, document, markWorkspaceNodesPending],
  );

  const updateImportedPartTransforms = useCallback(
    (updates: Array<{ nodeId: string; objectName: string; transform: Transform }>) => {
      if (!updates.length) return;
      const lockedTarget = updates.some((update) => document.nodes.find((node) => node.id === update.nodeId)?.locked);
      if (lockedTarget) {
        setStatus('Object is locked');
        return;
      }
      const updatesByNode = new Map<string, Array<{ objectName: string; transform: Transform }>>();
      updates.forEach((update) => {
        const items = updatesByNode.get(update.nodeId) ?? [];
        items.push({ objectName: update.objectName, transform: update.transform });
        updatesByNode.set(update.nodeId, items);
      });

      commit(
        {
          ...document,
          nodes: document.nodes.map((node) => {
            const nodeUpdates = updatesByNode.get(node.id);
            if (!nodeUpdates || node.geometry.kind !== 'imported-model') return node;
            const existing = node.geometry.freePartTransforms ?? [];
            const transformByName = new Map(existing.map((partTransform) => [partTransform.objectName, partTransform]));
            nodeUpdates.forEach((update) => {
              transformByName.set(update.objectName, {
                objectName: update.objectName,
                position: update.transform.position,
                rotation: update.transform.rotation,
                scale: update.transform.scale,
              });
            });

            return {
              ...node,
              geometry: {
                ...node.geometry,
                freePartTransforms: [...transformByName.values()],
              },
            };
          }),
        },
        updates.length === 1 ? 'Part moved' : 'Parts moved',
      );
      markWorkspaceNodesPending([...updatesByNode.keys()]);
    },
    [commit, document, markWorkspaceNodesPending],
  );

  const updatePartSelectionStatus = useCallback((selection: ImportedPartSelection[]) => {
    setSelectedParts(selection);
    const count = selection.length;
    if (!count) {
      if (tool === 'parts') setStatus('Part selection cleared');
      return;
    }
    setStatus(count === 1 ? '1 part selected' : `${count} parts selected`);
  }, [tool]);

  const updateSelectedPartColor = useCallback(
    (color: string) => {
      if (!selectedParts.length) return;
      const selectedByNode = new Map<string, Set<string>>();
      selectedParts.forEach((part) => {
        const names = selectedByNode.get(part.nodeId) ?? new Set<string>();
        names.add(part.objectName);
        selectedByNode.set(part.nodeId, names);
      });

      commit(
        {
          ...document,
          nodes: document.nodes.map((node) => {
            const names = selectedByNode.get(node.id);
            if (!names || node.geometry.kind !== 'imported-model') return node;
            const materialByName = new Map((node.geometry.partMaterials ?? []).map((partMaterial) => [partMaterial.objectName, partMaterial]));
            names.forEach((objectName) => {
              materialByName.set(objectName, {
                objectName,
                color,
                roughness: node.material.roughness,
                metalness: node.material.metalness,
              });
            });
            return {
              ...node,
              geometry: {
                ...node.geometry,
                partMaterials: [...materialByName.values()],
              },
            };
          }),
        },
        selectedParts.length === 1 ? 'Part color updated' : 'Part colors updated',
      );
      markWorkspaceNodesPending([...selectedByNode.keys()]);
    },
    [commit, document, markWorkspaceNodesPending, selectedParts],
  );

  const buildWarehouseItem = async (node: SceneNode, objectName: string, index: number): Promise<PartWarehousePartItem | undefined> => {
    if (node.geometry.kind !== 'imported-model') return undefined;
    const category = inferPartCategory(node.geometry.assetName, objectName);
    const className = inferPartClassName(objectName);
    const now = new Date().toISOString();
    const independentGeometry = await createIndependentWarehousePartGeometry(node.geometry, node.material, objectName);
    const componentId = functionalComponentId(node.geometry.assetName, objectName);
    const item: PartWarehousePartItem = {
      id: `part_${crypto.randomUUID().slice(0, 8)}`,
      itemType: 'part',
      code: makePartCode(category, className, (document.partWarehouse?.length ?? 0) + index),
      name: cleanPartToken(objectName),
      category,
      className,
      sourceNodeId: node.id,
      sourceAssetName: node.geometry.assetName,
      objectName,
      geometry: independentGeometry,
      material: { ...node.material },
      functionalComponent: buildFunctionalComponent({
        id: componentId,
        name: cleanPartToken(objectName),
        category,
        className,
        sourceAssetName: node.geometry.assetName,
        sourceObjectName: objectName,
        bounds: independentGeometry.originalBounds,
        material: { ...node.material },
        sourceGraph: node.geometry.kinematicGraph,
      }),
      metadata: {
        sourceFormat: independentGeometry.kind,
        originalBounds: independentGeometry.originalBounds,
        storedAt: now,
        updatedAt: now,
      },
    };
    try {
      const previewNode: SceneNode = {
        id: `preview_${item.id}`,
        name: item.name,
        geometry: cloneGeometry(item.geometry),
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: { ...item.material },
        visible: true,
        locked: false,
        createdAt: now,
      };
      const previewDocument: AssetDocument = {
        ...document,
        nodes: [previewNode],
        selectedNodeId: previewNode.id,
      };
      item.thumbnailDataUrl = await blobToDataUrl(await renderDocumentPreview(previewDocument, 180));
    } catch {
      item.thumbnailDataUrl = undefined;
    }
    return item;
  };

  const buildStoredScenePartItem = async (node: SceneNode, index: number): Promise<PartWarehousePartItem | undefined> => {
    if (node.geometry.kind !== 'serialized-object') return undefined;
    const category = inferPartCategory(node.name, node.name);
    const className = inferPartClassName(node.name);
    const now = new Date().toISOString();
    const componentId = functionalComponentId(node.geometry.assetName, node.name);
    const item: PartWarehousePartItem = {
      id: `part_${crypto.randomUUID().slice(0, 8)}`,
      itemType: 'part',
      code: makePartCode(category, className, (document.partWarehouse?.length ?? 0) + index),
      name: node.name,
      category,
      className,
      sourceNodeId: node.id,
      sourceAssetName: node.geometry.assetName,
      objectName: node.name,
      geometry: cloneGeometry(node.geometry),
      material: { ...node.material },
      functionalComponent: buildFunctionalComponent({
        id: componentId,
        name: node.name,
        category,
        className,
        sourceAssetName: node.geometry.assetName,
        sourceObjectName: node.name,
        bounds: node.geometry.originalBounds,
        material: { ...node.material },
        localTransform: node.transform,
      }),
      metadata: {
        sourceFormat: 'serialized-object',
        originalBounds: node.geometry.originalBounds,
        storedAt: now,
        updatedAt: now,
      },
    };
    try {
      const previewNode: SceneNode = {
        ...node,
        id: `preview_${item.id}`,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        visible: true,
      };
      const previewDocument: AssetDocument = {
        ...document,
        nodes: [previewNode],
        selectedNodeId: previewNode.id,
      };
      item.thumbnailDataUrl = await blobToDataUrl(await renderDocumentPreview(previewDocument, 180));
    } catch {
      item.thumbnailDataUrl = undefined;
    }
    return item;
  };

  const storePartsInWarehouse = async (mode: 'selected' | 'all') => {
    if (!selectedNode || selectedNode.geometry.kind !== 'imported-model') return;
    const objectNames =
      mode === 'selected'
        ? selectedParts.filter((part) => part.nodeId === selectedNode.id).map((part) => part.objectName)
        : selectedNode.geometry.partObjectNames?.length
          ? selectedNode.geometry.partObjectNames
          : selectedNode.geometry.joints.map((joint) => joint.name);
    const uniqueObjectNames = [...new Set(objectNames)].filter(Boolean);
    if (!uniqueObjectNames.length) {
      setStatus(mode === 'selected' ? 'Select parts first' : 'No parts detected');
      return;
    }

    const nextItems: PartWarehousePartItem[] = [];
    for (const [index, objectName] of uniqueObjectNames.entries()) {
      setStatus(`Storing part ${index + 1}/${uniqueObjectNames.length}`);
      try {
        const item = await buildWarehouseItem(selectedNode, objectName, index);
        if (item) nextItems.push(item);
      } catch {
        continue;
      }
    }

    if (!nextItems.length) {
      setStatus('No visible parts stored');
      return;
    }

    commit(
      {
        ...document,
        partWarehouse: [...(document.partWarehouse ?? []), ...nextItems],
        selectedWarehouseItemId: nextItems[0]?.id ?? document.selectedWarehouseItemId,
      },
      nextItems.length === 1 ? 'Part stored' : `${nextItems.length} parts stored`,
    );
  };

  const selectWarehouseItem = (itemId: string) => {
    setDocument((current) => ({ ...current, selectedWarehouseItemId: itemId }));
    setStatus('Warehouse part selected');
  };

  const loadPermanentWarehouseIntoProject = async () => {
    setStatus('Loading saved warehouse...');
    try {
      const source = await loadWarehouseItemsWithFallback(document.metadata.id);
      const items = await ensureWarehouseThumbnails(source.items);
      if (!items.length) {
        setStatus('No saved warehouse objects for this project');
        refreshWarehouseStorageInfo();
        return;
      }

      const currentItems = document.partWarehouse ?? [];
      const mergedItems = mergeWarehouseItems(currentItems, items);
      const added = mergedItems.length - currentItems.length;
      const nextDocument = {
        ...document,
        metadata: source.fallback
          ? {
              ...document.metadata,
              id: source.projectId,
              updatedAt: new Date().toISOString(),
            }
          : document.metadata,
        partWarehouse: mergedItems,
        selectedWarehouseItemId: document.selectedWarehouseItemId ?? mergedItems[0]?.id,
      };
      commit(
        nextDocument,
        source.fallback
          ? `${items.length} saved objects loaded from ${source.projectId}`
          : added
            ? `${added} saved objects loaded`
            : 'Saved warehouse already loaded',
      );
      const storageInfo = await loadWarehouseStorageInfo(source.projectId);
      setWarehouseStorageInfo(storageInfo);
    } catch {
      setStatus('Saved warehouse load failed');
    }
  };

  const warehouseScenePosition = (offset = 0): [number, number, number] => {
    const warehouseNodes = document.nodes.filter(
      (node) => node.geometry.kind === 'serialized-object' || (node.geometry.kind === 'imported-model' && node.geometry.sourceFormat === 'glb'),
    ).length + offset;
    return [1.35 + (warehouseNodes % 3) * 0.75, 0, -0.75 + Math.floor(warehouseNodes / 3) * 0.55];
  };

  const buildWarehouseSceneNodes = async (item: PartWarehouseItem, offset = 0): Promise<SceneNode[]> => {
    if (item.itemType === 'assembly') {
      return item.assemblyNodes.map((node, index) => cloneStoredNode(node, offset + index));
    }

    let geometry = cloneGeometry(item.geometry);
    if (geometry.kind === 'imported-model') {
      setStatus('Preparing stored part for scene...');
      try {
        geometry = await createIndependentWarehousePartGeometry(geometry, item.material, item.objectName);
      } catch {
        setStatus('Stored part has no visible geometry');
        return [];
      }
    }

    return [
      {
        id: `node_${crypto.randomUUID().slice(0, 8)}`,
        name: item.name,
        geometry,
        transform: {
          position: warehouseScenePosition(offset),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        material: { ...item.material },
        visible: true,
        locked: false,
        createdAt: new Date().toISOString(),
      },
    ];
  };

  const renderWarehouseItemThumbnail = async (item: PartWarehouseItem) => {
    const nodes = await buildWarehouseSceneNodes(item);
    if (!nodes.length) return undefined;
    const thumbnailDocument: AssetDocument = {
      ...document,
      nodes,
      selectedNodeId: nodes[0]?.id,
    };
    return blobToDataUrl(await renderDocumentPreview(thumbnailDocument, 180));
  };

  const ensureWarehouseThumbnails = useCallback(
    async (items: PartWarehouseItem[]) => {
      const missingItems = items.filter((item) => !item.thumbnailDataUrl);
      if (!missingItems.length) return items;

      const thumbnailById = new Map<string, string>();
      for (const item of missingItems) {
        try {
          const thumbnail = await renderWarehouseItemThumbnail(item);
          if (thumbnail) {
            thumbnailById.set(item.id, thumbnail);
            void saveWarehouseThumbnail(document.metadata.id, item, thumbnail).catch(() => undefined);
          }
        } catch {
          // Keep the item usable even if its preview cannot be rendered.
        }
      }

      if (!thumbnailById.size) return items;
      return items.map((item) => (thumbnailById.has(item.id) ? { ...item, thumbnailDataUrl: thumbnailById.get(item.id) } : item));
    },
    [document],
  );

  useEffect(() => {
    const currentItems = document.partWarehouse ?? [];
    if (!currentItems.some((item) => !item.thumbnailDataUrl)) return;

    let cancelled = false;
    void ensureWarehouseThumbnails(currentItems).then((itemsWithThumbnails) => {
      if (cancelled || !itemsWithThumbnails.some((item) => item.thumbnailDataUrl)) return;
      setDocument((current) => ({
        ...current,
        partWarehouse: (current.partWarehouse ?? []).map((item) => {
          const hydrated = itemsWithThumbnails.find((candidate) => candidate.id === item.id);
          return hydrated?.thumbnailDataUrl && !item.thumbnailDataUrl ? { ...item, thumbnailDataUrl: hydrated.thumbnailDataUrl } : item;
        }),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [document.partWarehouse, ensureWarehouseThumbnails]);

  const importFirstPermanentWarehouseObject = async () => {
    setActiveView('workspace');
    setStatus('Importing saved warehouse object...');
    try {
      const source = await loadWarehouseItemsWithFallback(document.metadata.id);
      const items = await ensureWarehouseThumbnails(source.items);
      const item = items[0];
      if (!item) {
        setStatus('No saved warehouse objects for this project');
        return;
      }

      const nodes = await buildWarehouseSceneNodes(item);
      if (!nodes.length) return;
      commit(
        {
          ...document,
          metadata: source.fallback
            ? {
                ...document.metadata,
                id: source.projectId,
                updatedAt: new Date().toISOString(),
              }
            : document.metadata,
          partWarehouse: mergeWarehouseItems(document.partWarehouse ?? [], items),
          nodes: [...document.nodes, ...nodes],
          selectedNodeId: nodes[0]?.id ?? document.selectedNodeId,
        },
        source.fallback ? `Saved object imported from ${source.projectId}` : 'Saved object imported',
      );
      const storageInfo = await loadWarehouseStorageInfo(source.projectId);
      setWarehouseStorageInfo(storageInfo);
    } catch {
      setStatus('Saved object import failed');
    }
  };

  const addWarehouseItemToScene = async (item: PartWarehouseItem) => {
    setWarehouseMenu(undefined);
    setActiveView('workspace');
    const nodes = await buildWarehouseSceneNodes(item);
    if (!nodes.length) return;
    commit(
      {
        ...document,
        nodes: [...document.nodes, ...nodes],
        selectedNodeId: nodes[0]?.id ?? document.selectedNodeId,
      },
      item.itemType === 'assembly' ? 'Warehouse assembly added' : 'Warehouse part added',
    );
  };

  const addAllWarehouseItemsToScene = async () => {
    const items = document.partWarehouse ?? [];
    if (!items.length) {
      setStatus('No warehouse objects to import');
      return;
    }

    setActiveView('workspace');
    setStatus('Importing saved objects...');
    const nodes: SceneNode[] = [];
    for (const item of items) {
      nodes.push(...(await buildWarehouseSceneNodes(item, nodes.length)));
    }
    if (!nodes.length) return;
    commit(
      {
        ...document,
        nodes: [...document.nodes, ...nodes],
        selectedNodeId: nodes[0]?.id ?? document.selectedNodeId,
      },
      `${nodes.length} warehouse objects imported`,
    );
  };

  const deleteWarehouseItem = (itemId: string) => {
    const itemToDelete = document.partWarehouse?.find((item) => item.id === itemId);
    commit(
      {
        ...document,
        partWarehouse: (document.partWarehouse ?? []).filter((item) => item.id !== itemId),
        selectedWarehouseItemId: document.selectedWarehouseItemId === itemId ? undefined : document.selectedWarehouseItemId,
      },
      'Warehouse item deleted',
    );
    if (itemToDelete) {
      deletePersistentWarehouseItem(document.metadata.id, itemToDelete)
        .then(() => void refreshWarehouseStorageInfo())
        .catch(() => setStatus('Warehouse item deleted locally'));
    }
    setWarehouseMenu(undefined);
  };

  const warehouseItemForWorkspaceNode = (node: SceneNode) =>
    (document.partWarehouse ?? []).find((item) => {
      if (item.metadata.storageKey === `workspace-${node.id}`) return true;
      if (item.itemType === 'part' && node.geometry.kind === 'imported-model' && item.metadata.storageFileName === node.geometry.assetName) return true;
      if (item.itemType === 'part' && node.geometry.kind === 'serialized-object' && item.name === node.name) return true;
      if (item.itemType === 'assembly' && item.name === node.name) return true;
      return false;
    });

  const deleteWorkspaceObjectPermanent = async (nodeId: string) => {
    const node = document.nodes.find((item) => item.id === nodeId);
    if (!node) {
      setStatus('Scene object not found');
      return;
    }
    if (node.locked) {
      setStatus('Object is locked');
      return;
    }

    const warehouseItem = warehouseItemForWorkspaceNode(node);
    commit(
      {
        ...document,
        nodes: document.nodes.filter((item) => item.id !== nodeId),
        selectedNodeId: document.selectedNodeId === nodeId ? undefined : document.selectedNodeId,
        partWarehouse: warehouseItem ? (document.partWarehouse ?? []).filter((item) => item.id !== warehouseItem.id) : document.partWarehouse,
        selectedWarehouseItemId: warehouseItem && document.selectedWarehouseItemId === warehouseItem.id ? undefined : document.selectedWarehouseItemId,
      },
      warehouseItem ? 'Workspace object deleted permanently' : 'Workspace object deleted',
    );
    clearPendingWorkspaceNodes([nodeId]);
    setWorkspaceMenu(undefined);

    if (warehouseItem) {
      await deletePersistentWarehouseItem(document.metadata.id, warehouseItem).catch(() => undefined);
      await refreshWarehouseStorageInfo();
    }
  };

  const saveWarehouseItemsPermanent = async (items: PartWarehouseItem[], label: string) => {
    if (!items.length) {
      setStatus('No warehouse items to save');
      return;
    }

    setStatus(`Saving ${label} to permanent warehouse...`);
    try {
      let result = { saved: 0, skipped: 0 };
      for (const item of items) {
        const nodes = await buildWarehouseSceneNodes(item);
        if (!nodes.length) continue;
        const glb = await exportDocumentAsGlb({
          ...document,
          nodes,
          selectedNodeId: nodes[0]?.id,
        });
        const saved = await saveWarehouseGlbItem(document.metadata.id, item, glb, { overwrite: Boolean(item.metadata.storageKey) });
        result = {
          saved: result.saved + saved.saved,
          skipped: result.skipped + saved.skipped,
        };
      }
      await refreshWarehouseStorageInfo();
      if (result.saved) {
        setStatus(`${result.saved} saved permanently${result.skipped ? `, ${result.skipped} already saved` : ''}`);
      } else {
        setStatus(`${result.skipped} already saved`);
      }
    } catch {
      setStatus('Permanent warehouse save failed');
    }
  };

  const saveSelectedWarehousePermanent = () => {
    if (!selectedWarehouseItem) {
      setStatus('Select a warehouse item first');
      return;
    }
    void saveWarehouseItemsPermanent([selectedWarehouseItem], 'selected item');
  };

  const saveAllWarehousePermanent = () => {
    void saveWarehouseItemsPermanent(document.partWarehouse ?? [], 'all items');
  };

  const exportWarehouseProject = () => {
    const items = warehouseStorageInfo.savedItems;
    if (!items.length) {
      setStatus('Warehouse is empty');
      return;
    }
    const payload = {
      schemaVersion: 1,
      kind: '3d-asset-forge.warehouse-manifest',
      exportedAt: new Date().toISOString(),
      project: {
        id: document.metadata.id,
        name: document.metadata.name,
      },
      storage: {
        directory: `project-warehouse/${document.metadata.id}`,
        usageBytes: warehouseStorageInfo.usageBytes,
      },
      items,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${document.metadata.name.replace(/\s+/g, '-').toLowerCase()}-warehouse.json`);
    setStatus('Warehouse manifest exported');
  };

  const importWarehouseProject = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as { kind?: string; items?: PartWarehouseItem[] };
        if (parsed.kind !== '3d-asset-forge.warehouse' || !Array.isArray(parsed.items)) {
          throw new Error('Invalid warehouse file.');
        }
        const importedItems = parsed.items.map((item, index) => cloneWarehouseItemForImport(item, (document.partWarehouse?.length ?? 0) + index));
        commit(
          {
            ...document,
            partWarehouse: [...(document.partWarehouse ?? []), ...importedItems],
            selectedWarehouseItemId: importedItems[0]?.id ?? document.selectedWarehouseItemId,
          },
          `${importedItems.length} warehouse items imported`,
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Warehouse import failed');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const storableSceneNodes = () => document.nodes.filter((node) => node.geometry.kind === 'imported-model' || node.geometry.kind === 'serialized-object');

  const storeScenePartsSeparately = async () => {
    const sceneNodes = storableSceneNodes();
    const pendingParts = sceneNodes.flatMap((node) => {
        if (node.geometry.kind === 'serialized-object') return [{ node, objectName: node.name, index: 0 }];
        if (node.geometry.kind !== 'imported-model') return [];
        const names = node.geometry.isolatedObjectNames?.length
          ? node.geometry.isolatedObjectNames
          : node.geometry.partObjectNames?.length
            ? node.geometry.partObjectNames
            : node.geometry.joints.map((joint) => joint.name);
        return [...new Set(names)].map((objectName, index) => ({ node, objectName, index }));
      });
    const nextItems: PartWarehousePartItem[] = [];
    for (const [partIndex, part] of pendingParts.entries()) {
      setStatus(`Storing scene part ${partIndex + 1}/${pendingParts.length}`);
      try {
        const item =
          part.node.geometry.kind === 'serialized-object'
            ? await buildStoredScenePartItem(part.node, part.index)
            : await buildWarehouseItem(part.node, part.objectName, part.index);
        if (item) nextItems.push(item);
      } catch {
        continue;
      }
    }

    if (!nextItems.length) {
      setStatus('No scene parts to store');
      return;
    }

    commit(
      {
        ...document,
        partWarehouse: [...(document.partWarehouse ?? []), ...nextItems],
        selectedWarehouseItemId: nextItems[0].id,
      },
      `${nextItems.length} scene parts stored`,
    );
  };

  const buildFunctionalComponentFromSceneNode = async (node: SceneNode, index: number) => {
    const instanceId = functionalComponentId(document.metadata.id, `${node.id}_${node.name}_${index}`);
    const existingItem = warehouseItemForWorkspaceNode(node);
    if (existingItem?.itemType === 'part' && existingItem.functionalComponent) {
      return instantiateFunctionalComponent(
        {
          ...existingItem.functionalComponent,
          metadata: {
            ...existingItem.functionalComponent.metadata,
            reusedFromWarehouseItemId: existingItem.id,
          },
        },
        instanceId,
        node.transform,
      );
    }

    if (node.geometry.kind === 'serialized-object') {
      return buildFunctionalComponent({
        id: instanceId,
        name: node.name,
        category: inferPartCategory(node.name, node.name),
        className: inferPartClassName(node.name),
        sourceAssetName: node.geometry.assetName,
        sourceObjectName: node.name,
        bounds: node.geometry.normalizedBounds,
        material: { ...node.material },
        localTransform: node.transform,
      });
    }

    if (node.geometry.kind === 'imported-model') {
      return buildFunctionalComponent({
        id: instanceId,
        name: node.name,
        category: inferPartCategory(node.geometry.assetName, node.name),
        className: inferPartClassName(node.name),
        sourceAssetName: node.geometry.assetName,
        sourceObjectName: node.name,
        bounds: node.geometry.normalizedBounds,
        material: { ...node.material },
        localTransform: node.transform,
        sourceGraph: node.geometry.kinematicGraph,
      });
    }

    return buildFunctionalComponent({
      id: instanceId,
      name: node.name,
      category: inferPartCategory(document.metadata.name, node.name),
      className: inferPartClassName(node.name),
      sourceAssetName: document.metadata.name,
      sourceObjectName: node.name,
      bounds: [1, 1, 1],
      material: { ...node.material },
      localTransform: node.transform,
    });
  };

  const buildSceneAssemblyWarehouseItem = async (nodes: SceneNode[], name?: string, storageKey?: string): Promise<PartWarehouseAssemblyItem | undefined> => {
    if (!nodes.length) return undefined;
    const now = new Date().toISOString();
    const components = await Promise.all(nodes.map((node, index) => buildFunctionalComponentFromSceneNode(node, index)));
    const functionalAssembly = buildFunctionalAssembly({
      id: `assembly_functional_${crypto.randomUUID().slice(0, 8)}`,
      name:
        name ??
        `Scene Assembly ${String((document.partWarehouse ?? []).filter((entry) => entry.itemType === 'assembly').length + 1).padStart(2, '0')}`,
      components,
      source: 'reassembly',
    });
    const item: PartWarehouseAssemblyItem = {
      id: `assembly_${crypto.randomUUID().slice(0, 8)}`,
      itemType: 'assembly' as const,
      code: makePartCode('Assemblies', 'Composite', document.partWarehouse?.length ?? 0),
      name:
        name ??
        `Scene Assembly ${String((document.partWarehouse ?? []).filter((entry) => entry.itemType === 'assembly').length + 1).padStart(2, '0')}`,
      category: 'Assemblies' as const,
      className: 'Composite',
      sourceAssetName: document.metadata.name,
      assemblyNodes: nodes.map((node) => cloneStoredNode(node)),
      functionalAssembly,
      metadata: {
        sourceFormat: 'assembly' as const,
        originalBounds: sceneAssemblyBounds(nodes),
        storedAt: now,
        updatedAt: now,
        storageKey,
        storageProjectId: storageKey ? document.metadata.id : undefined,
      },
    };
    try {
      const previewDocument: AssetDocument = {
        ...document,
        nodes: item.assemblyNodes.map((node, index) => cloneStoredNode(node, index)),
        selectedNodeId: item.assemblyNodes[0]?.id,
      };
      item.thumbnailDataUrl = await blobToDataUrl(await renderDocumentPreview(previewDocument, 180));
    } catch {
      item.thumbnailDataUrl = undefined;
    }
    return item;
  };

  const buildWorkspaceNodeWarehouseItem = async (node: SceneNode): Promise<PartWarehouseItem | undefined> => {
    const storageKey = `workspace-${node.id}`;
    if (node.geometry.kind === 'serialized-object') {
      const item = await buildStoredScenePartItem(node, document.partWarehouse?.length ?? 0);
      if (!item) return undefined;
      return {
        ...item,
        metadata: {
          ...item.metadata,
          storageKey,
          storageProjectId: document.metadata.id,
        },
      };
    }

    if (node.geometry.kind === 'imported-model') {
      return buildSceneAssemblyWarehouseItem([node], node.name, storageKey);
    }

    return buildSceneAssemblyWarehouseItem([node], node.name, storageKey);
  };

  const storeSceneAssembly = async () => {
    const nodes = storableSceneNodes();
    if (nodes.length < 2) {
      setStatus('Add at least two scene parts');
      return;
    }

    const item = await buildSceneAssemblyWarehouseItem(nodes);
    if (!item) return;

    commit(
      {
        ...document,
        partWarehouse: [...(document.partWarehouse ?? []), item],
        selectedWarehouseItemId: item.id,
      },
      'Scene assembly stored',
    );
    await saveWarehouseItemsPermanent([item], 'functional assembly');
    setStatus('Functional assembly saved');
  };

  const saveWorkspaceItemPermanent = async (nodeId: string) => {
    const node = document.nodes.find((item) => item.id === nodeId);
    if (!node) {
      setStatus('Scene object not found');
      return;
    }

    setWorkspaceMenu(undefined);
    setStatus('Saving workspace object...');
    const item = await buildWorkspaceNodeWarehouseItem(node);

    if (!item) {
      setStatus('This object cannot be stored in warehouse');
      return;
    }

    const nextWarehouse = mergeWarehouseItems(document.partWarehouse ?? [], [item]);
    commit(
      {
        ...document,
        partWarehouse: nextWarehouse,
        selectedWarehouseItemId: item.id,
      },
      'Workspace object stored',
    );
    await saveWarehouseItemsPermanent([item], 'workspace object');
    clearPendingWorkspaceNodes([nodeId]);
  };

  const savePendingWorkspaceChanges = async () => {
    const pendingNodes = pendingWorkspaceNodeIds
      .map((nodeId) => document.nodes.find((node) => node.id === nodeId))
      .filter((node): node is SceneNode => Boolean(node));
    if (!pendingNodes.length) {
      setStatus('No workspace changes to save');
      setPendingWorkspaceNodeIds([]);
      return;
    }

    setStatus(`Saving ${pendingNodes.length} workspace change${pendingNodes.length === 1 ? '' : 's'}...`);
    const items: PartWarehouseItem[] = [];
    for (const node of pendingNodes) {
      const item = await buildWorkspaceNodeWarehouseItem(node);
      if (item) items.push(item);
    }

    if (!items.length) {
      setStatus('No savable workspace objects');
      return;
    }

    const nextWarehouse = mergeWarehouseItems(document.partWarehouse ?? [], items);
    commit(
      {
        ...document,
        partWarehouse: nextWarehouse,
        selectedWarehouseItemId: items[0]?.id ?? document.selectedWarehouseItemId,
      },
      'Workspace changes stored',
    );
    await saveWarehouseItemsPermanent(items, 'workspace changes');
    clearPendingWorkspaceNodes(pendingNodes.map((node) => node.id));
  };

  const saveWorkspaceAssemblyPermanent = async () => {
    const nodes = storableSceneNodes();
    if (!nodes.length) {
      setStatus('No scene objects to store');
      return;
    }

    setWorkspaceMenu(undefined);
    setStatus('Saving workspace assembly...');
    const item = await buildSceneAssemblyWarehouseItem(nodes);
    if (!item) return;
    const nextWarehouse = mergeWarehouseItems(document.partWarehouse ?? [], [item]);
    commit(
      {
        ...document,
        partWarehouse: nextWarehouse,
        selectedWarehouseItemId: item.id,
      },
      'Workspace assembly stored',
    );
    await saveWarehouseItemsPermanent([item], 'workspace assembly');
  };

  const updateWarehouseItemFromSelection = async (copy: boolean) => {
    if (!selectedWarehouseItem || selectedWarehouseItem.itemType !== 'part' || !selectedNode) return;
    const nextItem =
      selectedNode.geometry.kind === 'serialized-object'
        ? await buildStoredScenePartItem(selectedNode, 0)
        : selectedNode.geometry.kind === 'imported-model'
          ? await buildWarehouseItem(selectedNode, selectedParts.find((part) => part.nodeId === selectedNode.id)?.objectName ?? selectedNode.geometry.isolatedObjectNames?.[0] ?? '', 0)
          : undefined;
    if (!nextItem) return;
    const itemToStore = copy
      ? { ...nextItem, name: `${nextItem.name} Copy`, code: makePartCode(nextItem.category, nextItem.className, document.partWarehouse?.length ?? 0) }
      : { ...nextItem, id: selectedWarehouseItem.id, code: selectedWarehouseItem.code, metadata: { ...nextItem.metadata, storedAt: selectedWarehouseItem.metadata.storedAt } };

    commit(
      {
        ...document,
        partWarehouse: copy
          ? [...(document.partWarehouse ?? []), itemToStore]
          : (document.partWarehouse ?? []).map((item) => (item.id === selectedWarehouseItem.id ? itemToStore : item)),
        selectedWarehouseItemId: itemToStore.id,
      },
      copy ? 'Warehouse copy created' : 'Warehouse part updated',
    );
    await saveWarehouseItemsPermanent([itemToStore], copy ? 'warehouse copy' : 'warehouse item');
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [document, ...items]);
    setDocument(previous);
    setIssues(validateProject(previous));
    setStatus('Undo');
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, document]);
    setDocument(next);
    setIssues(validateProject(next));
    setStatus('Redo');
  };

  const save = async () => {
    try {
      const saved = saveProjectToBrowser(document);
      setDocument(saved);

      if (desktopRuntime) {
        const filePath = await saveProjectNative(saved, nativeProjectPath);
        if (filePath) {
          setNativeProjectPath(filePath);
          setStatus(`Project saved: ${filePath}`);
        } else {
          setStatus('Save cancelled');
        }
        return;
      }

      downloadProjectFile(saved);
      setStatus('Project saved to browser storage and JSON');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  };

  const openNativeProject = async () => {
    if (!desktopRuntime) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const result = await openProjectNative();
      if (!result) {
        setStatus('Open cancelled');
        return;
      }

      setPast((items) => [...items, document]);
      setFuture([]);
      setDocument(result.document);
      setNativeProjectPath(result.path);
      setIssues(validateProject(result.document));
      saveProjectToBrowser(result.document);
      setStatus(`Opened ${result.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Open failed');
    }
  };

  const openProjectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as AssetDocument;
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)) {
          throw new Error('Invalid project file.');
        }
        setPast((items) => [...items, document]);
        setFuture([]);
        setDocument(parsed);
        setNativeProjectPath(undefined);
        setIssues(validateProject(parsed));
        setStatus(`Opened ${file.name}`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Open failed');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const importModelFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setStatus(`Importing ${file.name}...`);
      const node = await createImportedModelNode(file);
      const replacingStarterPlaceholder = document.nodes.length === 1 && isStarterPlaceholderNode(document.nodes[0]);
      if (replacingStarterPlaceholder) {
        commit(
          {
            ...document,
            nodes: [node],
            selectedNodeId: node.id,
          },
          node.geometry.kind === 'imported-model' && node.geometry.joints.length ? 'Articulated model imported' : 'Static model imported',
        );
        markWorkspaceNodesPending([node.id]);
      } else {
        addNode(node, node.geometry.kind === 'imported-model' && node.geometry.joints.length ? 'Articulated model imported' : 'Static model imported');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'GLB import failed');
    } finally {
      event.target.value = '';
    }
  };

  const removeSelected = () => {
    if (!selectedNode) return;
    if (selectedNode.locked) {
      setStatus('Object is locked');
      return;
    }
    commit(
      {
        ...document,
        nodes: document.nodes.filter((node) => node.id !== selectedNode.id),
        selectedNodeId: undefined,
      },
      'Object deleted',
    );
    clearPendingWorkspaceNodes([selectedNode.id]);
  };

  const duplicateSelected = () => {
    if (!selectedNode) return;
    const copy = cloneSceneNode(selectedNode);
    commit(
      {
        ...document,
        nodes: [...document.nodes, copy],
        selectedNodeId: copy.id,
      },
      'Object duplicated',
    );
    markWorkspaceNodesPending([copy.id]);
  };

  const toggleSelectedVisibility = () => {
    if (!selectedNode) return;
    commit(
      {
        ...document,
        nodes: document.nodes.map((node) => (node.id === selectedNode.id ? { ...node, visible: !node.visible } : node)),
      },
      selectedNode.visible ? 'Object hidden' : 'Object visible',
    );
  };

  const toggleSelectedLock = () => {
    if (!selectedNode) return;
    commit(
      {
        ...document,
        nodes: document.nodes.map((node) => (node.id === selectedNode.id ? { ...node, locked: !node.locked } : node)),
      },
      selectedNode.locked ? 'Object unlocked' : 'Object locked',
    );
  };

  const restoreAutosave = () => {
    try {
      const autosave = loadProjectAutosave();
      if (!autosave) {
        setStatus('No autosave found');
        return;
      }

      setPast((items) => [...items, document]);
      setFuture([]);
      setDocument(autosave);
      setIssues(validateProject(autosave));
      setStatus('Autosave restored');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Autosave restore failed');
    }
  };

  const validate = () => {
    const nextIssues = validateProject(document);
    setIssues(nextIssues);
    setStatus(nextIssues.some((issue) => issue.severity === 'error') ? 'Validation failed' : 'Validation passed');
  };

  const runPreflight = () => {
    const profile = getExportProfile(exportProfileId);
    const nextIssues = runExportPreflight(document, profile);
    setIssues(nextIssues);
    setStatus(nextIssues.some((issue) => issue.severity === 'error') ? 'Preflight failed' : `Preflight passed for ${profile.name}`);
  };

  const renderPreview = async () => {
    setStatus('Rendering preview...');
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const blob = await renderDocumentPreview(document);
      setPreviewUrl(URL.createObjectURL(blob));
      setStatus(`Preview rendered (${Math.round(blob.size / 1024)} KB)`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Preview failed');
    }
  };

  const savePreview = async () => {
    if (!previewUrl) return;

    const blob = await fetch(previewUrl).then((response) => response.blob());
    const fileName = `${document.metadata.name.replace(/\s+/g, '-').toLowerCase()}-preview.png`;
    if (desktopRuntime) {
      const filePath = await saveBlobNative(blob, fileName, 'png');
      setStatus(filePath ? `Preview saved: ${filePath}` : 'Preview save cancelled');
    } else {
      downloadBlob(blob, fileName);
      setStatus('Preview downloaded');
    }
  };

  const exportGlb = async () => {
    const profile = getExportProfile(exportProfileId);
    const nextIssues = runExportPreflight(document, profile);
    setIssues(nextIssues);
    if (nextIssues.some((issue) => issue.severity === 'error')) {
      setStatus('Export blocked by validation errors');
      return;
    }

    setStatus('Exporting GLB...');
    const startedAt = performance.now();
    const blob = await exportDocumentAsGlb(document);
    const fileName = `${document.metadata.name.replace(/\s+/g, '-').toLowerCase()}-${profile.filenameSuffix}.glb`;
    const report = buildExportReport(document, profile, fileName, blob.size, Math.round(performance.now() - startedAt), nextIssues);
    if (desktopRuntime) {
      const exportedPath = await saveBlobNative(blob, fileName, 'glb');
      if (!exportedPath) {
        setStatus('Export cancelled');
        return;
      }
      await saveJsonNative(report, fileName.replace(/\.glb$/, '.export-report.json'));
    } else {
      downloadBlob(blob, fileName);
      exportJsonReport(report, fileName.replace(/\.glb$/, '.export-report.json'));
    }
    setExportReport(report);
    setStatus(`GLB exported (${report.fileSizeKb} KB, ${profile.name})`);
  };

  const setTransformValue = (field: keyof Transform, index: number, value: number) => {
    updateSelectedNode((node) => {
      const nextTuple = [...node.transform[field]] as [number, number, number];
      nextTuple[index] = value;
      return {
        ...node,
        transform: {
          ...node.transform,
          [field]: nextTuple,
        },
      };
    });
  };

  const setMaterialValue = (field: 'color' | 'roughness' | 'metalness', value: string | number) => {
    updateSelectedNode((node) => ({
      ...node,
      material: {
        ...node.material,
        [field]: value,
      },
    }));
  };

  const applyMaterialPreset = (presetName: string) => {
    const preset = materialPresets.find((item) => item.name === presetName);
    if (!preset) return;
    updateSelectedNode(
      (node) => ({
        ...node,
        material: { ...preset },
      }),
      'Material preset applied',
    );
  };

  const setGeometryValue = (field: string, value: number) => {
    updateSelectedNode((node) => {
      const geometry = node.geometry;
      if ('generatorId' in geometry) {
        const nextParams = clampGeneratorParams(geometry.generatorId, {
          ...geometry.params,
          [field]: value,
        });

        return {
          ...node,
          geometry: {
            ...geometry,
            params: nextParams,
          },
        };
      }

      return {
        ...node,
        geometry: {
          ...geometry,
          [field]: value,
        } as GeometryDefinition,
      };
    }, 'Geometry updated');
  };

  const setImportedJointMotion = (jointName: string, value: number) => {
    if (!selectedNode) return;
    setImportedJointMotionForNode(selectedNode.id, jointName, value);
  };

  const setImportedJointMotionForNode = (nodeId: string, jointName: string, value: number) => {
    setDemoMotionNodeId((current) => (current === nodeId ? undefined : current));
    setDocument((current) =>
      touch({
        ...current,
        selectedNodeId: nodeId,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId || node.geometry.kind !== 'imported-model') return node;

          return {
            ...node,
            geometry: {
              ...node.geometry,
              joints: node.geometry.joints.map((joint) => {
                if (joint.name !== jointName) return joint;
                const axis = joint.axis === 'y' ? 1 : joint.axis === 'z' ? 2 : 0;
                const rotation: [number, number, number] = [0, 0, 0];
                const translation: [number, number, number] = [0, 0, 0];
                if (joint.motionKind === 'translation') translation[axis] = value;
                else rotation[axis] = value;
                return {
                  ...joint,
                  rotation,
                  translation,
                };
              }),
            },
          };
        }),
      }),
    );
    markWorkspaceNodesPending([nodeId]);
    setStatus('Joint adjusted');
  };

  const updateKinematicGraphForNode = (
    nodeId: string,
    updater: (graph: KinematicGraph, geometry: ImportedModelGeometry) => KinematicGraph,
    nextStatus: string,
  ) => {
    setDemoMotionNodeId((current) => (current === nodeId ? undefined : current));
    setDocument((current) => {
      const nextDocument = touch({
        ...current,
        selectedNodeId: nodeId,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId || node.geometry.kind !== 'imported-model') return node;
          const graph = updater(graphFromImportedGeometry(node.geometry), node.geometry);
          const state = node.geometry.kinematicState ?? createHomeKinematicState(graph);
          return {
            ...node,
            geometry: {
              ...node.geometry,
              kinematicGraph: graph,
              kinematicState: {
                homeJointValues: { ...createHomeKinematicState(graph).homeJointValues, ...state.homeJointValues },
                jointValues: { ...createHomeKinematicState(graph).jointValues, ...state.jointValues },
              },
            },
          };
        }),
      });
      setIssues(validateProject(nextDocument));
      return nextDocument;
    });
    markWorkspaceNodesPending([nodeId]);
    setStatus(nextStatus);
  };

  const setKinematicJointValueForNode = (nodeId: string, jointId: string, value: number) => {
    setDemoMotionNodeId((current) => (current === nodeId ? undefined : current));
    setDocument((current) =>
      touch({
        ...current,
        selectedNodeId: nodeId,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId || node.geometry.kind !== 'imported-model') return node;
          const graph = graphFromImportedGeometry(node.geometry);
          return {
            ...node,
            geometry: {
              ...node.geometry,
              kinematicGraph: graph,
              kinematicState: setJointValue(graph, node.geometry.kinematicState, jointId, value),
            },
          };
        }),
      }),
    );
    setStatus('Joint test updated');
  };

  const resetKinematicPoseForNode = (nodeId: string) => {
    setDemoMotionNodeId((current) => (current === nodeId ? undefined : current));
    setDocument((current) =>
      touch({
        ...current,
        selectedNodeId: nodeId,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId || node.geometry.kind !== 'imported-model') return node;
          const graph = graphFromImportedGeometry(node.geometry);
          return {
            ...node,
            geometry: {
              ...node.geometry,
              kinematicGraph: graph,
              kinematicState: resetKinematicState(graph, node.geometry.kinematicState),
            },
          };
        }),
      }),
    );
    markWorkspaceNodesPending([nodeId]);
    setStatus('Kinematic pose reset');
  };

  const updateKinematicJointForNode = (nodeId: string, jointId: string, patch: Partial<KinematicJoint>) => {
    updateKinematicGraphForNode(nodeId, (graph) => updateJoint(graph, jointId, patch), 'Kinematic joint updated');
  };

  const startKinematicEditForNode = (nodeId: string, jointId: string, mode: KinematicEditTarget['mode']) => {
    const node = document.nodes.find((item) => item.id === nodeId);
    if (!node || node.geometry.kind !== 'imported-model') return;
    const joint = graphFromImportedGeometry(node.geometry).joints.find((item) => item.id === jointId);
    if (!joint) return;
    setTool('select');
    setKinematicEditTarget({
      nodeId,
      jointId,
      mode,
      origin: joint.origin.position,
      axis: joint.axis,
      axisPointA: mode === 'pick-axis-b' ? kinematicEditTarget?.axisPointA : undefined,
    });
    setStatus(mode === 'pick-origin' ? 'Pick joint origin in viewport' : mode === 'axis-gizmo' ? 'Drag axis gizmo in viewport' : 'Pick axis point in viewport');
  };

  const handleKinematicPointPick = (event: KinematicPointPickEvent) => {
    if (event.mode === 'pick-origin') {
      updateKinematicGraphForNode(
        event.nodeId,
        (graph) =>
          updateJoint(graph, event.jointId, {
            origin: { position: event.point, rotation: [0, 0, 0, 1] },
            evidence: [
              ...(graph.joints.find((joint) => joint.id === event.jointId)?.evidence ?? []),
              { type: 'manual', score: 1, message: `Joint origin picked on ${event.objectName ?? 'model surface'}.` },
            ],
          }),
        'Joint origin picked',
      );
      setKinematicEditTarget(undefined);
      return;
    }

    if (event.mode === 'pick-axis-a') {
      setKinematicEditTarget((current) =>
        current && current.nodeId === event.nodeId && current.jointId === event.jointId
          ? { ...current, mode: 'pick-axis-b', axisPointA: event.point }
          : undefined,
      );
      setStatus('Pick second axis point');
      return;
    }

    const pointA = kinematicEditTarget?.axisPointA;
    if (!pointA) {
      setStatus('Pick first axis point before B');
      return;
    }
    const axis = normalizeAxis([event.point[0] - pointA[0], event.point[1] - pointA[1], event.point[2] - pointA[2]]);
    if (!axis) {
      setStatus('Axis points are too close');
      return;
    }
    updateKinematicGraphForNode(
      event.nodeId,
      (graph) =>
        updateJoint(graph, event.jointId, {
          axis,
          evidence: [
            ...(graph.joints.find((joint) => joint.id === event.jointId)?.evidence ?? []),
            { type: 'manual', score: 1, message: 'Axis calculated from two picked points.' },
          ],
        }),
      'Two-point axis applied',
    );
    setKinematicEditTarget(undefined);
  };

  const handleKinematicAxisChange = (event: KinematicAxisChangeEvent) => {
    updateKinematicGraphForNode(
      event.nodeId,
      (graph) => updateJoint(graph, event.jointId, { axis: event.axis }),
      'Axis gizmo adjusted',
    );
  };

  const acceptKinematicJointForNode = (nodeId: string, jointId: string) => {
    updateKinematicGraphForNode(nodeId, (graph) => acceptJointCandidate(graph, jointId), 'Kinematic joint accepted');
  };

  const rejectKinematicJointForNode = (nodeId: string, jointId: string) => {
    updateKinematicGraphForNode(nodeId, (graph) => rejectJointCandidate(graph, jointId), 'Kinematic joint rejected');
  };

  const deleteKinematicJointForNode = (nodeId: string, jointId: string) => {
    updateKinematicGraphForNode(nodeId, (graph) => removeJoint(graph, jointId), 'Kinematic joint deleted');
  };

  const createKinematicJointForNode = (nodeId: string, selectedObjectNames: string[]) => {
    const cleanSelection = [...new Set(selectedObjectNames)].slice(0, 2);
    updateKinematicGraphForNode(
      nodeId,
      (graph) => {
        const nextParts = [...graph.parts];
        const rootBounds = graph.parts.find((part) => part.id === graph.rootPartId)?.bounds;
        const ensurePart = (objectName: string): MechanicalPart => {
          const existing = nextParts.find((part) => part.meshObjectIds.includes(objectName));
          if (existing) return existing;
          const part: MechanicalPart = {
            id: `part_manual_${objectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}_${crypto.randomUUID().slice(0, 6)}`,
            name: cleanPartToken(objectName),
            meshObjectIds: [objectName],
            localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            bounds:
              rootBounds ?? {
                min: [0, 0, 0],
                max: [1, 1, 1],
                size: [1, 1, 1],
                center: [0, 0, 0],
              },
            static: false,
            visible: true,
            source: 'manual-group',
            metadata: { objectName, authoringSource: 'selected-parts' },
          };
          nextParts.push(part);
          return part;
        };
        const parent = cleanSelection[0] ? ensurePart(cleanSelection[0]) : graph.parts.find((part) => part.id === graph.rootPartId);
        const child = cleanSelection[1] ? ensurePart(cleanSelection[1]) : nextParts.find((part) => part.id !== parent?.id && !part.static);
        if (!parent || !child || parent.id === child.id) return { ...graph, parts: nextParts };
        const jointId = `joint_manual_${crypto.randomUUID().slice(0, 8)}`;
        const joint: KinematicJoint = {
          id: jointId,
          name: `Joint ${cleanPartToken(parent.name)} to ${cleanPartToken(child.name)}`,
          parentPartId: parent.id,
          childPartId: child.id,
          type: 'revolute',
          origin: { position: rootBounds?.center ?? [0, 0, 0], rotation: [0, 0, 0, 1] },
          axis: [0, 0, 1],
          limits: { lower: -Math.PI / 2, upper: Math.PI / 2 },
          source: 'manual',
          confidence: 1,
          evidence: [{ type: 'manual', score: 1, message: 'Created in Kinematic Authoring from selected parts.' }],
          status: 'candidate',
        };
        return createJoint({ ...graph, parts: nextParts }, joint);
      },
      'Kinematic joint candidate created',
    );
  };

  const resetImportedJointPose = () => {
    setDemoMotionNodeId(undefined);
    setMotionTrainer(undefined);
    setSelectedParts([]);
    setTool('select');
    setPartEditMode('free');
    updateSelectedNode(
      (node) => {
        if (node.geometry.kind !== 'imported-model') return node;
        return {
          ...node,
          transform: {
            ...node.transform,
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          geometry: {
            ...node.geometry,
            joints: node.geometry.joints.map((joint) => ({
              ...joint,
              rotation: [0, 0, 0],
              translation: [0, 0, 0],
            })),
            freePartTransforms: [],
            partMaterials: [],
            kinematicState: node.geometry.kinematicGraph ? resetKinematicState(node.geometry.kinematicGraph, node.geometry.kinematicState) : undefined,
          },
        };
      },
      'Factory state restored',
    );
  };

  const normalizeImportedModel = () => {
    updateSelectedNode(
      (node) => {
        if (node.geometry.kind !== 'imported-model') return node;
        const bounds = node.geometry.originalBounds;
        const maxDimension = Math.max(bounds[0], bounds[1], bounds[2], 0.0001);
        const importScale = 3 / maxDimension;
        const normalizedBounds: [number, number, number] = [bounds[0] * importScale, bounds[1] * importScale, bounds[2] * importScale];

        return {
          ...node,
          transform: {
            ...node.transform,
            position: [0, 0, 0],
            scale: [1, 1, 1],
          },
          geometry: {
            ...node.geometry,
            importScale,
            normalizedBounds,
          },
        };
      },
      'Imported model fitted to scene',
    );
  };

  const toggleImportedMotionDemo = () => {
    if (!selectedNode || selectedNode.geometry.kind !== 'imported-model' || !selectedNode.geometry.joints.length) return;
    setDemoMotionNodeId((current) => (current === selectedNode.id ? undefined : selectedNode.id));
    setStatus(demoMotionNodeId === selectedNode.id ? 'Motion demo stopped' : 'Motion demo started');
  };

  const randomizeGenerator = () => {
    if (!selectedNode || !('generatorId' in selectedNode.geometry)) return;
    setGeometryValue('seed', Math.floor(Math.random() * 999999));
  };

  const validationCounts = {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Hammer size={19} />
          <span>3D Asset Forge</span>
        </div>

        <div className="toolbar-group">
          <button title="New project" onClick={() => commit(makeStarterProject(), 'New project')}>
            <Play size={18} />
          </button>
          <button title="Open project" onClick={openNativeProject}>
            <FolderOpen size={18} />
          </button>
          <button title="Save project" onClick={save}>
            <Save size={18} />
          </button>
          <button title="Restore autosave" disabled={!autosaveAvailable} onClick={restoreAutosave}>
            <FolderOpen size={18} />
          </button>
          <input ref={fileInputRef} type="file" accept=".json,.forge.json" hidden onChange={openProjectFile} />
        </div>

        <div className="toolbar-group segmented">
          <button className={activeView === 'workspace' ? 'active' : ''} title="Workspace" onClick={() => setActiveView('workspace')}>
            <Focus size={17} />
          </button>
          <button className={activeView === 'warehouse' ? 'active' : ''} title="Warehouse dashboard" onClick={() => setActiveView('warehouse')}>
            <Grid3X3 size={17} />
          </button>
        </div>

        <div className="toolbar-group">
          <button title="Undo" disabled={!past.length} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button title="Redo" disabled={!future.length} onClick={redo}>
            <Redo2 size={18} />
          </button>
        </div>

        <div className="toolbar-group segmented">
          <button className={tool === 'select' ? 'active' : ''} title="Select" onClick={() => setTool('select')}>
            <Square size={17} />
          </button>
          <button className={tool === 'translate' || (tool === 'parts' && partEditMode === 'translate') ? 'active' : ''} title="Move" onClick={() => activateTransformTool('translate')}>
            <Move3D size={18} />
          </button>
          <button className={tool === 'rotate' || (tool === 'parts' && partEditMode === 'rotate') ? 'active' : ''} title="Rotate" onClick={() => activateTransformTool('rotate')}>
            <RotateCw size={18} />
          </button>
          <button className={tool === 'scale' || (tool === 'parts' && partEditMode === 'scale') ? 'active' : ''} title="Scale" onClick={() => activateTransformTool('scale')}>
            <Scaling size={18} />
          </button>
          <button className={tool === 'parts' ? 'active' : ''} title="Parts" onClick={togglePartsTool}>
            <Cuboid size={18} />
          </button>
        </div>

        <div className="toolbar-group">
          <button title="Duplicate selected object" disabled={!selectedNode} onClick={duplicateSelected}>
            <Copy size={17} />
          </button>
          <button title={selectedNode?.visible ? 'Hide selected object' : 'Show selected object'} disabled={!selectedNode} onClick={toggleSelectedVisibility}>
            {selectedNode?.visible ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
          <button title={selectedNode?.locked ? 'Unlock selected object' : 'Lock selected object'} disabled={!selectedNode} onClick={toggleSelectedLock}>
            {selectedNode?.locked ? <Lock size={17} /> : <Unlock size={17} />}
          </button>
          <button className={snapEnabled ? 'active' : ''} title="Toggle snapping" onClick={() => setSnapEnabled((value) => !value)}>
            <Magnet size={17} />
          </button>
          <button
            title="Dismantle selected model into warehouse"
            disabled={!selectedNode || selectedNode.geometry.kind !== 'imported-model' || !selectedNode.geometry.joints.length}
            onClick={() => storePartsInWarehouse('all')}
          >
            <Cuboid size={17} />
          </button>
          <button title="Import saved warehouse object to workspace" onClick={importFirstPermanentWarehouseObject}>
            <Import size={17} />
          </button>
          <button
            className={pendingWorkspaceNodeIds.length ? 'active' : ''}
            title="Save workspace changes permanently"
            disabled={!pendingWorkspaceNodeIds.length}
            onClick={savePendingWorkspaceChanges}
          >
            <Save size={17} />
            <span>{pendingWorkspaceNodeIds.length}</span>
          </button>
          <button title="Save selected object as project warehouse GLB" disabled={!selectedNode} onClick={() => selectedNode && saveWorkspaceItemPermanent(selectedNode.id)}>
            <Save size={17} />
          </button>
          <button title="Delete selected object permanently" disabled={!selectedNode} onClick={() => selectedNode && deleteWorkspaceObjectPermanent(selectedNode.id)}>
            <Trash2 size={17} />
          </button>
          <button title="Restore imported model factory state" disabled={!selectedNode || selectedNode.geometry.kind !== 'imported-model'} onClick={resetImportedJointPose}>
            <RotateCw size={17} />
          </button>
        </div>

        <div className="toolbar-group push-right">
          <button title="Validate" onClick={validate}>
            <ShieldCheck size={18} />
            <span>Validate</span>
          </button>
          <button title="Export GLB" className="primary" onClick={exportGlb}>
            <Download size={18} />
            <span>Export GLB</span>
          </button>
        </div>
      </header>

      {activeView === 'workspace' ? (
      <section className="workbench" onClick={() => setWorkspaceMenu(undefined)}>
        <aside className="left-panel panel">
          <section>
            <h2>Scene</h2>
            <div className="scene-list">
              {document.nodes.map((node) => (
                <button
                  key={node.id}
                  className={node.id === document.selectedNodeId ? 'scene-item selected' : 'scene-item'}
                  onClick={() => selectNode(node.id)}
                >
                  <Cuboid size={16} />
                  <span>{node.name}</span>
                  <small>{selectedName(node.geometry)}</small>
                  <span className="scene-flags">
                    {!node.visible && <EyeOff size={13} />}
                    {node.locked && <Lock size={13} />}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2>Primitives</h2>
            <div className="library-grid">
              <button onClick={() => addNode(createBoxNode(), 'Box added')}>
                <Box size={18} />
                <span>Box</span>
              </button>
              <button onClick={() => addNode(createSphereNode(), 'Sphere added')}>
                <Circle size={18} />
                <span>Sphere</span>
              </button>
              <button onClick={() => addNode(createCylinderNode(), 'Cylinder added')}>
                <Grid3X3 size={18} />
                <span>Cylinder</span>
              </button>
              <button onClick={() => addNode(createPlaneNode(), 'Plane added')}>
                <Square size={18} />
                <span>Plane</span>
              </button>
            </div>
          </section>

          <section>
            <h2>Import</h2>
            <button className="wide-action" onClick={() => glbInputRef.current?.click()}>
              <Import size={18} />
              <span>3D Model</span>
            </button>
            <input
              ref={glbInputRef}
              type="file"
              accept=".glb,.fbx,.dae,.obj,.3ds,.blend,.c4d,.max,.sldprt,.sldasm,model/gltf-binary"
              hidden
              onChange={importModelFile}
            />
          </section>

          <section>
            <h2>Saved Objects</h2>
            <div className="saved-object-actions">
              <button title="Load saved project warehouse objects" onClick={loadPermanentWarehouseIntoProject}>
                <FolderOpen size={16} />
                <span>Load Saved</span>
              </button>
              <button title="Import all visible warehouse objects to workspace" disabled={!(document.partWarehouse?.length)} onClick={addAllWarehouseItemsToScene}>
                <Import size={16} />
                <span>Import All</span>
              </button>
            </div>
            <div className="saved-object-list">
              {(document.partWarehouse ?? []).slice(0, 12).map((item) => (
                <button key={`workspace-${item.id}`} className="saved-object-item" title={`Import ${item.name}`} onClick={() => addWarehouseItemToScene(item)}>
                  {item.thumbnailDataUrl ? <img src={item.thumbnailDataUrl} alt="" /> : <Cuboid size={18} />}
                  <span>{item.name}</span>
                  <small>{functionalWarehouseSummary(item)}</small>
                </button>
              ))}
              {!(document.partWarehouse?.length) && <div className="empty-state compact">No saved objects loaded.</div>}
            </div>
          </section>

          <section>
            <h2>Generators</h2>
            <div className="generator-list">
              {generatorDefinitions.map((generator) => (
                <button key={generator.id} className="generator-item" onClick={() => addNode(createGeneratorNode(generator.id), `${generator.name} generated`)}>
                  <Sparkles size={18} />
                  <span>{generator.name}</span>
                  <small>{generator.description}</small>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <ThreeViewport
          document={document}
          tool={tool}
          partEditMode={partEditMode}
          snapEnabled={snapEnabled}
          kinematicEditTarget={activeKinematicEditTarget}
          motionDemoNodeId={demoMotionNodeId}
          motionTrainingPreview={motionTrainingPreview}
          onSelect={selectNode}
          onTransformCommit={updateNodeTransform}
          onImportedPartTransformsCommit={updateImportedPartTransforms}
          onJointPoseChange={setImportedJointMotionForNode}
          onKinematicPointPick={handleKinematicPointPick}
          onKinematicAxisChange={handleKinematicAxisChange}
          onPartSelectionChange={updatePartSelectionStatus}
          onNodeContextMenu={({ nodeId, x, y }) => setWorkspaceMenu({ nodeId, x, y })}
          onStatsChange={setStats}
        />

        <aside className="right-panel panel">
          <div className="inspector-head">
            <div>
              <h2>Inspector</h2>
              <p>{selectedNode ? selectedNode.name : 'No selection'}</p>
            </div>
            <button title="Delete selected object" disabled={!selectedNode} onClick={removeSelected}>
              <Trash2 size={17} />
            </button>
          </div>

          {selectedNode ? (
            <>
              <section>
                <h3>Transform</h3>
                <VectorEditor label="Position" values={selectedNode.transform.position} onChange={(index, value) => setTransformValue('position', index, value)} />
                <VectorEditor label="Rotation" values={selectedNode.transform.rotation} step={0.05} onChange={(index, value) => setTransformValue('rotation', index, value)} />
                <VectorEditor label="Scale" values={selectedNode.transform.scale} step={0.05} onChange={(index, value) => setTransformValue('scale', index, value)} />
              </section>

              <section>
                <h3>Material</h3>
                <label className="field-row">
                  <span>Preset</span>
                  <select value={selectedNode.material.name} onChange={(event) => applyMaterialPreset(event.target.value)}>
                    {materialPresets.map((preset) => (
                      <option key={preset.name} value={preset.name}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="material-presets">
                  {materialPresets.map((preset) => (
                    <button
                      key={preset.name}
                      title={preset.name}
                      className={selectedNode.material.name === preset.name ? 'swatch active' : 'swatch'}
                      style={{ backgroundColor: preset.color }}
                      onClick={() => applyMaterialPreset(preset.name)}
                    >
                      <Palette size={14} />
                    </button>
                  ))}
                </div>
                <label className="field-row">
                  <span>Color</span>
                  <input type="color" value={selectedNode.material.color} onChange={(event) => setMaterialValue('color', event.target.value)} />
                </label>
                <Slider label="Roughness" value={selectedNode.material.roughness} min={0} max={1} step={0.01} onChange={(value) => setMaterialValue('roughness', value)} />
                <Slider label="Metalness" value={selectedNode.material.metalness} min={0} max={1} step={0.01} onChange={(value) => setMaterialValue('metalness', value)} />
              </section>

              {selectedNode.geometry.kind === 'imported-model' && (
                <section>
                  <div className="section-title-row">
                    <h3>Parts Editor</h3>
                    <span className="part-selection-count">{selectedPartsForSelectedNode.length} selected</span>
                  </div>
                  <div className="part-mode-controls">
                    <button className={tool === 'parts' && partEditMode === 'free' ? 'active' : ''} title="Free part drag" onClick={() => {
                      if (tool === 'parts' && partEditMode === 'free') {
                        setTool('select');
                        setStatus('Parts mode cleared');
                        return;
                      }
                      setTool('parts');
                      setPartEditMode('free');
                    }}>
                      <Cuboid size={16} />
                    </button>
                    <button className={tool === 'parts' && partEditMode === 'translate' ? 'active' : ''} title="Part move" onClick={() => {
                      setTool('parts');
                      setPartEditMode('translate');
                    }}>
                      <Move3D size={16} />
                    </button>
                    <button className={tool === 'parts' && partEditMode === 'rotate' ? 'active' : ''} title="Part rotate" onClick={() => {
                      setTool('parts');
                      setPartEditMode('rotate');
                    }}>
                      <RotateCw size={16} />
                    </button>
                    <button className={tool === 'parts' && partEditMode === 'scale' ? 'active' : ''} title="Part scale" onClick={() => {
                      setTool('parts');
                      setPartEditMode('scale');
                    }}>
                      <Scaling size={16} />
                    </button>
                  </div>
                  <div className="material-presets expanded">
                    {materialPresets.map((preset) => (
                      <button
                        key={`part-${preset.name}`}
                        title={`Apply ${preset.name} to selected parts`}
                        className="swatch"
                        disabled={!selectedPartsForSelectedNode.length}
                        style={{ backgroundColor: preset.color }}
                        onClick={() => updateSelectedPartColor(preset.color)}
                      >
                        <Palette size={14} />
                      </button>
                    ))}
                  </div>
                  <label className="field-row">
                    <span>Part color</span>
                    <input type="color" disabled={!selectedPartsForSelectedNode.length} onChange={(event) => updateSelectedPartColor(event.target.value)} />
                  </label>
                  <div className="part-store-actions">
                    <button title="Store selected parts" disabled={!selectedPartsForSelectedNode.length} onClick={() => storePartsInWarehouse('selected')}>
                      <Save size={16} />
                      <span>Store Selected</span>
                    </button>
                    <button
                      title="Update selected warehouse part from current scene piece"
                      disabled={!selectedWarehouseItem || selectedWarehouseItem.itemType !== 'part' || !selectedNode}
                      onClick={() => updateWarehouseItemFromSelection(false)}
                    >
                      <Save size={16} />
                      <span>Update Stored</span>
                    </button>
                    <button
                      title="Save modified scene piece as new warehouse part"
                      disabled={!selectedWarehouseItem || selectedWarehouseItem.itemType !== 'part' || !selectedNode}
                      onClick={() => updateWarehouseItemFromSelection(true)}
                    >
                      <Copy size={16} />
                      <span>Save Copy</span>
                    </button>
                    <button title="Dismantle detected model parts into warehouse" disabled={!selectedNode.geometry.joints.length} onClick={() => storePartsInWarehouse('all')}>
                      <Cuboid size={16} />
                      <span>Dismantle Model</span>
                    </button>
                  </div>
                </section>
              )}

              {selectedNode.geometry.kind === 'serialized-object' && (
                <section>
                  <div className="section-title-row">
                    <h3>Stored Part</h3>
                    <span className="part-selection-count">Warehouse object</span>
                  </div>
                  <div className="part-store-actions">
                    <button
                      title="Update selected warehouse part from current scene piece"
                      disabled={!selectedWarehouseItem || selectedWarehouseItem.itemType !== 'part'}
                      onClick={() => updateWarehouseItemFromSelection(false)}
                    >
                      <Save size={16} />
                      <span>Update Stored</span>
                    </button>
                    <button
                      title="Save modified scene piece as new warehouse part"
                      disabled={!selectedWarehouseItem || selectedWarehouseItem.itemType !== 'part'}
                      onClick={() => updateWarehouseItemFromSelection(true)}
                    >
                      <Copy size={16} />
                      <span>Save Copy</span>
                    </button>
                  </div>
                </section>
              )}

              <GeometryInspector
                node={selectedNode}
                setGeometryValue={setGeometryValue}
                setImportedJointMotion={setImportedJointMotion}
                resetImportedJointPose={resetImportedJointPose}
                normalizeImportedModel={normalizeImportedModel}
                demoActive={demoMotionNodeId === selectedNode.id}
                toggleImportedMotionDemo={toggleImportedMotionDemo}
                trainingCandidate={currentMotionCandidate?.nodeId === selectedNode.id ? currentMotionCandidate : undefined}
                trainingProgress={currentMotionCandidate?.nodeId === selectedNode.id ? trainingProgress : undefined}
                startMotionTrainer={startMotionTrainer}
                acceptMotionTest={acceptMotionTest}
                rejectMotionTest={rejectMotionTest}
                stopMotionTrainer={stopMotionTrainer}
                moveValidatedMotion={moveValidatedMotion}
                removeValidatedMotion={removeValidatedMotion}
                selectedPartNames={selectedPartsForSelectedNode.map((part) => part.objectName)}
                setKinematicJointValue={setKinematicJointValueForNode}
                resetKinematicPose={resetKinematicPoseForNode}
                updateKinematicJoint={updateKinematicJointForNode}
                startKinematicEdit={startKinematicEditForNode}
                acceptKinematicJoint={acceptKinematicJointForNode}
                rejectKinematicJoint={rejectKinematicJointForNode}
                deleteKinematicJoint={deleteKinematicJointForNode}
                createKinematicJoint={createKinematicJointForNode}
                randomizeGenerator={randomizeGenerator}
              />
            </>
          ) : (
            <div className="empty-state">Select an object in the viewport or scene tree.</div>
          )}

          <section>
            <div className="section-title-row">
              <h3>Export Center</h3>
              <button title="Run preflight" onClick={runPreflight}>
                <ShieldCheck size={16} />
              </button>
            </div>

            <label className="field-row">
              <span>Preset</span>
              <select value={exportProfileId} onChange={(event) => setExportProfileId(event.target.value as ExportProfileId)}>
                {exportProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="export-profile-card">
              <strong>{getExportProfile(exportProfileId).engine}</strong>
              <span>{getExportProfile(exportProfileId).notes.join(' | ')}</span>
            </div>

            <div className="export-actions">
              <button title="Render preview" onClick={renderPreview}>
                <Eye size={16} />
                <span>Preview</span>
              </button>
              <button title="Export GLB" className="primary" onClick={exportGlb}>
                <Download size={16} />
                <span>GLB</span>
              </button>
              {exportReport && (
                <button
                  title="Download last report"
                  onClick={async () => {
                    const reportName = exportReport.fileName.replace(/\.glb$/, '.export-report.json');
                    if (desktopRuntime) {
                      await saveJsonNative(exportReport, reportName);
                    } else {
                      exportJsonReport(exportReport, reportName);
                    }
                  }}
                >
                  <FileJson size={16} />
                </button>
              )}
            </div>

            {previewUrl && (
              <button className="preview-frame" title="Save preview PNG" onClick={savePreview}>
                <img src={previewUrl} alt="Export preview" />
              </button>
            )}

            {exportReport && (
              <div className={`export-report ${exportReport.status}`}>
                <strong>{exportReport.status.toUpperCase()}</strong>
                <span>{exportReport.fileSizeKb} KB</span>
                <span>{exportReport.triangleEstimate.toLocaleString()} tris</span>
                <span>{exportReport.visibleObjects} visible</span>
              </div>
            )}
          </section>
        </aside>
      </section>
      ) : (

      <section className="warehouse-dashboard" onClick={() => setWarehouseMenu(undefined)}>
        <div className="warehouse-dashboard-head">
          <div>
            <h2>Parts Warehouse</h2>
            <p>
              {document.partWarehouse?.length ?? 0} visible items | {warehouseStorageInfo.items} saved | {formatGigabytes(warehouseStorageInfo.usageBytes)}
              {warehouseStorageInfo.quotaBytes ? ` / ${formatGigabytes(warehouseStorageInfo.quotaBytes)}` : ''}
            </p>
            <div className="warehouse-storage-ledger">
              {warehouseStorageInfo.savedItems.length ? (
                warehouseStorageInfo.savedItems.map((item, index) => (
                  <span key={`${item.name}-${item.savedAt}-${index}`}>
                    {item.name} | {item.itemType} | {formatGigabytes(item.sizeBytes)}
                  </span>
                ))
              ) : (
                <span>No permanent objects saved for this project</span>
              )}
            </div>
          </div>
          <div className="warehouse-dashboard-actions">
            <button title="Send selected warehouse item to scene" disabled={!selectedWarehouseItem} onClick={() => selectedWarehouseItem && addWarehouseItemToScene(selectedWarehouseItem)}>
              <Import size={16} />
              <span>To Scene</span>
            </button>
            <button title="Delete selected warehouse item" disabled={!selectedWarehouseItem} onClick={() => selectedWarehouseItem && deleteWarehouseItem(selectedWarehouseItem.id)}>
              <Trash2 size={16} />
              <span>Delete</span>
            </button>
            <button title="Save selected item permanently in this project warehouse" disabled={!selectedWarehouseItem} onClick={saveSelectedWarehousePermanent}>
              <Save size={16} />
              <span>Save Item</span>
            </button>
            <button title="Save all new warehouse items permanently in this project warehouse" disabled={!(document.partWarehouse?.length)} onClick={saveAllWarehousePermanent}>
              <ShieldCheck size={16} />
              <span>Save All</span>
            </button>
            <button title="Load permanent project warehouse objects" onClick={loadPermanentWarehouseIntoProject}>
              <FolderOpen size={16} />
              <span>Load Saved</span>
            </button>
            <button
              title="Save current scene imported parts separately"
              disabled={!document.nodes.some((node) => node.geometry.kind === 'imported-model' || node.geometry.kind === 'serialized-object')}
              onClick={storeScenePartsSeparately}
            >
              <Save size={16} />
              <span>Store Scene Parts</span>
            </button>
            <button
              title="Save scene imported parts as composite assembly"
              disabled={document.nodes.filter((node) => node.geometry.kind === 'imported-model' || node.geometry.kind === 'serialized-object').length < 2}
              onClick={storeSceneAssembly}
            >
              <Copy size={16} />
              <span>Store Assembly</span>
            </button>
            <button title="Export warehouse project" disabled={!(document.partWarehouse?.length)} onClick={exportWarehouseProject}>
              <Download size={16} />
              <span>Export Warehouse</span>
            </button>
            <button title="Import warehouse project" onClick={() => warehouseInputRef.current?.click()}>
              <FolderOpen size={16} />
              <span>Import Warehouse</span>
            </button>
            <input ref={warehouseInputRef} type="file" accept=".json,.warehouse.json" hidden onChange={importWarehouseProject} />
          </div>
        </div>

        <div className="warehouse-dashboard-body">
          {warehouseGroups.length ? (
            warehouseGroups.map((group) => (
              <div key={group.category} className="warehouse-rack">
                <div className="warehouse-rack-title">
                  <strong>{group.category}</strong>
                  <span>{group.classes.reduce((total, partClass) => total + partClass.items.length, 0)} items</span>
                </div>
                <div className="warehouse-rack-classes">
                  {group.classes.map((partClass) => (
                    <div key={`${group.category}-${partClass.className}`} className="warehouse-class-column">
                      <div className="warehouse-class-label">
                        <span>{partClass.className}</span>
                        <small>{partClass.items.length}</small>
                      </div>
                      <div className="warehouse-bin-grid dashboard">
                        {partClass.items.map((item) => (
                          <button
                            key={item.id}
                            className={item.id === document.selectedWarehouseItemId ? 'warehouse-bin selected' : 'warehouse-bin'}
                            title={`${item.code} - ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectWarehouseItem(item.id);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              selectWarehouseItem(item.id);
                              setWarehouseMenu({ itemId: item.id, x: event.clientX, y: event.clientY });
                            }}
                            onDoubleClick={() => addWarehouseItemToScene(item)}
                          >
                            {item.thumbnailDataUrl ? (
                              <img src={item.thumbnailDataUrl} alt="" />
                            ) : (
                              <Cuboid size={28} />
                            )}
                            <small>{item.code}</small>
                            <span>{item.name}</span>
                            <em>{functionalWarehouseSummary(item)}</em>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="warehouse-empty-dashboard">No stored parts yet.</div>
          )}
        </div>
      </section>
      )}

      {warehouseMenu && (
        <div className="warehouse-context-menu" style={{ left: warehouseMenu.x, top: warehouseMenu.y }} onClick={(event) => event.stopPropagation()}>
          {(() => {
            const item = document.partWarehouse?.find((entry) => entry.id === warehouseMenu.itemId);
            if (!item) return null;
            return (
              <>
                <button onClick={() => addWarehouseItemToScene(item)}>
                  <Import size={15} />
                  <span>Send to scene</span>
                </button>
                <button onClick={() => saveWarehouseItemsPermanent([item], 'selected item')}>
                  <Save size={15} />
                  <span>Save permanently</span>
                </button>
                <button onClick={() => deleteWarehouseItem(item.id)}>
                  <Trash2 size={15} />
                  <span>Delete from warehouse</span>
                </button>
              </>
            );
          })()}
        </div>
      )}

      {workspaceMenu && activeView === 'workspace' && (
        <div className="warehouse-context-menu" style={{ left: workspaceMenu.x, top: workspaceMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button onClick={() => saveWorkspaceItemPermanent(workspaceMenu.nodeId)}>
            <Save size={15} />
            <span>Save object to project</span>
          </button>
          <button onClick={saveWorkspaceAssemblyPermanent}>
            <Copy size={15} />
            <span>Save scene set</span>
          </button>
          <button onClick={() => deleteWorkspaceObjectPermanent(workspaceMenu.nodeId)}>
            <Trash2 size={15} />
            <span>Delete permanently</span>
          </button>
        </div>
      )}

      <footer className="statusbar">
        <span>{status}</span>
        <span>{stats.fps} FPS</span>
        <span>{stats.objects} objects</span>
        <span>{stats.triangles} triangles</span>
        <span>{desktopRuntime ? 'desktop' : 'web'}</span>
        <span>{snapEnabled ? 'snap on' : 'snap off'}</span>
        <span>{autosaveAvailable ? 'autosave ready' : 'autosave pending'}</span>
        <span>{validationCounts.errors} errors</span>
        <span>{validationCounts.warnings} warnings</span>
        <span>{document.metadata.name}</span>
      </footer>

      <section className="validation-strip">
        {issues.slice(0, 4).map((issue) => (
          <div key={`${issue.code}-${issue.nodeId ?? 'project'}`} className={`issue ${issue.severity}`}>
            <strong>{issue.code}</strong>
            <span>{issue.message}</span>
          </div>
        ))}
      </section>
    </main>
  );
};

type VectorEditorProps = {
  label: string;
  values: [number, number, number];
  step?: number;
  onChange: (index: number, value: number) => void;
};

const VectorEditor = ({ label, values, step = 0.1, onChange }: VectorEditorProps) => (
  <div className="vector-editor">
    <span>{label}</span>
    {values.map((value, index) => (
      <input
        key={index}
        type="number"
        value={Number(value.toFixed(3))}
        step={step}
        onChange={(event) => onChange(index, Number(event.target.value))}
      />
    ))}
  </div>
);

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

const Slider = ({ label, value, min, max, step, onChange }: SliderProps) => (
  <label className="slider-row">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <strong>{value.toFixed(2)}</strong>
  </label>
);

const formatVector = (values: number[] | undefined, digits = 3) => (values?.map((value) => Number(value).toFixed(digits)).join(', ') ?? 'n/a');

type KinematicGraphPanelProps = {
  node: SceneNode;
  selectedPartNames: string[];
  setKinematicJointValue: (nodeId: string, jointId: string, value: number) => void;
  resetKinematicPose: (nodeId: string) => void;
  updateKinematicJoint: (nodeId: string, jointId: string, patch: Partial<KinematicJoint>) => void;
  startKinematicEdit: (nodeId: string, jointId: string, mode: KinematicEditTarget['mode']) => void;
  acceptKinematicJoint: (nodeId: string, jointId: string) => void;
  rejectKinematicJoint: (nodeId: string, jointId: string) => void;
  deleteKinematicJoint: (nodeId: string, jointId: string) => void;
  createKinematicJoint: (nodeId: string, selectedPartNames: string[]) => void;
};

const KinematicGraphPanel = ({
  node,
  selectedPartNames,
  setKinematicJointValue,
  resetKinematicPose,
  updateKinematicJoint,
  startKinematicEdit,
  acceptKinematicJoint,
  rejectKinematicJoint,
  deleteKinematicJoint,
  createKinematicJoint,
}: KinematicGraphPanelProps) => {
  const geometry = node.geometry as ImportedModelGeometry;
  const graph = graphFromImportedGeometry(geometry);
  const partById = new Map(graph.parts.map((part) => [part.id, part]));
  const validatedCount = graph.joints.filter((joint) => joint.status === 'validated').length;
  const movableParts = graph.parts.filter((part) => !part.static).length;
  const validationIssues = validateKinematicGraph(graph);
  const issueByJoint = new Map<string, string[]>();
  validationIssues.forEach((issue) => {
    if (!issue.jointId) return;
    issueByJoint.set(issue.jointId, [...(issueByJoint.get(issue.jointId) ?? []), issue.code]);
  });
  const state = geometry.kinematicState ?? createHomeKinematicState(graph);

  const updateAxis = (joint: KinematicJoint, axis: [number, number, number]) => {
    updateKinematicJoint(node.id, joint.id, { axis });
  };

  const updateOrigin = (joint: KinematicJoint, position: [number, number, number]) => {
    updateKinematicJoint(node.id, joint.id, { origin: { ...joint.origin, position } });
  };

  const sliderRange = (joint: KinematicJoint) => {
    if (joint.type === 'prismatic') return { min: joint.limits?.lower ?? -1, max: joint.limits?.upper ?? 1, step: 0.01 };
    if (joint.type === 'continuous') return { min: -Math.PI * 2, max: Math.PI * 2, step: 0.01 };
    return { min: joint.limits?.lower ?? -Math.PI, max: joint.limits?.upper ?? Math.PI, step: 0.01 };
  };

  return (
    <div className="kinematic-graph-panel">
      <div className="section-title-row">
        <h4>Kinematic Authoring</h4>
        <span>Kinematic Graph | {graph.joints.length} joints</span>
      </div>
      <div className="graph-readiness">
        <span>Parts {graph.parts.length}</span>
        <span>Movable {movableParts}</span>
        <span>Validated {validatedCount}</span>
      </div>
      <div className="kinematic-authoring-actions">
        <button title="Create joint from selected parts" disabled={selectedPartNames.length < 2} onClick={() => createKinematicJoint(node.id, selectedPartNames)}>
          <Hammer size={14} />
          <span>Create Joint</span>
        </button>
        <button title="Reset all joint tests to home" onClick={() => resetKinematicPose(node.id)}>
          <RotateCw size={14} />
          <span>Home</span>
        </button>
      </div>
      {validationIssues.length ? (
        <div className="kinematic-validation-summary">
          {validationIssues.slice(0, 3).map((issue) => (
            <span key={`${issue.code}-${issue.jointId ?? issue.partId ?? 'graph'}`}>{issue.code}</span>
          ))}
        </div>
      ) : (
        <div className="kinematic-validation-summary ok">
          <span>VALID GRAPH</span>
        </div>
      )}
      {graph.joints.length ? (
        <div className="kinematic-joint-list">
          {graph.joints.map((joint) => (
            <div key={joint.id} className="kinematic-joint-row">
              <div className="joint-title-line">
                <strong title={joint.name}>{joint.name}</strong>
                <span>{joint.status}</span>
              </div>
              <div className="joint-authoring-grid">
                <label>
                  <span>Parent</span>
                  <select value={joint.parentPartId} onChange={(event) => updateKinematicJoint(node.id, joint.id, { parentPartId: event.target.value })}>
                    {graph.parts.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Child</span>
                  <select value={joint.childPartId} onChange={(event) => updateKinematicJoint(node.id, joint.id, { childPartId: event.target.value })}>
                    {graph.parts.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Type</span>
                  <select value={joint.type} onChange={(event) => updateKinematicJoint(node.id, joint.id, { type: event.target.value as KinematicJoint['type'] })}>
                    {['fixed', 'revolute', 'continuous', 'prismatic'].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="axis-buttons">
                  <button title="Use X axis" onClick={() => updateAxis(joint, [1, 0, 0])}>X</button>
                  <button title="Use Y axis" onClick={() => updateAxis(joint, [0, 1, 0])}>Y</button>
                  <button title="Use Z axis" onClick={() => updateAxis(joint, [0, 0, 1])}>Z</button>
                </div>
              </div>
              <VectorEditor
                label="Axis"
                values={joint.axis}
                step={0.01}
                onChange={(index, value) => {
                  const next: [number, number, number] = [...joint.axis];
                  next[index] = value;
                  updateAxis(joint, next);
                }}
              />
              <VectorEditor
                label="Origin"
                values={joint.origin.position}
                step={0.01}
                onChange={(index, value) => {
                  const next: [number, number, number] = [...joint.origin.position];
                  next[index] = value;
                  updateOrigin(joint, next);
                }}
              />
              <div className="joint-authoring-grid compact">
                <label>
                  <span>Min</span>
                  <input
                    type="number"
                    step={0.01}
                    value={joint.limits?.lower ?? ''}
                    onChange={(event) => updateKinematicJoint(node.id, joint.id, { limits: { ...joint.limits, lower: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  <span>Max</span>
                  <input
                    type="number"
                    step={0.01}
                    value={joint.limits?.upper ?? ''}
                    onChange={(event) => updateKinematicJoint(node.id, joint.id, { limits: { ...joint.limits, upper: Number(event.target.value) } })}
                  />
                </label>
              </div>
              <div className="joint-authoring-grid compact">
                <label>
                  <span>Mimic</span>
                  <select
                    value={joint.coupling?.driverJointId ?? ''}
                    onChange={(event) =>
                      updateKinematicJoint(node.id, joint.id, {
                        coupling: event.target.value
                          ? { driverJointId: event.target.value, multiplier: joint.coupling?.multiplier ?? 1, offset: joint.coupling?.offset ?? 0 }
                          : undefined,
                      })
                    }
                  >
                    <option value="">none</option>
                    {graph.joints
                      .filter((candidate) => candidate.id !== joint.id)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>Multiplier</span>
                  <input
                    type="number"
                    step={0.1}
                    disabled={!joint.coupling}
                    value={joint.coupling?.multiplier ?? 1}
                    onChange={(event) =>
                      joint.coupling &&
                      updateKinematicJoint(node.id, joint.id, { coupling: { ...joint.coupling, multiplier: Number(event.target.value) } })
                    }
                  />
                </label>
                <label>
                  <span>Offset</span>
                  <input
                    type="number"
                    step={0.01}
                    disabled={!joint.coupling}
                    value={joint.coupling?.offset ?? 0}
                    onChange={(event) =>
                      joint.coupling && updateKinematicJoint(node.id, joint.id, { coupling: { ...joint.coupling, offset: Number(event.target.value) } })
                    }
                  />
                </label>
              </div>
              <div className="joint-visual-tools">
                <button title="Pick joint origin on model" onClick={() => startKinematicEdit(node.id, joint.id, 'pick-origin')}>
                  <Circle size={14} />
                  <span>Pick Origin</span>
                </button>
                <button title="Edit axis with viewport gizmo" onClick={() => startKinematicEdit(node.id, joint.id, 'axis-gizmo')}>
                  <Move3D size={14} />
                  <span>Axis Gizmo</span>
                </button>
                <button title="Pick first axis point" onClick={() => startKinematicEdit(node.id, joint.id, 'pick-axis-a')}>
                  <Square size={14} />
                  <span>Axis A</span>
                </button>
                <button title="Pick second axis point" onClick={() => startKinematicEdit(node.id, joint.id, 'pick-axis-b')}>
                  <Square size={14} />
                  <span>Axis B</span>
                </button>
              </div>
              <Slider
                label="Test"
                value={state.jointValues[joint.id] ?? 0}
                {...sliderRange(joint)}
                onChange={(value) => setKinematicJointValue(node.id, joint.id, value)}
              />
              <div className="joint-authoring-actions">
                <button title="Accept joint" onClick={() => acceptKinematicJoint(node.id, joint.id)}>
                  <Check size={14} />
                </button>
                <button title="Reject joint" onClick={() => rejectKinematicJoint(node.id, joint.id)}>
                  <X size={14} />
                </button>
                <button title="Reset test to zero" onClick={() => setKinematicJointValue(node.id, joint.id, 0)}>
                  <RotateCw size={14} />
                </button>
                <button title="Delete joint" onClick={() => deleteKinematicJoint(node.id, joint.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              <dl>
                <dt>Evidence</dt>
                <dd>{joint.evidence.map((item) => item.type).join(', ') || 'none'}</dd>
                <dt>Issues</dt>
                <dd>{issueByJoint.get(joint.id)?.join(', ') ?? 'none'}</dd>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No kinematic joints yet. Select two parts and create a candidate joint.</div>
      )}
    </div>
  );
};

type GeometryInspectorProps = {
  node: SceneNode;
  setGeometryValue: (field: string, value: number) => void;
  setImportedJointMotion: (jointName: string, value: number) => void;
  resetImportedJointPose: () => void;
  normalizeImportedModel: () => void;
  demoActive: boolean;
  toggleImportedMotionDemo: () => void;
  trainingCandidate?: MotionTrainingCandidate;
  trainingProgress?: { current: number; total: number };
  startMotionTrainer: () => void;
  acceptMotionTest: () => void;
  rejectMotionTest: () => void;
  stopMotionTrainer: () => void;
  moveValidatedMotion: (nodeId: string, motionId: string, direction: -1 | 1) => void;
  removeValidatedMotion: (nodeId: string, motionId: string) => void;
  selectedPartNames: string[];
  setKinematicJointValue: (nodeId: string, jointId: string, value: number) => void;
  resetKinematicPose: (nodeId: string) => void;
  updateKinematicJoint: (nodeId: string, jointId: string, patch: Partial<KinematicJoint>) => void;
  startKinematicEdit: (nodeId: string, jointId: string, mode: KinematicEditTarget['mode']) => void;
  acceptKinematicJoint: (nodeId: string, jointId: string) => void;
  rejectKinematicJoint: (nodeId: string, jointId: string) => void;
  deleteKinematicJoint: (nodeId: string, jointId: string) => void;
  createKinematicJoint: (nodeId: string, selectedPartNames: string[]) => void;
  randomizeGenerator: () => void;
};

const GeometryInspector = ({
  node,
  setGeometryValue,
  setImportedJointMotion,
  resetImportedJointPose,
  normalizeImportedModel,
  demoActive,
  toggleImportedMotionDemo,
  trainingCandidate,
  trainingProgress,
  startMotionTrainer,
  acceptMotionTest,
  rejectMotionTest,
  stopMotionTrainer,
  moveValidatedMotion,
  removeValidatedMotion,
  selectedPartNames,
  setKinematicJointValue,
  resetKinematicPose,
  updateKinematicJoint,
  startKinematicEdit,
  acceptKinematicJoint,
  rejectKinematicJoint,
  deleteKinematicJoint,
  createKinematicJoint,
  randomizeGenerator,
}: GeometryInspectorProps) => {
  const geometry = node.geometry;

  if (geometry.kind === 'box') {
    return (
      <section>
        <h3>Geometry</h3>
        <Slider label="Width" value={geometry.width} min={0.1} max={6} step={0.05} onChange={(value) => setGeometryValue('width', value)} />
        <Slider label="Height" value={geometry.height} min={0.1} max={5} step={0.05} onChange={(value) => setGeometryValue('height', value)} />
        <Slider label="Depth" value={geometry.depth} min={0.1} max={6} step={0.05} onChange={(value) => setGeometryValue('depth', value)} />
      </section>
    );
  }

  if (geometry.kind === 'sphere') {
    return (
      <section>
        <h3>Geometry</h3>
        <Slider label="Radius" value={geometry.radius} min={0.1} max={3} step={0.05} onChange={(value) => setGeometryValue('radius', value)} />
        <Slider label="Segments" value={geometry.segments} min={8} max={64} step={1} onChange={(value) => setGeometryValue('segments', value)} />
      </section>
    );
  }

  if (geometry.kind === 'cylinder') {
    return (
      <section>
        <h3>Geometry</h3>
        <Slider label="Radius" value={geometry.radius} min={0.1} max={3} step={0.05} onChange={(value) => setGeometryValue('radius', value)} />
        <Slider label="Height" value={geometry.height} min={0.1} max={5} step={0.05} onChange={(value) => setGeometryValue('height', value)} />
        <Slider label="Segments" value={geometry.segments} min={8} max={64} step={1} onChange={(value) => setGeometryValue('segments', value)} />
      </section>
    );
  }

  if (geometry.kind === 'plane') {
    return (
      <section>
        <h3>Geometry</h3>
        <Slider label="Width" value={geometry.width} min={0.1} max={8} step={0.05} onChange={(value) => setGeometryValue('width', value)} />
        <Slider label="Depth" value={geometry.depth} min={0.1} max={8} step={0.05} onChange={(value) => setGeometryValue('depth', value)} />
      </section>
    );
  }

  if (geometry.kind === 'imported-model') {
    const validatedMotions = [...(geometry.validatedMotions ?? [])].sort((a, b) => a.order - b.order);

    return (
      <section>
        <div className="section-title-row">
          <h3>Imported Model</h3>
          <div className="mini-actions">
            <button title="Factory reset" onClick={resetImportedJointPose}>
              <RotateCw size={16} />
            </button>
            <button title="Fit model to scene" onClick={normalizeImportedModel}>
              <Focus size={16} />
            </button>
          </div>
        </div>
        <div className="imported-summary">
          <span>{geometry.assetName}</span>
          <span>{geometry.sourceFormat.toUpperCase()}</span>
          <span>{geometry.joints.length} joints</span>
          <span>{geometry.animations.length} animations</span>
        </div>
        <div className="bounds-summary">
          <span>Original {(geometry.originalBounds ?? [0, 0, 0]).map((value) => value.toFixed(2)).join(' x ')}</span>
          <span>Scene {(geometry.normalizedBounds ?? [0, 0, 0]).map((value) => value.toFixed(2)).join(' x ')}</span>
          <span>Scale {(geometry.importScale ?? 1).toFixed(4)}</span>
        </div>
        <KinematicGraphPanel
          node={node}
          selectedPartNames={selectedPartNames}
          setKinematicJointValue={setKinematicJointValue}
          resetKinematicPose={resetKinematicPose}
          updateKinematicJoint={updateKinematicJoint}
          startKinematicEdit={startKinematicEdit}
          acceptKinematicJoint={acceptKinematicJoint}
          rejectKinematicJoint={rejectKinematicJoint}
          deleteKinematicJoint={deleteKinematicJoint}
          createKinematicJoint={createKinematicJoint}
        />
        <button className={demoActive ? 'smart-motion-button active' : 'smart-motion-button'} disabled={!geometry.joints.length} onClick={toggleImportedMotionDemo}>
          {demoActive ? <Pause size={16} /> : <Activity size={16} />}
          <span>{demoActive ? 'Stop Smart Demo' : validatedMotions.length ? 'Start Learned Demo' : 'Start Smart Demo'}</span>
        </button>

        <div className="motion-trainer">
          <div className="section-title-row">
            <h4>Motion Trainer</h4>
            <button title="Start movement tests" disabled={!geometry.joints.length} onClick={startMotionTrainer}>
              <Play size={15} />
            </button>
          </div>

          {trainingCandidate ? (
            <div className="active-motion-test">
              <span>{trainingProgress ? `${trainingProgress.current}/${trainingProgress.total}` : 'Test'}</span>
              <strong title={trainingCandidate.label}>{trainingCandidate.label}</strong>
              <div className="motion-test-actions">
                <button className="primary" title="Validate movement" onClick={acceptMotionTest}>
                  <Check size={15} />
                  <span>Validate</span>
                </button>
                <button title="Reject movement" onClick={rejectMotionTest}>
                  <X size={15} />
                  <span>Reject</span>
                </button>
                <button title="Stop tests" onClick={stopMotionTrainer}>
                  <Pause size={15} />
                </button>
              </div>
            </div>
          ) : (
            <button className="wide-action compact" disabled={!geometry.joints.length} onClick={startMotionTrainer}>
              <Play size={16} />
              <span>Start Tests</span>
            </button>
          )}

          {validatedMotions.length ? (
            <div className="validated-motion-list">
              {validatedMotions.map((motion, index) => (
                <div key={motion.id} className="validated-motion-row">
                  <span>{index + 1}</span>
                  <strong title={motion.label}>{motion.label}</strong>
                  <button title="Move earlier" disabled={index === 0} onClick={() => moveValidatedMotion(node.id, motion.id, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button title="Move later" disabled={index === validatedMotions.length - 1} onClick={() => moveValidatedMotion(node.id, motion.id, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button title="Remove movement" onClick={() => removeValidatedMotion(node.id, motion.id)}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {geometry.joints.length ? (
          <div className="joint-list">
            {geometry.joints.slice(0, 24).map((joint) => (
              <div key={joint.name} className="joint-row">
                <strong title={joint.name}>{joint.label ?? joint.name}</strong>
                <Slider
                  label={`${joint.motionKind === 'translation' ? 'Slide' : 'Rotate'} ${(joint.axis ?? 'x').toUpperCase()}`}
                  value={
                    joint.motionKind === 'translation'
                      ? joint.translation?.[joint.axis === 'y' ? 1 : joint.axis === 'z' ? 2 : 0] ?? 0
                      : joint.rotation[joint.axis === 'y' ? 1 : joint.axis === 'z' ? 2 : 0]
                  }
                  min={joint.min ?? -3.14}
                  max={joint.max ?? 3.14}
                  step={0.01}
                  onChange={(value) => setImportedJointMotion(joint.name, value)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">This model has no skeleton. You can transform the whole object, but not pose articulations.</div>
        )}
      </section>
    );
  }

  if (geometry.kind === 'serialized-object') {
    return (
      <section>
        <h3>Stored Part</h3>
        <div className="metrics-list">
          <span>{geometry.assetName}</span>
          <span>
            Bounds {geometry.normalizedBounds.map((value) => value.toFixed(2)).join(' x ')}
          </span>
        </div>
      </section>
    );
  }

  const generator = getGeneratorDefinition(geometry.generatorId);

  if (!generator) {
    return (
      <section>
        <h3>Generator</h3>
        <div className="empty-state">Unknown generator definition.</div>
      </section>
    );
  }

  return (
    <section>
      <div className="section-title-row">
        <h3>{generator.name}</h3>
        <button title="Randomize seed" onClick={randomizeGenerator}>
          <Sparkles size={16} />
        </button>
      </div>
      <p className="generator-description">{generator.description}</p>
      {generator.parameters.map((parameter) =>
        parameter.key === 'seed' ? (
          <label className="field-row" key={parameter.key}>
            <span>{parameter.label}</span>
            <input type="number" value={geometry.params[parameter.key]} onChange={(event) => setGeometryValue(parameter.key, Number(event.target.value))} />
          </label>
        ) : (
          <Slider
            key={parameter.key}
            label={parameter.label}
            value={geometry.params[parameter.key]}
            min={parameter.min}
            max={parameter.max}
            step={parameter.step}
            onChange={(value) => setGeometryValue(parameter.key, value)}
          />
        ),
      )}
    </section>
  );
};
