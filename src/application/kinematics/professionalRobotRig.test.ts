import * as THREE from 'three';
import { createProfessionalRobotRigFromStaticObj, extractProfessionalRobotRig } from './professionalRobotRig';
import { evaluateForwardKinematics, setJointValue, transformPoint, validateKinematicGraph } from './kinematicAuthoring';

const deg = THREE.MathUtils.degToRad;

const mesh = (name: string, y = 0.05) => {
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
  object.name = name;
  object.position.y = y;
  return object;
};

const buildProfessionalRobotFixture = () => {
  const root = new THREE.Group();
  root.name = 'IndustrialRobotArm';
  root.userData = {
    schema: 'robot-arm-rig/1.0',
    units: 'meters',
    up: 'Y',
    gripper: { type: 'parallel_2_finger', axis: 'X', openMeters: 0.085, closedMeters: 0.032, strokeMeters: 0.106 },
    joints: [
      { name: 'J1_base_yaw', order: 'J1', type: 'revolute', axis: 'Y', limitsDeg: [-170, 170], maxSpeedDegPerSec: 180, homeDeg: 0 },
      { name: 'J2_shoulder_pitch', order: 'J2', type: 'revolute', axis: 'Z', limitsDeg: [-60, 95], maxSpeedDegPerSec: 140, homeDeg: -10 },
      { name: 'J3_elbow_pitch', order: 'J3', type: 'revolute', axis: 'Z', limitsDeg: [-20, 150], maxSpeedDegPerSec: 160, homeDeg: 60 },
      { name: 'J4_wrist_pitch', order: 'J4', type: 'revolute', axis: 'Z', limitsDeg: [-110, 110], maxSpeedDegPerSec: 250, homeDeg: 60 },
      { name: 'J5_tool_roll', order: 'J5', type: 'revolute', axis: 'Y', limitsDeg: [-180, 180], maxSpeedDegPerSec: 320, homeDeg: 0 },
      { name: 'J6_gripper_finger_L', order: 'J6', type: 'prismatic', axis: 'X', limitsMeters: [-0.085, -0.032] },
      { name: 'J6_gripper_finger_R', order: 'J6', type: 'prismatic', axis: 'X', limitsMeters: [0.032, 0.085] },
    ],
  };

  const base = new THREE.Group();
  base.name = 'BASE_fixed';
  base.add(mesh('base_plate'));
  root.add(base);

  const j1 = new THREE.Group();
  j1.name = 'J1_base_yaw';
  j1.position.y = 0.38;
  j1.rotation.y = 0;
  j1.add(mesh('turret_body'));
  base.add(j1);

  const j2 = new THREE.Group();
  j2.name = 'J2_shoulder_pitch';
  j2.position.set(0.02, 0.52, 0);
  j2.rotation.z = deg(-10);
  j2.add(mesh('upper_arm', 0.31));
  j1.add(j2);

  const j3 = new THREE.Group();
  j3.name = 'J3_elbow_pitch';
  j3.position.y = 0.62;
  j3.rotation.z = deg(60);
  j3.add(mesh('forearm', 0.23));
  j2.add(j3);

  const j4 = new THREE.Group();
  j4.name = 'J4_wrist_pitch';
  j4.position.y = 0.46;
  j4.rotation.z = deg(60);
  j4.add(mesh('wrist_ball', 0));
  j3.add(j4);

  const j5 = new THREE.Group();
  j5.name = 'J5_tool_roll';
  j5.position.y = 0.14;
  j5.rotation.y = 0;
  j5.add(mesh('tool_flange', 0.04));
  j4.add(j5);

  const left = new THREE.Group();
  left.name = 'J6_gripper_finger_L';
  left.position.set(-0.085, 0.12, 0);
  left.add(mesh('gripper_finger_L', 0.09));
  j5.add(left);

  const right = new THREE.Group();
  right.name = 'J6_gripper_finger_R';
  right.position.set(0.085, 0.12, 0);
  right.add(mesh('gripper_finger_R', 0.09));
  j5.add(right);

  return root;
};

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const equal = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
};

const deepEqual = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};

const nearly = (actual: number, expected: number, tolerance = 1e-6) => ok(Math.abs(actual - expected) <= tolerance, `${actual} !== ${expected}`);
const nearlyVector = (actual: number[], expected: number[], tolerance = 1e-6) => actual.forEach((value, index) => nearly(value, expected[index], tolerance));

export const runProfessionalRobotRigTests = () => {
  const fixture = buildProfessionalRobotFixture();
  const imported = extractProfessionalRobotRig(fixture);
  if (!imported) throw new Error('Professional robot rig metadata was not detected.');
  equal(imported.kinematicGraph.analysisVersion, 'professional-rig-1', 'Unexpected professional rig analysis version');
  equal(imported.kinematicGraph.joints.length, 7, 'Unexpected professional rig joint count');
  equal(imported.kinematicGraph.motionClips?.length, 3, 'Unexpected professional rig clip count');
  deepEqual(validateKinematicGraph(imported.kinematicGraph).filter((issue) => issue.severity === 'error'), [], 'Professional rig has validation errors');

  const graph = imported.kinematicGraph;
  const joint = (name: string) => {
    const result = graph.joints.find((candidate) => candidate.name === name);
    if (!result) throw new Error(`${name} was not imported.`);
    return result;
  };

  nearlyVector(joint('J1_base_yaw').axis, [0, 1, 0]);
  nearlyVector(joint('J2_shoulder_pitch').axis, [0, 0, 1]);
  nearlyVector(joint('J5_tool_roll').axis, [-0.9396926207859084, -0.3420201433256687, 0], 1e-5);
  equal(joint('J2_shoulder_pitch').parentPartId, joint('J1_base_yaw').childPartId, 'J2 parent chain is wrong');
  equal(joint('J3_elbow_pitch').parentPartId, joint('J2_shoulder_pitch').childPartId, 'J3 parent chain is wrong');
  equal(joint('J6_gripper_finger_L').parentPartId, joint('J5_tool_roll').childPartId, 'J6 parent chain is wrong');

  nearly(joint('J2_shoulder_pitch').limits?.lower ?? 0, deg(-50));
  nearly(joint('J2_shoulder_pitch').limits?.upper ?? 0, deg(105));
  nearly(imported.kinematicState.homeJointValues[joint('J2_shoulder_pitch').id], 0);

  const left = joint('J6_gripper_finger_L');
  const right = joint('J6_gripper_finger_R');
  deepEqual(right.coupling, { driverJointId: left.id, multiplier: -1, offset: 0 }, 'Gripper mimic coupling is wrong');
  nearly(left.limits?.lower ?? -1, 0);
  nearly(left.limits?.upper ?? -1, 0.053);
  nearly(right.limits?.lower ?? 1, -0.053);
  nearly(right.limits?.upper ?? 1, 0);

  const movedState = setJointValue(graph, imported.kinematicState, joint('J2_shoulder_pitch').id, deg(45));
  const poses = evaluateForwardKinematics(graph, movedState);
  const j2Pose = poses[joint('J2_shoulder_pitch').childPartId];
  const fixedPivot = transformPoint(j2Pose.matrix, joint('J2_shoulder_pitch').origin.position);
  nearlyVector(fixedPivot, joint('J2_shoulder_pitch').origin.position, 1e-5);

  const fullCycle = graph.motionClips?.find((clip) => clip.name === 'Ciclo_Pick_And_Place');
  const axisDemo = graph.motionClips?.find((clip) => clip.name === 'Demo_Ejes');
  if (!fullCycle || !axisDemo) throw new Error('Professional motion clips were not imported.');
  equal(fullCycle.keyframes.length, 10, 'Full robot cycle keyframes were not imported');
  equal(axisDemo.keyframes.length, 15, 'Joint-by-joint demo keyframes were not imported');
  const closedGrip = fullCycle.keyframes.find((keyframe) => Math.abs(keyframe.time - 3.3) < 0.001);
  if (!closedGrip) throw new Error('Full cycle grip close keyframe is missing.');
  nearly(closedGrip.jointValues[left.id], 0.053);
  nearly(closedGrip.jointValues[right.id], -0.053);
  const j1Sweep = axisDemo.keyframes.find((keyframe) => Math.abs(keyframe.time - 1.6) < 0.001);
  if (!j1Sweep) throw new Error('Axis demo J1 sweep keyframe is missing.');
  nearly(j1Sweep.jointValues[joint('J1_base_yaw').id], deg(-170));

  const objScene = new THREE.Group();
  [
    'base_plate',
    'base_pedestal',
    'base_bolt_0',
    'base_bolt_1',
    'base_bolt_2',
    'base_bolt_3',
    'base_bolt_4',
    'base_bolt_5',
    'base_bolt_6',
    'base_bolt_7',
    'cable_conduit',
    'turret_body',
    'turret_collar',
    'shoulder_housing',
    'shoulder_axle',
    'upper_arm',
    'upper_arm_rib',
    'upper_arm_stripe',
    'elbow_axle',
    'forearm',
    'forearm_motor_housing',
    'wrist_ball',
    'wrist_link',
    'tool_flange',
    'gripper_body',
    'gripper_finger_L',
    'gripper_pad_L',
    'gripper_finger_R',
    'gripper_pad_R',
  ].forEach((name, index) => {
    const item = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.04), new THREE.MeshBasicMaterial());
    item.name = name;
    item.position.set((index % 5) * 0.05, Math.floor(index / 5) * 0.05, 0);
    objScene.add(item);
  });
  const recovered = createProfessionalRobotRigFromStaticObj(objScene, 'brazo-robot-industrial.obj');
  if (!recovered) throw new Error('Static OBJ robot rig was not recovered from known mesh names.');
  equal(recovered.kinematicGraph.analysisVersion, 'professional-rig-1-static-obj', 'Static OBJ rig analysis version is wrong');
  equal(recovered.kinematicGraph.joints.length, 7, 'Static OBJ rig did not create seven robot joints');
  equal(recovered.kinematicGraph.motionClips?.length, 3, 'Static OBJ rig did not recover professional clips');
  const upperPart = recovered.kinematicGraph.parts.find((part) => part.name === 'J2_shoulder_pitch');
  ok(Boolean(upperPart?.meshObjectIds.includes('upper_arm')), 'Static OBJ upper arm mesh was not assigned to J2.');
  const recoveredLeft = recovered.kinematicGraph.joints.find((item) => /finger_l$/i.test(item.name));
  const recoveredRight = recovered.kinematicGraph.joints.find((item) => /finger_r$/i.test(item.name));
  ok(Boolean(recoveredLeft && recoveredRight?.coupling?.driverJointId === recoveredLeft.id), 'Static OBJ gripper coupling was not restored.');
  const orange = objScene.getObjectByName('upper_arm') as THREE.Mesh;
  equal((orange.material as THREE.MeshStandardMaterial).color.getHexString(), 'd9520c', 'Static OBJ safety orange material was not restored');
};
