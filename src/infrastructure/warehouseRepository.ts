import { PartWarehouseItem } from '../domain/model';

const DB_NAME = '3d-asset-forge-warehouse';
const DB_VERSION = 1;
const STORE_NAME = 'items';

type WarehouseRecord = {
  id: string;
  projectId: string;
  itemKey: string;
  savedAt: string;
  item: PartWarehouseItem;
};

export type WarehouseStorageInfo = {
  items: number;
  usageBytes: number;
  quotaBytes: number;
  savedItems: Array<{
    name: string;
    itemType: PartWarehouseItem['itemType'];
    category: string;
    className: string;
    savedAt: string;
    sizeBytes: number;
  }>;
};

export type WarehouseProjectSummary = {
  projectId: string;
  items: number;
  usageBytes: number;
  latestSavedAt: string;
};

export const warehouseItemKey = (item: PartWarehouseItem) => {
  if (item.metadata.storageKey) return item.metadata.storageKey;

  if (item.itemType === 'assembly') {
    return ['assembly', item.category, item.className, item.name, item.sourceAssetName, item.assemblyNodes.length].join('::');
  }

  return ['part', item.category, item.className, item.name, item.sourceAssetName, item.objectName].join('::');
};

const loadFileWarehouse = async (projectId: string) => {
  const response = await fetch(`/__warehouse/load?projectId=${encodeURIComponent(projectId)}`);
  if (!response.ok) throw new Error('File warehouse load failed.');
  return (await response.json()) as {
    manifest: {
      items?: Array<{
        name: string;
        itemType: PartWarehouseItem['itemType'];
        category: string;
        className: string;
        savedAt: string;
        sizeBytes: number;
      }>;
    };
    items: PartWarehouseItem[];
    usageBytes: number;
  };
};

const saveFileWarehouse = async (projectId: string, items: PartWarehouseItem[]) => {
  const response = await fetch('/__warehouse/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      items: items.map((item) => ({ key: warehouseItemKey(item), item })),
    }),
  });
  if (!response.ok) throw new Error('File warehouse save failed.');
  return (await response.json()) as { saved: number; skipped: number };
};

export const loadWarehouseProjectSummaries = async () => {
  const response = await fetch('/__warehouse/projects');
  if (!response.ok) throw new Error('Warehouse projects load failed.');
  const payload = (await response.json()) as { projects?: WarehouseProjectSummary[] };
  return payload.projects ?? [];
};

const openWarehouseDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('projectItemKey', ['projectId', 'itemKey'], { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Warehouse database failed to open.'));
  });

const runStoreTransaction = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>) => {
  const database = await openWarehouseDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = await action(store);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Warehouse transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Warehouse transaction aborted.'));
    });
    return result;
  } finally {
    database.close();
  }
};

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Warehouse request failed.'));
  });

export const loadWarehouseItems = async (projectId: string) => {
  try {
    const fileWarehouse = await loadFileWarehouse(projectId);
    if (fileWarehouse.items.length) return fileWarehouse.items;
  } catch {
    // Browser-only fallback for deployments without the local file endpoint.
  }

  return runStoreTransaction('readonly', async (store) => {
    const index = store.index('projectId');
    const records = await requestResult<WarehouseRecord[]>(index.getAll(projectId));
    return records.sort((a, b) => a.savedAt.localeCompare(b.savedAt)).map((record) => record.item);
  });
};

export const loadWarehouseItemsWithFallback = async (projectId: string) => {
  const projectItems = await loadWarehouseItems(projectId);
  if (projectItems.length) return { projectId, items: projectItems, fallback: false };

  try {
    const projects = await loadWarehouseProjectSummaries();
    const candidates = projects.filter((project) => project.projectId !== projectId && project.items > 0);
    for (const project of candidates) {
      const items = await loadWarehouseItems(project.projectId);
      if (items.length) return { projectId: project.projectId, items, fallback: true };
    }
  } catch {
    // Keep the original empty result if project discovery is unavailable.
  }

  return { projectId, items: projectItems, fallback: false };
};

export const loadWarehouseStorageInfo = async (projectId: string) => {
  try {
    const fileWarehouse = await loadFileWarehouse(projectId);
    return {
      items: fileWarehouse.manifest.items?.length ?? 0,
      usageBytes: fileWarehouse.usageBytes,
      quotaBytes: 0,
      savedItems: (fileWarehouse.manifest.items ?? []).map((item) => ({
        name: item.name,
        itemType: item.itemType,
        category: item.category,
        className: item.className,
        savedAt: item.savedAt,
        sizeBytes: item.sizeBytes,
      })),
    } satisfies WarehouseStorageInfo;
  } catch {
    // Browser-only fallback for deployments without the local file endpoint.
  }

  const records = await runStoreTransaction('readonly', async (store) => {
    const index = store.index('projectId');
    return requestResult<WarehouseRecord[]>(index.getAll(projectId));
  });
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  return {
    items: records.length,
    usageBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
    savedItems: records
      .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
      .map((record) => ({
        name: record.item.name,
        itemType: record.item.itemType,
        category: record.item.category,
        className: record.item.className,
        savedAt: record.savedAt,
        sizeBytes: new Blob([JSON.stringify(record.item)]).size,
      })),
  } satisfies WarehouseStorageInfo;
};

export const saveWarehouseItems = async (projectId: string, items: PartWarehouseItem[]) => {
  let fileResult = { saved: 0, skipped: 0 };
  for (const item of items) {
    const result = await saveFileWarehouse(projectId, [item]);
    fileResult = {
      saved: fileResult.saved + result.saved,
      skipped: fileResult.skipped + result.skipped,
    };
  }

  try {
    await runStoreTransaction('readwrite', async (store) => {
    const index = store.index('projectItemKey');
    const savedAt = new Date().toISOString();

    for (const item of items) {
      const itemKey = warehouseItemKey(item);
      const existing = await requestResult<WarehouseRecord | undefined>(index.get([projectId, itemKey]));
      if (existing) continue;

      const record: WarehouseRecord = {
        id: `${projectId}:${crypto.randomUUID()}`,
        projectId,
        itemKey,
        savedAt,
        item: {
          ...item,
          metadata: {
            ...item.metadata,
            updatedAt: savedAt,
          },
        } as PartWarehouseItem,
      };
      store.put(record);
    }
  });
  } catch {
    // File persistence is the source of truth; IndexedDB mirror is optional.
  }

  return fileResult;
};

export const saveWarehouseGlbItem = async (projectId: string, item: PartWarehouseItem, glb: Blob, options: { overwrite?: boolean } = {}) => {
  const metadata = encodeURIComponent(
    JSON.stringify({
      name: item.name,
      itemType: item.itemType,
      category: item.category,
      className: item.className,
      code: item.code,
      objectName: item.itemType === 'part' ? item.objectName : item.name,
      sourceAssetName: item.sourceAssetName,
      material: item.itemType === 'part' ? item.material : undefined,
      thumbnailDataUrl: item.thumbnailDataUrl,
    }),
  );
  const response = await fetch(
    `/__warehouse/save-glb?projectId=${encodeURIComponent(projectId)}&key=${encodeURIComponent(warehouseItemKey(item))}&metadata=${metadata}&overwrite=${options.overwrite ? '1' : '0'}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: glb,
    },
  );
  if (!response.ok) throw new Error('Physical GLB warehouse save failed.');
  return (await response.json()) as { saved: number; skipped: number; replaced?: number };
};

export const saveWarehouseThumbnail = async (projectId: string, item: PartWarehouseItem, thumbnailDataUrl: string) => {
  const storageProjectId = item.metadata.storageProjectId ?? projectId;
  const response = await fetch('/__warehouse/thumbnail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: storageProjectId,
      key: warehouseItemKey(item),
      thumbnailDataUrl,
    }),
  });
  if (!response.ok) throw new Error('Warehouse thumbnail save failed.');
  return (await response.json()) as { updated: number };
};

export const deleteWarehouseItem = async (projectId: string, item: PartWarehouseItem) => {
  const storageProjectId = item.metadata.storageProjectId ?? projectId;
  const itemKey = warehouseItemKey(item);
  await fetch('/__warehouse/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: storageProjectId, key: itemKey }),
  }).catch(() => undefined);

  return runStoreTransaction('readwrite', async (store) => {
    const index = store.index('projectItemKey');
    const existing = await requestResult<WarehouseRecord | undefined>(index.get([storageProjectId, itemKey]));
    if (existing) store.delete(existing.id);
  });
};
