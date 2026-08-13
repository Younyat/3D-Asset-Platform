import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const fileWarehouseRoot = resolve(root, 'tmp-test-warehouse');
const port = Number(process.env.PARTS_TEST_PORT ?? 5199);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const model = {
  name: 'Rmk3 OBJ',
  path: resolve('3d imported models', 'sk095yah4v7k-ModelRmk3', 'Rmk3.obj'),
  expectedText: 'Rmk3.obj',
};

const waitForServer = async (url, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const canvasSample = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return [];

    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const sample = [];
    for (let y = 0; y < canvas.height; y += 12) {
      for (let x = 0; x < canvas.width; x += 12) {
        const index = (y * canvas.width + x) * 4;
        sample.push(pixels[index], pixels[index + 1], pixels[index + 2]);
      }
    }
    return sample;
  });

const sampleDiff = (a, b) => {
  const count = Math.min(a.length, b.length);
  let changed = 0;
  for (let index = 0; index < count; index += 3) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 26) changed += 1;
  }
  return changed;
};

const safeName = (value) => String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

const clearWarehouseDatabase = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('3d-asset-forge-warehouse');
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
      }),
  );

const countPersistedWarehouseItems = (page, projectId) =>
  page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('3d-asset-forge-warehouse', 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('items')) {
            const store = database.createObjectStore('items', { keyPath: 'id' });
            store.createIndex('projectId', 'projectId', { unique: false });
            store.createIndex('projectItemKey', ['projectId', 'itemKey'], { unique: true });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('items', 'readonly');
          const index = transaction.objectStore('items').index('projectId');
          const getAll = index.getAll(id);
          getAll.onsuccess = () => {
            const count = getAll.result.length;
            database.close();
            resolve(count);
          };
          getAll.onerror = () => {
            database.close();
            reject(getAll.error);
          };
        };
      }),
    projectId,
  );

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}

if (!existsSync(model.path)) {
  console.error(`Missing parts selection model: ${model.path}`);
  process.exit(1);
}

const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
  console.error(`Parts selection model is still a Git LFS pointer: ${model.path}`);
  process.exit(1);
}

rmSync(fileWarehouseRoot, { recursive: true, force: true });

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  env: { ...process.env, ASSET_FORGE_WAREHOUSE_DIR: 'tmp-test-warehouse' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

try {
  await waitForServer(`http://127.0.0.1:${port}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await clearWarehouseDatabase(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
    await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 120000 });
    await page.waitForTimeout(1800);
    await page.locator('button[title="Parts"]').click();

    const canvasBox = await page.locator('canvas').boundingBox();
    if (!canvasBox) throw new Error('Viewport canvas was not found.');
    if (canvasBox.height < 760) {
      throw new Error(`Workspace viewport is too small; expected a full-height scene, got ${Math.round(canvasBox.height)}px.`);
    }
    const meterBox = await page.locator('.viewport-resource-meter').boundingBox();
    const meterText = await page.locator('.viewport-resource-meter').textContent();
    if (!meterBox || !meterText?.includes('CPU') || !meterText.includes('RAM')) {
      throw new Error(`${model.name} did not render the live CPU/RAM viewport meter.`);
    }
    if (meterBox.width > 260 || meterBox.height > 28 || meterBox.x + meterBox.width > canvasBox.x + canvasBox.width || meterBox.y + meterBox.height > canvasBox.y + canvasBox.height) {
      throw new Error(`${model.name} CPU/RAM viewport meter is too large or outside the scene.`);
    }

    const clickAt = async ({ x, y }, shift = false) => {
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.click(canvasBox.x + x, canvasBox.y + y);
      if (shift) await page.keyboard.up('Shift');
      await page.waitForTimeout(150);
    };

    const dragAt = async ({ x, y }) => {
      await page.mouse.move(canvasBox.x + x, canvasBox.y + y);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + x + 70, canvasBox.y + y + 35, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
    };

    const primary = { x: 430, y: 210 };
    const candidates = [
      { x: 450, y: 300 },
      { x: 500, y: 350 },
      { x: 380, y: 350 },
      { x: 470, y: 220 },
      { x: 420, y: 430 },
    ];

    let selectedPair;
    for (const candidate of candidates) {
      await page.locator('button[title="Move"]').click();
      await page.locator('button[title="Parts"]').click();
      await clickAt(primary);
      await clickAt(candidate, true);
      const bodyText = await page.locator('body').textContent();
      if (bodyText?.includes('2 parts selected')) {
        selectedPair = candidate;
        break;
      }
    }

    if (!selectedPair) {
      throw new Error('Shift-click did not create a two-part selection on the imported model.');
    }

    await clickAt({ x: 30, y: 30 });
    let bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('Part selection cleared')) {
      throw new Error(`${model.name} did not clear the part selection after clicking empty viewport space.`);
    }

    await clickAt(primary);
    await clickAt(selectedPair, true);
    bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('2 parts selected')) {
      throw new Error(`${model.name} did not recreate a two-part selection after clearing it.`);
    }

    const beforeDrag = await canvasSample(page);
    await dragAt(primary);
    const afterDrag = await canvasSample(page);
    const changedSamples = sampleDiff(beforeDrag, afterDrag);
    bodyText = await page.locator('body').textContent();
    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));

    if (errors.length) {
      throw new Error(`${model.name} produced browser errors: ${errors.join('\n')}`);
    }

    if (!bodyText?.includes('Parts moved')) {
      throw new Error(`${model.name} did not commit a grouped part movement.`);
    }

    if (changedSamples < 4) {
      throw new Error(`${model.name} grouped part movement did not visibly change the canvas. Changed samples: ${changedSamples}.`);
    }

    await page.locator('button[title^="Apply Signal Blue"]').click();
    await page.waitForTimeout(700);
    bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('Part colors updated')) {
      throw new Error(`${model.name} did not apply color to the selected parts.`);
    }

    await page.getByRole('button', { name: /Store Selected/ }).click();
    await page.waitForFunction(() => /Part stored|parts stored/.test(document.body.innerText), undefined, { timeout: 240000 });
    bodyText = await page.locator('body').textContent();
    if (!bodyText || !/Part stored|parts stored/.test(bodyText)) {
      throw new Error(`${model.name} did not store selected parts.`);
    }

    await page.locator('button[title="Warehouse dashboard"]').click();
    await page.waitForTimeout(500);
    const dashboardBox = await page.locator('.warehouse-dashboard').boundingBox();
    const canvasCountInDashboard = await page.locator('canvas').count();
    if (!dashboardBox || dashboardBox.height < 760 || canvasCountInDashboard !== 0) {
      throw new Error(`${model.name} warehouse dashboard is not a separate full page.`);
    }
    const rackCount = await page.locator('.warehouse-rack').count();
    const classColumnCount = await page.locator('.warehouse-class-column').count();
    if (rackCount < 1 || classColumnCount < 1) {
      throw new Error(`${model.name} warehouse dashboard does not render rack/category/class storage structure.`);
    }
    const warehouseBins = await page.locator('.warehouse-bin').count();
    if (warehouseBins < 2) {
      throw new Error(`${model.name} did not store selected parts in the warehouse.`);
    }
    const warehouseThumbnails = await page.locator('.warehouse-bin img').count();
    if (warehouseThumbnails < 1) {
      throw new Error(`${model.name} warehouse dashboard did not render real part thumbnails.`);
    }
    const projectId = await page.evaluate(() => window.__assetForgeDocument?.metadata?.id);
    await page.getByRole('button', { name: /Save All/ }).click();
    await page.waitForFunction(() => /saved permanently|already saved/.test(document.body.innerText), undefined, { timeout: 120000 });
    const fileWarehouseDir = resolve(fileWarehouseRoot, safeName(projectId));
    const manifestPath = resolve(fileWarehouseDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`${model.name} did not create a physical warehouse manifest at ${manifestPath}.`);
    }
    const physicalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(physicalManifest.items) || physicalManifest.items.length < warehouseBins) {
      throw new Error(`${model.name} physical warehouse manifest does not contain the stored parts.`);
    }
    let physicalWarehouseItems = physicalManifest.items.length;
    for (const entry of physicalManifest.items.slice(0, warehouseBins)) {
      const itemPath = resolve(fileWarehouseDir, entry.fileName);
      if (!String(entry.fileName).toLowerCase().endsWith('.glb')) {
        throw new Error(`${model.name} physical warehouse item is not a real GLB object: ${entry.fileName}.`);
      }
      if (!existsSync(itemPath)) {
        throw new Error(`${model.name} physical warehouse item file is missing: ${itemPath}.`);
      }
      const glbHeader = readFileSync(itemPath).subarray(0, 4).toString('utf8');
      if (glbHeader !== 'glTF') {
        throw new Error(`${model.name} physical warehouse item is not a valid GLB file: ${itemPath}.`);
      }
      if (!String(entry.thumbnailDataUrl ?? '').startsWith('data:image/')) {
        throw new Error(`${model.name} physical warehouse item did not persist a real thumbnail in manifest: ${entry.fileName}.`);
      }
    }
    const savedLedgerItems = await page.locator('.warehouse-storage-ledger span').count();
    if (savedLedgerItems !== physicalWarehouseItems) {
      throw new Error(`${model.name} saved warehouse ledger does not match physical files. Ledger ${savedLedgerItems}, files ${physicalWarehouseItems}.`);
    }
    await page.evaluate(() => {
      const runtimeDocument = window.__assetForgeDocument;
      localStorage.setItem(
        '3d-asset-forge.current-project',
        JSON.stringify({
          schemaVersion: 1,
          metadata: { ...runtimeDocument.metadata, id: 'project_empty_reload_test' },
          nodes: [],
          partWarehouse: [],
          selectedWarehouseItemId: undefined,
        }),
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /Load Saved/ }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes('saved objects loaded from'), undefined, { timeout: 180000 });
    if ((await page.locator('.saved-object-item').count()) < 1) {
      throw new Error(`${model.name} reload fallback did not load saved GLB warehouse objects from an existing project warehouse.`);
    }
    if ((await page.locator('.saved-object-item img').count()) < 1) {
      throw new Error(`${model.name} reload fallback loaded saved objects without real thumbnails.`);
    }
    await page.locator('button[title="Workspace"]').click();
    await page.waitForTimeout(500);
    const beforeWorkspaceSavedImport = await canvasSample(page);
    await page.locator('button[title="Import saved warehouse object to workspace"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Saved object imported'), undefined, { timeout: 180000 });
    await page.waitForTimeout(1400);
    const afterWorkspaceSavedImport = await canvasSample(page);
    const workspaceSavedDiff = sampleDiff(beforeWorkspaceSavedImport, afterWorkspaceSavedImport);
    if (workspaceSavedDiff < 4) {
      throw new Error(`${model.name} saved warehouse object did not import visibly from workspace. Changed samples: ${workspaceSavedDiff}.`);
    }

    await page.locator('button[title="Signal Blue"]').click();
    await page.locator('button[title="Save workspace changes permanently"]').click();
    await page.waitForFunction(() => /saved permanently|already saved/.test(document.body.innerText), undefined, { timeout: 180000 });
    let manifestAfterWorkspaceChangeSave = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifestAfterWorkspaceChangeSave.items) || manifestAfterWorkspaceChangeSave.items.length <= physicalWarehouseItems) {
      throw new Error(`${model.name} did not save the modified workspace color as a physical GLB.`);
    }
    physicalWarehouseItems = manifestAfterWorkspaceChangeSave.items.length;

    await page.locator('button[title="Duplicate selected object"]').click();
    await page.locator('button[title="Save workspace changes permanently"]').click();
    await page.waitForFunction(() => /saved permanently|already saved/.test(document.body.innerText), undefined, { timeout: 180000 });
    manifestAfterWorkspaceChangeSave = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifestAfterWorkspaceChangeSave.items) || manifestAfterWorkspaceChangeSave.items.length <= physicalWarehouseItems) {
      throw new Error(`${model.name} did not save the duplicated workspace object as a new physical GLB.`);
    }
    physicalWarehouseItems = manifestAfterWorkspaceChangeSave.items.length;

    await page.locator('button[title="Save selected object as project warehouse GLB"]').click();
    await page.waitForFunction(() => /saved permanently|already saved/.test(document.body.innerText), undefined, { timeout: 180000 });
    const manifestAfterWorkspaceSave = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifestAfterWorkspaceSave.items) || manifestAfterWorkspaceSave.items.length < physicalWarehouseItems) {
      throw new Error(`${model.name} lost physical warehouse entries after saving the selected workspace object.`);
    }
    const newestWorkspaceFile = manifestAfterWorkspaceSave.items[manifestAfterWorkspaceSave.items.length - 1]?.fileName;
    if (!newestWorkspaceFile || !newestWorkspaceFile.toLowerCase().endsWith('.glb') || !existsSync(resolve(fileWarehouseDir, newestWorkspaceFile))) {
      throw new Error(`${model.name} saved workspace object did not produce a new GLB file.`);
    }
    const deleteManifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8'));
    await page.locator('button[title="Delete selected object permanently"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Workspace object deleted'), undefined, { timeout: 120000 });
    const deleteManifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(deleteManifestAfter.items) || deleteManifestAfter.items.length >= deleteManifestBefore.items.length) {
      throw new Error(`${model.name} permanent workspace delete did not remove the physical warehouse manifest entry.`);
    }
    if (existsSync(resolve(fileWarehouseDir, newestWorkspaceFile))) {
      throw new Error(`${model.name} permanent workspace delete did not remove the physical GLB file.`);
    }
    await page.locator('button[title="Workspace"]').click();
    await page.waitForTimeout(500);
    await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
    await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 120000 });
    await page.locator('button[title="Restore imported model factory state"]').click();
    await page.waitForTimeout(900);
    bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('Factory state restored')) {
      throw new Error(`${model.name} did not restore the imported model factory state.`);
    }

    await page.locator('button[title="Dismantle selected model into warehouse"]').click();
    await page.waitForFunction(() => /Part stored|parts stored/.test(document.body.innerText), undefined, { timeout: 300000 });
    bodyText = await page.locator('body').textContent();
    if (!bodyText || !/Part stored|parts stored/.test(bodyText)) {
      throw new Error(`${model.name} did not dismantle the selected model into the warehouse from the direct button.`);
    }
    const beforeSendToScene = await canvasSample(page);
    await page.locator('button[title="Warehouse dashboard"]').click();
    await page.waitForTimeout(500);
    const dismantledWarehouseBins = await page.locator('.warehouse-bin').count();
    if (dismantledWarehouseBins <= warehouseBins) {
      throw new Error(`${model.name} did not dismantle the selected model into the warehouse from the direct button.`);
    }

    await page.locator('.warehouse-bin').first().click({ button: 'right' });
    await page.waitForTimeout(250);
    bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('Send to scene') || !bodyText?.includes('Delete from warehouse')) {
      throw new Error(`${model.name} did not show the warehouse context menu.`);
    }

    await page.getByRole('button', { name: /Send to scene/ }).click();
    await page.waitForTimeout(1200);
    await page.locator('canvas').waitFor({ timeout: 10000 });
    const afterSendToScene = await canvasSample(page);
    const sendDiff = sampleDiff(beforeSendToScene, afterSendToScene);
    if (sendDiff < 4) {
      throw new Error(`${model.name} sent warehouse item did not visibly appear in the scene. Changed samples: ${sendDiff}.`);
    }
    let sceneItemCount = await page.locator('.scene-item').count();
    if (sceneItemCount < 2) {
      throw new Error(`${model.name} did not send the stored warehouse item to the scene from context menu.`);
    }

    const beforeCopyBins = dismantledWarehouseBins;
    await page.getByRole('button', { name: /Save Copy/ }).click();
    await page.waitForFunction(() => /Warehouse copy created|saved permanently/.test(document.body.innerText), undefined, { timeout: 240000 });
    bodyText = await page.locator('body').textContent();
    if (!bodyText || !/Warehouse copy created|saved permanently/.test(bodyText)) {
      throw new Error(`${model.name} did not report saving the modified scene part as a physical warehouse copy.`);
    }
    await page.locator('button[title="Warehouse dashboard"]').click();
    await page.waitForTimeout(500);
    const afterCopyBins = await page.locator('.warehouse-bin').count();
    if (afterCopyBins <= beforeCopyBins) {
      throw new Error(`${model.name} did not save the modified scene part as a new warehouse copy.`);
    }

    await page.locator('button[title="Save scene imported parts as composite assembly"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Scene assembly stored'), undefined, { timeout: 240000 });
    await page.waitForTimeout(500);
    bodyText = await page.locator('body').textContent();
    if (!bodyText?.includes('Scene assembly stored') || !bodyText?.includes('Assemblies')) {
      throw new Error(`${model.name} did not store the current scene as a composite assembly.`);
    }

    const beforeDeleteBins = await page.locator('.warehouse-bin').count();
    await page.locator('.warehouse-bin').first().click({ button: 'right' });
    await page.getByRole('button', { name: /Delete from warehouse/ }).click();
    await page.waitForTimeout(700);
    const afterDeleteBins = await page.locator('.warehouse-bin').count();
    if (afterDeleteBins >= beforeDeleteBins) {
      throw new Error(`${model.name} did not delete a warehouse item from the context menu.`);
    }

    await page.locator('button[title="Workspace"]').click();
    await page.waitForTimeout(500);
    sceneItemCount = await page.locator('.scene-item').count();
    if (sceneItemCount < 2) {
      throw new Error(`${model.name} scene did not keep the warehouse part after dashboard operations.`);
    }

    await page.waitForTimeout(1200);
    const legacyWarehouseCreated = await page.evaluate(() => window.__assetForgeCreateLegacyWarehouseItem?.() ?? false);
    if (!legacyWarehouseCreated) {
      throw new Error(`${model.name} could not create a legacy warehouse item for fallback visibility testing.`);
    }

    await page.locator('button[title="Warehouse dashboard"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Legacy Pivot'), undefined, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.locator('button[title="Workspace"]').click();
    await page.waitForTimeout(700);
    const beforeLegacySend = await canvasSample(page);
    await page.locator('button[title="Warehouse dashboard"]').click();
    await page.waitForTimeout(500);
    await page.locator('.warehouse-bin').first().click({ button: 'right' });
    await page.getByRole('button', { name: /Send to scene/ }).click();
    await page.waitForTimeout(1500);
    const afterLegacySend = await canvasSample(page);
    const legacySendDiff = sampleDiff(beforeLegacySend, afterLegacySend);
    if (legacySendDiff < 4) {
      throw new Error(`${model.name} legacy warehouse item did not render visibly after send-to-scene. Changed samples: ${legacySendDiff}.`);
    }

    console.log(`${model.name}: separate dashboard, visible send-to-scene, legacy fallback visible, scene items ${sceneItemCount}`);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (serverLogs.length) {
    console.error(serverLogs.join(''));
  }
  throw error;
} finally {
  server.kill();
}
