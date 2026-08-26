import type { KinematicGraph, KinematicMotionClip, KinematicState } from '../../domain/kinematics';
import { getRobotJointBindings, type RobotJointBinding, type RobotSequenceStep } from './robotMotionController';

export type RobotMotionSeverity = 'info' | 'warning' | 'error';

export type RobotMotionIssue = {
  severity: RobotMotionSeverity;
  code: string;
  message: string;
  clipId?: string;
  jointId?: string;
  time?: number;
};

export type RobotMotionJointCoverage = {
  jointId: string;
  name: string;
  key: RobotJointBinding['key'];
  appearsInClips: string[];
  minValue: number;
  maxValue: number;
  maxObservedSpeed: number;
  limitLower: number;
  limitUpper: number;
};

export type RobotMotionClipReport = {
  clipId: string;
  name: string;
  duration: number;
  loop: boolean;
  keyframeCount: number;
  coveredJointCount: number;
  missingJointIds: string[];
  issues: RobotMotionIssue[];
};

export type RobotMotionAnalysisReport = {
  compatible: boolean;
  jointCount: number;
  clipCount: number;
  sequenceStepCount: number;
  joints: RobotMotionJointCoverage[];
  clips: RobotMotionClipReport[];
  issues: RobotMotionIssue[];
};

const EPSILON = 1e-8;

const issue = (
  severity: RobotMotionSeverity,
  code: string,
  message: string,
  detail: Pick<RobotMotionIssue, 'clipId' | 'jointId' | 'time'> = {},
): RobotMotionIssue => ({ severity, code, message, ...detail });

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const sortedKeyframes = (clip: KinematicMotionClip) => [...clip.keyframes].sort((a, b) => a.time - b.time);

const valueAt = (clip: KinematicMotionClip, jointId: string, time: number) => {
  const keys = sortedKeyframes(clip).filter((keyframe) => finite(keyframe.jointValues[jointId]));
  if (!keys.length) return undefined;
  if (time <= keys[0].time) return keys[0].jointValues[jointId];
  if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].jointValues[jointId];
  const nextIndex = keys.findIndex((keyframe) => keyframe.time >= time);
  const previous = keys[Math.max(0, nextIndex - 1)];
  const next = keys[nextIndex];
  const span = Math.max(next.time - previous.time, EPSILON);
  const t = (time - previous.time) / span;
  return previous.jointValues[jointId] + (next.jointValues[jointId] - previous.jointValues[jointId]) * t;
};

const allClipTimes = (clip: KinematicMotionClip) => {
  const times = new Set<number>();
  clip.keyframes.forEach((keyframe) => times.add(keyframe.time));
  return [...times].sort((a, b) => a - b);
};

const bindingById = (bindings: RobotJointBinding[]) => new Map(bindings.map((binding) => [binding.jointId, binding]));

const clipJointIds = (clip: KinematicMotionClip) => {
  const ids = new Set<string>();
  clip.keyframes.forEach((keyframe) => Object.keys(keyframe.jointValues).forEach((jointId) => ids.add(jointId)));
  return ids;
};

const analyzeClipTiming = (clip: KinematicMotionClip): RobotMotionIssue[] => {
  const issues: RobotMotionIssue[] = [];
  if (!finite(clip.duration) || clip.duration <= 0) {
    issues.push(issue('error', 'INVALID_CLIP_DURATION', `${clip.name} has an invalid duration.`, { clipId: clip.id }));
  }
  if (!clip.keyframes.length) {
    issues.push(issue('error', 'EMPTY_CLIP', `${clip.name} has no keyframes.`, { clipId: clip.id }));
    return issues;
  }
  const keys = sortedKeyframes(clip);
  if (keys[0].time > 0.001) {
    issues.push(issue('warning', 'CLIP_DOES_NOT_START_AT_ZERO', `${clip.name} starts after t=0.`, { clipId: clip.id, time: keys[0].time }));
  }
  if (keys[keys.length - 1].time > clip.duration + 0.001) {
    issues.push(issue('error', 'KEYFRAME_AFTER_DURATION', `${clip.name} has keyframes beyond clip duration.`, { clipId: clip.id, time: keys[keys.length - 1].time }));
  }
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index].time <= keys[index - 1].time) {
      issues.push(issue('error', 'NON_MONOTONIC_KEYFRAMES', `${clip.name} has duplicated or unordered keyframe time.`, { clipId: clip.id, time: keys[index].time }));
    }
  }
  return issues;
};

const analyzeClipLimits = (clip: KinematicMotionClip, bindings: RobotJointBinding[]): RobotMotionIssue[] => {
  const issues: RobotMotionIssue[] = [];
  const byId = bindingById(bindings);
  clip.keyframes.forEach((keyframe) => {
    Object.entries(keyframe.jointValues).forEach(([jointId, value]) => {
      const binding = byId.get(jointId);
      if (!binding) {
        issues.push(issue('warning', 'UNKNOWN_CLIP_JOINT', `${clip.name} references unknown joint ${jointId}.`, { clipId: clip.id, jointId, time: keyframe.time }));
        return;
      }
      if (!finite(value)) {
        issues.push(issue('error', 'NON_FINITE_CLIP_VALUE', `${clip.name} has a non-finite joint value for ${binding.name}.`, { clipId: clip.id, jointId, time: keyframe.time }));
        return;
      }
      if (value < binding.limits.lower - 0.0001 || value > binding.limits.upper + 0.0001) {
        issues.push(issue('error', 'CLIP_VALUE_OUT_OF_LIMITS', `${clip.name} drives ${binding.name} outside its limits.`, { clipId: clip.id, jointId, time: keyframe.time }));
      }
    });
  });
  return issues;
};

const analyzeClipSpeeds = (clip: KinematicMotionClip, bindings: RobotJointBinding[]): RobotMotionIssue[] => {
  const issues: RobotMotionIssue[] = [];
  const byId = bindingById(bindings);
  const times = allClipTimes(clip);
  if (times.length < 2) return issues;
  byId.forEach((binding, jointId) => {
    for (let index = 1; index < times.length; index += 1) {
      const previous = valueAt(clip, jointId, times[index - 1]);
      const next = valueAt(clip, jointId, times[index]);
      if (!finite(previous) || !finite(next)) continue;
      const dt = Math.max(times[index] - times[index - 1], EPSILON);
      const speed = Math.abs(next - previous) / dt;
      if (speed > binding.speed * 1.5) {
        issues.push(
          issue(
            'warning',
            'CLIP_SPEED_EXCEEDS_SERVO_LIMIT',
            `${clip.name} moves ${binding.name} faster than the configured servo speed.`,
            { clipId: clip.id, jointId, time: times[index] },
          ),
        );
      }
    }
  });
  return issues;
};

const analyzeGripMirror = (clip: KinematicMotionClip, bindings: RobotJointBinding[]): RobotMotionIssue[] => {
  const issues: RobotMotionIssue[] = [];
  const left = bindings.find((binding) => binding.key === 'J6L');
  const right = bindings.find((binding) => binding.key === 'J6R');
  if (!left || !right) return issues;
  allClipTimes(clip).forEach((time) => {
    const l = valueAt(clip, left.jointId, time);
    const r = valueAt(clip, right.jointId, time);
    if (!finite(l) || !finite(r)) return;
    if (Math.abs(l + r) > 0.004) {
      issues.push(issue('error', 'GRIPPER_NOT_MIRRORED', `${clip.name} does not keep gripper fingers mirrored.`, { clipId: clip.id, jointId: right.jointId, time }));
    }
  });
  return issues;
};

const jointCoverage = (bindings: RobotJointBinding[], clips: KinematicMotionClip[]): RobotMotionJointCoverage[] =>
  bindings.map((binding) => {
    const values: number[] = [];
    const appearsInClips: string[] = [];
    let maxObservedSpeed = 0;
    clips.forEach((clip) => {
      const times = allClipTimes(clip);
      let appeared = false;
      times.forEach((time, index) => {
        const value = valueAt(clip, binding.jointId, time);
        if (!finite(value)) return;
        appeared = true;
        values.push(value);
        if (index > 0) {
          const previous = valueAt(clip, binding.jointId, times[index - 1]);
          if (finite(previous)) maxObservedSpeed = Math.max(maxObservedSpeed, Math.abs(value - previous) / Math.max(time - times[index - 1], EPSILON));
        }
      });
      if (appeared) appearsInClips.push(clip.name);
    });
    return {
      jointId: binding.jointId,
      name: binding.name,
      key: binding.key,
      appearsInClips,
      minValue: values.length ? Math.min(...values) : binding.home,
      maxValue: values.length ? Math.max(...values) : binding.home,
      maxObservedSpeed,
      limitLower: binding.limits.lower,
      limitUpper: binding.limits.upper,
    };
  });

const sequenceIssues = (sequence: RobotSequenceStep[], bindings: RobotJointBinding[]) => {
  const issues: RobotMotionIssue[] = [];
  if (!sequence.length) {
    issues.push(issue('warning', 'EMPTY_SEQUENCE', 'Programmatic robot sequence has no steps.'));
    return issues;
  }
  const keys = new Set(bindings.map((binding) => binding.key));
  let hasGripStep = false;
  sequence.forEach((step, index) => {
    if (step.kind === 'wait' && (!finite(step.seconds) || step.seconds < 0)) {
      issues.push(issue('error', 'INVALID_SEQUENCE_WAIT', `Sequence step ${index + 1} has an invalid wait duration.`));
    }
    if (step.kind === 'grip') {
      hasGripStep = true;
      if (!finite(step.grip) || step.grip < 0 || step.grip > 1) issues.push(issue('error', 'INVALID_SEQUENCE_GRIP', `Sequence step ${index + 1} has invalid grip value.`));
    }
    if (step.kind === 'pose') {
      Object.keys(step.pose).forEach((key) => {
        if (key === 'grip') {
          hasGripStep = true;
          return;
        }
        if (!keys.has(key as RobotJointBinding['key'])) issues.push(issue('warning', 'UNKNOWN_SEQUENCE_AXIS', `Sequence step ${index + 1} references ${key}.`));
      });
    }
  });
  if (!hasGripStep) issues.push(issue('info', 'SEQUENCE_WITHOUT_GRIP', 'Programmatic sequence does not operate the gripper.'));
  return issues;
};

export const analyzeRobotMotion = (graph: KinematicGraph, state?: KinematicState, sequence: RobotSequenceStep[] = []): RobotMotionAnalysisReport => {
  const bindings = getRobotJointBindings(graph, state);
  const clips = graph.motionClips ?? [];
  const issues: RobotMotionIssue[] = [];

  const clipReports = clips.map((clip) => {
    const ids = clipJointIds(clip);
    const missingJointIds = bindings.map((binding) => binding.jointId).filter((jointId) => !ids.has(jointId));
    const clipIssues = [
      ...analyzeClipTiming(clip),
      ...analyzeClipLimits(clip, bindings),
      ...analyzeClipSpeeds(clip, bindings),
      ...analyzeGripMirror(clip, bindings),
    ];
    if (missingJointIds.length) {
      clipIssues.push(issue('warning', 'CLIP_MISSING_JOINTS', `${clip.name} does not key every robot joint.`, { clipId: clip.id }));
    }
    issues.push(...clipIssues);
    return {
      clipId: clip.id,
      name: clip.name,
      duration: clip.duration,
      loop: clip.loop,
      keyframeCount: clip.keyframes.length,
      coveredJointCount: ids.size,
      missingJointIds,
      issues: clipIssues,
    };
  });

  if (!clips.length) issues.push(issue('warning', 'NO_ROBOT_CLIPS', 'Robot graph has no imported or generated motion clips.'));
  if (bindings.length < 7) issues.push(issue('error', 'INCOMPLETE_ROBOT_BINDINGS', 'Robot graph does not expose all seven moving nodes.'));
  issues.push(...sequenceIssues(sequence, bindings));

  return {
    compatible: !issues.some((item) => item.severity === 'error'),
    jointCount: bindings.length,
    clipCount: clips.length,
    sequenceStepCount: sequence.length,
    joints: jointCoverage(bindings, clips),
    clips: clipReports,
    issues,
  };
};

export const summarizeRobotMotionAnalysis = (report: RobotMotionAnalysisReport) => {
  const lines: string[] = [];
  lines.push(`compatible: ${report.compatible ? 'yes' : 'no'}`);
  lines.push(`joints: ${report.jointCount}`);
  lines.push(`clips: ${report.clipCount}`);
  lines.push(`sequence steps: ${report.sequenceStepCount}`);
  report.joints.forEach((joint) => {
    lines.push(`${joint.key} ${joint.name}: ${joint.appearsInClips.length} clips, range ${joint.minValue.toFixed(3)}..${joint.maxValue.toFixed(3)}`);
  });
  if (report.issues.length) {
    lines.push('issues:');
    report.issues.forEach((item) => lines.push(`${item.severity} ${item.code}: ${item.message}`));
  }
  return lines.join('\n');
};
