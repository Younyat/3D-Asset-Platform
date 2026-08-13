import {
  AssetDocument,
  GeometryDefinition,
  SceneNode,
  defaultMaterial,
  defaultTransform,
} from './model';

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export const createEmptyProject = (name = 'Untitled Asset'): AssetDocument => {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    metadata: {
      id: id('project'),
      name,
      author: 'Local Artist',
      createdAt: now,
      updatedAt: now,
    },
    nodes: [],
    partWarehouse: [],
  };
};

export const createPrimitiveNode = (geometry: GeometryDefinition, name: string): SceneNode => ({
  id: id('node'),
  name,
  geometry,
  transform: defaultTransform(),
  material: defaultMaterial(),
  visible: true,
  locked: false,
  createdAt: new Date().toISOString(),
});

export const createBoxNode = (): SceneNode =>
  createPrimitiveNode({ kind: 'box', width: 2, height: 1.4, depth: 2 }, 'Game Box');

export const createSphereNode = (): SceneNode =>
  createPrimitiveNode({ kind: 'sphere', radius: 0.9, segments: 32 }, 'Sphere');

export const createCylinderNode = (): SceneNode =>
  createPrimitiveNode({ kind: 'cylinder', radius: 0.8, height: 1.7, segments: 32 }, 'Cylinder');

export const createPlaneNode = (): SceneNode =>
  createPrimitiveNode({ kind: 'plane', width: 3, depth: 3 }, 'Ground Plane');

export const cloneSceneNode = (node: SceneNode): SceneNode => ({
  ...node,
  id: id('node'),
  name: `${node.name} Copy`,
  geometry: JSON.parse(JSON.stringify(node.geometry)) as GeometryDefinition,
  transform: {
    position: [node.transform.position[0] + 0.4, node.transform.position[1], node.transform.position[2] + 0.4],
    rotation: [...node.transform.rotation],
    scale: [...node.transform.scale],
  },
  material: { ...node.material },
  locked: false,
  createdAt: new Date().toISOString(),
});
