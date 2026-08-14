import type {
  JointType,
  KinematicGraph,
  KinematicJoint,
  KinematicState,
  MechanicalPart,
  QuaternionTuple,
  Transform3D,
} from '../../domain/kinematics';
import type { Vector3Tuple } from '../../domain/model';

export type KinematicValidationIssue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  jointId?: string;
  partId?: string;
};

export type EvaluatedPartPose = {
  partId: string;
  matrix: number[];
  position: Vector3Tuple;
  rotation: QuaternionTuple;
  scale: Vector3Tuple;
};

const EPSILON = 1e-8;

const identityMatrix = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const finiteVector = (values: number[] | undefined, size: number) => Boolean(values && values.length === size && values.every(Number.isFinite));

export const normalizeAxis = (axis: Vector3Tuple): Vector3Tuple | undefined => {
  if (!finiteVector(axis, 3)) return undefined;
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length <= EPSILON) return undefined;
  return [axis[0] / length, axis[1] / length, axis[2] / length];
};

const normalizeQuaternion = (rotation: QuaternionTuple): QuaternionTuple | undefined => {
  if (!finiteVector(rotation, 4)) return undefined;
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (length <= EPSILON) return undefined;
  return [rotation[0] / length, rotation[1] / length, rotation[2] / length, rotation[3] / length];
};

const clamp = (value: number, lower?: number, upper?: number) => {
  let next = value;
  if (Number.isFinite(lower)) next = Math.max(lower as number, next);
  if (Number.isFinite(upper)) next = Math.min(upper as number, next);
  return next;
};

const matrixMultiply = (a: number[], b: number[]) => {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[row * 4 + col] =
        a[row * 4] * b[col] +
        a[row * 4 + 1] * b[4 + col] +
        a[row * 4 + 2] * b[8 + col] +
        a[row * 4 + 3] * b[12 + col];
    }
  }
  return out;
};

const translationMatrix = (position: Vector3Tuple) => [1, 0, 0, position[0], 0, 1, 0, position[1], 0, 0, 1, position[2], 0, 0, 0, 1];

const scaleMatrix = (scale: Vector3Tuple) => [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1];

const eulerMatrix = (rotation: Vector3Tuple) => {
  const [x, y, z] = rotation;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return [
    cy * cz,
    -cy * sz,
    sy,
    0,
    sx * sy * cz + cx * sz,
    -sx * sy * sz + cx * cz,
    -sx * cy,
    0,
    -cx * sy * cz + sx * sz,
    cx * sy * sz + sx * cz,
    cx * cy,
    0,
    0,
    0,
    0,
    1,
  ];
};

const quaternionMatrix = (rotation: QuaternionTuple) => {
  const [x, y, z, w] = rotation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz),
    2 * (xy - wz),
    2 * (xz + wy),
    0,
    2 * (xy + wz),
    1 - 2 * (xx + zz),
    2 * (yz - wx),
    0,
    2 * (xz - wy),
    2 * (yz + wx),
    1 - 2 * (xx + yy),
    0,
    0,
    0,
    0,
    1,
  ];
};

const axisAngleMatrix = (axis: Vector3Tuple, angle: number) => {
  const normalized = normalizeAxis(axis);
  if (!normalized) return identityMatrix();
  const [x, y, z] = normalized;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    0,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    0,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
};

const inverseTranslationMatrix = (position: Vector3Tuple) => translationMatrix([-position[0], -position[1], -position[2]]);

const transformToMatrix = (transform: Transform3D) =>
  matrixMultiply(matrixMultiply(translationMatrix(transform.position), eulerMatrix(transform.rotation)), scaleMatrix(transform.scale));

const matrixPosition = (matrix: number[]): Vector3Tuple => [matrix[3], matrix[7], matrix[11]];

const matrixScale = (matrix: number[]): Vector3Tuple => [
  Math.hypot(matrix[0], matrix[4], matrix[8]),
  Math.hypot(matrix[1], matrix[5], matrix[9]),
  Math.hypot(matrix[2], matrix[6], matrix[10]),
];

const matrixQuaternion = (matrix: number[]): QuaternionTuple => {
  const scale = matrixScale(matrix);
  const m00 = matrix[0] / (scale[0] || 1);
  const m11 = matrix[5] / (scale[1] || 1);
  const m22 = matrix[10] / (scale[2] || 1);
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(matrix[9] / (scale[2] || 1) - matrix[6] / (scale[1] || 1)) / s, (matrix[2] / (scale[0] || 1) - matrix[8] / (scale[2] || 1)) / s, (matrix[4] / (scale[1] || 1) - matrix[1] / (scale[0] || 1)) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (matrix[1] / (scale[0] || 1) + matrix[4] / (scale[1] || 1)) / s, (matrix[2] / (scale[0] || 1) + matrix[8] / (scale[2] || 1)) / s, (matrix[9] / (scale[2] || 1) - matrix[6] / (scale[1] || 1)) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(matrix[1] / (scale[0] || 1) + matrix[4] / (scale[1] || 1)) / s, 0.25 * s, (matrix[6] / (scale[1] || 1) + matrix[9] / (scale[2] || 1)) / s, (matrix[2] / (scale[0] || 1) - matrix[8] / (scale[2] || 1)) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(matrix[2] / (scale[0] || 1) + matrix[8] / (scale[2] || 1)) / s, (matrix[6] / (scale[1] || 1) + matrix[9] / (scale[2] || 1)) / s, 0.25 * s, (matrix[4] / (scale[1] || 1) - matrix[1] / (scale[0] || 1)) / s];
};

const jointMotionMatrix = (joint: KinematicJoint, value: number) => {
  const axis = normalizeAxis(joint.axis);
  if (!axis || joint.type === 'fixed') return identityMatrix();
  const limited = joint.type === 'continuous' ? value : clamp(value, joint.limits?.lower, joint.limits?.upper);
  if (joint.type === 'prismatic') return translationMatrix([axis[0] * limited, axis[1] * limited, axis[2] * limited]);
  if (joint.type === 'revolute' || joint.type === 'continuous') {
    const originRotation = normalizeQuaternion(joint.origin.rotation) ?? [0, 0, 0, 1];
    const originFrame = matrixMultiply(translationMatrix(joint.origin.position), quaternionMatrix(originRotation));
    return matrixMultiply(matrixMultiply(matrixMultiply(originFrame, axisAngleMatrix(axis, limited)), quaternionMatrix([-originRotation[0], -originRotation[1], -originRotation[2], originRotation[3]])), inverseTranslationMatrix(joint.origin.position));
  }
  return identityMatrix();
};

export const createHomeKinematicState = (graph: KinematicGraph): KinematicState => {
  const homeJointValues = Object.fromEntries(graph.joints.map((joint) => [joint.id, 0]));
  return { homeJointValues, jointValues: { ...homeJointValues } };
};

export const setJointValue = (graph: KinematicGraph, state: KinematicState | undefined, jointId: string, value: number): KinematicState => {
  const joint = graph.joints.find((item) => item.id === jointId);
  const baseState = state ?? createHomeKinematicState(graph);
  if (!joint || !Number.isFinite(value)) return baseState;
  const nextValue = joint.type === 'continuous' ? value : clamp(value, joint.limits?.lower, joint.limits?.upper);
  return {
    homeJointValues: { ...baseState.homeJointValues },
    jointValues: { ...baseState.jointValues, [jointId]: nextValue },
  };
};

export const setLogicalControlValue = (graph: KinematicGraph, state: KinematicState | undefined, controlId: string, value: number): KinematicState => {
  const control = graph.logicalControls?.find((item) => item.id === controlId);
  const baseState = state ?? createHomeKinematicState(graph);
  if (!control || !Number.isFinite(value)) return baseState;
  return control.jointMappings.reduce(
    (nextState, mapping) => setJointValue(graph, nextState, mapping.jointId, value * mapping.multiplier + mapping.offset),
    baseState,
  );
};

export const resetKinematicState = (graph: KinematicGraph, state?: KinematicState): KinematicState => {
  const home = state?.homeJointValues ?? createHomeKinematicState(graph).homeJointValues;
  return { homeJointValues: { ...home }, jointValues: { ...home } };
};

export const normalizeKinematicGraph = (graph: KinematicGraph): KinematicGraph => ({
  ...graph,
  joints: graph.joints.map((joint) => ({
    ...joint,
    axis: normalizeAxis(joint.axis) ?? joint.axis,
    origin: {
      position: joint.origin.position,
      rotation: normalizeQuaternion(joint.origin.rotation) ?? joint.origin.rotation,
    },
  })),
});

const duplicateIds = (ids: string[]) => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  ids.forEach((id) => {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  });
  return duplicates;
};

const requiresAxis = (type: JointType) => type === 'revolute' || type === 'continuous' || type === 'prismatic' || type === 'screw';

export const validateKinematicGraph = (graph: KinematicGraph): KinematicValidationIssue[] => {
  const issues: KinematicValidationIssue[] = [];
  const partIds = new Set(graph.parts.map((part) => part.id));
  const childParents = new Map<string, string>();
  const duplicatePartIds = duplicateIds(graph.parts.map((part) => part.id));
  const duplicateJointIds = duplicateIds(graph.joints.map((joint) => joint.id));
  const activeJoints = graph.joints.filter((joint) => joint.status !== 'rejected');

  if (!partIds.has(graph.rootPartId)) {
    issues.push({ severity: 'error', code: 'ROOT_MISSING', message: 'Kinematic root part does not exist.', partId: graph.rootPartId });
  }

  duplicatePartIds.forEach((id) => issues.push({ severity: 'error', code: 'DUPLICATE_PART_ID', message: `Duplicate part id ${id}.`, partId: id }));
  duplicateJointIds.forEach((id) => issues.push({ severity: 'error', code: 'DUPLICATE_JOINT_ID', message: `Duplicate joint id ${id}.`, jointId: id }));

  graph.parts.forEach((part) => {
    if (!finiteVector(part.localFrame.position, 3) || !finiteVector(part.localFrame.rotation, 3) || !finiteVector(part.localFrame.scale, 3)) {
      issues.push({ severity: 'error', code: 'PART_TRANSFORM_NON_FINITE', message: `${part.name} has a non-finite local frame.`, partId: part.id });
    }
  });

  activeJoints.forEach((joint) => {
    if (!partIds.has(joint.parentPartId)) {
      issues.push({ severity: 'error', code: 'PARENT_MISSING', message: `${joint.name} references a missing parent part.`, jointId: joint.id });
    }
    if (!partIds.has(joint.childPartId)) {
      issues.push({ severity: 'error', code: 'CHILD_MISSING', message: `${joint.name} references a missing child part.`, jointId: joint.id });
    }
    if (joint.parentPartId === joint.childPartId) {
      issues.push({ severity: 'error', code: 'SELF_PARENT', message: `${joint.name} uses the same parent and child.`, jointId: joint.id });
    }
    const existingParent = childParents.get(joint.childPartId);
    if (existingParent && existingParent !== joint.parentPartId) {
      issues.push({ severity: 'error', code: 'MULTIPLE_PARENTS', message: `${joint.childPartId} has incompatible kinematic parents.`, jointId: joint.id });
    }
    childParents.set(joint.childPartId, joint.parentPartId);

    if (requiresAxis(joint.type) && !normalizeAxis(joint.axis)) {
      issues.push({ severity: 'error', code: 'INVALID_AXIS', message: `${joint.name} has an invalid or zero axis.`, jointId: joint.id });
    }
    if (!finiteVector(joint.origin.position, 3) || !normalizeQuaternion(joint.origin.rotation)) {
      issues.push({ severity: 'error', code: 'INVALID_ORIGIN', message: `${joint.name} has an invalid joint origin frame.`, jointId: joint.id });
    }
    const lower = joint.limits?.lower;
    const upper = joint.limits?.upper;
    if ((lower !== undefined && !Number.isFinite(lower)) || (upper !== undefined && !Number.isFinite(upper))) {
      issues.push({ severity: 'error', code: 'INVALID_LIMIT', message: `${joint.name} has non-finite limits.`, jointId: joint.id });
    } else if ((joint.type === 'revolute' || joint.type === 'prismatic') && lower !== undefined && upper !== undefined && lower > upper) {
      issues.push({ severity: 'error', code: 'INVALID_LIMIT_ORDER', message: `${joint.name} lower limit is greater than upper limit.`, jointId: joint.id });
    }
    if (joint.coupling && !activeJoints.some((candidate) => candidate.id === joint.coupling?.driverJointId)) {
      issues.push({ severity: 'error', code: 'INVALID_COUPLING', message: `${joint.name} references a missing driver joint.`, jointId: joint.id });
    } else if (joint.coupling) {
      const driver = activeJoints.find((candidate) => candidate.id === joint.coupling?.driverJointId);
      if (joint.coupling.driverJointId === joint.id) {
        issues.push({ severity: 'error', code: 'COUPLING_SELF_REFERENCE', message: `${joint.name} cannot mimic itself.`, jointId: joint.id });
      }
      if (!Number.isFinite(joint.coupling.multiplier) || !Number.isFinite(joint.coupling.offset)) {
        issues.push({ severity: 'error', code: 'INVALID_COUPLING_VALUE', message: `${joint.name} has non-finite coupling parameters.`, jointId: joint.id });
      }
      if (driver?.limits && joint.limits && driver.limits.lower !== undefined && driver.limits.upper !== undefined && joint.limits.lower !== undefined && joint.limits.upper !== undefined) {
        const mappedA = driver.limits.lower * joint.coupling.multiplier + joint.coupling.offset;
        const mappedB = driver.limits.upper * joint.coupling.multiplier + joint.coupling.offset;
        const mappedLower = Math.min(mappedA, mappedB);
        const mappedUpper = Math.max(mappedA, mappedB);
        if (mappedUpper < joint.limits.lower || mappedLower > joint.limits.upper) {
          issues.push({ severity: 'error', code: 'COUPLING_LIMIT_CONFLICT', message: `${joint.name} mimic limits do not overlap child limits.`, jointId: joint.id });
        }
      }
    }
  });

  graph.logicalControls?.forEach((control) => {
    const seenMappings = new Set<string>();
    control.jointMappings.forEach((mapping) => {
      if (!activeJoints.some((joint) => joint.id === mapping.jointId)) {
        issues.push({ severity: 'error', code: 'LOGICAL_CONTROL_JOINT_MISSING', message: `${control.name} references a missing joint.`, jointId: mapping.jointId });
      }
      if (seenMappings.has(mapping.jointId)) {
        issues.push({ severity: 'error', code: 'LOGICAL_CONTROL_DUPLICATE_JOINT', message: `${control.name} maps the same joint more than once.`, jointId: mapping.jointId });
      }
      seenMappings.add(mapping.jointId);
      if (!Number.isFinite(mapping.multiplier) || !Number.isFinite(mapping.offset)) {
        issues.push({ severity: 'error', code: 'LOGICAL_CONTROL_NON_FINITE', message: `${control.name} has non-finite mapping values.`, jointId: mapping.jointId });
      }
    });
  });

  const couplingChildren = new Map<string, string[]>();
  activeJoints.forEach((joint) => {
    if (joint.coupling) couplingChildren.set(joint.coupling.driverJointId, [...(couplingChildren.get(joint.coupling.driverJointId) ?? []), joint.id]);
  });
  const couplingVisiting = new Set<string>();
  const couplingVisited = new Set<string>();
  const visitCoupling = (jointId: string) => {
    if (couplingVisiting.has(jointId)) {
      issues.push({ severity: 'error', code: 'COUPLING_CYCLE', message: `Coupling cycle detected at ${jointId}.`, jointId });
      return;
    }
    if (couplingVisited.has(jointId)) return;
    couplingVisiting.add(jointId);
    (couplingChildren.get(jointId) ?? []).forEach(visitCoupling);
    couplingVisiting.delete(jointId);
    couplingVisited.add(jointId);
  };
  activeJoints.forEach((joint) => visitCoupling(joint.id));

  const children = new Map<string, string[]>();
  activeJoints.forEach((joint) => {
    children.set(joint.parentPartId, [...(children.get(joint.parentPartId) ?? []), joint.childPartId]);
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (partId: string) => {
    if (visiting.has(partId)) {
      issues.push({ severity: 'error', code: 'CYCLE_DETECTED', message: `Cycle detected at ${partId}.`, partId });
      return;
    }
    if (visited.has(partId)) return;
    visiting.add(partId);
    (children.get(partId) ?? []).forEach(visit);
    visiting.delete(partId);
    visited.add(partId);
  };
  if (partIds.has(graph.rootPartId)) visit(graph.rootPartId);

  graph.parts
    .filter((part) => part.id !== graph.rootPartId && !visited.has(part.id))
    .forEach((part) => issues.push({ severity: 'warning', code: 'ORPHAN_PART', message: `${part.name} is not reachable from the kinematic root.`, partId: part.id }));

  return issues;
};

export const updateJoint = (graph: KinematicGraph, jointId: string, patch: Partial<KinematicJoint>): KinematicGraph =>
  normalizeKinematicGraph({
    ...graph,
    joints: graph.joints.map((joint) =>
      joint.id === jointId
        ? {
            ...joint,
            ...patch,
            origin: patch.origin ? { ...joint.origin, ...patch.origin } : joint.origin,
            limits: patch.limits ? { ...joint.limits, ...patch.limits } : joint.limits,
            source: patch.source ?? 'manual',
          }
        : joint,
    ),
  });

export const createJoint = (graph: KinematicGraph, joint: KinematicJoint): KinematicGraph =>
  normalizeKinematicGraph({
    ...graph,
    joints: [...graph.joints, joint],
  });

export const removeJoint = (graph: KinematicGraph, jointId: string): KinematicGraph => ({
  ...graph,
  joints: graph.joints.filter((joint) => joint.id !== jointId),
});

export const acceptJointCandidate = (graph: KinematicGraph, jointId: string): KinematicGraph => updateJoint(graph, jointId, { status: 'validated', source: 'manual' });

export const rejectJointCandidate = (graph: KinematicGraph, jointId: string): KinematicGraph => updateJoint(graph, jointId, { status: 'rejected' });

const graphChildren = (graph: KinematicGraph) => {
  const byParent = new Map<string, KinematicJoint[]>();
  graph.joints.filter((joint) => joint.status !== 'rejected').forEach((joint) => {
    byParent.set(joint.parentPartId, [...(byParent.get(joint.parentPartId) ?? []), joint]);
  });
  return byParent;
};

export const evaluateForwardKinematics = (graphInput: KinematicGraph, stateInput?: KinematicState): Record<string, EvaluatedPartPose> => {
  const graph = normalizeKinematicGraph(graphInput);
  const parts = new Map<string, MechanicalPart>(graph.parts.map((part) => [part.id, part]));
  const children = graphChildren(graph);
  const state = stateInput ?? createHomeKinematicState(graph);
  const result: Record<string, EvaluatedPartPose> = {};
  const visited = new Set<string>();

  const evaluatePart = (partId: string, parentMatrix: number[]) => {
    if (visited.has(partId)) return;
    visited.add(partId);
    const part = parts.get(partId);
    if (!part) return;
    const matrix = matrixMultiply(parentMatrix, transformToMatrix(part.localFrame));
    result[partId] = {
      partId,
      matrix,
      position: matrixPosition(matrix),
      rotation: normalizeQuaternion(matrixQuaternion(matrix)) ?? [0, 0, 0, 1],
      scale: matrixScale(matrix),
    };

    (children.get(partId) ?? []).forEach((joint) => {
      const baseValue = state.jointValues[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
      const value = joint.coupling
        ? (state.jointValues[joint.coupling.driverJointId] ?? state.homeJointValues[joint.coupling.driverJointId] ?? 0) * joint.coupling.multiplier +
          joint.coupling.offset
        : baseValue;
      evaluatePart(joint.childPartId, matrixMultiply(matrix, jointMotionMatrix(joint, value)));
    });
  };

  evaluatePart(graph.rootPartId, identityMatrix());
  return result;
};

export const transformPoint = (matrix: number[], point: Vector3Tuple): Vector3Tuple => [
  matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3],
  matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7],
  matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11],
];

export const distancePointToAxis = (point: Vector3Tuple, origin: Vector3Tuple, axisInput: Vector3Tuple) => {
  const axis = normalizeAxis(axisInput);
  if (!axis) return Number.NaN;
  const px = point[0] - origin[0];
  const py = point[1] - origin[1];
  const pz = point[2] - origin[2];
  const projection = px * axis[0] + py * axis[1] + pz * axis[2];
  const closest: Vector3Tuple = [origin[0] + axis[0] * projection, origin[1] + axis[1] * projection, origin[2] + axis[2] * projection];
  return Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]);
};
