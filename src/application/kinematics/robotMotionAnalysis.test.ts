import type { KinematicGraph, KinematicJoint, KinematicState, MechanicalPart } from '../../domain/kinematics';
import { analyzeRobotMotion, summarizeRobotMotionAnalysis } from './robotMotionAnalysis';
import { buildRobotPickAndPlaceSequence } from './robotMotionController';

const deg = (value: number) => (value * Math.PI) / 180;

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
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

const fixture = (): { graph: KinematicGraph; state: KinematicState; ids: Record<string, string> } => {
  const ids = { J1: 'j1', J2: 'j2', J3: 'j3', J4: 'j4', J5: 'j5', L: 'jl', R: 'jr' };
  const graph: KinematicGraph = {
    rootPartId: 'base',
    parts: ['base', 'p1', 'p2', 'p3', 'p4', 'p5', 'pl', 'pr'].map(part),
    joints: [
      joint(ids.J1, 'J1_base_yaw', 'base', 'p1', 'J1', deg(-170), deg(170), deg(180)),
      joint(ids.J2, 'J2_shoulder_pitch', 'p1', 'p2', 'J2', deg(-60), deg(95), deg(140)),
      joint(ids.J3, 'J3_elbow_pitch', 'p2', 'p3', 'J3', deg(-20), deg(150), deg(160)),
      joint(ids.J4, 'J4_wrist_pitch', 'p3', 'p4', 'J4', deg(-110), deg(110), deg(250)),
      joint(ids.J5, 'J5_tool_roll', 'p4', 'p5', 'J5', deg(-180), deg(180), deg(320)),
      joint(ids.L, 'J6_gripper_finger_L', 'p5', 'pl', 'J6', 0, 0.053, 0.12, 'prismatic'),
      {
        ...joint(ids.R, 'J6_gripper_finger_R', 'p5', 'pr', 'J6', -0.053, 0, 0.12, 'prismatic'),
        coupling: { driverJointId: ids.L, multiplier: -1, offset: 0 },
      },
    ],
    motionClips: [
      {
        id: 'good',
        name: 'Ciclo_Pick_And_Place',
        duration: 10,
        loop: true,
        source: 'imported',
        keyframes: [
          { time: 0, jointValues: { [ids.J1]: 0, [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 2, jointValues: { [ids.J1]: deg(-40), [ids.J2]: deg(50), [ids.J3]: deg(70), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 4, jointValues: { [ids.J1]: deg(-40), [ids.J2]: deg(70), [ids.J3]: deg(70), [ids.J4]: deg(40), [ids.J5]: 0, [ids.L]: 0, [ids.R]: 0 } },
          { time: 8, jointValues: { [ids.J1]: deg(55), [ids.J2]: deg(50), [ids.J3]: deg(70), [ids.J4]: deg(60), [ids.J5]: deg(90), [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 10, jointValues: { [ids.J1]: 0, [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
        ],
      },
      {
        id: 'axis',
        name: 'Demo_Ejes',
        duration: 16.2,
        loop: true,
        source: 'imported',
        keyframes: [
          { time: 0, jointValues: { [ids.J1]: 0, [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 1.6, jointValues: { [ids.J1]: deg(-170), [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
          { time: 4, jointValues: { [ids.J1]: deg(170), [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 } },
        ],
      },
    ],
    analysisVersion: 'professional-rig-1',
  };
  const state: KinematicState = {
    homeJointValues: { [ids.J1]: 0, [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 },
    jointValues: { [ids.J1]: 0, [ids.J2]: deg(-10), [ids.J3]: deg(60), [ids.J4]: deg(60), [ids.J5]: 0, [ids.L]: 0.053, [ids.R]: -0.053 },
  };
  return { graph, state, ids };
};

export const runRobotMotionAnalysisTests = () => {
  const { graph, state, ids } = fixture();
  const report = analyzeRobotMotion(graph, state, buildRobotPickAndPlaceSequence());
  ok(report.jointCount === 7, 'Analysis did not detect seven robot joints.');
  ok(report.clipCount === 2, 'Analysis did not inspect imported clips.');
  ok(report.joints.every((jointReport) => jointReport.appearsInClips.length > 0), 'Analysis found robot joints missing from all clips.');
  ok(report.sequenceStepCount === buildRobotPickAndPlaceSequence().length, 'Analysis did not inspect programmatic sequence.');
  ok(!report.issues.some((item) => item.code === 'GRIPPER_NOT_MIRRORED'), summarizeRobotMotionAnalysis(report));

  const brokenMirror: KinematicGraph = {
    ...graph,
    motionClips: graph.motionClips?.map((clip) =>
      clip.id === 'good'
        ? {
            ...clip,
            keyframes: clip.keyframes.map((keyframe) =>
              keyframe.time === 4 ? { ...keyframe, jointValues: { ...keyframe.jointValues, [ids.R]: -0.02 } } : keyframe,
            ),
          }
        : clip,
    ),
  };
  const mirrorReport = analyzeRobotMotion(brokenMirror, state, buildRobotPickAndPlaceSequence());
  ok(mirrorReport.issues.some((item) => item.code === 'GRIPPER_NOT_MIRRORED'), 'Analysis did not detect a non-mirrored gripper.');

  const outOfLimits: KinematicGraph = {
    ...graph,
    motionClips: graph.motionClips?.map((clip) =>
      clip.id === 'axis'
        ? {
            ...clip,
            keyframes: clip.keyframes.map((keyframe) =>
              keyframe.time === 4 ? { ...keyframe, jointValues: { ...keyframe.jointValues, [ids.J1]: deg(240) } } : keyframe,
            ),
          }
        : clip,
    ),
  };
  const limitsReport = analyzeRobotMotion(outOfLimits, state, buildRobotPickAndPlaceSequence());
  ok(limitsReport.issues.some((item) => item.code === 'CLIP_VALUE_OUT_OF_LIMITS'), 'Analysis did not detect out-of-limit clip value.');

  const incompleteClip: KinematicGraph = {
    ...graph,
    motionClips: [
      {
        id: 'minimal',
        name: 'Minimal',
        duration: 1,
        loop: false,
        source: 'manual',
        keyframes: [{ time: 0, jointValues: { [ids.J1]: 0 } }],
      },
    ],
  };
  const incompleteReport = analyzeRobotMotion(incompleteClip, state, []);
  ok(incompleteReport.issues.some((item) => item.code === 'CLIP_MISSING_JOINTS'), 'Analysis did not detect incomplete clip coverage.');
  ok(incompleteReport.issues.some((item) => item.code === 'SEQUENCE_WITHOUT_GRIP' || item.code === 'EMPTY_SEQUENCE'), 'Analysis did not inspect empty sequence.');
};
