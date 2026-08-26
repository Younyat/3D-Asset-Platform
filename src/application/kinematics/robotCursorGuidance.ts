import type { KinematicGraph, KinematicJoint, KinematicState } from '../../domain/kinematics';
import { createRobotServoState, getRobotJointBindings, type RobotJointBinding } from './robotMotionController';

const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-8;

export type RobotCursorGuideOptions = {
  preserveToolPitch?: boolean;
  elbowPreference?: 'nearest' | 'positive' | 'negative';
  wristRollDegrees?: number;
};

export type RobotCursorGuideResult = {
  compatible: boolean;
  reachable: boolean;
  targetPoint: [number, number, number];
  clampedPoint: [number, number, number];
  jointValues: Record<string, number>;
  poseDegrees: {
    J1?: number;
    J2?: number;
    J3?: number;
    J4?: number;
    J5?: number;
  };
  diagnostics: string[];
};

type RobotArmBindingSet = {
  J1: RobotJointBinding;
  J2: RobotJointBinding;
  J3: RobotJointBinding;
  J4: RobotJointBinding;
  J5?: RobotJointBinding;
};

type RobotArmGeometry = {
  base: [number, number, number];
  shoulder: [number, number, number];
  upperArm: number;
  forearm: number;
  wrist: number;
};

type IkCandidate = {
  yaw: number;
  j2: number;
  j3: number;
  j4: number;
  clampedPlanar: { x: number; y: number };
  reachable: boolean;
  score: number;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

const distance = (a: [number, number, number], b: [number, number, number]) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const metadata = (joint: KinematicJoint) => joint.evidence.find((item) => item.metadata)?.metadata ?? {};

const restValue = (joint: KinematicJoint | undefined) => {
  const value = joint ? metadata(joint).restValue : undefined;
  return finite(value) ? value : 0;
};

const jointByBinding = (graph: KinematicGraph, binding: RobotJointBinding | undefined) => graph.joints.find((joint) => joint.id === binding?.jointId);

const normalizeAngle = (value: number) => {
  let next = value;
  while (next > Math.PI) next -= TWO_PI;
  while (next < -Math.PI) next += TWO_PI;
  return next;
};

const closestEquivalentAngle = (value: number, reference: number) => {
  let best = value;
  let bestDistance = Math.abs(value - reference);
  for (let turn = -2; turn <= 2; turn += 1) {
    const candidate = value + turn * TWO_PI;
    const candidateDistance = Math.abs(candidate - reference);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
};

const bindingLimits = (binding: RobotJointBinding) => ({
  lower: finite(binding.limits.lower) ? binding.limits.lower : -Math.PI,
  upper: finite(binding.limits.upper) ? binding.limits.upper : Math.PI,
});

const currentInternal = (binding: RobotJointBinding, state?: KinematicState) => state?.jointValues[binding.jointId] ?? binding.home ?? 0;

const currentAbsolute = (graph: KinematicGraph, binding: RobotJointBinding, state?: KinematicState) =>
  restValue(jointByBinding(graph, binding)) + currentInternal(binding, state);

const internalFromAbsolute = (graph: KinematicGraph, binding: RobotJointBinding, absolute: number, state?: KinematicState) => {
  const rest = restValue(jointByBinding(graph, binding));
  const current = currentInternal(binding, state);
  const equivalent = closestEquivalentAngle(absolute - rest, current);
  const limits = bindingLimits(binding);
  return clamp(equivalent, limits.lower, limits.upper);
};

const limitPenalty = (binding: RobotJointBinding, internalValue: number) => {
  const limits = bindingLimits(binding);
  if (internalValue < limits.lower) return (limits.lower - internalValue) * 1000;
  if (internalValue > limits.upper) return (internalValue - limits.upper) * 1000;
  return 0;
};

const bindingSet = (graph: KinematicGraph, state?: KinematicState): RobotArmBindingSet | undefined => {
  const bindings = getRobotJointBindings(graph, state);
  const byKey = new Map(bindings.map((binding) => [binding.key, binding]));
  const J1 = byKey.get('J1');
  const J2 = byKey.get('J2');
  const J3 = byKey.get('J3');
  const J4 = byKey.get('J4');
  if (!J1 || !J2 || !J3 || !J4) return undefined;
  return { J1, J2, J3, J4, J5: byKey.get('J5') };
};

const positiveLength = (value: number, fallback: number) => (Number.isFinite(value) && value > 0.04 ? value : fallback);

const graphExtent = (graph: KinematicGraph) => {
  const sizes = graph.parts.flatMap((part) => part.bounds.size.filter(finite));
  const maxSize = sizes.length ? Math.max(...sizes) : 1;
  return Math.max(maxSize, 0.2);
};

export const inferRobotArmGeometry = (graph: KinematicGraph): RobotArmGeometry => {
  const jointForOrder = (order: string) =>
    graph.joints.find((joint) => {
      const value = metadata(joint).order;
      return value === order || new RegExp(order, 'i').test(joint.name);
    });

  const j1 = jointForOrder('J1');
  const j2 = jointForOrder('J2');
  const j3 = jointForOrder('J3');
  const j4 = jointForOrder('J4');
  const j5 = jointForOrder('J5');
  const extent = graphExtent(graph);
  const base = j1?.origin.position ?? ([0, 0, 0] as [number, number, number]);
  const shoulder = j2?.origin.position ?? ([base[0], base[1] + extent * 0.35, base[2]] as [number, number, number]);
  const upperArm = positiveLength(j2 && j3 ? distance(j2.origin.position, j3.origin.position) : 0, extent * 0.34);
  const forearm = positiveLength(j3 && j4 ? distance(j3.origin.position, j4.origin.position) : 0, extent * 0.28);
  const wrist = positiveLength(j4 && j5 ? distance(j4.origin.position, j5.origin.position) : 0, Math.min(extent * 0.1, 0.18));

  return {
    base: [...base],
    shoulder: [...shoulder],
    upperArm,
    forearm,
    wrist,
  };
};

const solveTwoLink = (x: number, y: number, upperArm: number, forearm: number, elbowSign: 1 | -1) => {
  const minReach = Math.max(Math.abs(upperArm - forearm) + 0.001, 0.001);
  const maxReach = Math.max(upperArm + forearm - 0.001, minReach + 0.001);
  const targetDistance = Math.sqrt(x * x + y * y);
  const reachable = targetDistance >= minReach && targetDistance <= maxReach;
  const safeDistance = clamp(targetDistance, minReach, maxReach);
  const scale = targetDistance > EPSILON ? safeDistance / targetDistance : 1;
  const clampedX = x * scale;
  const clampedY = y * scale;
  const cosElbow = clamp((safeDistance * safeDistance - upperArm * upperArm - forearm * forearm) / (2 * upperArm * forearm), -1, 1);
  const elbow = elbowSign * Math.acos(cosElbow);
  const shoulderTheta =
    Math.atan2(clampedY, clampedX) - Math.atan2(forearm * Math.sin(elbow), upperArm + forearm * Math.cos(elbow));
  return {
    j2: normalizeAngle(shoulderTheta - Math.PI / 2),
    j3: normalizeAngle(elbow),
    clampedPlanar: { x: clampedX, y: clampedY },
    reachable,
  };
};

const scoreCandidate = (
  graph: KinematicGraph,
  bindings: RobotArmBindingSet,
  candidate: Omit<IkCandidate, 'score'>,
  state: KinematicState | undefined,
  rest: { J1: number; J2: number; J3: number; J4: number },
) => {
  const rawValues = {
    [bindings.J1.jointId]: closestEquivalentAngle(candidate.yaw - rest.J1, currentInternal(bindings.J1, state)),
    [bindings.J2.jointId]: closestEquivalentAngle(candidate.j2 - rest.J2, currentInternal(bindings.J2, state)),
    [bindings.J3.jointId]: closestEquivalentAngle(candidate.j3 - rest.J3, currentInternal(bindings.J3, state)),
    [bindings.J4.jointId]: closestEquivalentAngle(candidate.j4 - rest.J4, currentInternal(bindings.J4, state)),
  };
  const limitScore =
    limitPenalty(bindings.J1, rawValues[bindings.J1.jointId]) +
    limitPenalty(bindings.J2, rawValues[bindings.J2.jointId]) +
    limitPenalty(bindings.J3, rawValues[bindings.J3.jointId]) +
    limitPenalty(bindings.J4, rawValues[bindings.J4.jointId]);
  const continuityScore =
    Math.abs(rawValues[bindings.J1.jointId] - currentInternal(bindings.J1, state)) * 1.2 +
    Math.abs(rawValues[bindings.J2.jointId] - currentInternal(bindings.J2, state)) +
    Math.abs(rawValues[bindings.J3.jointId] - currentInternal(bindings.J3, state)) +
    Math.abs(rawValues[bindings.J4.jointId] - currentInternal(bindings.J4, state)) * 0.45;
  const reachScore = candidate.reachable ? 0 : 100;
  return limitScore + continuityScore + reachScore;
};

export const solveRobotArmCursorTarget = (
  graph: KinematicGraph,
  state: KinematicState | undefined,
  targetPoint: [number, number, number],
  options: RobotCursorGuideOptions = {},
): RobotCursorGuideResult => {
  const bindings = bindingSet(graph, state);
  const diagnostics: string[] = [];
  if (!bindings) {
    return {
      compatible: false,
      reachable: false,
      targetPoint,
      clampedPoint: targetPoint,
      jointValues: state?.jointValues ?? {},
      poseDegrees: {},
      diagnostics: ['Robot cursor guidance requires J1, J2, J3 and J4 bindings in KinematicGraph.'],
    };
  }

  const geometry = inferRobotArmGeometry(graph);
  const dx = targetPoint[0] - geometry.base[0];
  const dz = targetPoint[2] - geometry.base[2];
  const radial = Math.sqrt(dx * dx + dz * dz);
  const vertical = targetPoint[1] - geometry.shoulder[1];
  const shoulderRadialOffset = Math.sqrt((geometry.shoulder[0] - geometry.base[0]) ** 2 + (geometry.shoulder[2] - geometry.base[2]) ** 2);
  const effectiveRadial = Math.max(0, radial - shoulderRadialOffset - geometry.wrist * 0.35);
  const currentToolPitch =
    options.preserveToolPitch === false
      ? currentAbsolute(graph, bindings.J4, state)
      : currentAbsolute(graph, bindings.J2, state) + currentAbsolute(graph, bindings.J3, state) + currentAbsolute(graph, bindings.J4, state);

  const rest = {
    J1: restValue(jointByBinding(graph, bindings.J1)),
    J2: restValue(jointByBinding(graph, bindings.J2)),
    J3: restValue(jointByBinding(graph, bindings.J3)),
    J4: restValue(jointByBinding(graph, bindings.J4)),
  };

  const horizontalDirection = radial > EPSILON ? { x: dx / radial, z: dz / radial } : { x: 1, z: 0 };
  const yawForPositivePlane = Math.atan2(-horizontalDirection.z, horizontalDirection.x);
  const yawForNegativePlane = Math.atan2(horizontalDirection.z, -horizontalDirection.x);
  const elbowSigns: Array<1 | -1> = options.elbowPreference === 'positive' ? [1] : options.elbowPreference === 'negative' ? [-1] : [1, -1];
  const candidates: IkCandidate[] = [];

  (
    [
      { yaw: yawForPositivePlane, signedRadial: effectiveRadial },
      { yaw: yawForNegativePlane, signedRadial: -effectiveRadial },
    ] as const
  ).forEach((baseCandidate) => {
    elbowSigns.forEach((elbowSign) => {
      const solution = solveTwoLink(baseCandidate.signedRadial, vertical, geometry.upperArm, geometry.forearm, elbowSign);
      const j4 = options.preserveToolPitch === false ? currentAbsolute(graph, bindings.J4, state) : normalizeAngle(currentToolPitch - solution.j2 - solution.j3);
      const candidate = {
        yaw: normalizeAngle(baseCandidate.yaw),
        j2: solution.j2,
        j3: solution.j3,
        j4,
        clampedPlanar: solution.clampedPlanar,
        reachable: solution.reachable,
      };
      candidates.push({
        ...candidate,
        score: scoreCandidate(graph, bindings, candidate, state, rest),
      });
    });
  });

  const best = candidates.sort((a, b) => a.score - b.score)[0];
  const jointValues: Record<string, number> = {
    [bindings.J1.jointId]: internalFromAbsolute(graph, bindings.J1, best.yaw, state),
    [bindings.J2.jointId]: internalFromAbsolute(graph, bindings.J2, best.j2, state),
    [bindings.J3.jointId]: internalFromAbsolute(graph, bindings.J3, best.j3, state),
    [bindings.J4.jointId]: internalFromAbsolute(graph, bindings.J4, best.j4, state),
  };
  if (bindings.J5 && finite(options.wristRollDegrees)) {
    jointValues[bindings.J5.jointId] = internalFromAbsolute(graph, bindings.J5, (options.wristRollDegrees * Math.PI) / 180, state);
  }

  const clampedDistance = Math.sqrt(best.clampedPlanar.x * best.clampedPlanar.x + best.clampedPlanar.y * best.clampedPlanar.y);
  const clampedRadial = Math.max(0, Math.abs(best.clampedPlanar.x) + shoulderRadialOffset + geometry.wrist * 0.35);
  const clampedPoint: [number, number, number] = [
    geometry.base[0] + horizontalDirection.x * clampedRadial,
    geometry.shoulder[1] + best.clampedPlanar.y,
    geometry.base[2] + horizontalDirection.z * clampedRadial,
  ];
  if (!best.reachable) {
    diagnostics.push(`Target clamped to reachable robot envelope (${clampedDistance.toFixed(3)} m planar reach).`);
  }
  const controller = createRobotServoState(graph, state);
  return {
    compatible: true,
    reachable: best.reachable,
    targetPoint,
    clampedPoint,
    jointValues: { ...controller.current, ...jointValues },
    poseDegrees: {
      J1: jointValues[bindings.J1.jointId] * RAD_TO_DEG,
      J2: jointValues[bindings.J2.jointId] * RAD_TO_DEG,
      J3: jointValues[bindings.J3.jointId] * RAD_TO_DEG,
      J4: jointValues[bindings.J4.jointId] * RAD_TO_DEG,
      J5: bindings.J5 ? (jointValues[bindings.J5.jointId] ?? currentInternal(bindings.J5, state)) * RAD_TO_DEG : undefined,
    },
    diagnostics,
  };
};
