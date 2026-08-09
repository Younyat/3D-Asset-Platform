import { AssetDocument } from '../domain/model';

const STORAGE_KEY = '3d-asset-forge.current-project';
const AUTOSAVE_KEY = '3d-asset-forge.autosave-project';

export const saveProjectToBrowser = (document: AssetDocument) => {
  const updatedDocument = {
    ...document,
    metadata: {
      ...document.metadata,
      updatedAt: new Date().toISOString(),
    },
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedDocument, null, 2));
  } catch (error) {
    console.warn('Project is too large for browser localStorage; JSON/native save is still available.', error);
  }
  return updatedDocument;
};

export const loadProjectFromBrowser = (): AssetDocument | null => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;

  const parsed = JSON.parse(stored) as AssetDocument;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)) {
    throw new Error('Unsupported or corrupted project schema.');
  }

  return parsed;
};

export const saveProjectAutosave = (assetDocument: AssetDocument) => {
  try {
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify(
        {
          ...assetDocument,
          metadata: {
            ...assetDocument.metadata,
            updatedAt: new Date().toISOString(),
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.warn('Autosave skipped because the project is too large for browser localStorage.', error);
  }
};

export const loadProjectAutosave = (): AssetDocument | null => {
  const stored = localStorage.getItem(AUTOSAVE_KEY);
  if (!stored) return null;

  const parsed = JSON.parse(stored) as AssetDocument;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)) {
    throw new Error('Unsupported or corrupted autosave schema.');
  }

  return parsed;
};

export const downloadProjectFile = (assetDocument: AssetDocument) => {
  const blob = new Blob([JSON.stringify(assetDocument, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${assetDocument.metadata.name.replace(/\s+/g, '-').toLowerCase()}.forge.json`;
  link.click();
  URL.revokeObjectURL(url);
};
