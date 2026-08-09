import { isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { AssetDocument } from '../domain/model';

export const isDesktopRuntime = () => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

const projectFilters = [{ name: '3D Asset Forge Project', extensions: ['forge.json', 'json'] }];
const glbFilters = [{ name: 'glTF Binary', extensions: ['glb'] }];
const jsonFilters = [{ name: 'JSON', extensions: ['json'] }];
const pngFilters = [{ name: 'PNG Image', extensions: ['png'] }];

export const saveProjectNative = async (assetDocument: AssetDocument, defaultPath?: string) => {
  const filePath = await save({
    title: 'Save 3D Asset Forge Project',
    defaultPath: defaultPath ?? `${assetDocument.metadata.name.replace(/\s+/g, '-').toLowerCase()}.forge.json`,
    filters: projectFilters,
  });

  if (!filePath) return null;
  await writeTextFile(filePath, JSON.stringify(assetDocument, null, 2));
  return filePath;
};

export const openProjectNative = async () => {
  const filePath = await open({
    title: 'Open 3D Asset Forge Project',
    multiple: false,
    directory: false,
    filters: projectFilters,
  });

  if (!filePath || Array.isArray(filePath)) return null;

  const content = await readTextFile(filePath);
  const parsed = JSON.parse(content) as AssetDocument;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)) {
    throw new Error('Invalid project file.');
  }

  return {
    document: parsed,
    path: filePath,
  };
};

export const saveBlobNative = async (blob: Blob, defaultPath: string, kind: 'glb' | 'png') => {
  const filePath = await save({
    title: kind === 'glb' ? 'Export GLB' : 'Save Preview PNG',
    defaultPath,
    filters: kind === 'glb' ? glbFilters : pngFilters,
  });

  if (!filePath) return null;
  await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
  return filePath;
};

export const saveJsonNative = async (data: unknown, defaultPath: string) => {
  const filePath = await save({
    title: 'Save JSON Report',
    defaultPath,
    filters: jsonFilters,
  });

  if (!filePath) return null;
  await writeTextFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
};
