import type { KinematicGraph, KinematicJoint, KinematicState, MechanicalPart } from '../../domain/kinematics';
import {
  distancePointToAxis,
  evaluateForwardKinematics,
  normalizeAxis,
  normalizeKinematicGraph,
  resetKinematicState,
  setLogicalControlValue,
  setJointValue,
  transformPoint,
  updateJoint,
  validateKinematicGraph,
} from './kinematicAuthoring';

const nearly = (actual: number, expected: number, tolerance = 1e-6) => {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`Expected ${actual} to be near ${expected}.`);
};

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const part = (id: string, position: [number, number, number] = [0, 0, 0]): MechanicalPart => ({
  id,
  name: id.toUpperCase(),
  meshObjectIds: [id],
  localFrame: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
  static: id === 'a',
  visible: true,
  source: 'manual-group',
  metadata: {},
});

const joint = (id: string, parentPartId: string, childPartId: string, patch: Partial<KinematicJoint> = {}): KinematicJoint => ({
  id,
  name: id.toUpperCase(),
  parentPartId,
  childPartId,
  type: 'revolute',
  origin: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  axis: [0, 0, 1],
  limits: { lower: -Math.PI, upper: Math.PI },
  source: 'manual',
  evidence: [{ type: 'manual' }],
  status: 'candidate',
  ...patch,
});

const graph = (parts: MechanicalPart[], joints: KinematicJoint[], rootPartId = 'a'): KinematicGraph => ({ parts, joints, rootPartId });

const hasIssue = (graphInput: KinematicGraph, code: string) => validateKinematicGraph(graphInput).some((issue) => issue.code === code);

export const runKinematicAuthoringTests = () => {
  const normalized = normalizeAxis([10, 0, 0]);
  ok(Boolean(normalized), 'K01 axis did not normalize.');
  nearly(normalized?.[0] ?? 0, 1);
  nearly(Math.hypot(...(normalized ?? [0, 0, 0])), 1);

  ok(hasIssue(graph([part('a'), part('b')], [joint('j1', 'a', 'b', { axis: [0, 0, 0] })]), 'INVALID_AXIS'), 'K02 zero axis was not invalid.');

  const arbitrary = normalizeKinematicGraph(graph([part('a'), part('b', [1, 0, 0])], [joint('j1', 'a', 'b', { axis: [1, 1, 0] })]));
  nearly(arbitrary.joints[0].axis[0], 1 / Math.sqrt(2));
  nearly(arbitrary.joints[0].axis[1], 1 / Math.sqrt(2));

  const revoluteGraph = graph([part('a'), part('b', [1, 0, 0])], [joint('j1', 'a', 'b')]);
  [0, Math.PI / 6, Math.PI / 2, -Math.PI / 4].forEach((angle) => {
    const state = setJointValue(revoluteGraph, undefined, 'j1', angle);
    const pose = evaluateForwardKinematics(revoluteGraph, state);
    const point = transformPoint(pose.b.matrix, [0, 0, 0]);
    nearly(distancePointToAxis(point, [0, 0, 0], [0, 0, 1]), 1);
  });

  const continuousGraph = graph([part('a'), part('b', [1, 0, 0])], [joint('j1', 'a', 'b', { type: 'continuous', limits: undefined })]);
  const pose0 = evaluateForwardKinematics(continuousGraph, setJointValue(continuousGraph, undefined, 'j1', 0)).b.position;
  const pose360 = evaluateForwardKinematics(continuousGraph, setJointValue(continuousGraph, undefined, 'j1', Math.PI * 2)).b.position;
  pose0.forEach((value, index) => nearly(value, pose360[index]));

  const pivotGraph = graph([part('a'), part('b', [2, 0, 0])], [joint('j1', 'a', 'b', { origin: { position: [1, 0, 0], rotation: [0, 0, 0, 1] } })]);
  const pivotPose = evaluateForwardKinematics(pivotGraph, setJointValue(pivotGraph, undefined, 'j1', Math.PI / 2)).b.position;
  nearly(pivotPose[0], 1);
  nearly(pivotPose[1], 1);

  const prismaticGraph = graph([part('a'), part('b')], [joint('j1', 'a', 'b', { type: 'prismatic', axis: [1, 1, 0], limits: { lower: -5, upper: 5 } })]);
  const distance = 2.5;
  const prismaticPose = evaluateForwardKinematics(prismaticGraph, setJointValue(prismaticGraph, undefined, 'j1', distance)).b.position;
  const prismaticAxis = normalizeAxis([1, 1, 0])!;
  const projection = prismaticPose[0] * prismaticAxis[0] + prismaticPose[1] * prismaticAxis[1];
  const perpendicular = Math.hypot(prismaticPose[0] - prismaticAxis[0] * projection, prismaticPose[1] - prismaticAxis[1] * projection, prismaticPose[2]);
  nearly(projection, distance);
  nearly(perpendicular, 0);

  const fixedGraph = graph([part('a'), part('b', [1, 0, 0])], [joint('j1', 'a', 'b', { type: 'fixed' })]);
  const fixedPose = evaluateForwardKinematics(fixedGraph, setJointValue(fixedGraph, undefined, 'j1', Math.PI)).b.position;
  nearly(fixedPose[0], 1);
  nearly(fixedPose[1], 0);

  const limitedGraph = graph([part('a'), part('b')], [joint('j1', 'a', 'b', { limits: { lower: -Math.PI / 6, upper: Math.PI / 3 } })]);
  const limitedState = setJointValue(limitedGraph, undefined, 'j1', 100);
  nearly(limitedState.jointValues.j1, Math.PI / 3);
  const limitedPrismatic = graph([part('a'), part('b')], [joint('j1', 'a', 'b', { type: 'prismatic', limits: { lower: -1, upper: 1 } })]);
  nearly(setJointValue(limitedPrismatic, undefined, 'j1', 5).jointValues.j1, 1);

  const chainGraph = graph(
    [part('a'), part('b', [1, 0, 0]), part('c', [1, 0, 0]), part('d', [1, 0, 0])],
    [joint('j1', 'a', 'b'), joint('j2', 'b', 'c'), joint('j3', 'c', 'd')],
  );
  const movedJ1 = evaluateForwardKinematics(chainGraph, setJointValue(chainGraph, undefined, 'j1', Math.PI / 2));
  nearly(movedJ1.a.position[0], 0);
  ok(Math.abs(movedJ1.b.position[1]) > 0.9 && Math.abs(movedJ1.c.position[1]) > 1.9 && Math.abs(movedJ1.d.position[1]) > 2.9, 'K10 descendants did not propagate from J1.');
  const movedJ3 = evaluateForwardKinematics(chainGraph, setJointValue(chainGraph, undefined, 'j3', Math.PI / 2));
  nearly(movedJ3.b.position[0], 1);
  nearly(movedJ3.c.position[0], 2);
  ok(Math.abs(movedJ3.d.position[0] - 2) < 1e-6 && Math.abs(movedJ3.d.position[1] - 1) < 1e-6, 'K10 child joint moved the wrong chain.');

  ok(!hasIssue(chainGraph, 'MULTIPLE_PARENTS') && !hasIssue(chainGraph, 'CYCLE_DETECTED'), 'K11 incoming/outgoing chain was invalid.');
  ok(hasIssue(graph([part('a'), part('b'), part('c')], [joint('j1', 'a', 'b'), joint('j2', 'b', 'c'), joint('j3', 'c', 'a')]), 'CYCLE_DETECTED'), 'K12 cycle was not detected.');
  ok(hasIssue(graph([part('a')], [joint('j1', 'a', 'missing')]), 'CHILD_MISSING'), 'K13 missing child was not detected.');
  ok(hasIssue(graph([part('a'), part('a')], []), 'DUPLICATE_PART_ID'), 'K14 duplicate part id was not detected.');
  ok(hasIssue(graph([part('a'), part('b')], [joint('j1', 'a', 'b'), joint('j1', 'a', 'b')]), 'DUPLICATE_JOINT_ID'), 'K14 duplicate joint id was not detected.');
  ok(
    hasIssue(
      graph([part('a'), part('b')], [joint('j1', 'a', 'b', { axis: [Number.NaN, 0, 1], origin: { position: [Infinity, 0, 0], rotation: [0, 0, 0, 1] } })]),
      'INVALID_AXIS',
    ),
    'K15 NaN axis was not detected.',
  );
  ok(
    hasIssue(
      graph([part('a'), part('b')], [joint('j1', 'a', 'b', { axis: [1, 0, 0], origin: { position: [Infinity, 0, 0], rotation: [0, 0, 0, 1] } })]),
      'INVALID_ORIGIN',
    ),
    'K15 Infinity origin was not detected.',
  );

  const pointA: [number, number, number] = [1, 2, 3];
  const pointB: [number, number, number] = [2, 3, 3];
  const twoPointAxis = normalizeAxis([pointB[0] - pointA[0], pointB[1] - pointA[1], pointB[2] - pointA[2]]);
  nearly(twoPointAxis?.[0] ?? 0, 1 / Math.sqrt(2));
  nearly(twoPointAxis?.[1] ?? 0, 1 / Math.sqrt(2));

  const pickedOriginGraph = updateJoint(revoluteGraph, 'j1', { origin: { position: [0.25, 0.5, 0.75], rotation: [0, 0, 0, 1] } });
  nearly(pickedOriginGraph.joints[0].origin.position[0], 0.25);
  nearly(pickedOriginGraph.joints[0].origin.position[1], 0.5);

  const gripperGraph = graph(
    [part('a'), part('left'), part('right')],
    [
      joint('left_open', 'a', 'left', { type: 'prismatic', axis: [1, 0, 0], limits: { lower: -1, upper: 1 } }),
      joint('right_open', 'a', 'right', {
        type: 'prismatic',
        axis: [1, 0, 0],
        limits: { lower: -1, upper: 1 },
        coupling: { driverJointId: 'left_open', multiplier: -1, offset: 0 },
      }),
    ],
  );
  const gripperPose = evaluateForwardKinematics(gripperGraph, setJointValue(gripperGraph, undefined, 'left_open', 0.35));
  nearly(gripperPose.left.position[0], 0.35);
  nearly(gripperPose.right.position[0], -0.35);

  ok(hasIssue(graph([part('a'), part('b')], [joint('j1', 'a', 'b', { coupling: { driverJointId: 'missing', multiplier: 1, offset: 0 } })]), 'INVALID_COUPLING'), 'K19 missing coupling driver was not detected.');
  ok(
    hasIssue(
      graph(
        [part('a'), part('b'), part('c')],
        [
          joint('j1', 'a', 'b', { limits: { lower: 10, upper: 20 } }),
          joint('j2', 'a', 'c', { limits: { lower: -1, upper: 1 }, coupling: { driverJointId: 'j1', multiplier: 1, offset: 0 } }),
        ],
      ),
      'COUPLING_LIMIT_CONFLICT',
    ),
    'K20 coupling limit conflict was not detected.',
  );

  const logicalGraph: KinematicGraph = {
    ...gripperGraph,
    logicalControls: [{ id: 'grip_open', name: 'Open Gripper', jointMappings: [{ jointId: 'left_open', multiplier: 1, offset: 0 }] }],
  };
  const logicalState = setLogicalControlValue(logicalGraph, undefined, 'grip_open', 0.42);
  nearly(logicalState.jointValues.left_open, 0.42);

  const cycledState = Array.from({ length: 500 }).reduce<KinematicState | undefined>((state) => {
    const moved = setJointValue(revoluteGraph, state, 'j1', Math.PI / 3);
    return resetKinematicState(revoluteGraph, moved);
  }, undefined as ReturnType<typeof resetKinematicState> | undefined);
  nearly((cycledState ?? resetKinematicState(revoluteGraph)).jointValues.j1, 0);
  const homePose = evaluateForwardKinematics(revoluteGraph, cycledState).b.position;
  nearly(homePose[0], 1);
  nearly(homePose[1], 0);

  const driftStart = evaluateForwardKinematics(revoluteGraph, setJointValue(revoluteGraph, undefined, 'j1', 0.75)).b.position;
  let driftState = setJointValue(revoluteGraph, undefined, 'j1', 0.75);
  Array.from({ length: 1000 }).forEach(() => {
    evaluateForwardKinematics(revoluteGraph, driftState);
  });
  const driftEnd = evaluateForwardKinematics(revoluteGraph, driftState).b.position;
  driftStart.forEach((value, index) => nearly(value, driftEnd[index]));

  const scaledGraph = graph([part('a'), { ...part('b', [1, 0, 0]), localFrame: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [2, 3, 4] } }], [joint('j1', 'a', 'b')]);
  const scaledPose = evaluateForwardKinematics(scaledGraph, setJointValue(scaledGraph, undefined, 'j1', 0.4)).b.scale;
  nearly(scaledPose[0], 2);
  nearly(scaledPose[1], 3);
  nearly(scaledPose[2], 4);

  const localGlobalGraph = graph(
    [
      {
        ...part('a'),
        localFrame: { position: [3, 2, -1], rotation: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
      },
      {
        ...part('b', [1.2, 0.4, 0.3]),
        localFrame: { position: [1.2, 0.4, 0.3], rotation: [0.15, -0.2, 0.1], scale: [1, 1, 1] },
      },
    ],
    [
      joint('j1', 'a', 'b', {
        axis: [1, 1, 0],
        origin: { position: [0.25, 0.4, 0.1], rotation: [0, 0, 0, 1] },
        limits: { lower: -Math.PI, upper: Math.PI },
      }),
    ],
  );
  const localBefore = evaluateForwardKinematics(localGlobalGraph, setJointValue(localGlobalGraph, undefined, 'j1', 0));
  const localAfter = evaluateForwardKinematics(localGlobalGraph, setJointValue(localGlobalGraph, undefined, 'j1', Math.PI / 3));
  const worldOrigin = transformPoint(localBefore.a.matrix, [0.25, 0.4, 0.1]);
  const worldAxisEnd = transformPoint(localBefore.a.matrix, [1.25, 1.4, 0.1]);
  const worldAxis = normalizeAxis([worldAxisEnd[0] - worldOrigin[0], worldAxisEnd[1] - worldOrigin[1], worldAxisEnd[2] - worldOrigin[2]])!;
  nearly(distancePointToAxis(localBefore.b.position, worldOrigin, worldAxis), distancePointToAxis(localAfter.b.position, worldOrigin, worldAxis));
  ok(Math.abs(localAfter.b.position[0] - localBefore.b.position[0]) > 0.01, 'K24 local/global frame test did not move the child.');
  ok(Math.abs(localAfter.a.position[0] - localBefore.a.position[0]) < 1e-9, 'K24 local/global frame test moved the parent.');

  const graphBefore = JSON.stringify(revoluteGraph);
  setJointValue(revoluteGraph, undefined, 'j1', 0.2);
  evaluateForwardKinematics(revoluteGraph, setJointValue(revoluteGraph, undefined, 'j1', 0.2));
  ok(JSON.stringify(revoluteGraph) === graphBefore, 'K25 state evaluation mutated the source KinematicGraph.');

  const rejectedGraph = graph([part('a'), part('b', [1, 0, 0])], [joint('j1', 'a', 'b', { status: 'rejected' })]);
  const rejectedPose = evaluateForwardKinematics(rejectedGraph, setJointValue(rejectedGraph, undefined, 'j1', Math.PI / 2));
  ok(!rejectedPose.b, 'K26 rejected joint should not produce an active child pose.');

  const normalizedQuaternionGraph = normalizeKinematicGraph(graph([part('a'), part('b')], [joint('j1', 'a', 'b', { origin: { position: [0, 0, 0], rotation: [0, 0, 0, 10] } })]));
  nearly(normalizedQuaternionGraph.joints[0].origin.rotation[3], 1);

  ok(validateKinematicGraph(graph([part('a'), part('orphan')], [], 'a')).some((issue) => issue.code === 'ORPHAN_PART' && issue.severity === 'warning'), 'K28 orphan warning was not produced.');
  ok(hasIssue(graph([part('a'), part('b'), part('c')], [joint('j1', 'a', 'c'), joint('j2', 'b', 'c')]), 'MULTIPLE_PARENTS'), 'K29 multiple parents were not detected.');

  const heavyParts = Array.from({ length: 260 }, (_, index) => part(`p${index}`, index === 0 ? [0, 0, 0] : [0.01, 0, 0]));
  const heavyJoints = heavyParts.slice(1).map((item, index) => joint(`hj${index}`, heavyParts[index].id, item.id, { type: 'revolute', axis: [0, 0, 1] }));
  const heavyGraph = graph(heavyParts, heavyJoints, 'p0');
  const start = performance.now();
  evaluateForwardKinematics(heavyGraph, setJointValue(heavyGraph, undefined, 'hj0', 0.3));
  const elapsed = performance.now() - start;
  ok(elapsed < 250, `K30 heavy mechanism evaluation took ${elapsed.toFixed(1)} ms.`);
};
