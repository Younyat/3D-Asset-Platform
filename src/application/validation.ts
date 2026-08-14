import { AssetDocument, SceneNode, ValidationIssue } from '../domain/model';
import { getGeneratorDefinition } from '../domain/generators';
import { validateFunctionalAssembly } from './mechanics/functionalModel';
import { validateKinematicGraph } from './kinematics/kinematicAuthoring';

const finiteTuple = (values: number[]) => values.every(Number.isFinite);

const validateNode = (node: SceneNode): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  if (!finiteTuple(node.transform.position) || !finiteTuple(node.transform.rotation) || !finiteTuple(node.transform.scale)) {
    issues.push({
      severity: 'error',
      code: 'TRANSFORM_NON_FINITE',
      message: `${node.name} contains non-finite transform values.`,
      nodeId: node.id,
    });
  }

  if (node.transform.scale.some((value) => Math.abs(value) < 0.0001)) {
    issues.push({
      severity: 'error',
      code: 'ZERO_SCALE',
      message: `${node.name} has a near-zero scale value.`,
      nodeId: node.id,
    });
  }

  if (node.geometry.kind === 'box' && [node.geometry.width, node.geometry.height, node.geometry.depth].some((value) => value <= 0)) {
    issues.push({ severity: 'error', code: 'INVALID_BOX', message: `${node.name} has invalid box dimensions.`, nodeId: node.id });
  }

  if (node.geometry.kind === 'sphere' && node.geometry.radius <= 0) {
    issues.push({ severity: 'error', code: 'INVALID_SPHERE', message: `${node.name} has invalid sphere radius.`, nodeId: node.id });
  }

  if (node.geometry.kind === 'cylinder' && (node.geometry.radius <= 0 || node.geometry.height <= 0)) {
    issues.push({ severity: 'error', code: 'INVALID_CYLINDER', message: `${node.name} has invalid cylinder dimensions.`, nodeId: node.id });
  }

  if (node.geometry.kind === 'imported-model') {
    if (!node.geometry.assetDataUrl.startsWith('data:')) {
      issues.push({ severity: 'error', code: 'IMPORTED_ASSET_MISSING', message: `${node.name} has no embedded model data.`, nodeId: node.id });
    }

    if (node.geometry.bones.length === 0 && node.geometry.joints.length === 0) {
      issues.push({
        severity: 'info',
        code: 'STATIC_IMPORTED_MODEL',
        message: `${node.name} is static; no articulation bones were found.`,
        nodeId: node.id,
      });
    }

    if (node.geometry.kinematicGraph) {
      validateKinematicGraph(node.geometry.kinematicGraph).forEach((issue) => {
        issues.push({
          severity: issue.severity,
          code: `KINEMATIC_${issue.code}`,
          message: `${node.name}: ${issue.message}`,
          nodeId: node.id,
        });
      });
    }
  }

  if ('generatorId' in node.geometry) {
    const params = node.geometry.params;
    const definition = getGeneratorDefinition(node.geometry.generatorId);

    if (!definition) {
      issues.push({ severity: 'error', code: 'UNKNOWN_GENERATOR', message: `${node.name} uses an unknown generator.`, nodeId: node.id });
      return issues;
    }

    definition.parameters.forEach((parameter) => {
      const value = params[parameter.key];
      if (!Number.isFinite(value)) {
        issues.push({
          severity: 'error',
          code: 'GENERATOR_NON_FINITE',
          message: `${node.name} has a non-finite ${parameter.label} parameter.`,
          nodeId: node.id,
        });
      } else if (value < parameter.min || value > parameter.max) {
        issues.push({
          severity: 'warning',
          code: 'GENERATOR_PARAM_RANGE',
          message: `${node.name} ${parameter.label} is outside the recommended range.`,
          nodeId: node.id,
        });
      }
    });
  }

  return issues;
};

export const validateProject = (document: AssetDocument): ValidationIssue[] => {
  const issues = document.nodes.flatMap(validateNode);

  (document.partWarehouse ?? []).forEach((item) => {
    if (item.itemType !== 'assembly' || !item.functionalAssembly) return;
    validateFunctionalAssembly(item.functionalAssembly).forEach((assemblyIssue) => {
      issues.push({
        severity: assemblyIssue.severity,
        code: `ASSEMBLY_${assemblyIssue.code}`,
        message: `${item.name}: ${assemblyIssue.message}`,
      });
    });
  });

  if (document.nodes.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'EMPTY_SCENE',
      message: 'The project has no exportable objects.',
    });
  }

  const visibleNodes = document.nodes.filter((node) => node.visible);
  if (visibleNodes.length === 0 && document.nodes.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'NO_VISIBLE_OBJECTS',
      message: 'All objects are hidden.',
    });
  }

  return issues.length
    ? issues
    : [
        {
          severity: 'info',
          code: 'VALIDATION_OK',
          message: 'Scene is structurally valid for GLB export.',
        },
      ];
};
