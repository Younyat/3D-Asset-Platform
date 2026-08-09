import { GeneratorId, MaterialDefinition, ProceduralParameters, SceneNode, defaultMaterial, defaultTransform } from './model';

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const seedDefault = () => Math.floor(Math.random() * 999999);

export type GeneratorParameterSchema = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
};

export type GeneratorDefinition = {
  id: GeneratorId;
  name: string;
  description: string;
  defaultMaterial: MaterialDefinition;
  defaults: ProceduralParameters;
  parameters: GeneratorParameterSchema[];
};

export const generatorDefinitions: GeneratorDefinition[] = [
  {
    id: 'scifi-crate',
    name: 'Sci-Fi Crate',
    description: 'Panelled game crate with ribs, wear marks and emissive status lights.',
    defaultMaterial: {
      ...defaultMaterial('Military Graphite', '#252b2f'),
      roughness: 0.68,
      metalness: 0.32,
      emissive: '#e53935',
      emissiveIntensity: 1.9,
    },
    defaults: { width: 2.4, height: 1.45, depth: 1.8, bevelStyle: 0.55, ribs: 4, lights: 4, damage: 0.12, seed: 481903 },
    parameters: [
      { key: 'width', label: 'Width', min: 0.8, max: 5, step: 0.05 },
      { key: 'height', label: 'Height', min: 0.5, max: 3.5, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 0.8, max: 5, step: 0.05 },
      { key: 'bevelStyle', label: 'Bevel', min: 0, max: 1, step: 0.01 },
      { key: 'ribs', label: 'Ribs', min: 1, max: 8, step: 1, integer: true },
      { key: 'lights', label: 'Lights', min: 0, max: 8, step: 1, integer: true },
      { key: 'damage', label: 'Damage', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'supply-barrel',
    name: 'Supply Barrel',
    description: 'Industrial barrel with reinforced bands, handles and deterministic dents.',
    defaultMaterial: { ...defaultMaterial('Safety Orange', '#c4612f'), roughness: 0.58, metalness: 0.28 },
    defaults: { radius: 0.72, height: 1.8, bands: 3, handles: 2, dents: 0.28, seed: 91204 },
    parameters: [
      { key: 'radius', label: 'Radius', min: 0.35, max: 1.5, step: 0.05 },
      { key: 'height', label: 'Height', min: 0.8, max: 3.2, step: 0.05 },
      { key: 'bands', label: 'Bands', min: 1, max: 6, step: 1, integer: true },
      { key: 'handles', label: 'Handles', min: 0, max: 4, step: 1, integer: true },
      { key: 'dents', label: 'Dents', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'power-core',
    name: 'Power Core',
    description: 'Compact sci-fi energy cell with base clamps and emissive core.',
    defaultMaterial: {
      ...defaultMaterial('Coolant Steel', '#5d6973'),
      roughness: 0.32,
      metalness: 0.7,
      emissive: '#35c7ff',
      emissiveIntensity: 2.4,
    },
    defaults: { radius: 0.55, height: 2.1, clamps: 4, rings: 3, glow: 0.9, seed: 733501 },
    parameters: [
      { key: 'radius', label: 'Radius', min: 0.25, max: 1.2, step: 0.05 },
      { key: 'height', label: 'Height', min: 0.8, max: 3.5, step: 0.05 },
      { key: 'clamps', label: 'Clamps', min: 2, max: 8, step: 1, integer: true },
      { key: 'rings', label: 'Rings', min: 1, max: 6, step: 1, integer: true },
      { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'antenna-array',
    name: 'Antenna Array',
    description: 'Game-ready communications mast with dishes and signal modules.',
    defaultMaterial: { ...defaultMaterial('Matte Alloy', '#6c757d'), roughness: 0.48, metalness: 0.62 },
    defaults: { height: 3.1, mastRadius: 0.08, dishes: 3, panels: 4, spread: 0.75, seed: 306721 },
    parameters: [
      { key: 'height', label: 'Height', min: 1.2, max: 5.5, step: 0.05 },
      { key: 'mastRadius', label: 'Mast', min: 0.04, max: 0.22, step: 0.01 },
      { key: 'dishes', label: 'Dishes', min: 1, max: 6, step: 1, integer: true },
      { key: 'panels', label: 'Panels', min: 0, max: 8, step: 1, integer: true },
      { key: 'spread', label: 'Spread', min: 0.2, max: 1.4, step: 0.05 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'modular-wall',
    name: 'Modular Wall',
    description: 'Tileable bunker wall segment with panels, columns and service ports.',
    defaultMaterial: { ...defaultMaterial('Concrete Alloy', '#747168'), roughness: 0.82, metalness: 0.12 },
    defaults: { width: 3.2, height: 2.2, depth: 0.28, panels: 4, ports: 2, damage: 0.08, seed: 642018 },
    parameters: [
      { key: 'width', label: 'Width', min: 1.4, max: 6, step: 0.05 },
      { key: 'height', label: 'Height', min: 1, max: 4, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 0.12, max: 0.8, step: 0.05 },
      { key: 'panels', label: 'Panels', min: 1, max: 8, step: 1, integer: true },
      { key: 'ports', label: 'Ports', min: 0, max: 6, step: 1, integer: true },
      { key: 'damage', label: 'Damage', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'tech-door',
    name: 'Tech Door',
    description: 'Heavy sci-fi sliding door with inset plates, rails, warning lights and vents.',
    defaultMaterial: {
      ...defaultMaterial('Armored Blue', '#2f5f9c'),
      roughness: 0.56,
      metalness: 0.42,
      emissive: '#ffd23f',
      emissiveIntensity: 1.4,
    },
    defaults: { width: 2.6, height: 3, depth: 0.28, panels: 3, vents: 4, lights: 4, damage: 0.12, seed: 195408 },
    parameters: [
      { key: 'width', label: 'Width', min: 1.4, max: 5, step: 0.05 },
      { key: 'height', label: 'Height', min: 1.8, max: 5, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 0.12, max: 0.7, step: 0.05 },
      { key: 'panels', label: 'Panels', min: 1, max: 5, step: 1, integer: true },
      { key: 'vents', label: 'Vents', min: 0, max: 8, step: 1, integer: true },
      { key: 'lights', label: 'Lights', min: 0, max: 8, step: 1, integer: true },
      { key: 'damage', label: 'Damage', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'floor-panel',
    name: 'Floor Panel',
    description: 'Tileable sci-fi floor piece with inset plates, grates, seams and corner bolts.',
    defaultMaterial: { ...defaultMaterial('Dark Floor Alloy', '#384047'), roughness: 0.62, metalness: 0.5 },
    defaults: { width: 3, depth: 3, thickness: 0.14, grates: 4, bolts: 8, hazard: 0.45, seed: 502741 },
    parameters: [
      { key: 'width', label: 'Width', min: 1.2, max: 6, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 1.2, max: 6, step: 0.05 },
      { key: 'thickness', label: 'Thickness', min: 0.05, max: 0.4, step: 0.01 },
      { key: 'grates', label: 'Grates', min: 0, max: 8, step: 1, integer: true },
      { key: 'bolts', label: 'Bolts', min: 0, max: 16, step: 1, integer: true },
      { key: 'hazard', label: 'Hazard', min: 0, max: 1, step: 0.01 },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'pipe-network',
    name: 'Pipe Network',
    description: 'Modular wall pipe kit with elbows, clamps, junction boxes and service valves.',
    defaultMaterial: { ...defaultMaterial('Utility Pipe Metal', '#6f7a7d'), roughness: 0.5, metalness: 0.64 },
    defaults: { width: 3.2, height: 2.2, pipeRadius: 0.08, branches: 4, clamps: 5, valves: 2, seed: 882406 },
    parameters: [
      { key: 'width', label: 'Width', min: 1.2, max: 6, step: 0.05 },
      { key: 'height', label: 'Height', min: 0.8, max: 4, step: 0.05 },
      { key: 'pipeRadius', label: 'Radius', min: 0.03, max: 0.18, step: 0.01 },
      { key: 'branches', label: 'Branches', min: 1, max: 8, step: 1, integer: true },
      { key: 'clamps', label: 'Clamps', min: 0, max: 10, step: 1, integer: true },
      { key: 'valves', label: 'Valves', min: 0, max: 5, step: 1, integer: true },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
  {
    id: 'control-console',
    name: 'Control Console',
    description: 'Angled sci-fi terminal with screen, keyboard blocks, side rails and emissive indicators.',
    defaultMaterial: {
      ...defaultMaterial('Console Graphite', '#2d3439'),
      roughness: 0.47,
      metalness: 0.38,
      emissive: '#35c7ff',
      emissiveIntensity: 1.7,
    },
    defaults: { width: 1.7, height: 1.35, depth: 1.05, screens: 2, buttons: 10, rails: 2, seed: 274993 },
    parameters: [
      { key: 'width', label: 'Width', min: 0.9, max: 3, step: 0.05 },
      { key: 'height', label: 'Height', min: 0.8, max: 2.2, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 0.6, max: 2, step: 0.05 },
      { key: 'screens', label: 'Screens', min: 1, max: 4, step: 1, integer: true },
      { key: 'buttons', label: 'Buttons', min: 0, max: 20, step: 1, integer: true },
      { key: 'rails', label: 'Rails', min: 0, max: 4, step: 1, integer: true },
      { key: 'seed', label: 'Seed', min: 1, max: 999999, step: 1, integer: true },
    ],
  },
];

export const getGeneratorDefinition = (generatorId: GeneratorId) =>
  generatorDefinitions.find((definition) => definition.id === generatorId);

export const createGeneratorNode = (generatorId: GeneratorId, seed = seedDefault()): SceneNode => {
  const definition = getGeneratorDefinition(generatorId);
  if (!definition) {
    throw new Error(`Unknown generator: ${generatorId}`);
  }

  return {
    id: id('node'),
    name: definition.name,
    geometry: {
      kind: definition.id,
      generatorId: definition.id,
      params: {
        ...definition.defaults,
        seed,
      },
    },
    transform: defaultTransform(),
    material: { ...definition.defaultMaterial },
    visible: true,
    locked: false,
    createdAt: new Date().toISOString(),
  };
};

export const createSciFiCrateNode = (seed = seedDefault()): SceneNode => createGeneratorNode('scifi-crate', seed);

export const seededNoise = (seed: number, index: number) => {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

export const clampGeneratorParams = (generatorId: GeneratorId, params: ProceduralParameters): ProceduralParameters => {
  const definition = getGeneratorDefinition(generatorId);
  if (!definition) return params;

  return Object.fromEntries(
    definition.parameters.map((parameter) => {
      const raw = params[parameter.key] ?? definition.defaults[parameter.key] ?? parameter.min;
      const clamped = Math.min(parameter.max, Math.max(parameter.min, raw));
      return [parameter.key, parameter.integer ? Math.round(clamped) : clamped];
    }),
  );
};
