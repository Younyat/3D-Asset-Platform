export type NodeId = string;

export type Transform = {
  position: Vector3Tuple;
  rotation: Vector3Tuple;
  scale: Vector3Tuple;
};

export type Vector3Tuple = [number, number, number];
export type MotionAxis = 'x' | 'y' | 'z';
export type JointMotionKind = 'rotation' | 'translation';

export type MaterialDefinition = {
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  emissive?: string;
  emissiveIntensity?: number;
};

export type PrimitiveGeometry =
  | { kind: 'box'; width: number; height: number; depth: number }
  | { kind: 'sphere'; radius: number; segments: number }
  | { kind: 'cylinder'; radius: number; height: number; segments: number }
  | { kind: 'plane'; width: number; depth: number };

export type GeneratorId =
  | 'scifi-crate'
  | 'supply-barrel'
  | 'power-core'
  | 'antenna-array'
  | 'modular-wall'
  | 'tech-door'
  | 'floor-panel'
  | 'pipe-network'
  | 'control-console';

export type ProceduralParameters = Record<string, number>;

export type GeneratedGeometry = {
  kind: GeneratorId;
  generatorId: GeneratorId;
  params: ProceduralParameters;
};

export type ImportedJointPose = {
  name: string;
  label?: string;
  sourceType?: 'bone' | 'object';
  motionKind?: JointMotionKind;
  axis?: MotionAxis;
  min?: number;
  max?: number;
  demoAmplitude?: number;
  rotation: Vector3Tuple;
  translation?: Vector3Tuple;
};

export type ValidatedJointMotion = {
  id: string;
  jointName: string;
  label: string;
  motionKind: JointMotionKind;
  axis: MotionAxis;
  min: number;
  max: number;
  amplitude: number;
  order: number;
};

export type ImportedModelGeometry = {
  kind: 'imported-model';
  assetName: string;
  assetDataUrl: string;
  sourceFormat: 'glb' | 'fbx' | 'dae' | 'obj' | '3ds';
  importScale: number;
  importOffset: Vector3Tuple;
  originalBounds: Vector3Tuple;
  normalizedBounds: Vector3Tuple;
  bones: string[];
  animations: string[];
  joints: ImportedJointPose[];
  validatedMotions?: ValidatedJointMotion[];
};

export type GeometryDefinition = PrimitiveGeometry | GeneratedGeometry | ImportedModelGeometry;

export type SceneNode = {
  id: NodeId;
  name: string;
  geometry: GeometryDefinition;
  transform: Transform;
  material: MaterialDefinition;
  visible: boolean;
  locked: boolean;
  createdAt: string;
};

export type ProjectMetadata = {
  id: string;
  name: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type AssetDocument = {
  schemaVersion: 1;
  metadata: ProjectMetadata;
  nodes: SceneNode[];
  selectedNodeId?: NodeId;
};

export type ValidationIssue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodeId?: NodeId;
};

export type EditorTool = 'select' | 'translate' | 'rotate' | 'scale';

export const defaultTransform = (): Transform => ({
  position: [0, 0.5, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

export const defaultMaterial = (name = 'Graphite PBR', color = '#3f4953'): MaterialDefinition => ({
  name,
  color,
  roughness: 0.52,
  metalness: 0.08,
});
