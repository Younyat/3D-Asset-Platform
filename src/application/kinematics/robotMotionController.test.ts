import type { KinematicGraph, KinematicJoint, KinematicState, MechanicalPart } from '../../domain/kinematics';
import {
  buildRobotDiagnosticText,
  buildRobotPickAndPlaceSequence,
  createRobotServoState,
  diagnoseRobotGraph,
  getRobotJointBindings,
  goRobotHome,
  robotPoseFromState,
  sampleKinematicMotionClip,
  setRobotJointTarget,
  setRobotPoseTarget,
  startRobotClip,
  startRobotSequence,
  updateRobotServo,
} from './robotMotionController';

const deg = (value: number) => (value * Math.PI) / 180;

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const nearly = (actual: number, expected: number, tolerance = 1e-6) => {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`Expected ${actual} near ${expected}.`);
};

const part = (id: string): MechanicalPart => ({
  id,
  name: id,
  meshObjectIds: [id],
  localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
  static: id === 'base',
  visible: true,
  source: 'imported',
  metadata: {},
});

const joint = (
  id: string,
  name: string,
  parentPartId: string,
  childPartId: string,
  order: string,
  lower: number,
  upper: number,
  home: number,
  velocity: number,
  type: KinematicJoint['type'] = 'revolute',
): KinematicJoint => ({
  id,
  name,
  parentPartId,
  childPartId,
  type,
  origin: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  axis: type === 'prismatic' ? [1, 0, 0] : order === 'J1' || order === 'J5' ? [0, 1, 0] : [0, 0, 1],
  limits: { lower, upper, velocity },
  source: 'imported',
  confidence: 0.99,
  evidence: [{ type: 'imported-hierarchy', score: 0.99, metadata: { order, restValue: 0 } }],
  status: 'validated',
});

const robotGraph = (): { graph: KinematicGraph; state: KinematicState; ids: Record<string, string> } => {
  const ids = {
    J1: 'j1',
    J2: 'j2',
    J3: 'j3',
    J4: 'j4',
    J5: 'j5',
    L: 'jl',
    R: 'jr',
  };
  const graph: KinematicGraph = {
    rootPartId: 'base',
    parts: ['base', 'p1', 'p2', 'p3', 'p4', 'p5', 'pl', 'pr'].map(part),
    joints: [
      joint(ids.J1, 'J1_base_yaw', 'base', 'p1', 'J1', deg(-170), deg(170), 0, deg(180)),
      joint(ids.J2, 'J2_shoulder_pitch', 'p1', 'p2', 'J2', deg(-50), deg(105), 0, deg(140)),
      joint(ids.J3, 'J3_elbow_pitch', 'p2', 'p3', 'J3', deg(-80), deg(90), 0, deg(160)),
      joint(ids.J4, 'J4_wrist_pitch', 'p3', 'p4', 'J4', deg(-170), deg(50), 0, deg(250)),
      joint(ids.J5, 'J5_tool_roll', 'p4', 'p5', 'J5', deg(-180), deg(180), 0, deg(320)),
      joint(ids.L, 'J6_gripper_finger_L', 'p5', 'pl', 'J6', 0, 0.053, 0.053, 0.12, 'prismatic'),
      {
        ...joint(ids.R, 'J6_gripper_finger_R', 'p5', 'pr', 'J6', -0.053, 0, -0.053, 0.12, 'prismatic'),
        coupling: { driverJointId: ids.L, multiplier: -1, offset: 0 },
      },
    ],
    motionClips: [
      {
        id: 'clip_pick',
        name: 'Ciclo_Pick_And_Place',
        duration: 10,
        loop: true,
        source: 'imported',
        keyframes: [
          { time: 0, jointValues: { [ids.J1]: 0, [ids.J2]: 0, [ids.J3]: 0, [ids.J4]: 0, [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 5, jointValues: { [ids.J1]: deg(55), [ids.J2]: deg(60), [ids.J3]: deg(10), [ids.J4]: deg(-20), [ids.J5]: deg(90), [ids.L]: 0, [ids.R]: 0 } },
          { time: 10, jointValues: { [ids.J1]: 0, [ids.J2]: 0, [ids.J3]: 0, [ids.J4]: 0, [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
        ],
      },
      {
        id: 'clip_home',
        name: 'Ir_A_Home',
        duration: 2,
        loop: false,
        source: 'imported',
        keyframes: [
          { time: 0, jointValues: { [ids.J1]: deg(45), [ids.L]: 0 } },
          { time: 2, jointValues: { [ids.J1]: 0, [ids.L]: 0.053 } },
        ],
      },
      {
        id: 'clip_axis',
        name: 'Demo_Ejes',
        duration: 16.2,
        loop: true,
        source: 'imported',
        keyframes: [
          { time: 0, jointValues: { [ids.J1]: 0 } },
          { time: 1.6, jointValues: { [ids.J1]: deg(-170) } },
          { time: 4, jointValues: { [ids.J1]: deg(170) } },
        ],
      },
    ],
    analysisVersion: 'professional-rig-1',
  };
  const state: KinematicState = {
    homeJointValues: {
      [ids.J1]: 0,
      [ids.J2]: 0,
      [ids.J3]: 0,
      [ids.J4]: 0,
      [ids.J5]: 0,
      [ids.L]: 0.053,
      [ids.R]: -0.053,
    },
    jointValues: {
      [ids.J1]: 0,
      [ids.J2]: 0,
      [ids.J3]: 0,
      [ids.J4]: 0,
      [ids.J5]: 0,
      [ids.L]: 0.053,
      [ids.R]: -0.053,
    },
  };
  return { graph, state, ids };
};

export const runRobotMotionControllerTests = () => {
  const { graph, state, ids } = robotGraph();
  const bindings = getRobotJointBindings(graph, state);
  ok(bindings.length === 7, 'Controller did not bind the seven moving robot nodes.');
  ok(bindings.map((binding) => binding.key).join(',') === 'J1,J2,J3,J4,J5,J6L,J6R', 'Controller binding order is wrong.');

  const diagnosis = diagnoseRobotGraph(graph, state);
  ok(diagnosis.compatible, buildRobotDiagnosticText(diagnosis));
  ok(diagnosis.nodesFound.J1_base_yaw && diagnosis.clipsFound.Demo_Ejes, 'Diagnosis did not find nodes and clips.');

  const sampled = sampleKinematicMotionClip(graph.motionClips![0], 2.5);
  ok(sampled[ids.J1] > 0 && sampled[ids.J5] > 0, 'Imported clip sampling did not interpolate robot joints.');
  nearly(sampleKinematicMotionClip(graph.motionClips![1], 5)[ids.J1], 0);

  let controller = createRobotServoState(graph, state, 1);
  controller = setRobotJointTarget(graph, controller, 'J1', 90);
  let update = updateRobotServo(graph, controller, 0.1, state);
  ok(update.kinematicState.jointValues[ids.J1] > 0, 'Servo did not start moving J1 toward target.');
  ok(update.kinematicState.jointValues[ids.J1] <= deg(18) + 1e-6, 'Servo ignored J1 velocity limit.');

  controller = setRobotPoseTarget(graph, createRobotServoState(graph, state), { J1: -40, J2: 50, J3: 70, J4: 60, J5: 90, grip: 0 });
  let targetState = state;
  for (let index = 0; index < 160; index += 1) {
    update = updateRobotServo(graph, controller, 0.05, targetState);
    controller = update.state;
    targetState = update.kinematicState;
  }
  ok(update.kinematicState.jointValues[ids.L] < 0.01, 'Grip close target did not drive left finger closed.');

  controller = startRobotClip(createRobotServoState(graph, state), graph.motionClips![0]);
  let clipState = state;
  for (let index = 0; index < 100; index += 1) {
    update = updateRobotServo(graph, controller, 0.05, clipState);
    controller = update.state;
    clipState = update.kinematicState;
  }
  ok(update.kinematicState.jointValues[ids.J1] > deg(40), 'Controller clip playback did not advance to the transfer pose.');

  controller = startRobotSequence(createRobotServoState(graph, state), 'test pick and place', buildRobotPickAndPlaceSequence());
  let sequenceState = state;
  for (let index = 0; index < 420; index += 1) {
    update = updateRobotServo(graph, controller, 0.05, sequenceState);
    controller = update.state;
    sequenceState = update.kinematicState;
  }
  ok(controller.sequence?.completed === true, 'Programmatic pick-and-place sequence did not complete.');
  const pose = robotPoseFromState(graph, sequenceState);
  nearly(pose.J1 ?? 1, 0, 1);
  ok((pose.grip ?? 0) > 0.95, 'Programmatic sequence did not return gripper to open Home.');

  controller = goRobotHome(graph, { ...controller, current: { ...sequenceState.jointValues }, target: { ...sequenceState.jointValues } }, true);
  nearly(controller.current[ids.J1], 0);
  nearly(controller.current[ids.L], 0.053);
};
