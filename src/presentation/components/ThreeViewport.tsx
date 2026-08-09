import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { AssetDocument, EditorTool, ImportedJointPose, JointMotionKind, MotionAxis, Transform, ValidatedJointMotion } from '../../domain/model';
import { createRenderableSceneAsync } from '../../infrastructure/threeSceneFactory';

export type ViewportStats = {
  fps: number;
  objects: number;
  triangles: number;
};

type ThreeViewportProps = {
  document: AssetDocument;
  tool: EditorTool;
  snapEnabled: boolean;
  motionDemoNodeId?: string;
  motionTrainingPreview?: MotionTrainingPreview;
  onSelect: (nodeId?: string) => void;
  onTransformCommit: (nodeId: string, transform: Transform) => void;
  onStatsChange: (stats: ViewportStats) => void;
};

export type MotionTrainingPreview = {
  nodeId: string;
  jointName: string;
  motionKind: JointMotionKind;
  axis: MotionAxis;
  min: number;
  max: number;
  amplitude: number;
};

const toTransform = (object: THREE.Object3D): Transform => ({
  position: object.position.toArray() as [number, number, number],
  rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
  scale: object.scale.toArray() as [number, number, number],
});

const countTriangles = (object: THREE.Object3D) => {
  let triangles = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry;
    if (!geometry) return;

    if (geometry.index) {
      triangles += geometry.index.count / 3;
    } else if (geometry.attributes.position) {
      triangles += geometry.attributes.position.count / 3;
    }
  });
  return Math.round(triangles);
};

const axisIndexOf = (axis?: 'x' | 'y' | 'z') => (axis === 'y' ? 1 : axis === 'z' ? 2 : 0);

const activeJointValue = (joint: ImportedJointPose) => {
  const axisIndex = axisIndexOf(joint.axis);
  return joint.motionKind === 'translation' ? joint.translation?.[axisIndex] ?? 0 : joint.rotation[axisIndex] ?? 0;
};

const logicalMotionValue = (joint: ImportedJointPose, index: number, elapsed: number) => {
  const name = joint.name.toLowerCase();
  const amplitude = joint.demoAmplitude ?? 0.45;
  const min = joint.min ?? -1.2;
  const max = joint.max ?? 1.2;
  let value = Math.sin(elapsed * (0.8 + index * 0.035)) * amplitude;

  if (/wheel|tire|tyre/.test(name)) value = elapsed * 3.2;
  else if (/grip|grasper|claw|finger/.test(name)) value = Math.sin(elapsed * 1.7) * amplitude;
  else if (/base|rotating|yaw/.test(name)) value = Math.sin(elapsed * 0.45) * amplitude;
  else if (/head|wrist/.test(name)) value = Math.sin(elapsed * 1.05 + index * 0.2) * amplitude;
  else if (/arm|joint|axis|elbow|shoulder/.test(name)) value = Math.sin(elapsed * 0.7 + index * 0.33) * amplitude;

  return Math.min(max, Math.max(min, value));
};

const previewMotionValue = (min: number, max: number, amplitude: number, elapsed: number) => {
  const boundedAmplitude = Math.min(Math.abs(amplitude), Math.abs(min), Math.abs(max));
  return Math.min(max, Math.max(min, Math.sin(elapsed * 1.3) * boundedAmplitude));
};

const orderedValidatedMotions = (motions: ValidatedJointMotion[] | undefined) => [...(motions ?? [])].sort((a, b) => a.order - b.order);

const applyLogicalJointPose = (child: THREE.Object3D, joint: ImportedJointPose, valueOverride?: number) => {
  const axisIndex = axisIndexOf(joint.axis);
  const restRotation = (child.userData.restRotation as THREE.Euler | undefined) ?? child.rotation.clone();
  const restPosition = (child.userData.restPosition as THREE.Vector3 | undefined) ?? child.position.clone();
  child.userData.restRotation = restRotation;
  child.userData.restPosition = restPosition;
  child.rotation.set(restRotation.x, restRotation.y, restRotation.z);
  child.position.copy(restPosition);

  const value = valueOverride ?? activeJointValue(joint);

  if (joint.motionKind === 'translation') {
    if (axisIndex === 0) child.position.x = restPosition.x + value;
    if (axisIndex === 1) child.position.y = restPosition.y + value;
    if (axisIndex === 2) child.position.z = restPosition.z + value;
  } else {
    if (axisIndex === 0) child.rotation.x = restRotation.x + value;
    if (axisIndex === 1) child.rotation.y = restRotation.y + value;
    if (axisIndex === 2) child.rotation.z = restRotation.z + value;
  }

  child.updateMatrixWorld(true);
};

const applyDocumentJointPoses = (assetRoot: THREE.Group, document: AssetDocument) => {
  document.nodes.forEach((node) => {
    if (node.geometry.kind !== 'imported-model') return;
    const poseByName = new Map(node.geometry.joints.map((joint) => [joint.name, joint]));
    assetRoot.traverse((child) => {
      if (child.userData.nodeId !== node.id) return;
      const joint = poseByName.get(child.name);
      if (joint) applyLogicalJointPose(child, joint);
    });
  });
};

const applyRuntimeMotionDemo = (
  assetRoot: THREE.Group,
  document: AssetDocument,
  motionDemoNodeId: string | undefined,
  motionTrainingPreview: MotionTrainingPreview | undefined,
  elapsed: number,
) => {
  document.nodes.forEach((node) => {
    if (node.geometry.kind !== 'imported-model') return;
    const poseByName = new Map(node.geometry.joints.map((joint, index) => [joint.name, { joint, index }]));
    const active = node.id === motionDemoNodeId;
    const validated = orderedValidatedMotions(node.geometry.validatedMotions);
    const activeValidatedMotion =
      active && validated.length ? validated[Math.floor((elapsed / 1.65) % validated.length)] : undefined;

    assetRoot.traverse((child) => {
      if (child.userData.nodeId !== node.id) return;
      const pose = poseByName.get(child.name);
      if (!pose) return;

      if (motionTrainingPreview?.nodeId === node.id && motionTrainingPreview.jointName === pose.joint.name) {
        const value = previewMotionValue(motionTrainingPreview.min, motionTrainingPreview.max, motionTrainingPreview.amplitude, elapsed);
        applyLogicalJointPose(
          child,
          {
            ...pose.joint,
            motionKind: motionTrainingPreview.motionKind,
            axis: motionTrainingPreview.axis,
          },
          value,
        );
      } else if (activeValidatedMotion?.jointName === pose.joint.name) {
        const value = previewMotionValue(activeValidatedMotion.min, activeValidatedMotion.max, activeValidatedMotion.amplitude, elapsed);
        applyLogicalJointPose(
          child,
          {
            ...pose.joint,
            motionKind: activeValidatedMotion.motionKind,
            axis: activeValidatedMotion.axis,
          },
          value,
        );
      } else if (active && !validated.length) {
        const value = logicalMotionValue(pose.joint, pose.index, elapsed);
        applyLogicalJointPose(child, pose.joint, value);
      } else {
        applyLogicalJointPose(child, pose.joint);
      }
    });
  });
};

const renderStructureSignature = (document: AssetDocument) =>
  JSON.stringify({
    nodes: document.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      transform: node.transform,
      material: node.material,
            geometry:
        node.geometry.kind === 'imported-model'
          ? {
              kind: node.geometry.kind,
              assetName: node.geometry.assetName,
              assetDataUrlLength: node.geometry.assetDataUrl.length,
              sourceFormat: node.geometry.sourceFormat,
              importScale: node.geometry.importScale,
              importOffset: node.geometry.importOffset,
              jointStructure: node.geometry.joints.map((joint) => ({
                name: joint.name,
                axis: joint.axis,
                motionKind: joint.motionKind,
                min: joint.min,
                max: joint.max,
              })),
              validatedMotionStructure: node.geometry.validatedMotions?.map((motion) => ({
                id: motion.id,
                jointName: motion.jointName,
                motionKind: motion.motionKind,
                axis: motion.axis,
                min: motion.min,
                max: motion.max,
                amplitude: motion.amplitude,
                order: motion.order,
              })),
            }
          : node.geometry,
    })),
  });

export const ThreeViewport = ({
  document,
  tool,
  snapEnabled,
  motionDemoNodeId,
  motionTrainingPreview,
  onSelect,
  onTransformCommit,
  onStatsChange,
}: ThreeViewportProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef(document);
  const motionDemoNodeIdRef = useRef(motionDemoNodeId);
  const motionTrainingPreviewRef = useRef(motionTrainingPreview);
  const onSelectRef = useRef(onSelect);
  const onTransformCommitRef = useRef(onTransformCommit);
  const onStatsChangeRef = useRef(onStatsChange);
  const renderStructureSignatureRef = useRef<string>();
  const runtimeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    orbit: OrbitControls;
    transform: TransformControls;
    assetRoot: THREE.Group;
    selectionBox: THREE.BoxHelper;
    animationId: number;
    lastFrame: number;
    frames: number;
    fps: number;
  } | null>(null);

  useEffect(() => {
    documentRef.current = document;
    motionDemoNodeIdRef.current = motionDemoNodeId;
    motionTrainingPreviewRef.current = motionTrainingPreview;
  }, [document, motionDemoNodeId, motionTrainingPreview]);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onTransformCommitRef.current = onTransformCommit;
    onStatsChangeRef.current = onStatsChange;
  }, [onSelect, onTransformCommit, onStatsChange]);

  useEffect(() => {
    if (!hostRef.current || runtimeRef.current) return;

    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.setClearColor('#202326');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, 200);
    camera.position.set(4.6, 3.8, 5.4);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.target.set(0, 0.7, 0);

    const transform = new TransformControls(camera, renderer.domElement);
    scene.add(transform.getHelper());

    scene.add(new THREE.HemisphereLight('#ffffff', '#47515a', 1.8));
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.6);
    keyLight.position.set(4, 7, 3);
    scene.add(keyLight);
    scene.add(new THREE.GridHelper(20, 20, '#56606a', '#343a40'));

    const assetRoot = new THREE.Group();
    scene.add(assetRoot);
    const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), '#30d6c8');
    selectionBox.visible = false;
    scene.add(selectionBox);

    transform.addEventListener('dragging-changed', (event) => {
      orbit.enabled = !event.value;
    });

    transform.addEventListener('mouseUp', () => {
      const attached = transform.object;
      const nodeId = attached?.userData.nodeId as string | undefined;
      if (attached && nodeId) {
        onTransformCommitRef.current(nodeId, toTransform(attached));
      }
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const onPointerDown = (event: PointerEvent) => {
      if (transform.dragging) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(assetRoot.children, true);
      onSelectRef.current(hits[0]?.object.userData.nodeId);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const animate = (time: number) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.frames += 1;
      if (time - runtime.lastFrame > 500) {
        runtime.fps = Math.round((runtime.frames * 1000) / (time - runtime.lastFrame));
        runtime.frames = 0;
        runtime.lastFrame = time;
      }

      orbit.update();
      applyRuntimeMotionDemo(assetRoot, documentRef.current, motionDemoNodeIdRef.current, motionTrainingPreviewRef.current, time / 1000);
      if (selectionBox.visible) selectionBox.update();
      renderer.render(scene, camera);
      runtime.animationId = requestAnimationFrame(animate);
    };

    runtimeRef.current = {
      renderer,
      camera,
      scene,
      raycaster,
      pointer,
      orbit,
      transform,
      assetRoot,
      selectionBox,
      animationId: requestAnimationFrame(animate),
      lastFrame: performance.now(),
      frames: 0,
      fps: 0,
    };

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      cancelAnimationFrame(runtimeRef.current?.animationId ?? 0);
      transform.dispose();
      orbit.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    let disposed = false;
    const nextSignature = renderStructureSignature(document);
    const syncViewportControls = () => {
      const selected = runtime.assetRoot.children.find((child) => child.userData.nodeId === document.selectedNodeId);
      runtime.transform.detach();

      const selectedNode = document.nodes.find((node) => node.id === document.selectedNodeId);

      if (selected && tool !== 'select' && !selectedNode?.locked) {
        runtime.transform.attach(selected);
        runtime.transform.setMode(tool);
      }

      runtime.transform.setTranslationSnap(snapEnabled ? 0.25 : null);
      runtime.transform.setRotationSnap(snapEnabled ? Math.PI / 12 : null);
      runtime.transform.setScaleSnap(snapEnabled ? 0.1 : null);

      if (selected) {
        runtime.selectionBox.setFromObject(selected);
        runtime.selectionBox.visible = true;
      } else {
        runtime.selectionBox.visible = false;
      }
    };

    if (renderStructureSignatureRef.current === nextSignature) {
      applyDocumentJointPoses(runtime.assetRoot, document);
      syncViewportControls();
      if (runtime.selectionBox.visible) runtime.selectionBox.update();
      onStatsChangeRef.current({
        fps: runtime.fps,
        objects: document.nodes.length,
        triangles: countTriangles(runtime.assetRoot),
      });
      return () => {
        disposed = true;
      };
    }

    createRenderableSceneAsync(document.nodes).then((renderable) => {
      if (disposed) return;
      renderStructureSignatureRef.current = nextSignature;
      runtime.assetRoot.clear();
      runtime.assetRoot.add(...renderable.children);
      syncViewportControls();

      onStatsChangeRef.current({
        fps: runtime.fps,
        objects: document.nodes.length,
        triangles: countTriangles(runtime.assetRoot),
      });
    });

    return () => {
      disposed = true;
    };
  }, [document, tool, snapEnabled]);

  return <div className="viewport" ref={hostRef} />;
};
