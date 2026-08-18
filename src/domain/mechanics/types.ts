import type { KinematicGraph, KinematicJoint, JointType } from '../kinematics';
import type { MaterialDefinition, Transform, Vector3Tuple } from '../model';

export type MechanicalInterfaceKind = 'axis' | 'hinge' | 'support' | 'rail' | 'shaft' | 'mount' | 'gripper' | 'surface';

export type FunctionalComponentEndpointRole = 'single' | 'fixed' | 'moving';

export type FunctionalComponentEndpoint = {
  id: string;
  name: string;
  role: FunctionalComponentEndpointRole;
  position: Vector3Tuple;
  axis?: Vector3Tuple;
};

export type FunctionalComponentMovement = {
  id: string;
  endpointId: string;
  kind: 'rotation' | 'translation';
  axis: Vector3Tuple;
  plane: 'xy' | 'xz' | 'yz';
  limits: {
    lower: number;
    upper: number;
  };
  testValue: number;
};

export type FunctionalComponentMotionDefinition = {
  version: 1;
  static: boolean;
  endpointMode: 'single' | 'two-end';
  activeEndpointId?: string;
  endpoints: FunctionalComponentEndpoint[];
  movements: FunctionalComponentMovement[];
  updatedAt: string;
};

export type MechanicalInterface = {
  id: string;
  componentId: string;
  name: string;
  kind: MechanicalInterfaceKind;
  frame: Transform;
  axis?: Vector3Tuple;
  compatibleWith: MechanicalInterfaceKind[];
  tags: string[];
  source: 'kinematic-graph' | 'semantic-name' | 'geometry' | 'manual' | 'fallback';
  confidence: number;
  metadata: Record<string, unknown>;
};

export type FunctionalComponent = {
  id: string;
  name: string;
  category: string;
  className: string;
  sourceAssetName: string;
  sourceObjectName: string;
  localTransform: Transform;
  origin: Transform;
  bounds: {
    size: Vector3Tuple;
    center: Vector3Tuple;
  };
  material: MaterialDefinition;
  mechanicalProperties: {
    role: 'base' | 'link' | 'joint' | 'end-effector' | 'drive' | 'panel' | 'generic';
    movable: boolean;
    preferredJointType?: JointType;
    massEstimateKg?: number;
  };
  interfaces: MechanicalInterface[];
  kinematicGraph: KinematicGraph;
  motionDefinition?: FunctionalComponentMotionDefinition;
  sourceKinematicPartIds: string[];
  metadata: Record<string, unknown>;
};

export type AssemblyConnectionStatus = 'candidate' | 'validated' | 'rejected' | 'manual';

export type AssemblyConnection = {
  id: string;
  name: string;
  parentComponentId: string;
  childComponentId: string;
  parentInterfaceId: string;
  childInterfaceId: string;
  joint: KinematicJoint;
  status: AssemblyConnectionStatus;
  source: 'suggested' | 'imported' | 'manual';
  confidence: number;
  metadata: Record<string, unknown>;
};

export type FunctionalAssembly = {
  id: string;
  name: string;
  rootComponentId?: string;
  components: FunctionalComponent[];
  connections: AssemblyConnection[];
  kinematicGraph: KinematicGraph;
  metadata: {
    createdAt: string;
    updatedAt: string;
    source: 'dismantled-machine' | 'reassembly' | 'workspace' | 'manual';
    validationStatus: 'unknown' | 'valid' | 'warning' | 'invalid';
    validationMessages: string[];
  };
};

export type AssemblyValidationIssue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  componentId?: string;
  connectionId?: string;
};
