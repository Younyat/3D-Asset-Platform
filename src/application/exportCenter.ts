import { AssetDocument, SceneNode, ValidationIssue } from '../domain/model';
import { validateProject } from './validation';

export type ExportProfileId = 'generic-glb' | 'unity-glb' | 'unreal-glb' | 'godot-glb';

export type ExportProfile = {
  id: ExportProfileId;
  name: string;
  engine: string;
  format: 'glb';
  unitScale: number;
  maxRecommendedTriangles: number;
  filenameSuffix: string;
  notes: string[];
};

export type ExportReport = {
  id: string;
  projectName: string;
  profile: ExportProfile;
  createdAt: string;
  fileName: string;
  fileSizeKb: number;
  durationMs: number;
  visibleObjects: number;
  hiddenObjects: number;
  totalObjects: number;
  triangleEstimate: number;
  materialSlots: number;
  issues: ValidationIssue[];
  status: 'passed' | 'warning' | 'failed';
};

export const exportProfiles: ExportProfile[] = [
  {
    id: 'generic-glb',
    name: 'Generic GLB',
    engine: 'DCC / Web / Runtime',
    format: 'glb',
    unitScale: 1,
    maxRecommendedTriangles: 60000,
    filenameSuffix: 'generic',
    notes: ['Binary GLB', 'Embedded materials', 'Y-up scene convention'],
  },
  {
    id: 'unity-glb',
    name: 'Unity GLB',
    engine: 'Unity',
    format: 'glb',
    unitScale: 1,
    maxRecommendedTriangles: 45000,
    filenameSuffix: 'unity',
    notes: ['Meter scale', 'PBR material slots', 'Ready for glTFast import'],
  },
  {
    id: 'unreal-glb',
    name: 'Unreal GLB',
    engine: 'Unreal Engine',
    format: 'glb',
    unitScale: 100,
    maxRecommendedTriangles: 50000,
    filenameSuffix: 'unreal',
    notes: ['Centimeter target scale', 'Metal/rough PBR workflow', 'Nanite review recommended for high-poly assets'],
  },
  {
    id: 'godot-glb',
    name: 'Godot GLB',
    engine: 'Godot',
    format: 'glb',
    unitScale: 1,
    maxRecommendedTriangles: 40000,
    filenameSuffix: 'godot',
    notes: ['Meter scale', 'GLB scene import', 'Use inherited scene for reusable props'],
  },
];

export const getExportProfile = (profileId: ExportProfileId) =>
  exportProfiles.find((profile) => profile.id === profileId) ?? exportProfiles[0];

const generatedTriangleEstimate: Record<string, number> = {
  'scifi-crate': 620,
  'supply-barrel': 1450,
  'power-core': 2200,
  'antenna-array': 1250,
  'modular-wall': 900,
  'tech-door': 950,
  'floor-panel': 760,
  'pipe-network': 1550,
  'control-console': 820,
};

const estimateNodeTriangles = (node: SceneNode) => {
  const geometry = node.geometry;
  if (geometry.kind === 'box') return 12;
  if (geometry.kind === 'plane') return 2;
  if (geometry.kind === 'sphere') return Math.max(64, geometry.segments * geometry.segments);
  if (geometry.kind === 'cylinder') return geometry.segments * 4;
  if (geometry.kind === 'imported-model') return Math.max(1000, geometry.bones.length * 120);
  if ('generatorId' in geometry) return generatedTriangleEstimate[geometry.generatorId] ?? 1200;
  return 0;
};

export const estimateDocumentTriangles = (document: AssetDocument) =>
  document.nodes.filter((node) => node.visible).reduce((total, node) => total + estimateNodeTriangles(node), 0);

export const countMaterialSlots = (document: AssetDocument) => {
  const keys = new Set<string>();
  document.nodes
    .filter((node) => node.visible)
    .forEach((node) => keys.add(`${node.material.name}:${node.material.color}:${node.material.roughness}:${node.material.metalness}`));
  return keys.size;
};

export const runExportPreflight = (document: AssetDocument, profile: ExportProfile): ValidationIssue[] => {
  const issues = validateProject(document).filter((issue) => issue.code !== 'VALIDATION_OK');
  const visibleObjects = document.nodes.filter((node) => node.visible);
  const triangleEstimate = estimateDocumentTriangles(document);

  if (triangleEstimate > profile.maxRecommendedTriangles) {
    issues.push({
      severity: 'warning',
      code: 'TRIANGLE_BUDGET',
      message: `Estimated ${triangleEstimate.toLocaleString()} triangles exceeds ${profile.name} recommended budget.`,
    });
  }

  if (visibleObjects.length > 120) {
    issues.push({
      severity: 'warning',
      code: 'OBJECT_COUNT_HIGH',
      message: 'Visible object count is high for a single prop export.',
    });
  }

  if (document.nodes.some((node) => node.locked && node.visible)) {
    issues.push({
      severity: 'info',
      code: 'LOCKED_OBJECTS',
      message: 'Locked visible objects will still be exported.',
    });
  }

  return issues.length
    ? issues
    : [
        {
          severity: 'info',
          code: 'PREFLIGHT_OK',
          message: `${profile.name} preflight passed.`,
        },
      ];
};

export const buildExportReport = (
  document: AssetDocument,
  profile: ExportProfile,
  fileName: string,
  fileSizeBytes: number,
  durationMs: number,
  issues: ValidationIssue[],
): ExportReport => {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    id: crypto.randomUUID(),
    projectName: document.metadata.name,
    profile,
    createdAt: new Date().toISOString(),
    fileName,
    fileSizeKb: Math.max(1, Math.round(fileSizeBytes / 1024)),
    durationMs,
    visibleObjects: document.nodes.filter((node) => node.visible).length,
    hiddenObjects: document.nodes.filter((node) => !node.visible).length,
    totalObjects: document.nodes.length,
    triangleEstimate: estimateDocumentTriangles(document),
    materialSlots: countMaterialSlots(document),
    issues,
    status: errors ? 'failed' : warnings ? 'warning' : 'passed',
  };
};
