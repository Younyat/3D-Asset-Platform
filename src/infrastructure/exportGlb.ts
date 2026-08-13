import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { AssetDocument } from '../domain/model';
import { createRenderableSceneAsync } from './threeSceneFactory';

export const exportDocumentAsGlb = async (document: AssetDocument) => {
  const scene = new THREE.Scene();
  scene.name = document.metadata.name;
  scene.add(await createRenderableSceneAsync(document.nodes.filter((node) => node.visible)));

  const exporter = new GLTFExporter();

  const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          resolve(new TextEncoder().encode(JSON.stringify(result)).buffer);
        }
      },
      (error) => reject(error),
      { binary: true, onlyVisible: true },
    );
  });

  return new Blob([arrayBuffer], { type: 'model/gltf-binary' });
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const exportJsonReport = (data: unknown, filename: string) => {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
};

export const renderDocumentPreview = async (document: AssetDocument, size = 768) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.setClearColor('#202326');

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#47515a', 1.9));
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.6);
  keyLight.position.set(4, 7, 5);
  scene.add(keyLight);

  const assetRoot = await createRenderableSceneAsync(document.nodes.filter((node) => node.visible));
  scene.add(assetRoot);

  const box = new THREE.Box3().setFromObject(assetRoot);
  const center = new THREE.Vector3();
  const dimensions = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(dimensions);

  const radius = Math.max(dimensions.x, dimensions.y, dimensions.z, 1);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  camera.position.set(center.x + radius * 1.15, center.y + radius * 0.85, center.z + radius * 1.35);
  camera.lookAt(center);

  renderer.render(scene, camera);

  const blob = await new Promise<Blob>((resolve, reject) => {
    renderer.domElement.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Preview render failed.'));
    }, 'image/png');
  });

  renderer.dispose();
  return blob;
};
