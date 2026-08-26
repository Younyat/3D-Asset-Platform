import type { KinematicGraph, KinematicJoint, MechanicalPart } from '../../domain/kinematics';
import type { Vector3Tuple } from '../../domain/model';
import { analyzeGeometryCached, axisAngularErrorDeg, axisLineDistance, inferJointFrameFromSeed } from './geometryAnalysis';
import { distancePointToAxis, evaluateForwardKinematics, setJointValue, transformPoint } from './kinematicAuthoring';
import type { ReferenceTriangle } from './referenceCenter';

const EPSILON = 1e-6;
const normalize = (value: Vector3Tuple): Vector3Tuple => {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
};
const dot = (a: Vector3Tuple, b: Vector3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vector3Tuple, value: number): Vector3Tuple => [a[0] * value, a[1] * value, a[2] * value];
const distance = (a: Vector3Tuple, b: Vector3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

const basis = (axis: Vector3Tuple) => {
  const z = normalize(axis);
  const helper: Vector3Tuple = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize([helper[0] - dot(helper, z) * z[0], helper[1] - dot(helper, z) * z[1], helper[2] - dot(helper, z) * z[2]]);
  return { x, y: normalize(cross(z, x)), z };
};

const cylinder = (origin: Vector3Tuple, axis: Vector3Tuple, radius = 1, length = 6, segments = 48): ReferenceTriangle[] => {
  const frame = basis(axis);
  const a = add(origin, scale(frame.z, -length / 2));
  const b = add(origin, scale(frame.z, length / 2));
  const ring = (center: Vector3Tuple, index: number) => add(center, add(scale(frame.x, radius * Math.cos(index / segments * Math.PI * 2)), scale(frame.y, radius * Math.sin(index / segments * Math.PI * 2))));
  const triangles: ReferenceTriangle[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    triangles.push([ring(a, index), ring(a, next), ring(b, next)]);
    triangles.push([ring(a, index), ring(b, next), ring(b, index)]);
  }
  return triangles;
};

const rotateZ = (point: Vector3Tuple, radians: number, translate: Vector3Tuple): Vector3Tuple => [
  point[0] * Math.cos(radians) - point[1] * Math.sin(radians) + translate[0],
  point[0] * Math.sin(radians) + point[1] * Math.cos(radians) + translate[1],
  point[2] + translate[2],
];

const part = (id: string, position: Vector3Tuple): MechanicalPart => ({
  id, name: id, meshObjectIds: [id], localFrame: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: { min: [-1, -1, -1], max: [1, 1, 1], size: [2, 2, 2], center: [0, 0, 0] }, static: id === 'base', visible: true, source: 'manual-group', metadata: {},
});

const joint = (id: string, parentPartId: string, childPartId: string, type: KinematicJoint['type'], origin: Vector3Tuple, axis: Vector3Tuple): KinematicJoint => ({
  id, name: id, parentPartId, childPartId, type, origin: { position: origin, rotation: [0, 0, 0, 1] }, axis, limits: { lower: -4, upper: 4 }, source: 'geometry', evidence: [{ type: 'geometry', message: 'Analytic fixture.' }], status: 'candidate',
});

export type M2FixtureResult = { fixture: string; axisErrorDeg?: number; axisLineError?: number; result: 'PASS' | 'FAIL' };

export const runM2GeometryTests = (): M2FixtureResult[] => {
  const results: M2FixtureResult[] = [];
  const fixtures: Array<{ name: string; origin: Vector3Tuple; axis: Vector3Tuple }> = [
    { name: 'cylinder-z', origin: [0, 0, 0], axis: [0, 0, 1] },
    { name: 'cylinder-x', origin: [2, -1, 0.5], axis: [1, 0, 0] },
    { name: 'cylinder-arbitrary', origin: [-1.5, 0.75, 2], axis: normalize([1, 1, 0]) },
    { name: 'cylinder-fully-arbitrary', origin: [3, -2, 1], axis: normalize([0.32, 0.71, -0.41]) },
  ];
  fixtures.forEach((fixture) => {
    const candidate = inferJointFrameFromSeed(cylinder(fixture.origin, fixture.axis), add(fixture.origin, [1, 0, 0]));
    assert(Boolean(candidate), `${fixture.name} did not yield a candidate.`);
    const axisErrorDeg = axisAngularErrorDeg(candidate!.frame.axis, fixture.axis);
    const axisLineError = axisLineDistance(candidate!.frame.origin, candidate!.frame.axis, fixture.origin, fixture.axis) / Math.sqrt(40);
    assert(axisErrorDeg <= 0.5, `${fixture.name} axis error ${axisErrorDeg}.`);
    assert(axisLineError <= 0.002, `${fixture.name} line error ${axisLineError}.`);
    results.push({ fixture: fixture.name, axisErrorDeg, axisLineError, result: 'PASS' });
  });

  const source = cylinder([0, 0, 0], normalize([1, 1, 0]));
  const transformed = source.map(([a, b, c]) => [rotateZ(a, 0.61, [4, -3, 2]), rotateZ(b, 0.61, [4, -3, 2]), rotateZ(c, 0.61, [4, -3, 2])] as ReferenceTriangle);
  const transformedCandidate = inferJointFrameFromSeed(transformed, [4, -3, 2]);
  const transformedAxis = normalize([Math.cos(0.61) - Math.sin(0.61), Math.sin(0.61) + Math.cos(0.61), 0]);
  assert(Boolean(transformedCandidate), 'Transformed cylinder did not yield a candidate.');
  assert(axisAngularErrorDeg(transformedCandidate!.frame.axis, transformedAxis) <= 0.5, 'Rigid transform changed inferred axis.');
  results.push({ fixture: 'rigid-transform-invariance', axisErrorDeg: axisAngularErrorDeg(transformedCandidate!.frame.axis, transformedAxis), result: 'PASS' });

  const clickSeeds = [0, Math.PI / 4, Math.PI / 2, 2.39, 3.93, 5.41].map((angle) => [Math.cos(angle), Math.sin(angle), 0] as Vector3Tuple);
  const seeded = clickSeeds.map((seed) => inferJointFrameFromSeed(source, seed));
  assert(seeded.every(Boolean), 'Circular seed did not consistently resolve a candidate.');
  const first = seeded[0]!;
  seeded.forEach((candidate) => {
    assert(distance(candidate!.frame.origin, first.frame.origin) < EPSILON, 'Seed click was used directly as the pivot.');
    assert(axisAngularErrorDeg(candidate!.frame.axis, first.frame.axis) < EPSILON, 'Seed click changed a stable axis-line.');
  });
  results.push({ fixture: 'one-click-cylinder', axisErrorDeg: 0, axisLineError: 0, result: 'PASS' });

  const open = analyzeGeometryCached(source);
  assert(!open.massProperties.valid && !open.geometricProperties.topology.watertight, 'Open cylinder incorrectly claimed a valid volume mass property.');
  const cachedAgain = analyzeGeometryCached(source);
  assert(open === cachedAgain, 'Geometry cache did not reuse the analysis result.');
  results.push({ fixture: 'open-cylinder-topology-cache', result: 'PASS' });

  const axis = normalize([0.137, 0.982, -0.129]);
  const graph: KinematicGraph = { parts: [part('base', [0, 0, 0]), part('arm', [2, 1, -1]), part('tool', [1, 0, 0])], joints: [joint('j1', 'base', 'arm', 'revolute', [0.4, -0.2, 0.1], axis), joint('j2', 'arm', 'tool', 'prismatic', [0.2, 0.3, 0.1], normalize([1, -1, 0.5]))], rootPartId: 'base' };
  const home = evaluateForwardKinematics(graph, setJointValue(graph, undefined, 'j1', 0));
  const rotated = evaluateForwardKinematics(graph, setJointValue(graph, undefined, 'j1', 0.8));
  const rotatedPoint = transformPoint(rotated.arm.matrix, [0, 0, 0]);
  const homePoint = transformPoint(home.arm.matrix, [0, 0, 0]);
  assert(Math.abs(distancePointToAxis(homePoint, [0.4, -0.2, 0.1], axis) - distancePointToAxis(rotatedPoint, [0.4, -0.2, 0.1], axis)) < 1e-6, 'Revolute radius invariant failed.');
  const slide = evaluateForwardKinematics(graph, setJointValue(graph, undefined, 'j2', 0.7));
  const delta: Vector3Tuple = [slide.tool.position[0] - home.tool.position[0], slide.tool.position[1] - home.tool.position[1], slide.tool.position[2] - home.tool.position[2]];
  const slideAxis = normalize([1, -1, 0.5]);
  assert(Math.hypot(...cross(delta, slideAxis)) < 1e-6, 'Prismatic motion has a perpendicular component.');
  const restored = evaluateForwardKinematics(graph, setJointValue(graph, undefined, 'j1', 0));
  assert(distance(restored.arm.position, home.arm.position) < EPSILON, 'Home restoration drifted.');
  const persisted = JSON.parse(JSON.stringify(graph)) as KinematicGraph;
  assert(JSON.stringify(persisted) === JSON.stringify(graph), 'Joint frame persistence changed graph data.');
  results.push({ fixture: 'pure-kinematics-home-persistence', result: 'PASS' });
  return results;
};
