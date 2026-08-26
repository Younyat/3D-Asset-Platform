import type { KinematicGraph, KinematicJoint, KinematicMotionClip, KinematicState } from '../../domain/kinematics';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EPSILON = 1e-8;

export type RobotJointKey = 'J1' | 'J2' | 'J3' | 'J4' | 'J5';
export type RobotPose = Partial<Record<RobotJointKey, number>> & { grip?: number };

export type RobotJointBinding = {
  key: RobotJointKey | 'J6L' | 'J6R';
  order: string;
  jointId: string;
  name: string;
  type: KinematicJoint['type'];
  axis: [number, number, number];
  limits: {
    lower: number;
    upper: number;
  };
  home: number;
  speed: number;
  units: 'radians' | 'meters';
  mirroredDriverId?: string;
};

export type RobotGraphDiagnosis = {
  compatible: boolean;
  schema?: string;
  nodesFound: Record<string, boolean>;
  clipsFound: Record<string, boolean>;
  joints: RobotJointBinding[];
  missing: string[];
  warnings: string[];
};

export type RobotServoState = {
  current: Record<string, number>;
  target: Record<string, number>;
  home: Record<string, number>;
  speedScale: number;
  gripTarget: number;
  gripCurrent: number;
  activeClip?: {
    clipId: string;
    elapsed: number;
    loop: boolean;
  };
  sequence?: {
    id: string;
    name: string;
    steps: RobotSequenceStep[];
    index: number;
    waiting: number;
    active: boolean;
    completed: boolean;
  };
};

export type RobotSequenceStep =
  | { kind: 'pose'; pose: RobotPose; label?: string }
  | { kind: 'grip'; grip: number; label?: string }
  | { kind: 'wait'; seconds: number; label?: string }
  | { kind: 'home'; label?: string };

export type RobotMotionUpdate = {
  state: RobotServoState;
  kinematicState: KinematicState;
  settled: boolean;
  activeLabel?: string;
};

const ROBOT_JOINT_NAMES: Record<RobotJointKey, string> = {
  J1: 'J1_base_yaw',
  J2: 'J2_shoulder_pitch',
  J3: 'J3_elbow_pitch',
  J4: 'J4_wrist_pitch',
  J5: 'J5_tool_roll',
};

const REQUIRED_NODE_NAMES = [
  'J1_base_yaw',
  'J2_shoulder_pitch',
  'J3_elbow_pitch',
  'J4_wrist_pitch',
  'J5_tool_roll',
  'J6_gripper_finger_L',
  'J6_gripper_finger_R',
];

const REQUIRED_CLIPS = ['Ciclo_Pick_And_Place', 'Ir_A_Home', 'Demo_Ejes'];

const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const stepToward = (current: number, target: number, maxStep: number) => {
  if (Math.abs(target - current) <= maxStep) return target;
  return current + Math.sign(target - current) * maxStep;
};

const metadata = (joint: KinematicJoint) => joint.evidence.find((item) => item.metadata)?.metadata ?? {};

const orderFromJoint = (joint: KinematicJoint) => {
  const order = metadata(joint).order;
  if (typeof order === 'string') return order;
  if (/J1|base_yaw/i.test(joint.name)) return 'J1';
  if (/J2|shoulder/i.test(joint.name)) return 'J2';
  if (/J3|elbow/i.test(joint.name)) return 'J3';
  if (/J4|wrist_pitch/i.test(joint.name)) return 'J4';
  if (/J5|tool_roll/i.test(joint.name)) return 'J5';
  if (/finger/i.test(joint.name)) return 'J6';
  return undefined;
};

const speedFromJoint = (joint: KinematicJoint) => {
  if (finite(joint.limits?.velocity) && joint.limits!.velocity! > 0) return joint.limits!.velocity!;
  const meta = metadata(joint);
  const absolute = meta.absoluteLimits;
  if (Array.isArray(absolute) && joint.type !== 'prismatic') return 180 * DEG_TO_RAD;
  if (joint.type === 'prismatic') return 0.12;
  if (/J2|shoulder/i.test(joint.name)) return 140 * DEG_TO_RAD;
  if (/J3|elbow/i.test(joint.name)) return 160 * DEG_TO_RAD;
  if (/J4|wrist/i.test(joint.name)) return 250 * DEG_TO_RAD;
  if (/J5|tool/i.test(joint.name)) return 320 * DEG_TO_RAD;
  return 180 * DEG_TO_RAD;
};

const homeFromState = (state: KinematicState | undefined, joint: KinematicJoint) => state?.homeJointValues[joint.id] ?? 0;

const limitsFromJoint = (joint: KinematicJoint) => ({
  lower: finite(joint.limits?.lower) ? joint.limits!.lower! : joint.type === 'prismatic' ? -0.1 : -Math.PI,
  upper: finite(joint.limits?.upper) ? joint.limits!.upper! : joint.type === 'prismatic' ? 0.1 : Math.PI,
});

export const getRobotJointBindings = (graph: KinematicGraph, state?: KinematicState): RobotJointBinding[] => {
  const result: RobotJointBinding[] = [];
  const left = graph.joints.find((joint) => /J6_gripper_finger_L|finger_L/i.test(joint.name));
  const right = graph.joints.find((joint) => /J6_gripper_finger_R|finger_R/i.test(joint.name));

  graph.joints
    .filter((joint) => joint.status !== 'rejected')
    .forEach((joint) => {
      const order = orderFromJoint(joint);
      if (!order) return;
      const key =
        order === 'J6'
          ? /finger_l$/i.test(joint.name) || /finger_L/i.test(joint.name)
            ? 'J6L'
            : 'J6R'
          : (order as RobotJointKey);
      const limits = limitsFromJoint(joint);
      result.push({
        key,
        order,
        jointId: joint.id,
        name: joint.name,
        type: joint.type,
        axis: joint.axis,
        limits,
        home: homeFromState(state, joint),
        speed: speedFromJoint(joint),
        units: joint.type === 'prismatic' ? 'meters' : 'radians',
        mirroredDriverId: right?.id === joint.id ? left?.id : undefined,
      });
    });

  return result.sort((a, b) => {
    const orderA = a.order === 'J6' ? (a.key === 'J6L' ? 6 : 7) : Number(a.order.slice(1));
    const orderB = b.order === 'J6' ? (b.key === 'J6L' ? 6 : 7) : Number(b.order.slice(1));
    return orderA - orderB;
  });
};

export const diagnoseRobotGraph = (graph: KinematicGraph, state?: KinematicState): RobotGraphDiagnosis => {
  const bindings = getRobotJointBindings(graph, state);
  const foundByName = new Set(bindings.map((binding) => binding.name));
  const clips = graph.motionClips ?? [];
  const clipNames = new Set(clips.map((clip) => clip.name));
  const nodesFound = Object.fromEntries(REQUIRED_NODE_NAMES.map((name) => [name, foundByName.has(name)]));
  const clipsFound = Object.fromEntries(REQUIRED_CLIPS.map((name) => [name, clipNames.has(name)]));
  const missing = [
    ...Object.entries(nodesFound)
      .filter(([, found]) => !found)
      .map(([name]) => name),
    ...Object.entries(clipsFound)
      .filter(([, found]) => !found)
      .map(([name]) => name),
  ];
  const warnings: string[] = [];
  const left = bindings.find((binding) => binding.key === 'J6L');
  const right = bindings.find((binding) => binding.key === 'J6R');
  if (left && right && !right.mirroredDriverId) warnings.push('Right gripper finger is not explicitly coupled to the left finger.');
  bindings.forEach((binding) => {
    if (binding.limits.lower > binding.limits.upper) warnings.push(`${binding.name} has inverted limits.`);
    if (binding.speed <= 0) warnings.push(`${binding.name} has no positive speed limit.`);
  });

  return {
    compatible: missing.length === 0 && warnings.length === 0,
    schema: graph.analysisVersion,
    nodesFound,
    clipsFound,
    joints: bindings,
    missing,
    warnings,
  };
};

export const createRobotServoState = (graph: KinematicGraph, state?: KinematicState, speedScale = 1): RobotServoState => {
  const bindings = getRobotJointBindings(graph, state);
  const home = Object.fromEntries(bindings.map((binding) => [binding.jointId, binding.home]));
  const current = Object.fromEntries(bindings.map((binding) => [binding.jointId, state?.jointValues[binding.jointId] ?? binding.home]));
  return {
    current,
    target: { ...current },
    home,
    speedScale,
    gripTarget: 1,
    gripCurrent: 1,
  };
};

const stateWithValues = (base: KinematicState | undefined, controller: RobotServoState): KinematicState => ({
  homeJointValues: { ...(base?.homeJointValues ?? controller.home), ...controller.home },
  jointValues: { ...(base?.jointValues ?? {}), ...controller.current },
});

const keyToBinding = (bindings: RobotJointBinding[], key: RobotJointKey | 'J6L' | 'J6R') => bindings.find((binding) => binding.key === key);

const poseTargetValues = (bindings: RobotJointBinding[], pose: RobotPose) => {
  const values: Record<string, number> = {};
  (['J1', 'J2', 'J3', 'J4', 'J5'] as RobotJointKey[]).forEach((key) => {
    const binding = keyToBinding(bindings, key);
    const degrees = pose[key];
    if (!binding || !finite(degrees)) return;
    values[binding.jointId] = clamp(degrees * DEG_TO_RAD, binding.limits.lower, binding.limits.upper);
  });
  if (finite(pose.grip)) {
    const grip = clamp(pose.grip, 0, 1);
    const left = keyToBinding(bindings, 'J6L');
    const right = keyToBinding(bindings, 'J6R');
    if (left && right) {
      const travel = Math.min(Math.abs(left.limits.upper - left.limits.lower), Math.abs(right.limits.upper - right.limits.lower));
      const closedLeft = Math.max(left.limits.lower, 0);
      values[left.jointId] = clamp(closedLeft + travel * grip, left.limits.lower, left.limits.upper);
      values[right.jointId] = clamp((right.home >= 0 ? 0 : right.home) - travel * grip, right.limits.lower, right.limits.upper);
    }
  }
  return values;
};

export const setRobotPoseTarget = (graph: KinematicGraph, controller: RobotServoState, pose: RobotPose): RobotServoState => {
  const bindings = getRobotJointBindings(graph);
  const values = poseTargetValues(bindings, pose);
  return {
    ...controller,
    target: { ...controller.target, ...values },
    gripTarget: finite(pose.grip) ? clamp(pose.grip, 0, 1) : controller.gripTarget,
    activeClip: undefined,
  };
};

export const setRobotJointTarget = (graph: KinematicGraph, controller: RobotServoState, key: RobotJointKey, degrees: number): RobotServoState =>
  setRobotPoseTarget(graph, controller, { [key]: degrees } as RobotPose);

export const setRobotGripTarget = (graph: KinematicGraph, controller: RobotServoState, grip: number): RobotServoState =>
  setRobotPoseTarget(graph, controller, { grip });

export const goRobotHome = (_graph: KinematicGraph, controller: RobotServoState, immediate = false): RobotServoState => {
  const next = {
    ...controller,
    target: { ...controller.home },
    gripTarget: 1,
    activeClip: undefined,
    sequence: undefined,
  };
  return immediate ? { ...next, current: { ...next.home }, gripCurrent: 1 } : next;
};

export const isRobotSettled = (graph: KinematicGraph, controller: RobotServoState, tolerance = 0.5 * DEG_TO_RAD) => {
  const bindings = getRobotJointBindings(graph);
  return bindings.every((binding) => Math.abs((controller.target[binding.jointId] ?? 0) - (controller.current[binding.jointId] ?? 0)) <= (binding.units === 'meters' ? 0.002 : tolerance));
};

export const updateRobotServo = (graph: KinematicGraph, controller: RobotServoState, dtSeconds: number, baseState?: KinematicState): RobotMotionUpdate => {
  const dt = Math.max(0, Math.min(dtSeconds, 0.2));
  const bindings = getRobotJointBindings(graph, baseState);
  let next = controller;
  let activeLabel: string | undefined;

  if (next.activeClip) {
    const clip = graph.motionClips?.find((candidate) => candidate.id === next.activeClip?.clipId);
    if (clip) {
      const elapsed = next.activeClip.elapsed + dt;
      const values = sampleKinematicMotionClip(clip, elapsed);
      next = {
        ...next,
        activeClip: clip.loop || elapsed < clip.duration ? { ...next.activeClip, elapsed } : undefined,
        current: { ...next.current, ...values },
        target: { ...next.target, ...values },
      };
      activeLabel = clip.name;
      return {
        state: next,
        kinematicState: stateWithValues(baseState, next),
        settled: !next.activeClip,
        activeLabel,
      };
    }
  }

  next = advanceRobotSequence(graph, next, dt);
  const current = { ...next.current };
  bindings.forEach((binding) => {
    const target = clamp(next.target[binding.jointId] ?? binding.home, binding.limits.lower, binding.limits.upper);
    const previous = current[binding.jointId] ?? binding.home;
    const maxStep = binding.speed * Math.max(next.speedScale, 0.05) * dt;
    current[binding.jointId] = stepToward(previous, target, maxStep);
  });

  next = {
    ...next,
    current,
    gripCurrent: stepToward(next.gripCurrent, next.gripTarget, Math.max(next.speedScale, 0.05) * dt * 2),
  };

  return {
    state: next,
    kinematicState: stateWithValues(baseState, next),
    settled: isRobotSettled(graph, next),
    activeLabel: next.sequence && !next.sequence.completed ? next.sequence.name : undefined,
  };
};

export const startRobotClip = (controller: RobotServoState, clip: KinematicMotionClip): RobotServoState => ({
  ...controller,
  activeClip: { clipId: clip.id, elapsed: 0, loop: clip.loop },
  sequence: undefined,
});

export const stopRobotMotion = (controller: RobotServoState): RobotServoState => ({
  ...controller,
  activeClip: undefined,
  sequence: undefined,
  target: { ...controller.current },
});

export const sampleKinematicMotionClip = (clip: KinematicMotionClip, elapsedSeconds: number): Record<string, number> => {
  if (!clip.keyframes.length) return {};
  const duration = Math.max(clip.duration, clip.keyframes[clip.keyframes.length - 1]?.time ?? 0.001, 0.001);
  const time = clip.loop ? ((elapsedSeconds % duration) + duration) % duration : Math.min(Math.max(elapsedSeconds, 0), duration);
  const sorted = [...clip.keyframes].sort((a, b) => a.time - b.time);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (time <= first.time) return { ...first.jointValues };
  if (time >= last.time) return { ...last.jointValues };
  const nextIndex = sorted.findIndex((keyframe) => keyframe.time >= time);
  const previous = sorted[Math.max(0, nextIndex - 1)];
  const next = sorted[nextIndex];
  const span = Math.max(next.time - previous.time, 0.001);
  const t = smoothstep((time - previous.time) / span);
  const jointIds = new Set([...Object.keys(previous.jointValues), ...Object.keys(next.jointValues)]);
  return Object.fromEntries(
    [...jointIds].map((jointId) => {
      const start = previous.jointValues[jointId] ?? next.jointValues[jointId] ?? 0;
      const end = next.jointValues[jointId] ?? start;
      return [jointId, start + (end - start) * t];
    }),
  );
};

export const robotPoseFromState = (graph: KinematicGraph, state: KinematicState | undefined): RobotPose => {
  const bindings = getRobotJointBindings(graph, state);
  const pose: RobotPose = {};
  bindings.forEach((binding) => {
    const value = state?.jointValues[binding.jointId] ?? binding.home;
    if (binding.key === 'J1' || binding.key === 'J2' || binding.key === 'J3' || binding.key === 'J4' || binding.key === 'J5') {
      pose[binding.key] = value * RAD_TO_DEG;
    }
  });
  const left = keyToBinding(bindings, 'J6L');
  if (left) {
    const value = state?.jointValues[left.jointId] ?? left.home;
    const travel = Math.max(left.limits.upper - left.limits.lower, EPSILON);
    pose.grip = clamp((value - left.limits.lower) / travel, 0, 1);
  }
  return pose;
};

export const buildRobotPickAndPlaceSequence = (options: { pickYaw?: number; placeYaw?: number; placeRoll?: number } = {}): RobotSequenceStep[] => {
  const pickYaw = options.pickYaw ?? -40;
  const placeYaw = options.placeYaw ?? 55;
  const placeRoll = options.placeRoll ?? 90;
  const high = { J2: 50, J3: 70, J4: 60 };
  const low = { J2: 70, J3: 70, J4: 40 };
  return [
    { kind: 'pose', label: 'orient to pick approach', pose: { J1: pickYaw, ...high, J5: 0, grip: 1 } },
    { kind: 'pose', label: 'descend to pick', pose: { J1: pickYaw, ...low } },
    { kind: 'wait', label: 'settle before grasp', seconds: 0.35 },
    { kind: 'grip', label: 'close gripper', grip: 0 },
    { kind: 'wait', label: 'hold grasp', seconds: 0.35 },
    { kind: 'pose', label: 'lift from pick', pose: { J1: pickYaw, ...high } },
    { kind: 'pose', label: 'transfer to place', pose: { J1: placeYaw, ...high, J5: placeRoll } },
    { kind: 'pose', label: 'descend to place', pose: { J1: placeYaw, ...low } },
    { kind: 'wait', label: 'settle before release', seconds: 0.35 },
    { kind: 'grip', label: 'open gripper', grip: 1 },
    { kind: 'wait', label: 'release hold', seconds: 0.25 },
    { kind: 'pose', label: 'retract from place', pose: { J1: placeYaw, ...high } },
    { kind: 'home', label: 'return home' },
  ];
};

export const startRobotSequence = (controller: RobotServoState, name: string, steps: RobotSequenceStep[]): RobotServoState => ({
  ...controller,
  activeClip: undefined,
  sequence: {
    id: `sequence_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    name,
    steps: [...steps],
    index: 0,
    waiting: 0,
    active: false,
    completed: false,
  },
});

const advanceRobotSequence = (graph: KinematicGraph, controller: RobotServoState, dt: number): RobotServoState => {
  const sequence = controller.sequence;
  if (!sequence || sequence.completed) return controller;
  if (sequence.waiting > 0) {
    return {
      ...controller,
      sequence: { ...sequence, waiting: Math.max(0, sequence.waiting - dt) },
    };
  }
  if (sequence.active && !isRobotSettled(graph, controller)) return controller;
  const step = sequence.steps[sequence.index];
  if (!step) {
    return {
      ...controller,
      sequence: { ...sequence, completed: true, active: false },
    };
  }

  const base = {
    ...controller,
    sequence: {
      ...sequence,
      index: sequence.index + 1,
      active: false,
      waiting: 0,
    },
  };

  if (step.kind === 'wait') {
    return {
      ...base,
      sequence: { ...base.sequence!, waiting: step.seconds },
    };
  }
  if (step.kind === 'home') {
    const home = goRobotHome(graph, base);
    return { ...home, sequence: { ...base.sequence!, active: true } };
  }
  if (step.kind === 'grip') {
    const next = setRobotGripTarget(graph, base, step.grip);
    return { ...next, sequence: { ...base.sequence!, active: true } };
  }
  const next = setRobotPoseTarget(graph, base, step.pose);
  return { ...next, sequence: { ...base.sequence!, active: true } };
};

export const buildRobotDiagnosticText = (diagnosis: RobotGraphDiagnosis) => {
  const lines: string[] = [];
  lines.push(`compatible: ${diagnosis.compatible ? 'yes' : 'no'}`);
  lines.push(`schema: ${diagnosis.schema ?? 'unknown'}`);
  lines.push('nodes:');
  Object.entries(diagnosis.nodesFound).forEach(([name, found]) => lines.push(`  ${found ? 'ok' : 'missing'} ${name}`));
  lines.push('clips:');
  Object.entries(diagnosis.clipsFound).forEach(([name, found]) => lines.push(`  ${found ? 'ok' : 'missing'} ${name}`));
  if (diagnosis.warnings.length) {
    lines.push('warnings:');
    diagnosis.warnings.forEach((warning) => lines.push(`  ${warning}`));
  }
  return lines.join('\n');
};
