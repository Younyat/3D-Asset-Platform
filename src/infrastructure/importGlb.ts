import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { createKinematicGraphFromLegacyJoints } from '../application/articulation/analyzeModel';
import { ImportedJointPose, ImportedModelGeometry, SceneNode, defaultMaterial, defaultTransform } from '../domain/model';

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read model file.'));
    reader.readAsDataURL(file);
  });

const extensionOf = (file: File) => file.name.split('.').pop()?.toLowerCase();

const assertRealModelFile = async (file: File) => {
  const header = await file.slice(0, 160).text().catch(() => '');
  if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error(`${file.name} is a Git LFS pointer, not the real model file. Pull/download the LFS asset before importing.`);
  }
};

const arrayBufferToGltf = (buffer: ArrayBuffer) =>
  new Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      '',
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      reject,
    );
  });

const arrayBufferToFbx = (buffer: ArrayBuffer) => {
  const loader = new FBXLoader();
  const scene = loader.parse(buffer, '');
  return { scene, animations: scene.animations ?? [] };
};

const textToCollada = (text: string) => {
  const loader = new ColladaLoader();
  const collada = loader.parse(text, '');
  return { scene: collada.scene, animations: [] as THREE.AnimationClip[] };
};

const parseModelFile = async (file: File) => {
  await assertRealModelFile(file);
  const extension = extensionOf(file);

  if (extension === 'glb') {
    return {
      sourceFormat: 'glb' as const,
      ...(await file.arrayBuffer().then(arrayBufferToGltf)),
    };
  }

  if (extension === 'fbx') {
    return {
      sourceFormat: 'fbx' as const,
      ...arrayBufferToFbx(await file.arrayBuffer()),
    };
  }

  if (extension === 'dae') {
    return {
      sourceFormat: 'dae' as const,
      ...textToCollada(await file.text()),
    };
  }

  if (extension === 'obj') {
    const loader = new OBJLoader();
    return {
      sourceFormat: 'obj' as const,
      scene: loader.parse(await file.text()),
      animations: [] as THREE.AnimationClip[],
    };
  }

  if (extension === '3ds') {
    const loader = new TDSLoader();
    return {
      sourceFormat: '3ds' as const,
      scene: loader.parse(await file.arrayBuffer(), ''),
      animations: [] as THREE.AnimationClip[],
    };
  }

  if (extension === 'blend') {
    throw new Error('Blender .blend files must be converted to GLB/FBX/DAE with Blender before import.');
  }

  if (extension === 'c4d') {
    throw new Error('Cinema 4D .c4d files must be exported to OBJ/FBX/GLB/DAE before import.');
  }

  if (extension === 'max') {
    throw new Error('3ds Max .max files are proprietary and must be exported to FBX/OBJ/GLB/DAE or 3DS before import.');
  }

  if (extension === 'sldprt' || extension === 'sldasm') {
    throw new Error('SolidWorks files must be exported to STEP/STL/OBJ/FBX/GLB before import. This platform can import OBJ/FBX/GLB/DAE/3DS directly.');
  }

  throw new Error('Supported import formats: .glb, .fbx, .dae, .obj, .3ds. Convert .blend/.c4d/.max/.sldprt/.sldasm files first.');
};

const normalizeName = (name: string) => name.toLowerCase().replace(/[_-]+/g, ' ');

const inferJointMetadata = (name: string): Omit<ImportedJointPose, 'name' | 'rotation' | 'translation'> | null => {
  const normalized = normalizeName(name);
  const axisMatch = normalized.match(/axis\s*([1-6a-z])|([abcxyz])\s*axis/);
  const axisToken = axisMatch?.[1] ?? axisMatch?.[2];
  const inferredRobotAxis: 'x' | 'y' | 'z' | undefined =
    axisToken === '1' || /base rot|base rotating|yaw/.test(normalized)
      ? 'y'
      : axisToken === '2' || axisToken === '3' || axisToken === '4' || /pitch|pith|arm/.test(normalized)
        ? 'x'
        : axisToken === '5' || axisToken === '6' || /wrist|grip|grasper|claw|finger/.test(normalized)
          ? 'z'
          : axisToken === 'x' || axisToken === 'y' || axisToken === 'z'
            ? axisToken
            : undefined;
  const isBaseYaw = /base rot|base rotating|yaw/.test(normalized) || axisToken === '1';
  const isPitchArm = /pitch|pith|shoulder|elbow/.test(normalized) || axisToken === '2' || axisToken === '3' || axisToken === '4';

  const hasMotionToken = /rotating|\brot\b|base rot|pitch|pith|yaw|axis|arm|joint|grip|grasper|claw|finger|wheel|tire|tyre|door|head|wrist|elbow|shoulder/.test(
    normalized,
  );

  if (/not moving|base static/.test(normalized) && !hasMotionToken) return null;

  if (/slider|slide|rail|piston|lift|elevator|fork|telescop|extend|linear|suspension|shock|damper|actuator/.test(normalized)) {
    const axis = /vertical|lift|elevator|up|down/.test(normalized) ? 'y' : axisMatch ? 'x' : 'z';
    return { label: 'Linear actuator', sourceType: 'object', motionKind: 'translation', axis, cursorControl: 'linear-axis', min: -0.45, max: 0.45, demoAmplitude: 0.22 };
  }

  if (/wheel|tire|tyre/.test(normalized)) {
    return { label: 'Rotary wheel', sourceType: 'object', motionKind: 'rotation', axis: 'x', cursorControl: 'dial-rotation', min: -3.14, max: 3.14, demoAmplitude: 2.8 };
  }

  if (/door|hood|bonnet|trunk|boot/.test(normalized)) {
    return { label: 'Hinge panel', sourceType: 'object', motionKind: 'rotation', axis: 'y', cursorControl: 'horizontal-rotation', min: -1.35, max: 1.35, demoAmplitude: 0.8 };
  }

  if (/grip|grasper|claw|finger/.test(normalized)) {
    return { label: 'Gripper hinge', sourceType: 'object', motionKind: 'rotation', axis: inferredRobotAxis ?? 'z', cursorControl: 'horizontal-rotation', min: -0.9, max: 0.9, demoAmplitude: 0.55 };
  }

  if (/head|wrist|joint|elbow|shoulder|knee|hip|neck|arm|forearm|leg|hand/.test(normalized)) {
    return {
      label: 'Rotary joint',
      sourceType: 'object',
      motionKind: 'rotation',
      axis: inferredRobotAxis ?? 'x',
      cursorControl: isBaseYaw ? 'horizontal-rotation' : isPitchArm ? 'vertical-rotation' : 'horizontal-rotation',
      min: -1.45,
      max: 1.45,
      demoAmplitude: 0.75,
    };
  }

  if (/rotating|\brot\b|base rot|pitch|pith|yaw|axis/.test(normalized)) {
    return {
      label: 'Rotary axis',
      sourceType: 'object',
      motionKind: 'rotation',
      axis: inferredRobotAxis ?? 'y',
      cursorControl: isPitchArm ? 'vertical-rotation' : 'horizontal-rotation',
      min: -1.57,
      max: 1.57,
      demoAmplitude: 0.9,
    };
  }

  if (/bone|mixamorig|bip|pelvis|spine/.test(normalized)) {
    return { label: 'Skeleton joint', sourceType: 'bone', motionKind: 'rotation', axis: 'x', cursorControl: 'vertical-rotation', min: -1.2, max: 1.2, demoAmplitude: 0.45 };
  }

  return null;
};

const shortLabel = (name: string) => {
  const chunks = name.split(/\s+|__/).filter(Boolean);
  return chunks.slice(-3).join(' ').replace(/_/g, ' ');
};

const extractArticulationJoints = (scene: THREE.Object3D): ImportedJointPose[] => {
  const joints = new Map<string, ImportedJointPose>();

  scene.traverse((object) => {
    if (!object.name) return;

    const metadata = inferJointMetadata(object.name);
    const isBone = 'isBone' in object && object.isBone;
    const isNamedPart = object.type === 'Mesh' || object.type === 'SkinnedMesh' || object.type === 'Group' || object.children.length > 0;

    if (isBone || (metadata && isNamedPart)) {
      joints.set(object.name, {
        name: object.name,
        label: metadata ? `${metadata.label} - ${shortLabel(object.name)}` : shortLabel(object.name),
        sourceType: isBone ? 'bone' : metadata?.sourceType ?? 'object',
        motionKind: metadata?.motionKind ?? 'rotation',
        axis: metadata?.axis ?? 'x',
        cursorControl: metadata?.cursorControl,
        min: metadata?.min ?? -1.2,
        max: metadata?.max ?? 1.2,
        demoAmplitude: metadata?.demoAmplitude ?? 0.5,
        rotation: [0, 0, 0],
        translation: [0, 0, 0],
      });
    }
  });

  return [...joints.values()].slice(0, 80);
};

const objectHasVisibleGeometry = (object: THREE.Object3D) => {
  let hasGeometry = false;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) hasGeometry = true;
  });
  return hasGeometry;
};

const extractRenderablePartNames = (scene: THREE.Object3D, joints: ImportedJointPose[]) => {
  const names = new Set<string>();
  const jointNames = new Set(joints.map((joint) => joint.name));

  scene.traverse((object) => {
    if (!object.name || !objectHasVisibleGeometry(object)) return;
    if (jointNames.has(object.name)) {
      names.add(object.name);
      return;
    }
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) names.add(object.name);
  });

  return [...names].slice(0, 160);
};

const computeImportNormalization = (scene: THREE.Object3D) => {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDimension = Math.max(size.x, size.y, size.z, 0.0001);
  const targetMaxDimension = 3;
  const importScale = targetMaxDimension / maxDimension;
  const minYAfterCenter = (box.min.y - center.y) * importScale;

  return {
    importScale,
    importOffset: [-center.x * importScale, -minYAfterCenter, -center.z * importScale] as [number, number, number],
    originalBounds: [size.x, size.y, size.z] as [number, number, number],
    normalizedBounds: [size.x * importScale, size.y * importScale, size.z * importScale] as [number, number, number],
  };
};

export const createImportedModelNode = async (file: File): Promise<SceneNode> => {
  const [dataUrl, parsed] = await Promise.all([fileToDataUrl(file), parseModelFile(file)]);
  const joints = extractArticulationJoints(parsed.scene);
  const partObjectNames = extractRenderablePartNames(parsed.scene, joints);
  const normalization = computeImportNormalization(parsed.scene);
  const bones = joints.filter((joint) => joint.sourceType === 'bone').map((joint) => joint.name);
  const kinematicGraph = createKinematicGraphFromLegacyJoints(parsed.scene.clone(true), joints);
  const geometry: ImportedModelGeometry = {
    kind: 'imported-model',
    assetName: file.name,
    assetDataUrl: dataUrl,
    sourceFormat: parsed.sourceFormat,
    ...normalization,
    bones,
    animations: parsed.animations.map((clip: THREE.AnimationClip) => clip.name || 'Animation'),
    joints,
    partObjectNames,
    kinematicGraph,
  };

  return {
    id: id('node'),
    name: file.name.replace(/\.(glb|fbx|dae)$/i, ''),
    geometry,
    transform: {
      ...defaultTransform(),
      position: [0, 0, 0],
    },
    material: defaultMaterial(`Imported ${parsed.sourceFormat.toUpperCase()}`, '#8b949e'),
    visible: true,
    locked: false,
    createdAt: new Date().toISOString(),
  };
};

export const createImportedGlbNode = createImportedModelNode;
