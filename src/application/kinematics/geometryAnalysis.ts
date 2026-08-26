import type {
  CylinderCandidate,
  GeometricProperties,
  JointFrame,
  JointFrameCandidate,
  MassProperties,
  QuaternionTuple,
} from '../../domain/kinematics';
import type { Vector3Tuple } from '../../domain/model';
import { normalizeAxis } from './kinematicAuthoring';
import type { ReferenceTriangle } from './referenceCenter';

const EPSILON = 1e-9;

type Mat3 = [Vector3Tuple, Vector3Tuple, Vector3Tuple];

export type GeometryAnalysis = {
  geometryHash: string;
  analyzerVersion: 'm2-geometry-v1';
  geometricProperties: GeometricProperties;
  massProperties: MassProperties;
  cylinderCandidates: CylinderCandidate[];
};

const add = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vector3Tuple, amount: number): Vector3Tuple => [a[0] * amount, a[1] * amount, a[2] * amount];
const dot = (a: Vector3Tuple, b: Vector3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vector3Tuple) => Math.hypot(...a);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const pointKey = (point: Vector3Tuple) => point.map((value) => value.toPrecision(12)).join(',');

export const geometryHashForTriangles = (triangles: readonly ReferenceTriangle[]) => {
  let hash = 2166136261;
  triangles.forEach((triangle) => triangle.forEach((point) => point.forEach((value) => {
    const text = Number.isFinite(value) ? value.toPrecision(12) : 'nan';
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  })));
  return `fnv1a-${(hash >>> 0).toString(16)}`;
};

const orthonormalBasis = (axisInput: Vector3Tuple): { x: Vector3Tuple; y: Vector3Tuple; z: Vector3Tuple } | undefined => {
  const z = normalizeAxis(axisInput);
  if (!z) return undefined;
  const reference: Vector3Tuple = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalizeAxis(subtract(reference, scale(z, dot(reference, z))));
  if (!x) return undefined;
  const y = normalizeAxis(cross(z, x));
  if (!y) return undefined;
  return { x, y, z };
};

const quaternionFromBasis = (basis: { x: Vector3Tuple; y: Vector3Tuple; z: Vector3Tuple }): QuaternionTuple => {
  const [x, y, z] = [basis.x, basis.y, basis.z];
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    return [s / 4, (x[1] + y[0]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    return [(x[1] + y[0]) / s, s / 4, (y[2] + z[1]) / s, (z[0] - x[2]) / s];
  }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
  return [(z[0] + x[2]) / s, (y[2] + z[1]) / s, s / 4, (x[1] - y[0]) / s];
};

export const createJointFrame = (
  origin: Vector3Tuple,
  axisInput: Vector3Tuple,
  source: JointFrame['source'],
  evidence: JointFrame['evidence'],
  status: JointFrame['status'] = 'candidate',
): JointFrame | undefined => {
  const basis = orthonormalBasis(axisInput);
  if (!basis) return undefined;
  return { origin, axis: basis.z, orientation: quaternionFromBasis(basis), source, evidence, status, axisSignConvention: 'canonical' };
};

const covariance = (points: Vector3Tuple[], center: Vector3Tuple): Mat3 => {
  const matrix: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  points.forEach((point) => {
    const value = subtract(point, center);
    for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) matrix[row][col] += value[row] * value[col];
  });
  const divisor = Math.max(points.length, 1);
  return matrix.map((row) => row.map((value) => value / divisor) as Vector3Tuple) as Mat3;
};

const multiplyMatVec = (matrix: Mat3, vector: Vector3Tuple): Vector3Tuple => [dot(matrix[0], vector), dot(matrix[1], vector), dot(matrix[2], vector)];

const principalAxis = (matrix: Mat3, initial: Vector3Tuple): Vector3Tuple | undefined => {
  let vector = normalizeAxis(initial);
  if (!vector) return undefined;
  for (let index = 0; index < 48; index += 1) {
    const next = normalizeAxis(multiplyMatVec(matrix, vector));
    if (!next) return vector;
    if (Math.abs(dot(next, vector)) > 1 - 1e-10) return next;
    vector = next;
  }
  return vector;
};

const deflate = (matrix: Mat3, vector: Vector3Tuple): Mat3 => {
  const eigenvalue = dot(vector, multiplyMatVec(matrix, vector));
  return matrix.map((row, rowIndex) => row.map((value, colIndex) => value - eigenvalue * vector[rowIndex] * vector[colIndex]) as Vector3Tuple) as Mat3;
};

const principalAxes = (points: Vector3Tuple[], center: Vector3Tuple): [Vector3Tuple, Vector3Tuple, Vector3Tuple] | undefined => {
  if (points.length < 3) return undefined;
  const first = principalAxis(covariance(points, center), [0.731, 0.521, 0.439]);
  if (!first) return undefined;
  const second = principalAxis(deflate(covariance(points, center), first), [0.127, 0.883, 0.451]);
  if (!second) return undefined;
  const third = normalizeAxis(cross(first, second));
  if (!third) return undefined;
  return [first, normalizeAxis(cross(third, first)) ?? second, third];
};

const angularCoverage = (points: Vector3Tuple[], center: Vector3Tuple, axis: Vector3Tuple) => {
  const basis = orthonormalBasis(axis);
  if (!basis || !points.length) return 0;
  const angles = points.map((point) => {
    const radial = subtract(subtract(point, center), scale(basis.z, dot(subtract(point, center), basis.z)));
    return Math.atan2(dot(radial, basis.y), dot(radial, basis.x));
  }).sort((a, b) => a - b);
  let largestGap = 0;
  angles.forEach((angle, index) => {
    const next = index === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[index + 1];
    largestGap = Math.max(largestGap, next - angle);
  });
  return Math.max(0, (Math.PI * 2 - largestGap) * 180 / Math.PI);
};

export const fitCylinderCandidate = (triangles: readonly ReferenceTriangle[]): CylinderCandidate | undefined => {
  const points = triangles.flatMap((triangle) => triangle.map((point) => point as Vector3Tuple));
  if (points.length < 12) return undefined;
  const center = scale(points.reduce(add, [0, 0, 0]), 1 / points.length);
  const axes = principalAxes(points, center);
  if (!axes) return undefined;
  const dimensions = points.reduce((size, point) => [
    Math.max(size[0], Math.abs(point[0] - center[0])),
    Math.max(size[1], Math.abs(point[1] - center[1])),
    Math.max(size[2], Math.abs(point[2] - center[2])),
  ] as Vector3Tuple, [0, 0, 0]);
  const diagonal = Math.max(length(scale(dimensions, 2)), EPSILON);
  const candidates = axes.map((axis) => {
    const radii = points.map((point) => length(subtract(subtract(point, center), scale(axis, dot(subtract(point, center), axis)))));
    const radius = median(radii);
    const residuals = radii.map((radiusAtPoint) => Math.abs(radiusAtPoint - radius));
    const threshold = Math.max(diagonal * 0.01, radius * 0.035, EPSILON);
    const inlierCount = residuals.filter((residual) => residual <= threshold).length;
    const axial = points.map((point) => dot(subtract(point, center), axis));
    return {
      axisPoint: center,
      axisDirection: axis,
      radius,
      radialResidualRms: Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / residuals.length),
      radialResidualMedian: median(residuals),
      supportRatio: inlierCount / points.length,
      angularCoverageDeg: angularCoverage(points, center, axis),
      axialCoverage: Math.max(...axial) - Math.min(...axial),
      inlierCount,
      totalCount: points.length,
    } satisfies CylinderCandidate;
  });
  return candidates.sort((a, b) => (a.radialResidualMedian / Math.max(a.radius, EPSILON)) - (b.radialResidualMedian / Math.max(b.radius, EPSILON)))[0];
};

export const analyzeGeometry = (triangles: readonly ReferenceTriangle[]): GeometryAnalysis => {
  const points = triangles.flatMap((triangle) => triangle.map((point) => point as Vector3Tuple));
  const min: Vector3Tuple = [Infinity, Infinity, Infinity];
  const max: Vector3Tuple = [-Infinity, -Infinity, -Infinity];
  let surfaceArea = 0;
  let surfaceSum: Vector3Tuple = [0, 0, 0];
  let signedVolume = 0;
  let volumeSum: Vector3Tuple = [0, 0, 0];
  const directedEdges = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  triangles.forEach(([a, b, c]) => {
    [a, b, c].forEach((point) => point.forEach((value, index) => {
      min[index] = Math.min(min[index], value);
      max[index] = Math.max(max[index], value);
    }));
    const area = length(cross(subtract(b, a), subtract(c, a))) / 2;
    if (area > EPSILON) {
      surfaceArea += area;
      surfaceSum = add(surfaceSum, scale([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], area));
    }
    const volume = dot(a, cross(b, c)) / 6;
    signedVolume += volume;
    volumeSum = add(volumeSum, scale([(a[0] + b[0] + c[0]) / 4, (a[1] + b[1] + c[1]) / 4, (a[2] + b[2] + c[2]) / 4], volume));
    [[a, b], [b, c], [c, a]].forEach(([start, end]) => {
      const startKey = pointKey(start);
      const endKey = pointKey(end);
      const canonical = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
      edgeCounts.set(canonical, (edgeCounts.get(canonical) ?? 0) + 1);
      const directed = `${startKey}>${endKey}`;
      directedEdges.set(directed, (directedEdges.get(directed) ?? 0) + 1);
    });
  });
  const dimensions: Vector3Tuple = points.length ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0];
  const aabbCenter: Vector3Tuple = points.length ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] : [0, 0, 0];
  const boundaryEdgeCount = [...edgeCounts.values()].filter((count) => count === 1).length;
  const nonManifoldEdgeCount = [...edgeCounts.values()].filter((count) => count > 2).length;
  let inconsistent = 0;
  directedEdges.forEach((count, directed) => {
    const [start, end] = directed.split('>');
    if (count > 1 || !directedEdges.has(`${end}>${start}`)) inconsistent += 1;
  });
  const topology = {
    watertight: Boolean(points.length && boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0),
    manifold: nonManifoldEdgeCount === 0,
    consistentlyOriented: Boolean(points.length && inconsistent === 0),
    boundaryEdgeCount,
    nonManifoldEdgeCount,
  };
  const surfaceCentroid = surfaceArea > EPSILON ? scale(surfaceSum, 1 / surfaceArea) : undefined;
  const volumeValid = topology.watertight && topology.consistentlyOriented && Math.abs(signedVolume) > EPSILON;
  const volumeCentroid = volumeValid ? scale(volumeSum, 1 / signedVolume) : undefined;
  const centerForPca = surfaceCentroid ?? aabbCenter;
  const geometricProperties: GeometricProperties = { aabbCenter, surfaceCentroid, volumeCentroid, principalAxes: principalAxes(points, centerForPca), dimensions, topology };
  const massProperties: MassProperties = {
    centerOfMass: volumeValid ? volumeCentroid : undefined,
    volume: volumeValid ? Math.abs(signedVolume) : undefined,
    assumption: 'uniform-density',
    valid: volumeValid,
  };
  const cylinder = fitCylinderCandidate(triangles);
  return { geometryHash: geometryHashForTriangles(triangles), analyzerVersion: 'm2-geometry-v1', geometricProperties, massProperties, cylinderCandidates: cylinder ? [cylinder] : [] };
};

const analysisCache = new Map<string, GeometryAnalysis>();
export const analyzeGeometryCached = (triangles: readonly ReferenceTriangle[]) => {
  const hash = geometryHashForTriangles(triangles);
  const cached = analysisCache.get(hash);
  if (cached) return cached;
  const analysis = analyzeGeometry(triangles);
  analysisCache.set(hash, analysis);
  return analysis;
};

export const inferJointFrameFromSeed = (triangles: readonly ReferenceTriangle[], seedPoint: Vector3Tuple): JointFrameCandidate | undefined => {
  const analysis = analyzeGeometryCached(triangles);
  const cylinder = analysis.cylinderCandidates[0];
  if (!cylinder) return undefined;
  const diagonal = Math.max(length(analysis.geometricProperties.dimensions), EPSILON);
  const normalizedResidual = cylinder.radialResidualMedian / diagonal;
  const evidenceLevel: JointFrame['evidence']['evidenceLevel'] = normalizedResidual <= 0.002 && cylinder.supportRatio >= 0.7 ? 'high' : normalizedResidual <= 0.01 ? 'medium' : 'low';
  if (evidenceLevel === 'low') return undefined;
  const frame = createJointFrame(cylinder.axisPoint, cylinder.axisDirection, 'user-seeded', {
    primitive: 'cylinder',
    residual: cylinder.radialResidualMedian,
    normalizedResidual,
    supportRatio: cylinder.supportRatio,
    angularCoverageDeg: cylinder.angularCoverageDeg,
    axialCoverage: cylinder.axialCoverage,
    userSeeded: true,
    evidenceLevel,
    messages: ['The click was used as a geometry seed; the fitted cylinder defines the mechanical axis.'],
  });
  return frame ? { frame, motionType: 'revolute', cylinder, seedPoint } : undefined;
};

export const axisAngularErrorDeg = (a: Vector3Tuple, b: Vector3Tuple) => {
  const first = normalizeAxis(a);
  const second = normalizeAxis(b);
  if (!first || !second) return Number.NaN;
  return Math.acos(Math.min(1, Math.max(-1, Math.abs(dot(first, second))))) * 180 / Math.PI;
};

export const axisLineDistance = (originA: Vector3Tuple, axisA: Vector3Tuple, originB: Vector3Tuple, axisB: Vector3Tuple) => {
  const first = normalizeAxis(axisA);
  const second = normalizeAxis(axisB);
  if (!first || !second) return Number.NaN;
  const delta = subtract(originB, originA);
  const normal = cross(first, second);
  const normalLength = length(normal);
  return normalLength > 1e-7 ? Math.abs(dot(delta, normal)) / normalLength : length(subtract(delta, scale(first, dot(delta, first))));
};
