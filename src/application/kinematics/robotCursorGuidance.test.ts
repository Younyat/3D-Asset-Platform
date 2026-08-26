import type { KinematicGraph, KinematicJoint, KinematicState, MechanicalPart } from '../../domain/kinematics';
import { inferRobotArmGeometry, solveRobotArmCursorTarget } from './robotCursorGuidance';

const deg = (value: number) => (value * Math.PI) / 180;

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const part = (id: string): MechanicalPart => ({
  id,
  name: id,
  meshObjectIds: [id],
  localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1], size: [0.2, 0.2, 0.2], center: [0, 0, 0] },
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
  origin: [number, number, number],
  lower: number,
  upper: number,
  rest: number,
  home: number,
  axis: [number, number, number],
): KinematicJoint => ({
  id,
  name,
  parentPartId,
  childPartId,
  type: 'revolute',
  origin: { position: origin, rotation: [0, 0, 0, 1] },
  axis,
  limits: { lower: lower - rest, upper: upper - rest, velocity: deg(180) },
  source: 'imported',
  confidence: 0.99,
  evidence: [{ type: 'imported-hierarchy', score: 0.99, metadata: { order, restValue: rest, absoluteHome: home, units: 'radians' } }],
  status: 'validated',
});

const robotGraph = (): { graph: KinematicGraph; state: KinematicState; ids: Record<string, string> } => {
  const ids = {
    J1: 'joint-base',
    J2: 'joint-shoulder',
    J3: 'joint-elbow',
    J4: 'joint-wrist',
    J5: 'joint-tool',
  };
  const graph: KinematicGraph = {
    rootPartId: 'base',
    parts: ['base', 'turret', 'upper', 'forearm', 'wrist', 'tool'].map(part),
    joints: [
      joint(ids.J1, 'J1_base_yaw', 'base', 'turret', 'J1', [0, 0.38, 0], deg(-170), deg(170), 0, 0, [0, 1, 0]),
      joint(ids.J2, 'J2_shoulder_pitch', 'turret', 'upper', 'J2', [0.02, 0.9, 0], deg(-60), deg(95), deg(-10), deg(-10), [0, 0, 1]),
      joint(ids.J3, 'J3_elbow_pitch', 'upper', 'forearm', 'J3', [0.02, 1.52, 0], deg(-20), deg(150), deg(60), deg(60), [0, 0, 1]),
      joint(ids.J4, 'J4_wrist_pitch', 'forearm', 'wrist', 'J4', [0.02, 1.98, 0], deg(-110), deg(110), deg(60), deg(60), [0, 0, 1]),
      joint(ids.J5, 'J5_tool_roll', 'wrist', 'tool', 'J5', [0.02, 2.12, 0], deg(-180), deg(180), 0, 0, [0, 1, 0]),
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
    },
    jointValues: {
      [ids.J1]: 0,
      [ids.J2]: 0,
      [ids.J3]: 0,
      [ids.J4]: 0,
      [ids.J5]: 0,
    },
  };
  return { graph, state, ids };
};

export const runRobotCursorGuidanceTests = () => {
  const { graph, state, ids } = robotGraph();
  const geometry = inferRobotArmGeometry(graph);
  ok(Math.abs(geometry.upperArm - 0.62) < 0.001, 'Cursor guidance did not infer upper arm length from joint origins.');
  ok(Math.abs(geometry.forearm - 0.46) < 0.001, 'Cursor guidance did not infer forearm length from joint origins.');

  const reachable = solveRobotArmCursorTarget(graph, state, [0.62, 1.28, 0.2]);
  ok(reachable.compatible, 'Cursor guidance did not recognize the professional robot graph.');
  ok(reachable.reachable, 'A target inside the robot envelope was incorrectly clamped.');
  [ids.J1, ids.J2, ids.J3, ids.J4].forEach((jointId) => {
    ok(finite(reachable.jointValues[jointId]), `Cursor guidance produced a non-finite value for ${jointId}.`);
    const jointLimits = graph.joints.find((jointItem) => jointItem.id === jointId)?.limits;
    ok(reachable.jointValues[jointId] >= (jointLimits?.lower ?? -Infinity) - 1e-6, `${jointId} target is below its lower limit.`);
    ok(reachable.jointValues[jointId] <= (jointLimits?.upper ?? Infinity) + 1e-6, `${jointId} target is above its upper limit.`);
  });

  const next = solveRobotArmCursorTarget(graph, { ...state, jointValues: reachable.jointValues }, [0.68, 1.3, 0.24]);
  ok(Math.abs(next.jointValues[ids.J1] - reachable.jointValues[ids.J1]) < deg(20), 'Cursor guidance created a discontinuous base jump for nearby points.');
  ok(Math.abs(next.jointValues[ids.J2] - reachable.jointValues[ids.J2]) < deg(25), 'Cursor guidance created a discontinuous shoulder jump for nearby points.');

  const far = solveRobotArmCursorTarget(graph, state, [5, 3, 5]);
  ok(far.compatible, 'Far cursor target should still be solvable as a clamped target.');
  ok(!far.reachable, 'Far target should be reported outside the reachable envelope.');
  ok(far.diagnostics.some((message) => /clamped/i.test(message)), 'Far target did not explain that it was clamped.');

  const broken = solveRobotArmCursorTarget({ rootPartId: 'base', parts: [part('base')], joints: [] }, undefined, [0, 0, 0]);
  ok(!broken.compatible, 'Cursor guidance accepted a graph without the required robot joints.');
};
