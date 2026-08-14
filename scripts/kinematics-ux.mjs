import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.KINEMATICS_UX_PORT ?? 5202);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const modelPath = resolve('3d imported models', 'sk095yah4v7k-ModelRmk3', 'Rmk3.obj');

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

const documentSnapshot = (page) => page.evaluate(() => window.__assetForgeDocument);

const nonZeroJointValueCount = async (page) => {
  const snapshot = await documentSnapshot(page);
  const node = snapshot.nodes.find((item) => item.geometry.kind === 'imported-model');
  return Object.values(node?.geometry.kinematicState?.jointValues ?? {}).filter((value) => Math.abs(Number(value)) > 0.0001).length;
};

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}

if (!existsSync(modelPath)) {
  console.error(`Missing UX test model: ${modelPath}`);
  process.exit(1);
}

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
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.locator('input[accept*=".3ds"]').setInputFiles(modelPath);
    await page.waitForFunction(() => document.body.innerText.includes('Mechanical Setup'), undefined, { timeout: 120000 });

    await page.getByRole('button', { name: /Analyze Mechanics/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Joint candidates'), undefined, { timeout: 30000 });
    const jointRows = page.locator('.kinematic-joint-row');
    if ((await jointRows.count()) === 0) throw new Error('UX01 failed: Analyze Mechanics did not expose a visible joint list.');

    const firstRow = jointRows.first();
    await firstRow.getByRole('button', { name: /Show Joint/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Showing joint in viewport'), undefined, { timeout: 30000 });
    if (!(await page.locator('canvas').isVisible())) throw new Error('UX02 failed: viewport is not visible after Show Joint.');

    const slider = firstRow.locator('input[type="range"]').first();
    await slider.evaluate((element) => {
      const input = element;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, String(Number(input.max) * 0.45));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if ((await nonZeroJointValueCount(page)) < 1) throw new Error('UX03 failed: Test Joint slider did not move a joint.');
    await page.getByRole('button', { name: /Home/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Kinematic pose reset'), undefined, { timeout: 30000 });
    if ((await nonZeroJointValueCount(page)) !== 0) throw new Error('UX03 failed: Home did not return the joint to zero.');

    await page.getByRole('button', { name: /Test All Joints/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Testing 1/'), undefined, { timeout: 30000 });
    await page.waitForFunction(() => {
      const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry.kind === 'imported-model');
      return Object.values(node?.geometry.kinematicState?.jointValues ?? {}).some((value) => Math.abs(Number(value)) > 0.0001);
    }, undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Stop$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Inspection stopped'), undefined, { timeout: 30000 });
    if ((await nonZeroJointValueCount(page)) !== 0) throw new Error('UX05 failed: Stop did not leave the kinematic state at Home.');

    await firstRow.getByRole('button', { name: /Movement incorrect/ }).click();
    await page.getByRole('button', { name: /Wrong axis/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Drag axis gizmo'), undefined, { timeout: 30000 });
    if (!((await page.locator('[title*="Axis Gizmo"]').count()) > 0)) throw new Error('UX06 failed: wrong-axis repair did not expose Axis Gizmo.');

    await page.getByRole('button', { name: /Wrong pivot/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Pick joint origin'), undefined, { timeout: 30000 });
    if (!((await page.locator('[title*="Pick Origin"]').count()) > 0)) throw new Error('UX07 failed: wrong-pivot repair did not expose Pick Origin.');

    const summaryText = await page.locator('.mechanical-summary').textContent();
    if (!summaryText?.includes('Parts') || !summaryText.includes('Validated joints') || !summaryText.includes('Graph')) {
      throw new Error('UX08 failed: Mechanical Summary is incomplete.');
    }

    const requiredTooltips = [
      'Analyze Mechanics',
      'Test All Joints',
      'Home returns',
      'Validate checks',
      'Save stores',
      'Pick Origin',
      'Axis Gizmo',
      'Two-Point Axis',
      'Revolute means',
      'Prismatic means',
      'Parent is',
      'Child is',
      'Mimic links',
    ];
    for (const tooltip of requiredTooltips) {
      if ((await page.locator(`[title*="${tooltip}"]`).count()) === 0) throw new Error(`UX09 failed: missing tooltip containing "${tooltip}".`);
    }

    await firstRow.getByRole('button', { name: /Movement correct/ }).click();
    await page.getByRole('button', { name: /^Save$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Mechanical setup saved'), undefined, { timeout: 30000 });
    const savedSnapshot = await documentSnapshot(page);
    const savedNode = savedSnapshot.nodes.find((item) => item.geometry.kind === 'imported-model');
    const savedGraph = JSON.stringify(savedNode.geometry.kinematicGraph);
    const compactDocument = JSON.parse(JSON.stringify(savedSnapshot));
    const compactNode = compactDocument.nodes.find((item) => item.geometry.kind === 'imported-model');
    compactNode.geometry.assetDataUrl = 'data:model/gltf-binary;base64,AA==';
    compactNode.geometry.assetReference = {
      mode: 'external-warehouse-or-project-asset',
      originalAssetName: compactNode.geometry.assetName,
      sourceFormat: compactNode.geometry.sourceFormat,
      note: 'UX test stores kinematic configuration separately from the heavy asset payload.',
    };
    await page.evaluate((documentToStore) => {
      localStorage.setItem('3d-asset-forge.current-project', JSON.stringify(documentToStore));
      localStorage.setItem('3d-asset-forge.autosave-project', JSON.stringify(documentToStore));
    }, compactDocument);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Mechanical Setup'), undefined, { timeout: 120000 });
    const reloadedSnapshot = await documentSnapshot(page);
    const reloadedNode = reloadedSnapshot.nodes.find((item) => item.geometry.kind === 'imported-model');
    if (JSON.stringify(reloadedNode.geometry.kinematicGraph) !== savedGraph) {
      throw new Error('UX10 failed: reload did not preserve inspected kinematic configuration.');
    }

    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`Browser errors during kinematics UX test: ${errors.join('\n')}`);
    console.log('Kinematics UX01-UX10 PASS: guided setup, visual joint review, safe tests, repair routing, tooltips and reload persistence.');
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
