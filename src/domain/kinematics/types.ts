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

export type JointMotionProfile = 'rotation-around-origin' | 'linear-slide' | 'fixed-origin-lift';

export type JointMotionPlane = 'xy' | 'xz' | 'yz';

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

export type TopologyProperties = {
  watertight: boolean;
  manifold: boolean;
  consistentlyOriented: boolean;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
};

export type GeometricProperties = {
  aabbCenter: Vector3Tuple;
  surfaceCentroid?: Vector3Tuple;
  volumeCentroid?: Vector3Tuple;
  principalAxes?: [Vector3Tuple, Vector3Tuple, Vector3Tuple];
  dimensions: Vector3Tuple;
  topology: TopologyProperties;
};

export type MassProperties = {
  centerOfMass?: Vector3Tuple;
  volume?: number;
  mass?: number;
  inertiaTensor?: [Vector3Tuple, Vector3Tuple, Vector3Tuple];
  assumption: 'uniform-density' | 'material-defined';
  valid: boolean;
};

export type JointFrameEvidence = {
  primitive?: 'cylinder' | 'circle' | 'plane' | 'sphere';
  residual?: number;
  normalizedResidual?: number;
  supportRatio?: number;
  angularCoverageDeg?: number;
  axialCoverage?: number;
  contactAgreement?: number;
  pcaAxisAgreementDeg?: number;
  userSeeded?: boolean;
  evidenceLevel: 'low' | 'medium' | 'high';
  messages: string[];
};

export type JointFrame = {
  origin: Vector3Tuple;
  axis: Vector3Tuple;
  orientation: QuaternionTuple;
  source: 'geometry' | 'assembly-contact' | 'user-seeded' | 'manual' | 'imported';
  evidence: JointFrameEvidence;
  status: 'candidate' | 'accepted' | 'rejected' | 'manual';
  axisSignConvention?: 'parent-to-child' | 'user-defined' | 'canonical';
};

export type CylinderCandidate = {
  axisPoint: Vector3Tuple;
  axisDirection: Vector3Tuple;
  radius: number;
  radialResidualRms: number;
  radialResidualMedian: number;
  supportRatio: number;
  angularCoverageDeg: number;
  axialCoverage: number;
  inlierCount: number;
  totalCount: number;
};

export type JointFrameCandidate = {
  frame: JointFrame;
  motionType: 'revolute' | 'prismatic' | 'fixed' | 'unknown';
  cylinder?: CylinderCandidate;
  seedPoint?: Vector3Tuple;
};

export type MechanicalAdjacency = {
  partA: string;
  partB: string;
  minimumDistance: number;
  coaxialCandidates: Array<{ axisPoint: Vector3Tuple; axisDirection: Vector3Tuple; lineDistance: number; angularErrorDeg: number }>;
  metadata?: Record<string, unknown>;
};

export type MechanicalPart = {
  id: string;
  name: string;
  meshObjectIds: string[];
  localFrame: Transform3D;
  bounds: Bounds3D;
  geometricProperties?: GeometricProperties;
  massProperties?: MassProperties;
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
  jointFrame?: JointFrame;
  inferredCandidate?: JointFrameCandidate;
  motionProfile?: JointMotionProfile;
  motionPlane?: JointMotionPlane;
  drivenPoint?: Vector3Tuple;
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
  coupling?: {
    driverJointId: string;
    multiplier: number;
    offset: number;
  };
};

export type KinematicLogicalControl = {
  id: string;
  name: string;
  jointMappings: Array<{
    jointId: string;
    multiplier: number;
    offset: number;
  }>;
};

export type KinematicMotionKeyframe = {
  time: number;
  label?: string;
  jointValues: Record<string, number>;
};

export type KinematicMotionClip = {
  id: string;
  name: string;
  duration: number;
  loop: boolean;
  source: 'imported' | 'manual' | 'generated';
  description?: string;
  keyframes: KinematicMotionKeyframe[];
};

export type KinematicGraph = {
  parts: MechanicalPart[];
  joints: KinematicJoint[];
  rootPartId: string;
  logicalControls?: KinematicLogicalControl[];
  motionClips?: KinematicMotionClip[];
  mechanicalAdjacency?: MechanicalAdjacency[];
  analysisVersion?: string;
};

export type KinematicState = {
  jointValues: Record<string, number>;
  homeJointValues: Record<string, number>;
};
