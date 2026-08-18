import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.PIECE_MODE_PORT ?? 5212);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const modelPath = resolve('3d imported models', 'sk095yah4v7k-ModelRmk3', 'Rmk3.obj');
const captureDir = process.env.PIECE_MODE_CAPTURE_DIR ? resolve(process.env.PIECE_MODE_CAPTURE_DIR) : undefined;

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

const rightClickActiveJoint = async (page) => {
  const point = await page.evaluate(() => window.__assetForgeViewportActiveJointPoint?.());
  if (!point) throw new Error('No active joint point available for viewport context menu.');
  await page.locator('canvas').click({ button: 'right', position: { x: Math.max(4, point.x), y: Math.max(4, point.y) } });
};

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}

if (!existsSync(modelPath)) {
  console.error(`Missing piece mode test model: ${modelPath}`);
  process.exit(1);
}

if (captureDir) mkdirSync(captureDir, { recursive: true });

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page = await context.newPage();
    const browserLogs = [];
    page.on('console', (message) => browserLogs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => browserLogs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.locator('input[accept*=".3ds"]').setInputFiles(modelPath);
    await page.waitForFunction(() => document.body.innerText.includes('Mechanical Setup'), undefined, { timeout: 120000 });
    await page.getByRole('button', { name: /Analyze Mechanics/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Joint candidates'), undefined, { timeout: 30000 });

    let rows = page.locator('.kinematic-joint-row');
    if ((await rows.count()) === 0) throw new Error('Piece mode failed: analyzed model has no visible joint rows.');
    await rows.first().getByRole('button', { name: /Show Joint/ }).click();
    await page.waitForFunction(() => window.__assetForgeViewportActiveJointPoint?.(), undefined, { timeout: 30000 });
    await rightClickActiveJoint(page);
    await page.waitForSelector('.viewport-context-menu.joint-menu', { timeout: 30000 });
    const jointMenuText = await page.locator('.viewport-context-menu').textContent();
    if (!jointMenuText?.includes('Analyze piece')) throw new Error('Piece mode failed: joint menu does not expose Analyze piece.');

    await page.getByRole('button', { name: /Analyze piece/ }).click();
    await page.waitForFunction(
      () => window.__assetForgeDocument?.nodes.length === 1 && window.__assetForgeDocument.nodes[0]?.geometry?.isIsolatedFunctionalComponent === true,
      undefined,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () => {
        const reference = window.__assetForgeDocument?.nodes[0]?.geometry?.pieceReferenceCenter;
        return Boolean(reference && reference.triangleCount > 0 && reference.position.every(Number.isFinite));
      },
      undefined,
      { timeout: 30000 },
    );
    const automaticReference = await page.evaluate(() => window.__assetForgeDocument?.nodes[0]?.geometry?.pieceReferenceCenter);
    if (!['volume-centroid', 'surface-centroid', 'bounds-center'].includes(automaticReference?.method)) {
      throw new Error(`Piece mode failed: unexpected automatic reference method ${automaticReference?.method}.`);
    }
    if (captureDir) await page.locator('.viewport').screenshot({ path: resolve(captureDir, 'piece-reference-center.png') });
    await page.getByRole('button', { name: /Correct reference center/ }).click();
    const pickedReference = await page.evaluate(() => window.__assetForgeViewportPickActiveKinematicPoint?.());
    if (!pickedReference) throw new Error('Piece mode failed: could not pick a manual reference center.');
    await page.waitForFunction(
      () => window.__assetForgeDocument?.nodes[0]?.geometry?.pieceReferenceCenter?.method === 'manual',
      undefined,
      { timeout: 30000 },
    );
    const manualReferenceMatchesJoint = await page.evaluate(() => {
      const geometry = window.__assetForgeDocument?.nodes[0]?.geometry;
      const joint = geometry?.kinematicGraph?.joints?.[0];
      return Boolean(joint && geometry?.pieceReferenceCenter?.position.every((value, index) => Math.abs(value - joint.origin.position[index]) < 0.000001));
    });
    if (!manualReferenceMatchesJoint) throw new Error('Piece mode failed: manual reference center and joint pivot diverged.');
    await page.waitForFunction(() => window.__assetForgeViewportActiveJointPoint?.(), undefined, { timeout: 30000 });

    await page.getByRole('button', { name: /Dynamic piece/ }).click();
    await page.getByRole('button', { name: /One end/ }).click();
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes[0]?.geometry?.kinematicGraph?.joints?.[0]?.type === 'revolute', undefined, { timeout: 30000 });
    await page.getByRole('button', { name: 'Wrong axis', exact: true }).click();
    await page.getByRole('button', { name: 'Set Z', exact: true }).click();
    await page.getByRole('button', { name: 'Test Again', exact: true }).click();
    await page.waitForFunction(() => {
      const geometry = window.__assetForgeDocument?.nodes[0]?.geometry;
      const joint = geometry?.kinematicGraph?.joints?.[0];
      const value = joint ? geometry?.kinematicState?.jointValues?.[joint.id] ?? 0 : 0;
      return joint?.type === 'revolute' && joint.axis?.[2] === 1 && Math.abs(value) > 0.001;
    }, undefined, { timeout: 30000 });
    if (captureDir) await page.locator('.viewport').screenshot({ path: resolve(captureDir, 'piece-rotation-test.png') });
    await rightClickActiveJoint(page);
    await page.waitForSelector('.viewport-context-menu', { timeout: 30000 });
    const pieceMenuText = await page.locator('.viewport-context-menu').textContent();
    if (!pieceMenuText?.includes('Correct Movement') || !pieceMenuText.includes('Exit piece mode')) {
      throw new Error('Piece mode failed: isolated piece menu does not expose correction and exit actions.');
    }

    await page.getByRole('button', { name: /Exit piece mode/ }).click();
    await page.waitForSelector('.viewport-context-menu', { state: 'detached', timeout: 30000 });
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes.some((item) => item.geometry.kind === 'imported-model'), undefined, { timeout: 30000 });
    const storedReference = await page.evaluate(() =>
      window.__assetForgeDocument?.partWarehouse?.some((item) => item.itemType === 'part' && item.geometry?.pieceReferenceCenter?.method === 'manual'),
    );
    if (!storedReference) throw new Error('Piece mode failed: reference center was not persisted with the stored component.');
    rows = page.locator('.kinematic-joint-row');
    if ((await rows.count()) === 0) throw new Error('Piece mode failed: exiting isolated mode did not restore the analyzed model.');
    await rows.first().getByRole('button', { name: /Show Joint/ }).click();
    await page.waitForFunction(() => window.__assetForgeViewportActiveJointPoint?.(), undefined, { timeout: 30000 });

    const errors = browserLogs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`Browser errors during piece mode test: ${errors.join('\n')}`);
    console.log('Piece mode E2E PASS: calculated and manual reference center, joint alignment, persistence, exit and restored joint inspection.');
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (serverLogs.length) console.error(serverLogs.join(''));
  throw error;
} finally {
  server.kill();
}
