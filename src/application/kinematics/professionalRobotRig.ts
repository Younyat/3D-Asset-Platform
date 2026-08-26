import * as THREE from 'three';
import type { ImportedJointPose, Vector3Tuple } from '../../domain/model';
import type { KinematicGraph, KinematicJoint, KinematicMotionClip, KinematicState, MechanicalPart } from '../../domain/kinematics';
import { createJointFrame } from './geometryAnalysis';
import { normalizeAxis } from './kinematicAuthoring';

type RigAxis = 'X' | 'Y' | 'Z';

type RobotArmRigJointMetadata = {
  name: string;
  order?: string;
  type: 'revolute' | 'continuous' | 'prismatic' | 'fixed';
  axis: RigAxis;
  parent?: string;
  originMeters?: [number, number, number];
  limitsDeg?: [number, number];
  limitsMeters?: [number, number];
  homeDeg?: number;
  homeMeters?: number;
  maxSpeedDegPerSec?: number;
  maxSpeedMetersPerSec?: number;
};

type RobotArmRigMetadata = {
  schema: string;
  units?: string;
  up?: string;
  joints?: RobotArmRigJointMetadata[];
  gripper?: {
    type?: string;
    axis?: RigAxis;
    openMeters?: number;
    closedMeters?: number;
    strokeMeters?: number;
  };
  clips?: Array<{ name: string; durationSec?: number; loop?: boolean }>;
};

type RobotArmPoseKey = {
  t: number;
  phase?: string;
  J1?: number;
  J2?: number;
  J3?: number;
  J4?: number;
  J5?: number;
  grip?: number;
};

export type ProfessionalRigImport = {
  joints: ImportedJointPose[];
  kinematicGraph: KinematicGraph;
  kinematicState: KinematicState;
  rigRootName: string;
  sourceSchema: string;
};

const DEG_TO_RAD = Math.PI / 180;
const EPSILON = 1e-8;

const id = (prefix: string, value: string) =>
  `${prefix}_${value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 56)}`;

const tuple = (vector: THREE.Vector3): Vector3Tuple => [vector.x, vector.y, vector.z];

const axisVector = (axis: RigAxis): Vector3Tuple => {
  if (axis === 'Y') return [0, 1, 0];
  if (axis === 'Z') return [0, 0, 1];
  return [1, 0, 0];
};

const axisKey = (axis: RigAxis): 'x' | 'y' | 'z' => axis.toLowerCase() as 'x' | 'y' | 'z';

const boundsFromObject = (object: THREE.Object3D) => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(center),
  };
};

const findRigRoot = (scene: THREE.Object3D): { root: THREE.Object3D; metadata: RobotArmRigMetadata } | undefined => {
  let result: { root: THREE.Object3D; metadata: RobotArmRigMetadata } | undefined;
  scene.traverse((object) => {
    if (result) return;
    const metadata = object.userData as RobotArmRigMetadata;
    if (metadata?.schema === 'robot-arm-rig/1.0' && Array.isArray(metadata.joints)) {
      result = { root: object, metadata };
    }
  });
  return result;
};

const objectMapByName = (scene: THREE.Object3D) => {
  const objects = new Map<string, THREE.Object3D>();
  scene.traverse((object) => {
    if (object.name && !objects.has(object.name)) objects.set(object.name, object);
  });
  return objects;
};

const nearestRigAncestor = (object: THREE.Object3D, rigNames: Set<string>, rigRoot: THREE.Object3D) => {
  let current = object.parent;
  while (current && current !== rigRoot.parent) {
    if (current.name && rigNames.has(current.name)) return current.name;
    if (current === rigRoot) return undefined;
    current = current.parent;
  }
  return undefined;
};

const parentAxisWorld = (object: THREE.Object3D, axis: RigAxis) => {
  const direction = new THREE.Vector3(...axisVector(axis));
  const parent = object.parent ?? object;
  parent.updateMatrixWorld(true);
  direction.transformDirection(parent.matrixWorld);
  return tuple(direction.normalize());
};

const jointWorldOrigin = (object: THREE.Object3D) => {
  const position = new THREE.Vector3();
  object.updateMatrixWorld(true);
  object.getWorldPosition(position);
  return tuple(position);
};

const localJointValue = (object: THREE.Object3D, metadata: RobotArmRigJointMetadata) => {
  const axis = axisKey(metadata.axis);
  if (metadata.type === 'prismatic') return object.position[axis];
  return object.rotation[axis];
};

const absoluteLimits = (metadata: RobotArmRigJointMetadata): [number, number] | undefined => {
  if (metadata.type === 'prismatic') return metadata.limitsMeters;
  if (metadata.limitsDeg) return [metadata.limitsDeg[0] * DEG_TO_RAD, metadata.limitsDeg[1] * DEG_TO_RAD];
  return undefined;
};

const absoluteHome = (metadata: RobotArmRigJointMetadata, rig: RobotArmRigMetadata, restValue: number) => {
  if (metadata.type === 'prismatic') {
    if (Number.isFinite(metadata.homeMeters)) return metadata.homeMeters as number;
    const gripper = rig.gripper;
    if (gripper && /finger_l$/i.test(metadata.name) && Number.isFinite(gripper.openMeters)) return -(gripper.openMeters as number);
    if (gripper && /finger_r$/i.test(metadata.name) && Number.isFinite(gripper.openMeters)) return gripper.openMeters as number;
    return restValue;
  }
  return Number.isFinite(metadata.homeDeg) ? (metadata.homeDeg as number) * DEG_TO_RAD : restValue;
};

const ROBOT_ARM_RIG_CLIPS: Array<{ name: string; durationSec: number; loop: boolean; description: string; keys: RobotArmPoseKey[] }> = [
  {
    name: 'Ciclo_Pick_And_Place',
    durationSec: 10,
    loop: true,
    description: 'Pick and place completo con cierre y apertura de pinza.',
    keys: [
      { t: 0, phase: 'home', J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 1.5, phase: 'aproximacion', J1: -40, J2: 50, J3: 70, J4: 60, J5: 0, grip: 1 },
      { t: 2.6, phase: 'descenso', J1: -40, J2: 70, J3: 70, J4: 40, J5: 0, grip: 1 },
      { t: 3.3, phase: 'cierre', J1: -40, J2: 70, J3: 70, J4: 40, J5: 0, grip: 0 },
      { t: 4.2, phase: 'elevacion', J1: -40, J2: 50, J3: 70, J4: 60, J5: 0, grip: 0 },
      { t: 5.8, phase: 'transferencia', J1: 55, J2: 50, J3: 70, J4: 60, J5: 90, grip: 0 },
      { t: 6.9, phase: 'descenso destino', J1: 55, J2: 70, J3: 70, J4: 40, J5: 90, grip: 0 },
      { t: 7.6, phase: 'apertura', J1: 55, J2: 70, J3: 70, J4: 40, J5: 90, grip: 1 },
      { t: 8.5, phase: 'retirada', J1: 55, J2: 50, J3: 70, J4: 60, J5: 90, grip: 1 },
      { t: 10, phase: 'retorno home', J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
  {
    name: 'Ir_A_Home',
    durationSec: 2,
    loop: false,
    description: 'Retorno suave a Home.',
    keys: [
      { t: 0, J1: 0, J2: 20, J3: 90, J4: 40, J5: 0, grip: 0 },
      { t: 2, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
  {
    name: 'Demo_Ejes',
    durationSec: 16.2,
    loop: true,
    description: 'Verifica los ejes J1-J5 en orden y la pinza al final.',
    keys: [
      { t: 0, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 1.6, J1: -170, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 4, J1: 170, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 5.4, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 6.6, J1: 0, J2: 95, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 7.8, J1: 0, J2: -60, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 8.8, J1: 0, J2: -10, J3: 150, J4: 60, J5: 0, grip: 1 },
      { t: 9.8, J1: 0, J2: -10, J3: -20, J4: 60, J5: 0, grip: 1 },
      { t: 10.8, J1: 0, J2: -10, J3: 60, J4: 110, J5: 0, grip: 1 },
      { t: 11.8, J1: 0, J2: -10, J3: 60, J4: -110, J5: 0, grip: 1 },
      { t: 12.8, J1: 0, J2: -10, J3: 60, J4: 60, J5: 180, grip: 1 },
      { t: 13.8, J1: 0, J2: -10, J3: 60, J4: 60, J5: -180, grip: 1 },
      { t: 14.6, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 15.4, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 0 },
      { t: 16.2, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
];

const STATIC_OBJ_JOINTS: RobotArmRigJointMetadata[] = [
  { order: 'J1', name: 'J1_base_yaw', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', originMeters: [0, 0.38, 0], limitsDeg: [-170, 170], homeDeg: 0, maxSpeedDegPerSec: 180 },
  { order: 'J2', name: 'J2_shoulder_pitch', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', originMeters: [0.02, 0.9, 0], limitsDeg: [-60, 95], homeDeg: -10, maxSpeedDegPerSec: 140 },
  { order: 'J3', name: 'J3_elbow_pitch', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', originMeters: [0.02, 1.52, 0], limitsDeg: [-20, 150], homeDeg: 60, maxSpeedDegPerSec: 160 },
  { order: 'J4', name: 'J4_wrist_pitch', type: 'revolute', axis: 'Z', parent: 'J3_elbow_pitch', originMeters: [0.02, 1.98, 0], limitsDeg: [-110, 110], homeDeg: 60, maxSpeedDegPerSec: 250 },
  { order: 'J5', name: 'J5_tool_roll', type: 'revolute', axis: 'Y', parent: 'J4_wrist_pitch', originMeters: [0.02, 2.12, 0], limitsDeg: [-180, 180], homeDeg: 0, maxSpeedDegPerSec: 320 },
  { order: 'J6', name: 'J6_gripper_finger_L', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', originMeters: [-0.065, 2.24, 0], limitsMeters: [-0.085, -0.032], homeMeters: -0.085, maxSpeedMetersPerSec: 0.12 },
  { order: 'J6', name: 'J6_gripper_finger_R', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', originMeters: [0.105, 2.24, 0], limitsMeters: [0.032, 0.085], homeMeters: 0.085, maxSpeedMetersPerSec: 0.12 },
];

const STATIC_OBJ_MESH_IDS: Record<string, string[]> = {
  BASE_fixed: ['base_plate', 'base_pedestal', 'base_bolt_0', 'base_bolt_1', 'base_bolt_2', 'base_bolt_3', 'base_bolt_4', 'base_bolt_5', 'base_bolt_6', 'base_bolt_7', 'cable_conduit'],
  J1_base_yaw: ['turret_body', 'turret_collar', 'shoulder_housing'],
  J2_shoulder_pitch: ['shoulder_axle', 'upper_arm', 'upper_arm_rib', 'upper_arm_stripe'],
  J3_elbow_pitch: ['elbow_axle', 'forearm', 'forearm_motor_housing'],
  J4_wrist_pitch: ['wrist_ball', 'wrist_link'],
  J5_tool_roll: ['tool_flange', 'gripper_body'],
  J6_gripper_finger_L: ['gripper_finger_L', 'gripper_pad_L'],
  J6_gripper_finger_R: ['gripper_finger_R', 'gripper_pad_R'],
};

const STATIC_OBJ_MATERIALS: Record<string, { color: number; roughness: number; metalness: number }> = {
  steel_housing: { color: 0x454b52, roughness: 0.5, metalness: 0.4 },
  safety_orange: { color: 0xd9520c, roughness: 0.42, metalness: 0.18 },
  chrome_joint: { color: 0xcfd2d6, roughness: 0.22, metalness: 0.8 },
  cable_rubber: { color: 0x1b1c1e, roughness: 0.85, metalness: 0.05 },
  warning_yellow: { color: 0xe8b400, roughness: 0.5, metalness: 0.1 },
};

const STATIC_OBJ_MATERIAL_BY_MESH: Record<string, keyof typeof STATIC_OBJ_MATERIALS> = {
  base_plate: 'steel_housing',
  base_pedestal: 'safety_orange',
  cable_conduit: 'cable_rubber',
  turret_body: 'steel_housing',
  turret_collar: 'chrome_joint',
  shoulder_housing: 'safety_orange',
  shoulder_axle: 'chrome_joint',
  upper_arm: 'safety_orange',
  upper_arm_rib: 'steel_housing',
  upper_arm_stripe: 'warning_yellow',
  elbow_axle: 'chrome_joint',
  forearm: 'safety_orange',
  forearm_motor_housing: 'steel_housing',
  wrist_ball: 'chrome_joint',
  wrist_link: 'steel_housing',
  tool_flange: 'chrome_joint',
  gripper_body: 'steel_housing',
  gripper_finger_L: 'steel_housing',
  gripper_pad_L: 'cable_rubber',
  gripper_finger_R: 'steel_housing',
  gripper_pad_R: 'cable_rubber',
};

for (let index = 0; index < 8; index += 1) {
  STATIC_OBJ_MATERIAL_BY_MESH[`base_bolt_${index}`] = 'chrome_joint';
}

const makePart = (partId: string, name: string, object: THREE.Object3D | undefined, staticPart: boolean, sourceSchema: string): MechanicalPart => ({
  id: partId,
  name,
  meshObjectIds: object?.name ? [object.name] : [],
  localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: object
    ? boundsFromObject(object)
    : {
        min: [0, 0, 0],
        max: [0, 0, 0],
        size: [0, 0, 0],
        center: [0, 0, 0],
      },
  static: staticPart,
  visible: true,
  source: 'imported',
  metadata: {
    sourceSchema,
    professionalRig: true,
  },
});

const makeStaticObjMaterial = (name: keyof typeof STATIC_OBJ_MATERIALS) => {
  const spec = STATIC_OBJ_MATERIALS[name];
  return new THREE.MeshStandardMaterial({
    name,
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
  });
};

export const applyStaticObjRobotMaterials = (scene: THREE.Object3D) => {
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (name: keyof typeof STATIC_OBJ_MATERIALS) => {
    const cached = materialCache.get(name);
    if (cached) return cached;
    const material = makeStaticObjMaterial(name);
    materialCache.set(name, material);
    return material;
  };

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materialName =
      STATIC_OBJ_MATERIAL_BY_MESH[mesh.name] ??
      (/bolt|axle|collar|ball|flange/i.test(mesh.name)
        ? 'chrome_joint'
        : /upper_arm|forearm|pedestal|shoulder_housing/i.test(mesh.name)
          ? 'safety_orange'
          : /pad|cable/i.test(mesh.name)
            ? 'cable_rubber'
            : /stripe/i.test(mesh.name)
              ? 'warning_yellow'
              : 'steel_housing');
    mesh.material = materialFor(materialName);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
};

const boundsFromObjects = (objects: THREE.Object3D[]) => {
  const box = new THREE.Box3();
  objects.forEach((object) => {
    object.updateMatrixWorld(true);
    box.expandByObject(object);
  });
  if (box.isEmpty()) {
    return {
      min: [0, 0, 0] as Vector3Tuple,
      max: [0, 0, 0] as Vector3Tuple,
      size: [0, 0, 0] as Vector3Tuple,
      center: [0, 0, 0] as Vector3Tuple,
    };
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(center),
  };
};

const centerOfObject = (objects: Map<string, THREE.Object3D>, name: string): Vector3Tuple | undefined => {
  const object = objects.get(name);
  if (!object) return undefined;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return undefined;
  const center = new THREE.Vector3();
  box.getCenter(center);
  return tuple(center);
};

const vectorFrom = (a: Vector3Tuple | undefined, b: Vector3Tuple | undefined): Vector3Tuple | undefined =>
  a && b ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : undefined;

const vectorLength = (value: Vector3Tuple | undefined) => (value ? Math.hypot(value[0], value[1], value[2]) : 0);

const normalizedVector = (value: Vector3Tuple | undefined, fallback: Vector3Tuple): Vector3Tuple => {
  const length = vectorLength(value);
  return length > EPSILON && value ? [value[0] / length, value[1] / length, value[2] / length] : fallback;
};

const crossVector = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dotVector = (a: Vector3Tuple, b: Vector3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const signedAngleAroundAxis = (fromInput: Vector3Tuple, toInput: Vector3Tuple | undefined, axisInput: Vector3Tuple) => {
  const from = normalizedVector(fromInput, [0, 1, 0]);
  const to = normalizedVector(toInput, from);
  const axis = normalizedVector(axisInput, [0, 0, 1]);
  const sin = dotVector(axis, crossVector(from, to));
  const cos = Math.max(-1, Math.min(1, dotVector(from, to)));
  return Math.atan2(sin, cos);
};

const inferStaticObjRigFrame = (objects: Map<string, THREE.Object3D>) => {
  const base = centerOfObject(objects, 'turret_collar') ?? ([0, 0.38, 0] as Vector3Tuple);
  const shoulder = centerOfObject(objects, 'shoulder_axle') ?? ([0.02, 0.9, 0] as Vector3Tuple);
  const elbow = centerOfObject(objects, 'elbow_axle') ?? ([0.02, 1.52, 0] as Vector3Tuple);
  const wrist = centerOfObject(objects, 'wrist_ball') ?? ([0.02, 1.98, 0] as Vector3Tuple);
  const tool = centerOfObject(objects, 'tool_flange') ?? centerOfObject(objects, 'gripper_body') ?? ([0.02, 2.12, 0] as Vector3Tuple);
  const leftFinger = centerOfObject(objects, 'gripper_finger_L') ?? ([-0.065, 2.24, 0] as Vector3Tuple);
  const rightFinger = centerOfObject(objects, 'gripper_finger_R') ?? ([0.105, 2.24, 0] as Vector3Tuple);
  const upperVector = vectorFrom(elbow, shoulder);
  const forearmVector = vectorFrom(wrist, elbow);
  const wristVector = vectorFrom(tool, wrist);
  const pitchAxis = normalizedVector(crossVector(normalizedVector(upperVector, [0, 1, 0]), normalizedVector(forearmVector, [1, 0, 0])), [0, 0, 1]);
  const gripperAxis = normalizedVector(vectorFrom(rightFinger, leftFinger), [1, 0, 0]);
  const toolAxis = normalizedVector(wristVector, [0, 1, 0]);
  const upperAngle = signedAngleAroundAxis([0, 1, 0], upperVector, pitchAxis);
  const forearmAngle = signedAngleAroundAxis([0, 1, 0], forearmVector, pitchAxis);
  const wristAngle = signedAngleAroundAxis([0, 1, 0], wristVector, pitchAxis);

  return {
    origins: {
      J1_base_yaw: base,
      J2_shoulder_pitch: shoulder,
      J3_elbow_pitch: elbow,
      J4_wrist_pitch: wrist,
      J5_tool_roll: tool,
      J6_gripper_finger_L: leftFinger,
      J6_gripper_finger_R: rightFinger,
    } as Record<string, Vector3Tuple>,
    axes: {
      J1_base_yaw: [0, 1, 0] as Vector3Tuple,
      J2_shoulder_pitch: pitchAxis,
      J3_elbow_pitch: pitchAxis,
      J4_wrist_pitch: pitchAxis,
      J5_tool_roll: toolAxis,
      J6_gripper_finger_L: gripperAxis,
      J6_gripper_finger_R: gripperAxis,
    } as Record<string, Vector3Tuple>,
    restValues: {
      J1_base_yaw: Math.atan2(pitchAxis[0], pitchAxis[2]),
      J2_shoulder_pitch: upperAngle,
      J3_elbow_pitch: forearmAngle - upperAngle,
      J4_wrist_pitch: wristAngle - forearmAngle,
      J5_tool_roll: 0,
      J6_gripper_finger_L: 0,
      J6_gripper_finger_R: 0,
    } as Record<string, number>,
  };
};

const makeStaticObjPart = (partId: string, name: string, meshObjectIds: string[], objects: Map<string, THREE.Object3D>, staticPart: boolean, sourceSchema: string): MechanicalPart => {
  const meshObjects = meshObjectIds.map((meshName) => objects.get(meshName)).filter((object): object is THREE.Object3D => Boolean(object));
  return {
    id: partId,
    name,
    meshObjectIds: meshObjects.map((object) => object.name),
    localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    bounds: boundsFromObjects(meshObjects),
    static: staticPart,
    visible: true,
    source: 'imported',
    metadata: {
      sourceSchema,
      professionalRig: true,
      recoveredFromStaticObj: true,
    },
  };
};

const staticObjMotionClips = (joints: KinematicJoint[], restValueByJointId: Map<string, number>, gripper: NonNullable<RobotArmRigMetadata['gripper']>): KinematicMotionClip[] => {
  const valueForKey = (joint: KinematicJoint, key: RobotArmPoseKey) => {
    const order = joint.evidence[0]?.metadata?.order;
    const restValue = restValueByJointId.get(joint.id) ?? 0;
    if (typeof order === 'string' && order !== 'J6') {
      const value = key[order as keyof RobotArmPoseKey];
      return Number.isFinite(value) ? (value as number) * DEG_TO_RAD - restValue : undefined;
    }
    if (order === 'J6' && Number.isFinite(key.grip)) {
      const open = gripper.openMeters ?? 0.085;
      const closed = gripper.closedMeters ?? 0.032;
      const travel = open - closed;
      const closeValue = travel * (1 - (key.grip as number));
      return /finger_l$/i.test(joint.name) ? closeValue : -closeValue;
    }
    return undefined;
  };

  return ROBOT_ARM_RIG_CLIPS.map((clip) => ({
    id: id('clip', clip.name),
    name: clip.name,
    duration: clip.durationSec,
    loop: clip.loop,
    source: 'imported',
    description: clip.description,
    keyframes: clip.keys.map((key) => ({
      time: key.t,
      label: key.phase,
      jointValues: Object.fromEntries(
        joints
          .map((joint) => [joint.id, valueForKey(joint, key)] as const)
          .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
      ),
    })),
  }));
};

export const createProfessionalRobotRigFromStaticObj = (scene: THREE.Object3D, fileName: string): ProfessionalRigImport | undefined => {
  if (!/brazo-robot-industrial\.obj$/i.test(fileName)) return undefined;
  scene.updateMatrixWorld(true);
  const objects = objectMapByName(scene);
  const hasRequiredMeshes = ['base_plate', 'turret_body', 'upper_arm', 'forearm', 'wrist_link', 'gripper_finger_L', 'gripper_finger_R'].every((name) => objects.has(name));
  if (!hasRequiredMeshes) return undefined;

  applyStaticObjRobotMaterials(scene);

  const sourceSchema = 'robot-arm-rig/1.0';
  const recoveredFrame = inferStaticObjRigFrame(objects);
  const rootPartId = id('part', 'BASE_fixed');
  const partIdByName = new Map<string, string>([['BASE_fixed', rootPartId]]);
  const parts: MechanicalPart[] = [makeStaticObjPart(rootPartId, 'BASE_fixed', STATIC_OBJ_MESH_IDS.BASE_fixed, objects, true, sourceSchema)];
  STATIC_OBJ_JOINTS.forEach((metadata) => {
    const partId = id('part', metadata.name);
    partIdByName.set(metadata.name, partId);
    parts.push(makeStaticObjPart(partId, metadata.name, STATIC_OBJ_MESH_IDS[metadata.name] ?? [], objects, metadata.type === 'fixed', sourceSchema));
  });

  const homeJointValues: Record<string, number> = {};
  const restValueByJointId = new Map<string, number>();
  const importedJoints: ImportedJointPose[] = [];
  const joints: KinematicJoint[] = [];
  const gripper = { type: 'parallel_2_finger', axis: 'X' as RigAxis, openMeters: 0.085, closedMeters: 0.032, strokeMeters: 0.106 };

  STATIC_OBJ_JOINTS.forEach((metadata) => {
    const childPartId = partIdByName.get(metadata.name);
    const parentPartId = partIdByName.get(metadata.parent ?? 'BASE_fixed') ?? rootPartId;
    const axis = normalizeAxis(recoveredFrame.axes[metadata.name] ?? axisVector(metadata.axis));
    const origin = recoveredFrame.origins[metadata.name] ?? metadata.originMeters;
    if (!childPartId || !axis || !origin) return;
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Recovered from the robot OBJ companion rig. The OBJ geometry remains unchanged.'],
    }, 'accepted');
    if (!frame) return;

    const restValue = recoveredFrame.restValues[metadata.name] ?? 0;
    const limits = absoluteLimits(metadata);
    const isStaticGripper = metadata.type === 'prismatic' && /finger_[lr]$/i.test(metadata.name);
    const gripperTravel = (gripper.openMeters ?? 0.085) - (gripper.closedMeters ?? 0.032);
    const lower = isStaticGripper ? (/finger_l$/i.test(metadata.name) ? 0 : -gripperTravel) : limits ? Math.min(limits[0] - restValue, limits[1] - restValue) : undefined;
    const upper = isStaticGripper ? (/finger_l$/i.test(metadata.name) ? gripperTravel : 0) : limits ? Math.max(limits[0] - restValue, limits[1] - restValue) : undefined;
    const jointId = id('joint', metadata.name);
    homeJointValues[jointId] = 0;
    restValueByJointId.set(jointId, restValue);
    importedJoints.push({
      name: metadata.name,
      label: metadata.name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: metadata.type === 'prismatic' ? 'translation' : 'rotation',
      axis: axisKey(metadata.axis),
      cursorControl: metadata.type === 'prismatic' ? 'linear-axis' : metadata.axis === 'Y' ? 'horizontal-rotation' : 'vertical-rotation',
      min: lower,
      max: upper,
      demoAmplitude: metadata.type === 'prismatic' ? Math.min(Math.abs(upper ?? 0), 0.06) : Math.min(Math.abs(upper ?? 0), 0.9),
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });
    joints.push({
      id: jointId,
      name: metadata.name,
      parentPartId,
      childPartId,
      type: metadata.type === 'continuous' ? 'continuous' : metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'fixed' ? 'fixed' : 'revolute',
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits:
        lower !== undefined || upper !== undefined
          ? {
              lower,
              upper,
              velocity: metadata.type === 'prismatic' ? metadata.maxSpeedMetersPerSec : metadata.maxSpeedDegPerSec ? metadata.maxSpeedDegPerSec * DEG_TO_RAD : undefined,
            }
          : undefined,
      source: 'imported',
      confidence: 0.96,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.96,
          message: `Recovered static OBJ robot joint ${metadata.name}: ${metadata.type} ${metadata.axis}.`,
          metadata: {
            sourceSchema,
            order: metadata.order,
            absoluteLimits: limits,
            absoluteHome: restValue,
            restValue,
            recoveredFromStaticObj: true,
            recoveredOrigin: origin,
            recoveredAxis: axis,
            units: metadata.type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const left = joints.find((joint) => /finger_l$/i.test(joint.name));
  const right = joints.find((joint) => /finger_r$/i.test(joint.name));
  if (left && right) {
    right.coupling = { driverJointId: left.id, multiplier: -1, offset: 0 };
  }

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      logicalControls:
        left && right
          ? [
              {
                id: 'control_gripper_opening',
                name: 'Parallel gripper opening',
                jointMappings: [
                  { jointId: left.id, multiplier: 1, offset: 0 },
                  { jointId: right.id, multiplier: -1, offset: 0 },
                ],
              },
            ]
          : undefined,
      motionClips: staticObjMotionClips(joints, restValueByJointId, gripper),
      analysisVersion: 'professional-rig-1-static-obj',
    },
    kinematicState: {
      homeJointValues,
      jointValues: { ...homeJointValues },
    },
    rigRootName: 'IndustrialRobotArm',
    sourceSchema,
  };
};

export const extractProfessionalRobotRig = (scene: THREE.Object3D): ProfessionalRigImport | undefined => {
  scene.updateMatrixWorld(true);
  const rig = findRigRoot(scene);
  if (!rig || !rig.metadata.joints?.length) return undefined;

  const objects = objectMapByName(scene);
  const rigJointNames = new Set(rig.metadata.joints.map((joint) => joint.name));
  const sourceSchema = rig.metadata.schema;
  const rootPartId = id('part', rig.root.name || 'professional_robot_root');
  const baseObject = objects.get('BASE_fixed') ?? rig.root;
  const parts: MechanicalPart[] = [makePart(rootPartId, baseObject.name || 'BASE fixed', baseObject, true, sourceSchema)];
  const partIdByJointName = new Map<string, string>();
  const homeJointValues: Record<string, number> = {};
  const restValueByJointId = new Map<string, number>();
  const importedJoints: ImportedJointPose[] = [];

  rig.metadata.joints.forEach((metadata) => {
    const object = objects.get(metadata.name);
    if (!object) return;
    const partId = id('part', metadata.name);
    partIdByJointName.set(metadata.name, partId);
    parts.push(makePart(partId, metadata.name, object, metadata.type === 'fixed', sourceSchema));
  });

  const joints: KinematicJoint[] = [];
  rig.metadata.joints.forEach((metadata) => {
    const object = objects.get(metadata.name);
    const childPartId = partIdByJointName.get(metadata.name);
    if (!object || !childPartId) return;

    const axis = normalizeAxis(parentAxisWorld(object, metadata.axis));
    if (!axis) return;
    const origin = jointWorldOrigin(object);
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Imported from professional robot rig metadata; click points are not used as pivots.'],
    }, 'accepted');
    if (!frame) return;

    const parentRigName = nearestRigAncestor(object, rigJointNames, rig.root);
    const parentPartId = parentRigName ? partIdByJointName.get(parentRigName) ?? rootPartId : rootPartId;
    const restValue = localJointValue(object, metadata);
    const limits = absoluteLimits(metadata);
    const homeValue = absoluteHome(metadata, rig.metadata, restValue);
    const lower = limits ? Math.min(limits[0] - restValue, limits[1] - restValue) : undefined;
    const upper = limits ? Math.max(limits[0] - restValue, limits[1] - restValue) : undefined;
    const jointId = id('joint', metadata.name);

    homeJointValues[jointId] = homeValue - restValue;
    restValueByJointId.set(jointId, restValue);
    importedJoints.push({
      name: metadata.name,
      label: metadata.name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: metadata.type === 'prismatic' ? 'translation' : 'rotation',
      axis: axisKey(metadata.axis),
      cursorControl: metadata.type === 'prismatic' ? 'linear-axis' : metadata.axis === 'Y' ? 'horizontal-rotation' : 'vertical-rotation',
      min: lower,
      max: upper,
      demoAmplitude: metadata.type === 'prismatic' ? Math.min(Math.abs(upper ?? 0), 0.06) : Math.min(Math.abs(upper ?? 0), 0.9),
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });

    joints.push({
      id: jointId,
      name: metadata.name,
      parentPartId,
      childPartId,
      type: metadata.type === 'continuous' ? 'continuous' : metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'fixed' ? 'fixed' : 'revolute',
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits:
        lower !== undefined || upper !== undefined
          ? {
              lower,
              upper,
              velocity: metadata.maxSpeedDegPerSec ? metadata.maxSpeedDegPerSec * DEG_TO_RAD : undefined,
            }
          : undefined,
      source: 'imported',
      confidence: 0.98,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.98,
          message: `Professional rig joint ${metadata.name}: ${metadata.type} ${metadata.axis}.`,
          metadata: {
            sourceSchema,
            order: metadata.order,
            absoluteLimits: limits,
            absoluteHome: homeValue,
            restValue,
            units: metadata.type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const left = joints.find((joint) => /finger_l$/i.test(joint.name));
  const right = joints.find((joint) => /finger_r$/i.test(joint.name));
  if (left && right) {
    right.coupling = { driverJointId: left.id, multiplier: -1, offset: 0 };
  }

  const valueForKey = (joint: KinematicJoint, key: RobotArmPoseKey) => {
    const order = joint.evidence[0]?.metadata?.order;
    const restValue = restValueByJointId.get(joint.id) ?? 0;
    if (typeof order === 'string' && order !== 'J6') {
      const value = key[order as keyof RobotArmPoseKey];
      return Number.isFinite(value) ? (value as number) * DEG_TO_RAD - restValue : undefined;
    }
    if (order === 'J6' && Number.isFinite(key.grip)) {
      const open = rig.metadata.gripper?.openMeters ?? 0.085;
      const closed = rig.metadata.gripper?.closedMeters ?? 0.032;
      const x = closed + (open - closed) * (key.grip as number);
      const absolute = /finger_l$/i.test(joint.name) ? -x : x;
      return absolute - restValue;
    }
    return undefined;
  };

  const motionClips: KinematicMotionClip[] = ROBOT_ARM_RIG_CLIPS.map((clip) => ({
    id: id('clip', clip.name),
    name: clip.name,
    duration: clip.durationSec,
    loop: clip.loop,
    source: 'imported',
    description: clip.description,
    keyframes: clip.keys.map((key) => ({
      time: key.t,
      label: key.phase,
      jointValues: Object.fromEntries(
        joints
          .map((joint) => [joint.id, valueForKey(joint, key)] as const)
          .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
      ),
    })),
  }));

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      logicalControls:
        left && right
          ? [
              {
                id: 'control_gripper_opening',
                name: 'Parallel gripper opening',
                jointMappings: [
                  { jointId: left.id, multiplier: 1, offset: 0 },
                  { jointId: right.id, multiplier: -1, offset: 0 },
                ],
              },
            ]
          : undefined,
      motionClips,
      analysisVersion: 'professional-rig-1',
    },
    kinematicState: {
      homeJointValues,
      jointValues: { ...homeJointValues },
    },
    rigRootName: rig.root.name || 'ProfessionalRobotRig',
    sourceSchema,
  };
};
