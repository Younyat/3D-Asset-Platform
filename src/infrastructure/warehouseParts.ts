import * as THREE from 'three';
import { ImportedModelGeometry, MaterialDefinition, SceneNode, SerializedObjectGeometry, Vector3Tuple } from '../domain/model';
import { createImportedSceneObject } from './threeSceneFactory';

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

const objectBounds = (object: THREE.Object3D): [number, number, number] => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  return [size.x, size.y, size.z];
};

const hasRenderableGeometry = (object: THREE.Object3D) => {
  let hasGeometry = false;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) hasGeometry = true;
  });
  return hasGeometry;
};

const encodeBuffer = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const attributeBuffer = (attribute: THREE.BufferAttribute) => {
  const array = attribute.array;
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return encodeBuffer(copy.buffer);
};

const serializeCompactObject = (object: THREE.Object3D) => {
  object.updateMatrixWorld(true);
  const meshes: Array<{
    name: string;
    position: string;
    normal?: string;
    uv?: string;
    index?: string;
  }> = [];

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    const index = geometry.index;

    meshes.push({
      name: mesh.name || child.name || 'mesh',
      position: attributeBuffer(position),
      normal: normal ? attributeBuffer(normal) : undefined,
      uv: uv ? attributeBuffer(uv) : undefined,
      index: index ? attributeBuffer(index) : undefined,
    });
    geometry.dispose();
  });

  return {
    assetForgeSerializedObject: 2,
    meshes,
  };
};

export type IndependentWarehousePart = {
  geometry: SerializedObjectGeometry;
  sourcePointToStoredPoint: (point: Vector3Tuple) => Vector3Tuple;
  sourceDirectionToStoredDirection: (direction: Vector3Tuple) => Vector3Tuple;
};

export const createIndependentWarehousePartGeometry = async (
  sourceGeometry: ImportedModelGeometry,
  material: MaterialDefinition,
  objectName: string,
): Promise<IndependentWarehousePart> => {
  const isolatedGeometry: ImportedModelGeometry = {
    ...JSON.parse(JSON.stringify(sourceGeometry)),
    isolatedObjectNames: [objectName],
    joints: sourceGeometry.joints.filter((joint) => joint.name === objectName || objectName.includes(joint.name) || joint.name.includes(objectName)),
    freePartTransforms: sourceGeometry.freePartTransforms?.filter((item) => item.objectName === objectName) ?? [],
    partMaterials: sourceGeometry.partMaterials?.filter((item) => item.objectName === objectName) ?? [],
  };
  const now = new Date().toISOString();
  const isolatedNode: SceneNode = {
    id: id('part_source'),
    name: objectName,
    geometry: isolatedGeometry,
    material,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    createdAt: now,
  };

  const isolatedObject = await createImportedSceneObject(isolatedNode);
  if (!isolatedObject || !hasRenderableGeometry(isolatedObject)) {
    throw new Error(`Part ${objectName} does not contain visible geometry.`);
  }

  const bounds = objectBounds(isolatedObject);
  isolatedObject.name = objectName;

  const sourceRoot = isolatedObject.children[0] ?? isolatedObject;
  const sourcePointToStoredPoint = (point: Vector3Tuple): Vector3Tuple => {
    const storedPoint = sourceRoot.localToWorld(new THREE.Vector3(...point));
    return [storedPoint.x, storedPoint.y, storedPoint.z];
  };
  const sourceDirectionToStoredDirection = (direction: Vector3Tuple): Vector3Tuple => {
    const origin = sourceRoot.localToWorld(new THREE.Vector3());
    const end = sourceRoot.localToWorld(new THREE.Vector3(...direction));
    const storedDirection = end.sub(origin);
    return storedDirection.lengthSq() > 0.00000001
      ? [storedDirection.x / storedDirection.length(), storedDirection.y / storedDirection.length(), storedDirection.z / storedDirection.length()]
      : [1, 0, 0];
  };

  return {
    geometry: {
      kind: 'serialized-object',
      assetName: `${objectName}.assetpart.json`,
      objectJson: serializeCompactObject(isolatedObject),
      originalBounds: bounds,
      normalizedBounds: bounds,
    },
    sourcePointToStoredPoint,
    sourceDirectionToStoredDirection,
  };
};
