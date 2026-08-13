import type { Transform, Vector3Tuple } from '../model';

export type QuaternionTuple = [number, number, number, number];

export type Bounds3D = {
  min: Vector3Tuple;
  max: Vector3Tuple;
  size: Vector3Tuple;
  center: Vector3Tuple;
};

export type OrientedBounds3D = {
  center: Vector3Tuple;
  halfExtents: Vector3Tuple;
  rotation: QuaternionTuple;
};

export type Transform3D = Transform;

export type JointType = 'fixed' | 'revolute' | 'continuous' | 'prismatic' | 'spherical' | 'planar' | 'screw' | 'generic6dof';

export type JointEvidence = {
  type:
    | 'semantic-name'
    | 'imported-hierarchy'
    | 'existing-pivot'
    | 'geometry'
    | 'contact'
    | 'principal-axis'
    | 'symmetry'
    | 'manual';
  score?: number;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type JointValidationResult = {
  status: 'unknown' | 'pass' | 'warning' | 'fail';
  messages: string[];
  testedAt?: string;
};

export type MechanicalPart = {
  id: string;
  name: string;
  meshObjectIds: string[];
  localFrame: Transform3D;
  bounds: Bounds3D;
  orientedBounds?: OrientedBounds3D;
  static: boolean;
  visible: boolean;
  source: 'imported' | 'automatic-segmentation' | 'manual-group';
  collisionGeometryId?: string;
  metadata: Record<string, unknown>;
};

export type KinematicJoint = {
  id: string;
  name: string;
  parentPartId: string;
  childPartId: string;
  type: JointType;
  origin: {
    position: Vector3Tuple;
    rotation: QuaternionTuple;
  };
  axis: Vector3Tuple;
  axis2?: Vector3Tuple;
  limits?: {
    lower?: number;
    upper?: number;
    velocity?: number;
    effort?: number;
  };
  dynamics?: {
    damping?: number;
    friction?: number;
    stiffness?: number;
  };
  screwPitch?: number;
  source: 'imported' | 'name-heuristic' | 'geometry' | 'model' | 'manual' | 'hybrid';
  confidence?: number;
  evidence: JointEvidence[];
  status: 'candidate' | 'validated' | 'rejected' | 'manual';
  validation?: JointValidationResult;
};

export type KinematicGraph = {
  parts: MechanicalPart[];
  joints: KinematicJoint[];
  rootPartId: string;
};
