import * as THREE from 'three';
import { ImportedJointPose, Vector3Tuple } from '../../domain/model';
import { Bounds3D, JointEvidence, JointType, KinematicGraph, MechanicalPart } from '../../domain/kinematics';

const id = (prefix: string, value: string) => `${prefix}_${value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)}`;

const tuple = (vector: THREE.Vector3): Vector3Tuple => [vector.x, vector.y, vector.z];

const boundsFromObject = (object: THREE.Object3D): Bounds3D => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
      size: [0, 0, 0],
      center: [0, 0, 0],
    };
  }

  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(center),
  };
};

const axisVector = (axis?: 'x' | 'y' | 'z'): Vector3Tuple => {
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return [1, 0, 0];
};

const jointTypeFromLegacy = (joint: ImportedJointPose): JointType => {
  if (joint.motionKind === 'translation') return 'prismatic';
  if (/wheel|continuous/i.test(joint.name)) return 'continuous';
  return 'revolute';
};

const evidenceFromLegacy = (joint: ImportedJointPose): JointEvidence[] => {
  const evidence: JointEvidence[] = [];
  if (joint.label || joint.name) {
    evidence.push({
      type: 'semantic-name',
      score: 0.45,
      message: `Legacy semantic articulation candidate from object name: ${joint.name}`,
    });
  }
  if (joint.sourceType === 'bone') {
    evidence.push({
      type: 'imported-hierarchy',
      score: 0.7,
      message: 'Imported skeleton bone was used as articulation evidence.',
    });
  } else {
    evidence.push({
      type: 'existing-pivot',
      score: 0.55,
      message: 'Imported object or reconstructed pivot was used as articulation evidence.',
    });
  }
  return evidence;
};

const makeRootPart = (scene: THREE.Object3D): MechanicalPart => ({
  id: 'part_source_model',
  name: 'SOURCE MODEL',
  meshObjectIds: [],
  localFrame: {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
  bounds: boundsFromObject(scene),
  static: true,
  visible: true,
  source: 'imported',
  metadata: {
    role: 'source-root',
    nonDestructive: true,
  },
});

const objectPositionByName = (scene: THREE.Object3D) => {
  const positions = new Map<string, Vector3Tuple>();
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (!object.name || positions.has(object.name)) return;
    const position = new THREE.Vector3();
    object.getWorldPosition(position);
    positions.set(object.name, tuple(position));
  });
  return positions;
};

export const createKinematicGraphFromLegacyJoints = (scene: THREE.Object3D, joints: ImportedJointPose[]): KinematicGraph => {
  const rootPart = makeRootPart(scene);
  const positions = objectPositionByName(scene);
  const parts: MechanicalPart[] = [rootPart];

  const graphJoints = joints.map((joint, index) => {
    const childPartId = id('part', `${index + 1}_${joint.name || 'joint'}`);
    const originPosition = positions.get(joint.name) ?? rootPart.bounds.center;
    parts.push({
      id: childPartId,
      name: joint.label ?? joint.name,
      meshObjectIds: [joint.name],
      localFrame: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      bounds: rootPart.bounds,
      static: false,
      visible: true,
      source: 'imported',
      metadata: {
        legacyJointName: joint.name,
        legacySourceType: joint.sourceType,
      },
    });

    return {
      id: id('joint', `${index + 1}_${joint.name || 'joint'}`),
      name: joint.label ?? joint.name,
      parentPartId: rootPart.id,
      childPartId,
      type: jointTypeFromLegacy(joint),
      origin: {
        position: originPosition,
        rotation: [0, 0, 0, 1] as [number, number, number, number],
      },
      axis: axisVector(joint.axis),
      limits: {
        lower: joint.min,
        upper: joint.max,
      },
      source: 'hybrid' as const,
      confidence: joint.sourceType === 'bone' ? 0.7 : 0.55,
      evidence: evidenceFromLegacy(joint),
      status: 'candidate' as const,
    };
  });

  return {
    parts,
    joints: graphJoints,
    rootPartId: rootPart.id,
  };
};
