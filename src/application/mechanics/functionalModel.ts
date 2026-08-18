import type { KinematicGraph, KinematicJoint, JointType, MechanicalPart } from '../../domain/kinematics';
import type { AssemblyConnection, AssemblyValidationIssue, FunctionalAssembly, FunctionalComponent, MechanicalInterface, MechanicalInterfaceKind } from '../../domain/mechanics';
import type { MaterialDefinition, SceneNode, Transform, Vector3Tuple } from '../../domain/model';

const id = (prefix: string, value: string) =>
  `${prefix}_${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 56)}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const zeroTransform = (): Transform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

const tuple = (values?: Vector3Tuple): Vector3Tuple => values ?? [0, 0, 0];

const interfaceCompatibility: Record<MechanicalInterfaceKind, MechanicalInterfaceKind[]> = {
  axis: ['shaft', 'hinge', 'support', 'mount'],
  hinge: ['axis', 'support', 'mount'],
  support: ['axis', 'hinge', 'shaft', 'mount', 'surface'],
  rail: ['support', 'mount'],
  shaft: ['axis', 'support', 'mount'],
  mount: ['axis', 'hinge', 'support', 'rail', 'shaft', 'surface'],
  gripper: ['mount', 'surface'],
  surface: ['support', 'mount', 'gripper'],
};

const mechanicalRole = (name: string, className: string): FunctionalComponent['mechanicalProperties']['role'] => {
  const text = `${name} ${className}`.toLowerCase();
  if (/base|frame|chassis|body|structure/.test(text)) return 'base';
  if (/grip|claw|finger|grasper|effector/.test(text)) return 'end-effector';
  if (/joint|axis|pivot|hinge|shaft/.test(text)) return 'joint';
  if (/motor|drive|actuator|gear/.test(text)) return 'drive';
  if (/arm|link|beam|forearm/.test(text)) return 'link';
  if (/panel|cover|door|hood/.test(text)) return 'panel';
  return 'generic';
};

const preferredJointType = (role: FunctionalComponent['mechanicalProperties']['role'], name: string): JointType | undefined => {
  const text = name.toLowerCase();
  if (/rail|slide|linear|piston/.test(text)) return 'prismatic';
  if (role === 'joint' || /axis|pivot|hinge|wheel|rot/.test(text)) return 'revolute';
  if (role === 'base' || role === 'panel') return 'fixed';
  return undefined;
};

const interfaceKindFromJoint = (joint: KinematicJoint): MechanicalInterfaceKind => {
  if (joint.type === 'prismatic') return 'rail';
  if (joint.type === 'revolute' || joint.type === 'continuous') return /shaft|wheel|axis/i.test(joint.name) ? 'axis' : 'hinge';
  if (joint.type === 'fixed') return 'mount';
  return 'support';
};

const semanticInterfaces = (componentId: string, name: string, role: FunctionalComponent['mechanicalProperties']['role']): MechanicalInterface[] => {
  const text = name.toLowerCase();
  const kind: MechanicalInterfaceKind = /rail|slide|linear/.test(text)
    ? 'rail'
    : /shaft|axis|wheel/.test(text)
      ? 'shaft'
      : role === 'end-effector'
        ? 'gripper'
        : role === 'joint'
          ? 'hinge'
          : 'mount';

  return [
    {
      id: id('iface', `${componentId}_${kind}_main`),
      componentId,
      name: `${kind} interface`,
      kind,
      frame: zeroTransform(),
      axis: kind === 'rail' || kind === 'shaft' || kind === 'hinge' ? [1, 0, 0] : undefined,
      compatibleWith: interfaceCompatibility[kind],
      tags: [kind, role],
      source: 'semantic-name',
      confidence: 0.42,
      metadata: { inferredFrom: text },
    },
  ];
};

const cleanMotionDefinition = (boundsSize: Vector3Tuple): FunctionalComponent['motionDefinition'] => ({
  version: 1,
  static: true,
  endpointMode: 'single',
  activeEndpointId: 'end_a',
  endpoints: [
    {
      id: 'end_a',
      name: 'Primary end',
      role: 'single',
      position: [0, boundsSize[1] / 2, 0],
    },
  ],
  movements: [],
  updatedAt: new Date().toISOString(),
});

const matchingGraphPartIds = (graph: KinematicGraph | undefined, objectName: string) => {
  if (!graph) return [];
  const text = objectName.toLowerCase();
  return graph.parts
    .filter((part) => {
      const partText = `${part.name} ${part.meshObjectIds.join(' ')}`.toLowerCase();
      return partText.includes(text) || text.includes(part.name.toLowerCase()) || part.meshObjectIds.some((meshId) => text.includes(meshId.toLowerCase()));
    })
    .map((part) => part.id);
};

const componentSubgraph = (sourceGraph: KinematicGraph | undefined, partIds: string[], componentId: string, name: string, boundsSize: Vector3Tuple): KinematicGraph => {
  if (!sourceGraph || !partIds.length) {
    const fallbackPart: MechanicalPart = {
      id: `${componentId}_part`,
      name,
      meshObjectIds: [name],
      localFrame: zeroTransform(),
      bounds: {
        min: [0, 0, 0],
        max: boundsSize,
        size: boundsSize,
        center: [boundsSize[0] / 2, boundsSize[1] / 2, boundsSize[2] / 2],
      },
      static: false,
      visible: true,
      source: 'manual-group',
      metadata: { componentId },
    };
    return { rootPartId: fallbackPart.id, parts: [fallbackPart], joints: [] };
  }

  const partSet = new Set(partIds);
  const parts = sourceGraph.parts.filter((part) => partSet.has(part.id)).map(clone);
  const joints = sourceGraph.joints
    .filter((joint) => partSet.has(joint.parentPartId) || partSet.has(joint.childPartId))
    .map((joint) => ({
      ...clone(joint),
      status: joint.status === 'rejected' ? 'candidate' : joint.status,
    }));
  return {
    rootPartId: parts[0]?.id ?? sourceGraph.rootPartId,
    parts: parts.length ? parts : [clone(sourceGraph.parts.find((part) => part.id === sourceGraph.rootPartId) ?? sourceGraph.parts[0])],
    joints,
  };
};

const interfacesFromGraph = (componentId: string, sourceGraph: KinematicGraph | undefined, partIds: string[]): MechanicalInterface[] => {
  if (!sourceGraph || !partIds.length) return [];
  const partSet = new Set(partIds);
  return sourceGraph.joints
    .filter((joint) => partSet.has(joint.parentPartId) || partSet.has(joint.childPartId))
    .map((joint) => {
      const kind = interfaceKindFromJoint(joint);
      return {
        id: id('iface', `${componentId}_${joint.id}`),
        componentId,
        name: joint.name,
        kind,
        frame: {
          position: tuple(joint.origin.position),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        axis: tuple(joint.axis),
        compatibleWith: interfaceCompatibility[kind],
        tags: [kind, joint.type, joint.status],
        source: 'kinematic-graph',
        confidence: joint.confidence ?? 0.5,
        metadata: {
          sourceJointId: joint.id,
          jointType: joint.type,
        },
      } satisfies MechanicalInterface;
    });
};

export type BuildFunctionalComponentInput = {
  id: string;
  name: string;
  category: string;
  className: string;
  sourceAssetName: string;
  sourceObjectName: string;
  bounds: Vector3Tuple;
  material: MaterialDefinition;
  localTransform?: Transform;
  sourceGraph?: KinematicGraph;
};

export const buildFunctionalComponent = (input: BuildFunctionalComponentInput): FunctionalComponent => {
  const componentId = input.id;
  const role = mechanicalRole(input.name, input.className);
  const sourcePartIds = matchingGraphPartIds(input.sourceGraph, input.sourceObjectName);
  const kinematicGraph = componentSubgraph(input.sourceGraph, sourcePartIds, componentId, input.name, input.bounds);
  const graphInterfaces = interfacesFromGraph(componentId, input.sourceGraph, sourcePartIds);
  const fallbackInterfaces = semanticInterfaces(componentId, input.name, role);
  const interfaces = graphInterfaces.length ? graphInterfaces : fallbackInterfaces;

  return {
    id: componentId,
    name: input.name,
    category: input.category,
    className: input.className,
    sourceAssetName: input.sourceAssetName,
    sourceObjectName: input.sourceObjectName,
    localTransform: input.localTransform ?? zeroTransform(),
    origin: zeroTransform(),
    bounds: {
      size: input.bounds,
      center: [input.bounds[0] / 2, input.bounds[1] / 2, input.bounds[2] / 2],
    },
    material: input.material,
    mechanicalProperties: {
      role,
      movable: role !== 'base' && role !== 'panel',
      preferredJointType: preferredJointType(role, input.name),
      massEstimateKg: Math.max(input.bounds[0] * input.bounds[1] * input.bounds[2] * 35, 0.001),
    },
    interfaces,
    kinematicGraph,
    motionDefinition: cleanMotionDefinition(input.bounds),
    sourceKinematicPartIds: sourcePartIds,
    metadata: {
      createdAt: new Date().toISOString(),
      source: sourcePartIds.length ? 'kinematic-graph' : 'semantic-fallback',
    },
  };
};

const compatible = (a: MechanicalInterface, b: MechanicalInterface) => a.compatibleWith.includes(b.kind) || b.compatibleWith.includes(a.kind);

const connectionJointType = (a: MechanicalInterface, b: MechanicalInterface, parent: FunctionalComponent, child: FunctionalComponent): JointType => {
  const preferred = child.mechanicalProperties.preferredJointType ?? parent.mechanicalProperties.preferredJointType;
  if (preferred) return preferred;
  if (a.kind === 'rail' || b.kind === 'rail') return 'prismatic';
  if (a.kind === 'hinge' || b.kind === 'hinge' || a.kind === 'axis' || b.kind === 'axis' || a.kind === 'shaft' || b.kind === 'shaft') return 'revolute';
  return 'fixed';
};

export const suggestAssemblyConnections = (components: FunctionalComponent[]): AssemblyConnection[] => {
  const connections: AssemblyConnection[] = [];
  const connected = new Set<string>();

  for (let index = 1; index < components.length; index += 1) {
    const parent = components[index - 1];
    const child = components[index];
    const candidates = parent.interfaces.flatMap((parentInterface) =>
      child.interfaces
        .filter((childInterface) => compatible(parentInterface, childInterface))
        .map((childInterface) => ({ parentInterface, childInterface, score: parentInterface.confidence + childInterface.confidence })),
    );
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    if (!best) continue;

    const jointType = connectionJointType(best.parentInterface, best.childInterface, parent, child);
    const joint: KinematicJoint = {
      id: id('joint', `${parent.id}_${child.id}_${best.parentInterface.id}_${best.childInterface.id}`),
      name: `${parent.name} to ${child.name}`,
      parentPartId: parent.id,
      childPartId: child.id,
      type: jointType,
      origin: {
        position: best.childInterface.frame.position,
        rotation: [0, 0, 0, 1],
      },
      axis: best.childInterface.axis ?? best.parentInterface.axis ?? [1, 0, 0],
      limits: jointType === 'revolute' ? { lower: -Math.PI, upper: Math.PI } : jointType === 'prismatic' ? { lower: -1, upper: 1 } : undefined,
      source: 'hybrid',
      confidence: Math.min(best.score / 2, 0.95),
      evidence: [
        {
          type: 'manual',
          score: Math.min(best.score / 2, 0.95),
          message: 'Suggested from compatible mechanical interfaces.',
        },
      ],
      status: 'candidate',
    };

    connections.push({
      id: id('conn', `${parent.id}_${child.id}_${index}`),
      name: `${parent.name} -> ${child.name}`,
      parentComponentId: parent.id,
      childComponentId: child.id,
      parentInterfaceId: best.parentInterface.id,
      childInterfaceId: best.childInterface.id,
      joint,
      status: 'candidate',
      source: 'suggested',
      confidence: joint.confidence ?? 0.5,
      metadata: {
        parentKind: best.parentInterface.kind,
        childKind: best.childInterface.kind,
      },
    });
    connected.add(parent.id);
    connected.add(child.id);
  }

  if (components.length === 1 && !connected.has(components[0].id)) return [];
  return connections;
};

const graphFromAssembly = (components: FunctionalComponent[], connections: AssemblyConnection[]): KinematicGraph => ({
  rootPartId: components[0]?.id ?? 'assembly_root',
  parts: components.map((component) => ({
    id: component.id,
    name: component.name,
    meshObjectIds: [component.sourceObjectName],
    localFrame: component.localTransform,
    bounds: {
      min: [0, 0, 0],
      max: component.bounds.size,
      size: component.bounds.size,
      center: component.bounds.center,
    },
    static: component.mechanicalProperties.role === 'base',
    visible: true,
    source: 'manual-group',
    metadata: {
      category: component.category,
      className: component.className,
      componentRole: component.mechanicalProperties.role,
    },
  })),
  joints: connections.map((connection) => connection.joint),
});

export const validateFunctionalAssembly = (assembly: FunctionalAssembly): AssemblyValidationIssue[] => {
  const issues: AssemblyValidationIssue[] = [];
  const componentIds = new Set<string>();
  const connectionIds = new Set<string>();

  assembly.components.forEach((component) => {
    if (componentIds.has(component.id)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_COMPONENT', message: `${component.name} is duplicated.`, componentId: component.id });
    }
    componentIds.add(component.id);
    if (!component.interfaces.length) {
      issues.push({ severity: 'warning', code: 'NO_INTERFACES', message: `${component.name} has no mechanical interfaces.`, componentId: component.id });
    }
  });

  assembly.connections.forEach((connection) => {
    if (connectionIds.has(connection.id)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_CONNECTION', message: `${connection.name} is duplicated.`, connectionId: connection.id });
    }
    connectionIds.add(connection.id);
    const parent = assembly.components.find((component) => component.id === connection.parentComponentId);
    const child = assembly.components.find((component) => component.id === connection.childComponentId);
    if (!parent || !child) {
      issues.push({ severity: 'error', code: 'MISSING_COMPONENT', message: `${connection.name} references a missing component.`, connectionId: connection.id });
      return;
    }
    const parentInterface = parent.interfaces.find((item) => item.id === connection.parentInterfaceId);
    const childInterface = child.interfaces.find((item) => item.id === connection.childInterfaceId);
    if (!parentInterface || !childInterface) {
      issues.push({ severity: 'error', code: 'MISSING_INTERFACE', message: `${connection.name} references a missing interface.`, connectionId: connection.id });
      return;
    }
    if (!compatible(parentInterface, childInterface)) {
      issues.push({ severity: 'error', code: 'INCOMPATIBLE_INTERFACES', message: `${connection.name} joins incompatible interfaces.`, connectionId: connection.id });
    }
    const limits = connection.joint.limits;
    if (limits?.lower !== undefined && limits.upper !== undefined && limits.lower > limits.upper) {
      issues.push({ severity: 'error', code: 'INVALID_LIMITS', message: `${connection.name} has contradictory joint limits.`, connectionId: connection.id });
    }
  });

  if (assembly.components.length > 1) {
    const graph = new Map<string, string[]>();
    assembly.components.forEach((component) => graph.set(component.id, []));
    assembly.connections.forEach((connection) => {
      graph.get(connection.parentComponentId)?.push(connection.childComponentId);
    });

    const rootId = assembly.rootComponentId ?? assembly.components[0]?.id;
    const reachable = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let hasCycle = false;
    const visit = (componentId: string) => {
      if (visiting.has(componentId)) {
        hasCycle = true;
        return;
      }
      if (visited.has(componentId)) return;
      visiting.add(componentId);
      reachable.add(componentId);
      graph.get(componentId)?.forEach(visit);
      visiting.delete(componentId);
      visited.add(componentId);
    };
    if (rootId) visit(rootId);
    assembly.components.forEach((component) => {
      if (!reachable.has(component.id)) {
        issues.push({ severity: 'warning', code: 'FLOATING_COMPONENT', message: `${component.name} is not connected to the assembly root.`, componentId: component.id });
      }
    });
    if (hasCycle) {
      issues.push({ severity: 'error', code: 'KINEMATIC_CYCLE', message: 'Assembly contains a directed kinematic cycle.' });
    }
  }

  return issues;
};

export const buildFunctionalAssembly = (input: {
  id: string;
  name: string;
  components: FunctionalComponent[];
  source: FunctionalAssembly['metadata']['source'];
  connections?: AssemblyConnection[];
}): FunctionalAssembly => {
  const now = new Date().toISOString();
  const connections = input.connections ?? suggestAssemblyConnections(input.components);
  const draft: FunctionalAssembly = {
    id: input.id,
    name: input.name,
    rootComponentId: input.components[0]?.id,
    components: input.components,
    connections,
    kinematicGraph: graphFromAssembly(input.components, connections),
    metadata: {
      createdAt: now,
      updatedAt: now,
      source: input.source,
      validationStatus: 'unknown',
      validationMessages: [],
    },
  };
  const issues = validateFunctionalAssembly(draft);
  return {
    ...draft,
    metadata: {
      ...draft.metadata,
      validationStatus: issues.some((issue) => issue.severity === 'error') ? 'invalid' : issues.some((issue) => issue.severity === 'warning') ? 'warning' : 'valid',
      validationMessages: issues.map((issue) => issue.message),
    },
  };
};
