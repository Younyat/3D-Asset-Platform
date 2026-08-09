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
  JointMotionKind,
  MaterialDefinition,
  MotionAxis,
  SceneNode,
  Transform,
  ValidatedJointMotion,
  ValidationIssue,
} from '../domain/model';
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
import { MotionTrainingPreview, ThreeViewport, ViewportStats } from './components/ThreeViewport';

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
  return geometry.kind.charAt(0).toUpperCase() + geometry.kind.slice(1);
};

const materialPresets: MaterialDefinition[] = [
  { name: 'Graphite PBR', color: '#3f4953', roughness: 0.52, metalness: 0.08 },
  { name: 'Industrial Steel', color: '#8b949e', roughness: 0.34, metalness: 0.78 },
  { name: 'Military Black', color: '#20262a', roughness: 0.72, metalness: 0.25 },
  { name: 'Safety Orange', color: '#d66b2c', roughness: 0.46, metalness: 0.12 },
  { name: 'Emissive Red Trim', color: '#34383d', roughness: 0.42, metalness: 0.35, emissive: '#e53935', emissiveIntensity: 1.8 },
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

export const App = () => {
  const [document, setDocument] = useState<AssetDocument>(loadInitialProject);
  const [past, setPast] = useState<AssetDocument[]>([]);
  const [future, setFuture] = useState<AssetDocument[]>([]);
  const [tool, setTool] = useState<EditorTool>('translate');
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>(() => validateProject(document));
  const [status, setStatus] = useState('Ready');
  const [stats, setStats] = useState<ViewportStats>({ fps: 0, objects: document.nodes.length, triangles: 0 });
  const [autosaveAvailable, setAutosaveAvailable] = useState(false);
  const [exportProfileId, setExportProfileId] = useState<ExportProfileId>('generic-glb');
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [desktopRuntime] = useState(isDesktopRuntime);
  const [nativeProjectPath, setNativeProjectPath] = useState<string | undefined>();
  const [demoMotionNodeId, setDemoMotionNodeId] = useState<string | undefined>();
  const [motionTrainer, setMotionTrainer] = useState<MotionTrainerState | undefined>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const glbInputRef = useRef<HTMLInputElement | null>(null);

  const selectedNode = useMemo(
    () => document.nodes.find((node) => node.id === document.selectedNodeId),
    [document.nodes, document.selectedNodeId],
  );

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
        setTool('translate');
      } else if (key === 'e') {
        setTool('rotate');
      } else if (key === 'r') {
        setTool('scale');
      } else if (key === 'v') {
        setTool('select');
      } else if (key === 'delete' || key === 'backspace') {
        removeSelected();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const selectNode = useCallback(
    (nodeId?: string) => {
      setDocument((current) => ({ ...current, selectedNodeId: nodeId }));
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
    },
    [commit, document],
  );

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
      addNode(node, node.geometry.kind === 'imported-model' && node.geometry.joints.length ? 'Articulated model imported' : 'Static model imported');
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
    updateSelectedNodeLive(
      (node) => {
        if (node.geometry.kind !== 'imported-model') return node;

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
      },
      'Joint adjusted',
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
          <button className={tool === 'translate' ? 'active' : ''} title="Move" onClick={() => setTool('translate')}>
            <Move3D size={18} />
          </button>
          <button className={tool === 'rotate' ? 'active' : ''} title="Rotate" onClick={() => setTool('rotate')}>
            <RotateCw size={18} />
          </button>
          <button className={tool === 'scale' ? 'active' : ''} title="Scale" onClick={() => setTool('scale')}>
            <Scaling size={18} />
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

      <section className="workbench">
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
          snapEnabled={snapEnabled}
          motionDemoNodeId={demoMotionNodeId}
          motionTrainingPreview={motionTrainingPreview}
          onSelect={selectNode}
          onTransformCommit={updateNodeTransform}
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

              <GeometryInspector
                node={selectedNode}
                setGeometryValue={setGeometryValue}
                setImportedJointMotion={setImportedJointMotion}
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

type GeometryInspectorProps = {
  node: SceneNode;
  setGeometryValue: (field: string, value: number) => void;
  setImportedJointMotion: (jointName: string, value: number) => void;
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
  randomizeGenerator: () => void;
};

const GeometryInspector = ({
  node,
  setGeometryValue,
  setImportedJointMotion,
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
