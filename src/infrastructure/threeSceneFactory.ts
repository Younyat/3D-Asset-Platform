import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SceneNode } from '../domain/model';
import { seededNoise } from '../domain/generators';

const applyNodeTransform = (object: THREE.Object3D, node: SceneNode) => {
  object.position.fromArray(node.transform.position);
  object.rotation.set(...node.transform.rotation);
  object.scale.fromArray(node.transform.scale);
};

const tagObject = (object: THREE.Object3D, node: SceneNode) => {
  object.name = node.name;
  object.userData.nodeId = node.id;
  object.traverse((child) => {
    child.userData.nodeId = node.id;
  });
};

const importedModelCache = new Map<string, Promise<THREE.Object3D>>();

const loadImportedDataUrl = async (dataUrl: string, format: 'glb' | 'fbx' | 'dae' | 'obj' | '3ds') => {
  const cacheKey = `${format}:${dataUrl.slice(0, 128)}:${dataUrl.length}`;
  const cached = importedModelCache.get(cacheKey);
  if (cached) {
    return cloneSkeleton(await cached);
  }

  const loaded = (async () => {
  const buffer = await fetch(dataUrl).then((response) => response.arrayBuffer());

  if (format === 'glb') {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buffer, '');
    return gltf.scene;
  }

  if (format === 'fbx') {
    const loader = new FBXLoader();
    return loader.parse(buffer, '');
  }

  const text = new TextDecoder().decode(buffer);

  if (format === 'obj') {
    const loader = new OBJLoader();
    return loader.parse(text);
  }

  if (format === '3ds') {
    const loader = new TDSLoader();
    return loader.parse(buffer, '');
  }

  const loader = new ColladaLoader();
  return loader.parse(text, '').scene;
  })();

  importedModelCache.set(cacheKey, loaded);
  return cloneSkeleton(await loaded);
};

const axisIndexOf = (axis?: 'x' | 'y' | 'z') => (axis === 'y' ? 1 : axis === 'z' ? 2 : 0);

const captureImportedRestTransforms = (object: THREE.Object3D) => {
  object.traverse((child) => {
    child.userData.restRotation = child.rotation.clone();
    child.userData.restPosition = child.position.clone();
  });
};

const applyImportedJointPoses = (object: THREE.Object3D, node: SceneNode) => {
  if (node.geometry.kind !== 'imported-model') return;
  const poseByName = new Map(node.geometry.joints.map((joint) => [joint.name, joint]));

  object.traverse((child) => {
    const joint = poseByName.get(child.name);
    if (!joint) return;

    const restRotation = (child.userData.restRotation as THREE.Euler | undefined) ?? child.rotation.clone();
    const restPosition = (child.userData.restPosition as THREE.Vector3 | undefined) ?? child.position.clone();
    child.rotation.set(restRotation.x, restRotation.y, restRotation.z);
    child.position.copy(restPosition);

    const axisIndex = axisIndexOf(joint.axis);
    const rotation = [...joint.rotation] as [number, number, number];
    const translation = [...(joint.translation ?? [0, 0, 0])] as [number, number, number];

    if (joint.motionKind === 'translation') {
      const value = translation[axisIndex] ?? 0;
      if (axisIndex === 0) child.position.x = restPosition.x + value;
      if (axisIndex === 1) child.position.y = restPosition.y + value;
      if (axisIndex === 2) child.position.z = restPosition.z + value;
    } else {
      if (axisIndex === 0) child.rotation.x = restRotation.x + (rotation[0] ?? 0);
      if (axisIndex === 1) child.rotation.y = restRotation.y + (rotation[1] ?? 0);
      if (axisIndex === 2) child.rotation.z = restRotation.z + (rotation[2] ?? 0);
    }

    child.updateMatrixWorld(true);
  });
};

const applyImportedFreePartTransforms = (object: THREE.Object3D, node: SceneNode) => {
  if (node.geometry.kind !== 'imported-model' || !node.geometry.freePartTransforms?.length) return;
  const transformByName = new Map(node.geometry.freePartTransforms.map((partTransform) => [partTransform.objectName, partTransform]));

  object.traverse((child) => {
    const partTransform = transformByName.get(child.name);
    if (!partTransform) return;

    child.position.fromArray(partTransform.position);
    child.rotation.set(...partTransform.rotation);
    child.scale.fromArray(partTransform.scale);
    child.updateMatrixWorld(true);
  });
};

const objectHasRenderableGeometry = (object: THREE.Object3D) => {
  let hasGeometry = false;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) hasGeometry = true;
  });
  return hasGeometry;
};

const normalizedObjectName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const visibleIsolationFallback = (objects: THREE.Object3D[], targetName: string) => {
  const target = normalizedObjectName(targetName);
  const targetTokens = target.split(/\s+/).filter((token) => token.length > 2);
  const visibleObjects = objects.filter((candidate) => candidate.name && objectHasRenderableGeometry(candidate));

  return (
    visibleObjects.find((candidate) => {
      const candidateName = normalizedObjectName(candidate.name);
      if (!candidateName) return false;
      if (candidateName.includes(target) || target.includes(candidateName)) return true;
      return targetTokens.some((token) => candidateName.includes(token));
    }) ?? visibleObjects.find((candidate) => (candidate as THREE.Mesh).isMesh) ?? visibleObjects[0]
  );
};

const cloneObjectInWorld = (object: THREE.Object3D) => {
  const clone = cloneSkeleton(object);
  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();
  object.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
  clone.position.copy(worldPosition);
  clone.quaternion.copy(worldQuaternion);
  clone.scale.copy(worldScale);
  return clone;
};

const isolateImportedObjects = (object: THREE.Object3D, node: SceneNode) => {
  if (node.geometry.kind !== 'imported-model' || !node.geometry.isolatedObjectNames?.length) return object;
  const isolatedNames = new Set(node.geometry.isolatedObjectNames);
  const isolatedRoot = new THREE.Group();
  isolatedRoot.name = object.name;
  object.updateMatrixWorld(true);
  const objects: THREE.Object3D[] = [];

  object.traverse((child) => {
    objects.push(child);
    if (!isolatedNames.has(child.name) || !objectHasRenderableGeometry(child)) return;
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) {
      isolatedRoot.add(cloneObjectInWorld(child));
      return;
    }
    const descendants: THREE.Object3D[] = [];
    child.traverse((descendant) => descendants.push(descendant));
    const fallback = visibleIsolationFallback(descendants, child.name);
    if (fallback && fallback !== child) isolatedRoot.add(cloneObjectInWorld(fallback));
  });

  if (!isolatedRoot.children.length) {
    node.geometry.isolatedObjectNames.forEach((name) => {
      const fallback = visibleIsolationFallback(objects, name);
      if (fallback) isolatedRoot.add(cloneObjectInWorld(fallback));
    });
  }

  return objectHasRenderableGeometry(isolatedRoot) ? isolatedRoot : object;
};

const hasGeometryVertices = (object: THREE.Object3D) => {
  const mesh = object as THREE.Mesh;
  return Boolean(mesh.geometry?.attributes?.position?.count);
};

const buildThreeDsMechanicalHierarchy = (root: THREE.Object3D, node: SceneNode) => {
  if (node.geometry.kind !== 'imported-model' || node.geometry.sourceFormat !== '3ds') return root;

  const jointNames = new Set(node.geometry.joints.map((joint) => joint.name));
  if (!jointNames.size) return root;

  root.updateMatrixWorld(true);
  const orderedChildren = [...root.children];
  const jointMarkers = orderedChildren.filter((child) => jointNames.has(child.name) && !hasGeometryVertices(child));
  if (!jointMarkers.length) return root;

  jointMarkers.forEach((marker, markerIndex) => {
    const startIndex = orderedChildren.indexOf(marker) + 1;
    const nextMarker = jointMarkers[markerIndex + 1];
    const endIndex = nextMarker ? orderedChildren.indexOf(nextMarker) : orderedChildren.length;
    const members = orderedChildren.slice(startIndex, endIndex).filter((child) => hasGeometryVertices(child));

    if (!members.length) return;

    const pivot = new THREE.Group();
    pivot.name = marker.name;
    pivot.userData.articulationProxy = true;
    pivot.position.copy(marker.position);
    root.add(pivot);
    pivot.updateMatrixWorld(true);

    members.forEach((member) => {
      pivot.attach(member);
    });
  });

  return root;
};

const makeMaterial = (node: SceneNode, overrides: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({
    color: node.material.color,
    roughness: node.material.roughness,
    metalness: node.material.metalness,
    emissive: node.material.emissive ?? '#000000',
    emissiveIntensity: node.material.emissiveIntensity ?? 0,
    ...overrides,
  });

const makeImportedSurfaceMaterial = (node: SceneNode, source?: THREE.Material) => {
  const sourceWithMaps = source as
    | (THREE.Material & {
        normalMap?: THREE.Texture | null;
        roughnessMap?: THREE.Texture | null;
        metalnessMap?: THREE.Texture | null;
        aoMap?: THREE.Texture | null;
      })
    | undefined;

  const material = makeMaterial(node, {
    name: source?.name,
    side: source?.side ?? THREE.FrontSide,
    transparent: source?.transparent ?? false,
    opacity: source?.opacity ?? 1,
    alphaTest: source?.alphaTest ?? 0,
    normalMap: sourceWithMaps?.normalMap ?? null,
    roughnessMap: sourceWithMaps?.roughnessMap ?? null,
    metalnessMap: sourceWithMaps?.metalnessMap ?? null,
    aoMap: sourceWithMaps?.aoMap ?? null,
  });
  material.needsUpdate = true;
  return material;
};

const applyNodeMaterialToImportedMeshes = (object: THREE.Object3D, node: SceneNode) => {
  const partMaterialByName =
    node.geometry.kind === 'imported-model' ? new Map((node.geometry.partMaterials ?? []).map((partMaterial) => [partMaterial.objectName, partMaterial])) : new Map();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    let current: THREE.Object3D | null = mesh;
    let partMaterial: { color: string; roughness?: number; metalness?: number } | undefined;
    while (current && !partMaterial) {
      partMaterial = partMaterialByName.get(current.name);
      current = current.parent;
    }
    const materialNode = partMaterial
      ? {
          ...node,
          material: {
            ...node.material,
            color: partMaterial.color,
            roughness: partMaterial.roughness ?? node.material.roughness,
            metalness: partMaterial.metalness ?? node.material.metalness,
          },
        }
      : node;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => makeImportedSurfaceMaterial(materialNode, material));
    } else {
      mesh.material = makeImportedSurfaceMaterial(materialNode, mesh.material);
    }
  });
};

const createPrimitiveObject = (node: SceneNode) => {
  const material = makeMaterial(node);
  const geometry = node.geometry;

  if (geometry.kind === 'box') {
    return new THREE.Mesh(new THREE.BoxGeometry(geometry.width, geometry.height, geometry.depth), material);
  }

  if (geometry.kind === 'sphere') {
    return new THREE.Mesh(new THREE.SphereGeometry(geometry.radius, geometry.segments, geometry.segments / 2), material);
  }

  if (geometry.kind === 'cylinder') {
    return new THREE.Mesh(new THREE.CylinderGeometry(geometry.radius, geometry.radius, geometry.height, geometry.segments), material);
  }

  if (geometry.kind === 'plane') {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(geometry.width, geometry.depth), material);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  return null;
};

const addBoxPart = (
  group: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  name: string,
) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.name = name;
  group.add(mesh);
  return mesh;
};

const addCylinderPart = (
  group: THREE.Group,
  radius: number,
  height: number,
  position: [number, number, number],
  material: THREE.Material,
  name: string,
  segments = 32,
) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material);
  mesh.position.set(...position);
  mesh.name = name;
  group.add(mesh);
  return mesh;
};

const addFrontDisk = (
  group: THREE.Group,
  radius: number,
  depth: number,
  position: [number, number, number],
  material: THREE.Material,
  name: string,
  segments = 20,
) => {
  const mesh = addCylinderPart(group, radius, depth, position, material, name, segments);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
};

const createSciFiCrateObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'scifi-crate') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const base = makeMaterial(node);
  const trim = makeMaterial(node, { color: '#11161a', roughness: 0.74, metalness: 0.42 });
  const worn = makeMaterial(node, { color: '#5a6065', roughness: 0.82, metalness: 0.18 });
  const light = makeMaterial(node, {
    color: node.material.emissive ?? '#e53935',
    emissive: node.material.emissive ?? '#e53935',
    emissiveIntensity: node.material.emissiveIntensity ?? 2,
    roughness: 0.18,
    metalness: 0,
  });

  const { width, height, depth } = params;
  addBoxPart(group, [width, height, depth], [0, height / 2, 0], base, 'crate body');

  const ribCount = Math.max(1, Math.round(params.ribs));
  for (let index = 0; index < ribCount; index += 1) {
    const x = -width / 2 + ((index + 1) * width) / (ribCount + 1);
    addBoxPart(group, [0.08 + params.bevelStyle * 0.08, height + 0.08, depth + 0.08], [x, height / 2, 0], trim, `vertical rib ${index + 1}`);
  }

  addBoxPart(group, [width + 0.1, 0.12, depth + 0.12], [0, height + 0.06, 0], trim, 'top trim');
  addBoxPart(group, [width + 0.1, 0.12, depth + 0.12], [0, 0.06, 0], trim, 'bottom trim');
  addBoxPart(group, [width + 0.12, height * 0.22, 0.08], [0, height * 0.58, depth / 2 + 0.06], trim, 'front panel');
  addBoxPart(group, [width + 0.12, height * 0.22, 0.08], [0, height * 0.58, -depth / 2 - 0.06], trim, 'back panel');
  addBoxPart(group, [width * 0.34, 0.08, depth + 0.16], [0, height + 0.16, 0], trim, 'top carry rail');

  [
    [-width / 2 - 0.05, height + 0.02, depth / 2 + 0.04],
    [width / 2 + 0.05, height + 0.02, depth / 2 + 0.04],
    [-width / 2 - 0.05, 0.12, depth / 2 + 0.04],
    [width / 2 + 0.05, 0.12, depth / 2 + 0.04],
  ].forEach((position, index) => {
    addBoxPart(group, [0.2, 0.22, 0.12], position as [number, number, number], trim, `front corner cap ${index + 1}`);
  });

  for (let index = 0; index < 8; index += 1) {
    const x = -width * 0.42 + (index % 4) * width * 0.28;
    const y = index < 4 ? height * 0.78 : height * 0.26;
    addFrontDisk(group, 0.035, 0.025, [x, y, depth / 2 + 0.125], worn, `front bolt ${index + 1}`, 16);
  }

  for (let index = 0; index < 6; index += 1) {
    addBoxPart(group, [width * 0.08, 0.028, 0.035], [-width * 0.25 + index * width * 0.1, height * 0.84, depth / 2 + 0.13], worn, `vent slit ${index + 1}`);
  }

  const lightCount = Math.max(0, Math.round(params.lights));
  for (let index = 0; index < lightCount; index += 1) {
    const x = -width * 0.38 + (index * width * 0.76) / Math.max(1, lightCount - 1);
    addBoxPart(group, [0.14, 0.1, 0.035], [x, height * 0.66, depth / 2 + 0.115], light, `status light ${index + 1}`);
  }

  const scarCount = Math.round(params.damage * 18);
  for (let index = 0; index < scarCount; index += 1) {
    const x = (seededNoise(params.seed, index) - 0.5) * width * 0.82;
    const y = 0.28 + seededNoise(params.seed, index + 33) * height * 0.55;
    const z = depth / 2 + 0.12;
    const scratchWidth = 0.16 + seededNoise(params.seed, index + 77) * 0.28;
    const scratch = addBoxPart(group, [scratchWidth, 0.025, 0.026], [x, y, z], worn, `wear mark ${index + 1}`);
    scratch.rotation.z = (seededNoise(params.seed, index + 91) - 0.5) * 0.7;
  }

  return group;
};

const createSupplyBarrelObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'supply-barrel') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const body = makeMaterial(node);
  const band = makeMaterial(node, { color: '#23282d', roughness: 0.44, metalness: 0.55 });
  const wear = makeMaterial(node, { color: '#d6c3a3', roughness: 0.9, metalness: 0.05 });
  const radius = params.radius;
  const height = params.height;

  addCylinderPart(group, radius, height, [0, height / 2, 0], body, 'barrel body', 40);
  addCylinderPart(group, radius * 1.04, 0.08, [0, height + 0.04, 0], band, 'top rim', 40);
  addCylinderPart(group, radius * 1.04, 0.08, [0, 0.04, 0], band, 'bottom rim', 40);
  addCylinderPart(group, radius * 0.72, 0.035, [0, height + 0.12, 0], band, 'top service cap', 40);

  const bandCount = Math.max(1, Math.round(params.bands));
  for (let index = 0; index < bandCount; index += 1) {
    const y = ((index + 1) * height) / (bandCount + 1);
    addCylinderPart(group, radius * 1.03, 0.075, [0, y, 0], band, `reinforcement band ${index + 1}`, 40);
  }

  const handles = Math.max(0, Math.round(params.handles));
  for (let index = 0; index < handles; index += 1) {
    const angle = (index / Math.max(1, handles)) * Math.PI * 2;
    const x = Math.cos(angle) * (radius + 0.08);
    const z = Math.sin(angle) * (radius + 0.08);
    const handle = addBoxPart(group, [0.1, height * 0.28, 0.16], [x, height * 0.58, z], band, `handle ${index + 1}`);
    handle.rotation.y = -angle;
  }

  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    const x = Math.cos(angle) * radius * 0.86;
    const z = Math.sin(angle) * radius * 0.86;
    addCylinderPart(group, 0.025, 0.025, [x, height + 0.15, z], band, `lid rivet ${index + 1}`, 12);
  }

  const dentCount = Math.round(params.dents * 18);
  for (let index = 0; index < dentCount; index += 1) {
    const angle = seededNoise(params.seed, index) * Math.PI * 2;
    const y = height * (0.18 + seededNoise(params.seed, index + 19) * 0.65);
    const x = Math.cos(angle) * (radius + 0.012);
    const z = Math.sin(angle) * (radius + 0.012);
    const dent = addBoxPart(group, [0.18, 0.035, 0.018], [x, y, z], wear, `dent mark ${index + 1}`);
    dent.rotation.y = -angle;
    dent.rotation.z = (seededNoise(params.seed, index + 44) - 0.5) * 0.8;
  }

  return group;
};

const createPowerCoreObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'power-core') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const shell = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#1f252a', roughness: 0.42, metalness: 0.72 });
  const glow = makeMaterial(node, {
    color: node.material.emissive ?? '#35c7ff',
    emissive: node.material.emissive ?? '#35c7ff',
    emissiveIntensity: 1 + params.glow * 3,
    roughness: 0.1,
    metalness: 0.02,
    transparent: true,
    opacity: 0.78,
  });
  const radius = params.radius;
  const height = params.height;

  addCylinderPart(group, radius * 0.62, height * 0.72, [0, height * 0.52, 0], glow, 'energy core', 48);
  addCylinderPart(group, radius * 1.15, 0.16, [0, 0.08, 0], dark, 'bottom base', 48);
  addCylinderPart(group, radius * 1.15, 0.16, [0, height + 0.08, 0], dark, 'top cap', 48);

  const ringCount = Math.max(1, Math.round(params.rings));
  for (let index = 0; index < ringCount; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.86, 0.035, 10, 48), shell);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = height * (0.22 + (index * 0.56) / Math.max(1, ringCount - 1));
    ring.name = `containment ring ${index + 1}`;
    group.add(ring);
  }

  const clamps = Math.max(2, Math.round(params.clamps));
  for (let index = 0; index < clamps; index += 1) {
    const angle = (index / clamps) * Math.PI * 2;
    const x = Math.cos(angle) * radius * 1.04;
    const z = Math.sin(angle) * radius * 1.04;
    const clamp = addBoxPart(group, [0.09, height * 0.7, 0.12], [x, height * 0.5, z], dark, `vertical clamp ${index + 1}`);
    clamp.rotation.y = -angle;
  }

  return group;
};

const createAntennaArrayObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'antenna-array') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const metal = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#20262b', roughness: 0.5, metalness: 0.7 });
  const height = params.height;

  addCylinderPart(group, params.mastRadius, height, [0, height / 2, 0], metal, 'antenna mast', 20);
  addBoxPart(group, [0.65, 0.12, 0.65], [0, 0.06, 0], dark, 'base plate');

  const dishes = Math.max(1, Math.round(params.dishes));
  for (let index = 0; index < dishes; index += 1) {
    const angle = (index / dishes) * Math.PI * 2 + seededNoise(params.seed, index) * 0.4;
    const y = height * (0.35 + (index * 0.45) / Math.max(1, dishes - 1));
    const dish = new THREE.Mesh(new THREE.ConeGeometry(0.22 + params.spread * 0.13, 0.12, 28, 1, true), metal);
    dish.position.set(Math.cos(angle) * params.spread, y, Math.sin(angle) * params.spread);
    dish.rotation.z = Math.PI / 2;
    dish.rotation.y = -angle;
    dish.name = `signal dish ${index + 1}`;
    group.add(dish);
    addBoxPart(group, [params.spread, 0.035, 0.035], [Math.cos(angle) * params.spread * 0.5, y, Math.sin(angle) * params.spread * 0.5], dark, `dish arm ${index + 1}`).rotation.y = -angle;
  }

  const panels = Math.max(0, Math.round(params.panels));
  for (let index = 0; index < panels; index += 1) {
    const angle = (index / Math.max(1, panels)) * Math.PI * 2;
    const y = height * (0.22 + seededNoise(params.seed, index + 30) * 0.62);
    const x = Math.cos(angle) * (params.spread * 0.56);
    const z = Math.sin(angle) * (params.spread * 0.56);
    const panel = addBoxPart(group, [0.22, 0.34, 0.035], [x, y, z], dark, `relay panel ${index + 1}`);
    panel.rotation.y = -angle;
  }

  return group;
};

const createModularWallObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'modular-wall') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const base = makeMaterial(node);
  const trim = makeMaterial(node, { color: '#31343a', roughness: 0.76, metalness: 0.22 });
  const port = makeMaterial(node, { color: '#171b1f', roughness: 0.44, metalness: 0.58 });
  const wear = makeMaterial(node, { color: '#a79d8c', roughness: 0.95, metalness: 0.02 });
  const { width, height, depth } = params;

  addBoxPart(group, [width, height, depth], [0, height / 2, 0], base, 'wall slab');
  addBoxPart(group, [0.14, height + 0.08, depth + 0.08], [-width / 2 - 0.04, height / 2, 0], trim, 'left column');
  addBoxPart(group, [0.14, height + 0.08, depth + 0.08], [width / 2 + 0.04, height / 2, 0], trim, 'right column');
  addBoxPart(group, [width + 0.16, 0.14, depth + 0.08], [0, height + 0.04, 0], trim, 'top beam');
  addBoxPart(group, [width + 0.16, 0.14, depth + 0.08], [0, 0.04, 0], trim, 'bottom beam');

  const panels = Math.max(1, Math.round(params.panels));
  for (let index = 0; index < panels; index += 1) {
    const x = -width / 2 + ((index + 0.5) * width) / panels;
    addBoxPart(group, [width / panels - 0.1, height * 0.62, 0.045], [x, height * 0.52, depth / 2 + 0.035], trim, `wall panel ${index + 1}`);
  }

  const ports = Math.max(0, Math.round(params.ports));
  for (let index = 0; index < ports; index += 1) {
    const x = -width * 0.36 + (index * width * 0.72) / Math.max(1, ports - 1);
    addBoxPart(group, [0.22, 0.16, 0.05], [x, height * 0.36, depth / 2 + 0.075], port, `service port ${index + 1}`);
  }

  const pipe = addCylinderPart(group, 0.055, width * 0.72, [0, height * 0.78, depth / 2 + 0.13], trim, 'surface conduit', 20);
  pipe.rotation.z = Math.PI / 2;
  addCylinderPart(group, 0.075, 0.12, [-width * 0.38, height * 0.78, depth / 2 + 0.13], port, 'left pipe joint', 20);
  addCylinderPart(group, 0.075, 0.12, [width * 0.38, height * 0.78, depth / 2 + 0.13], port, 'right pipe joint', 20);

  for (let index = 0; index < 8; index += 1) {
    const x = -width * 0.44 + index * width * 0.125;
    addBoxPart(group, [0.04, 0.14, 0.035], [x, height * 0.14, depth / 2 + 0.09], port, `lower grille ${index + 1}`);
  }

  const chips = Math.round(params.damage * 16);
  for (let index = 0; index < chips; index += 1) {
    const x = (seededNoise(params.seed, index) - 0.5) * width * 0.82;
    const y = 0.24 + seededNoise(params.seed, index + 20) * height * 0.66;
    const chip = addBoxPart(group, [0.12 + seededNoise(params.seed, index + 7) * 0.2, 0.035, 0.025], [x, y, depth / 2 + 0.09], wear, `surface chip ${index + 1}`);
    chip.rotation.z = (seededNoise(params.seed, index + 88) - 0.5) * 0.9;
  }

  return group;
};

const createTechDoorObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'tech-door') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const base = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#151a1f', roughness: 0.55, metalness: 0.62 });
  const trim = makeMaterial(node, { color: '#5f6870', roughness: 0.42, metalness: 0.72 });
  const light = makeMaterial(node, {
    color: node.material.emissive ?? '#ffd23f',
    emissive: node.material.emissive ?? '#ffd23f',
    emissiveIntensity: node.material.emissiveIntensity ?? 1.5,
  });
  const wear = makeMaterial(node, { color: '#9e8c6a', roughness: 0.9, metalness: 0.05 });
  const { width, height, depth } = params;

  addBoxPart(group, [width, height, depth], [0, height / 2, 0], base, 'door slab');
  addBoxPart(group, [0.16, height + 0.2, depth + 0.12], [-width / 2 - 0.08, height / 2, 0], trim, 'left rail');
  addBoxPart(group, [0.16, height + 0.2, depth + 0.12], [width / 2 + 0.08, height / 2, 0], trim, 'right rail');
  addBoxPart(group, [width + 0.2, 0.18, depth + 0.12], [0, height + 0.08, 0], dark, 'top track');
  addBoxPart(group, [width + 0.2, 0.14, depth + 0.12], [0, 0.07, 0], dark, 'floor track');

  const panels = Math.max(1, Math.round(params.panels));
  for (let index = 0; index < panels; index += 1) {
    const x = -width / 2 + ((index + 0.5) * width) / panels;
    addBoxPart(group, [width / panels - 0.12, height * 0.66, 0.045], [x, height * 0.54, depth / 2 + 0.045], dark, `inset door plate ${index + 1}`);
  }

  const vents = Math.max(0, Math.round(params.vents));
  for (let index = 0; index < vents; index += 1) {
    const y = height * (0.25 + index * 0.06);
    addBoxPart(group, [width * 0.36, 0.025, 0.04], [0, y, depth / 2 + 0.09], trim, `door vent ${index + 1}`);
  }

  const lights = Math.max(0, Math.round(params.lights));
  for (let index = 0; index < lights; index += 1) {
    const y = height * (0.18 + (index * 0.64) / Math.max(1, lights - 1));
    addBoxPart(group, [0.055, 0.18, 0.04], [width / 2 + 0.18, y, depth / 2 + 0.08], light, `warning light ${index + 1}`);
  }

  const chips = Math.round(params.damage * 14);
  for (let index = 0; index < chips; index += 1) {
    const x = (seededNoise(params.seed, index) - 0.5) * width * 0.72;
    const y = height * (0.18 + seededNoise(params.seed, index + 23) * 0.7);
    const chip = addBoxPart(group, [0.11 + seededNoise(params.seed, index + 44) * 0.16, 0.024, 0.02], [x, y, depth / 2 + 0.09], wear, `paint chip ${index + 1}`);
    chip.rotation.z = (seededNoise(params.seed, index + 64) - 0.5) * 0.8;
  }

  return group;
};

const createFloorPanelObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'floor-panel') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const base = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#171b1f', roughness: 0.54, metalness: 0.72 });
  const trim = makeMaterial(node, { color: '#6b747b', roughness: 0.48, metalness: 0.62 });
  const hazard = makeMaterial(node, { color: '#d3a632', roughness: 0.58, metalness: 0.18 });
  const { width, depth, thickness } = params;

  addBoxPart(group, [width, thickness, depth], [0, thickness / 2, 0], base, 'floor base');
  addBoxPart(group, [width - 0.22, thickness * 0.35, depth - 0.22], [0, thickness + 0.03, 0], dark, 'recessed plate');

  const grates = Math.max(0, Math.round(params.grates));
  for (let index = 0; index < grates; index += 1) {
    const x = -width * 0.35 + (index * width * 0.7) / Math.max(1, grates - 1);
    addBoxPart(group, [0.08, thickness * 0.55, depth * 0.62], [x, thickness + 0.08, 0], trim, `floor grate ${index + 1}`);
  }

  const bolts = Math.max(0, Math.round(params.bolts));
  for (let index = 0; index < bolts; index += 1) {
    const t = index / Math.max(1, bolts - 1);
    const side = index % 4;
    const x = side < 2 ? -width / 2 + 0.22 + t * (width - 0.44) : side === 2 ? -width / 2 + 0.22 : width / 2 - 0.22;
    const z = side < 2 ? (side === 0 ? -depth / 2 + 0.22 : depth / 2 - 0.22) : -depth / 2 + 0.22 + t * (depth - 0.44);
    addCylinderPart(group, 0.045, 0.035, [x, thickness + 0.12, z], trim, `floor bolt ${index + 1}`, 14);
  }

  addBoxPart(group, [width * params.hazard, thickness * 0.22, 0.05], [0, thickness + 0.13, -depth * 0.38], hazard, 'hazard stripe');
  addBoxPart(group, [width * params.hazard, thickness * 0.22, 0.05], [0, thickness + 0.13, depth * 0.38], hazard, 'hazard stripe rear');

  return group;
};

const createPipeNetworkObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'pipe-network') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const pipeMaterial = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#25292d', roughness: 0.56, metalness: 0.55 });
  const valveMaterial = makeMaterial(node, { color: '#b84237', roughness: 0.5, metalness: 0.32 });
  const r = params.pipeRadius;

  const main = addCylinderPart(group, r, params.width, [0, params.height * 0.62, 0], pipeMaterial, 'main pipe', 24);
  main.rotation.z = Math.PI / 2;

  const branches = Math.max(1, Math.round(params.branches));
  for (let index = 0; index < branches; index += 1) {
    const x = -params.width * 0.42 + (index * params.width * 0.84) / Math.max(1, branches - 1);
    const branchHeight = params.height * (0.2 + seededNoise(params.seed, index) * 0.48);
    const branch = addCylinderPart(group, r * 0.78, branchHeight, [x, branchHeight / 2, 0], pipeMaterial, `vertical branch ${index + 1}`, 20);
    branch.position.y = params.height * 0.62 - branchHeight / 2;
    addCylinderPart(group, r * 1.25, 0.12, [x, params.height * 0.62, 0], dark, `junction ${index + 1}`, 20);
  }

  const clamps = Math.max(0, Math.round(params.clamps));
  for (let index = 0; index < clamps; index += 1) {
    const x = -params.width * 0.45 + (index * params.width * 0.9) / Math.max(1, clamps - 1);
    addBoxPart(group, [0.08, r * 3.4, r * 2.7], [x, params.height * 0.62, 0], dark, `pipe clamp ${index + 1}`);
  }

  const valves = Math.max(0, Math.round(params.valves));
  for (let index = 0; index < valves; index += 1) {
    const x = -params.width * 0.3 + (index * params.width * 0.6) / Math.max(1, valves - 1);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(r * 2.2, r * 0.18, 10, 24), valveMaterial);
    wheel.position.set(x, params.height * 0.62 + r * 2.2, r * 0.2);
    wheel.name = `valve wheel ${index + 1}`;
    group.add(wheel);
  }

  return group;
};

const createControlConsoleObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'control-console') return null;

  const params = node.geometry.params;
  const group = new THREE.Group();
  const body = makeMaterial(node);
  const dark = makeMaterial(node, { color: '#14191e', roughness: 0.52, metalness: 0.55 });
  const screen = makeMaterial(node, {
    color: node.material.emissive ?? '#35c7ff',
    emissive: node.material.emissive ?? '#35c7ff',
    emissiveIntensity: node.material.emissiveIntensity ?? 1.8,
    roughness: 0.08,
    metalness: 0,
  });
  const accent = makeMaterial(node, { color: '#aeb8bf', roughness: 0.36, metalness: 0.66 });
  const { width, height, depth } = params;

  addBoxPart(group, [width, height * 0.58, depth], [0, height * 0.29, 0], body, 'console pedestal');
  const head = addBoxPart(group, [width * 1.04, height * 0.38, depth * 0.72], [0, height * 0.72, -depth * 0.08], body, 'angled console head');
  head.rotation.x = -0.22;
  addBoxPart(group, [width * 0.9, 0.08, depth * 0.2], [0, height * 0.48, depth * 0.36], dark, 'keyboard deck');

  const screens = Math.max(1, Math.round(params.screens));
  for (let index = 0; index < screens; index += 1) {
    const x = -width * 0.3 + (index * width * 0.6) / Math.max(1, screens - 1);
    const panel = addBoxPart(group, [width * 0.28, height * 0.18, 0.035], [x, height * 0.82, -depth * 0.45], screen, `screen ${index + 1}`);
    panel.rotation.x = -0.22;
  }

  const buttons = Math.max(0, Math.round(params.buttons));
  for (let index = 0; index < buttons; index += 1) {
    const x = -width * 0.36 + (index % 5) * width * 0.18;
    const z = depth * 0.31 - Math.floor(index / 5) * depth * 0.08;
    addBoxPart(group, [0.08, 0.035, 0.055], [x, height * 0.55, z], index % 3 === 0 ? screen : accent, `button ${index + 1}`);
  }

  const rails = Math.max(0, Math.round(params.rails));
  for (let index = 0; index < rails; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    addBoxPart(group, [0.07, height * 0.72, 0.08], [side * (width / 2 + 0.07), height * 0.42, 0], dark, `side rail ${index + 1}`);
  }

  return group;
};

const createGeneratedObject = (node: SceneNode) => {
  if (node.geometry.kind === 'scifi-crate') return createSciFiCrateObject(node);
  if (node.geometry.kind === 'supply-barrel') return createSupplyBarrelObject(node);
  if (node.geometry.kind === 'power-core') return createPowerCoreObject(node);
  if (node.geometry.kind === 'antenna-array') return createAntennaArrayObject(node);
  if (node.geometry.kind === 'modular-wall') return createModularWallObject(node);
  if (node.geometry.kind === 'tech-door') return createTechDoorObject(node);
  if (node.geometry.kind === 'floor-panel') return createFloorPanelObject(node);
  if (node.geometry.kind === 'pipe-network') return createPipeNetworkObject(node);
  if (node.geometry.kind === 'control-console') return createControlConsoleObject(node);
  return null;
};

type CompactSerializedMesh = {
  name: string;
  position: string;
  normal?: string;
  uv?: string;
  index?: string;
};

type CompactSerializedObject = {
  assetForgeSerializedObject: number;
  meshes: CompactSerializedMesh[];
};

const isCompactSerializedObject = (value: unknown): value is CompactSerializedObject =>
  Boolean(value && typeof value === 'object' && 'assetForgeSerializedObject' in value && Array.isArray((value as CompactSerializedObject).meshes));

const createSerializedObject = (node: SceneNode) => {
  if (node.geometry.kind !== 'serialized-object') return null;
  const serialized = node.geometry.objectJson;
  const decodeBuffer = (encoded: string) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  };

  const object =
    isCompactSerializedObject(serialized)
      ? (() => {
          const group = new THREE.Group();
          group.name = node.name;
          serialized.meshes.forEach((meshData) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(decodeBuffer(meshData.position)), 3));
            if (meshData.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(decodeBuffer(meshData.normal)), 3));
            if (meshData.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(decodeBuffer(meshData.uv)), 2));
            if (meshData.index) geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(decodeBuffer(meshData.index)), 1));
            if (!geometry.attributes.normal) geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, makeMaterial(node));
            mesh.name = meshData.name;
            group.add(mesh);
          });
          return group;
        })()
      : new THREE.ObjectLoader().parse(serialized as Parameters<THREE.ObjectLoader['parse']>[0]);
  applyNodeMaterialToImportedMeshes(object, node);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDimension = Math.max(size.x, size.y, size.z);
    if (maxDimension > 0.0001) {
      const scale = 1.65 / maxDimension;
      const minYAfterCenter = (box.min.y - center.y) * scale;
      object.scale.multiplyScalar(scale);
      object.position.set(-center.x * scale, -minYAfterCenter, -center.z * scale);
    }
  }
  return object;
};

export const createSceneObject = (node: SceneNode) => {
  const object = createSerializedObject(node) ?? createGeneratedObject(node) ?? createPrimitiveObject(node);
  if (!object) {
    throw new Error(`Unsupported geometry: ${node.geometry.kind}`);
  }

  applyNodeTransform(object, node);
  object.visible = node.visible;
  tagObject(object, node);
  return object;
};

export const createRenderableScene = (nodes: SceneNode[]) => {
  const group = new THREE.Group();
  group.name = 'AssetDocument';
  nodes.forEach((node) => group.add(createSceneObject(node)));
  return group;
};

export const createImportedSceneObject = async (node: SceneNode) => {
  if (node.geometry.kind !== 'imported-model') return null;

  let root = await loadImportedDataUrl(node.geometry.assetDataUrl, node.geometry.sourceFormat);
  const isolated = Boolean(node.geometry.isolatedObjectNames?.length);
  const group = new THREE.Group();
  group.name = node.name;
  root.name = node.name;
  buildThreeDsMechanicalHierarchy(root, node);
  captureImportedRestTransforms(root);
  applyImportedJointPoses(root, node);
  applyImportedFreePartTransforms(root, node);
  root = isolateImportedObjects(root, node);
  applyNodeMaterialToImportedMeshes(root, node);
  if (isolated) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const scale = 1.65 / Math.max(size.x, size.y, size.z, 0.0001);
    const minYAfterCenter = (box.min.y - center.y) * scale;
    root.scale.multiplyScalar(scale);
    root.position.set(-center.x * scale, -minYAfterCenter, -center.z * scale);
  } else {
    root.scale.multiplyScalar(node.geometry.importScale ?? 1);
    root.position.fromArray(node.geometry.importOffset ?? [0, 0, 0]);
  }
  root.updateMatrixWorld(true);
  group.add(root);
  applyNodeTransform(group, node);
  group.visible = node.visible;
  tagObject(group, node);
  return group;
};

export const createRenderableSceneAsync = async (nodes: SceneNode[]) => {
  const group = new THREE.Group();
  group.name = 'AssetDocument';

  for (const node of nodes) {
    if (node.geometry.kind === 'imported-model') {
      const imported = await createImportedSceneObject(node);
      if (imported) group.add(imported);
    } else {
      group.add(createSceneObject(node));
    }
  }

  return group;
};
