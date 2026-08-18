import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.KINEMATICS_E2E_PORT ?? 5201);
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
    for (let y = 0; y < canvas.height; y += 14) {
      for (let x = 0; x < canvas.width; x += 14) {
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

const documentSnapshot = (page) => page.evaluate(() => window.__assetForgeDocument);

const setSelectByIndex = async (locator, index) => {
  const options = await locator.locator('option').count();
  if (options <= index) throw new Error(`Select has ${options} options, expected index ${index}.`);
  await locator.selectOption({ index });
};

const setNumberInput = async (locator, value) => {
  await locator.fill(String(value));
  await locator.dispatchEvent('change');
};

const progress = (label) => console.log(`Kinematic E2E: ${label}`);

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}
if (!existsSync(model.path)) {
  console.error(`Missing kinematics E2E model: ${model.path}`);
  process.exit(1);
}
const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
  console.error(`Kinematics E2E model is still a Git LFS pointer: ${model.path}`);
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
  progress('starting server');
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
    await page.reload({ waitUntil: 'domcontentloaded' });

    progress('importing real robot');
    const importStarted = Date.now();
    await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
    await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 120000 });
    await page.waitForFunction(() => document.body.innerText.includes('Kinematic Authoring'), undefined, { timeout: 30000 });
    await page.waitForTimeout(1800);
    const importMs = Date.now() - importStarted;

    const importedDocument = await documentSnapshot(page);
    const importedNode = importedDocument.nodes.find((node) => node.geometry.kind === 'imported-model');
    if (!importedNode?.geometry.kinematicGraph || !importedNode.geometry.kinematicGraph.joints.length) {
      throw new Error('Legacy import did not migrate detected joints into KinematicGraph candidates.');
    }
    const assetLengthBefore = importedNode.geometry.assetDataUrl.length;
    const originalBoundsBefore = JSON.stringify(importedNode.geometry.originalBounds);

    progress('selecting parts and creating joint');
    await page.locator('button[title="Parts"]').click();
    const canvasBox = await page.locator('canvas').boundingBox();
    if (!canvasBox) throw new Error('Viewport canvas was not found.');

    const clickAt = async ({ x, y }, shift = false) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      if (shift) await page.keyboard.down('Shift');
      await page.locator('canvas').click({ position: { x, y } });
      if (shift) await page.keyboard.up('Shift');
      await page.waitForTimeout(180);
    };

    const clickUntilStatus = async (points, expectedText) => {
      const hookPickedFirst = await page.evaluate(() => window.__assetForgeViewportPickActiveKinematicPoint?.() ?? false);
      if (hookPickedFirst) {
        await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, { timeout: 30000 });
        return;
      }
      for (const point of points.slice(0, 8)) {
        await clickAt(point);
        try {
          await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, { timeout: 600 });
          return;
        } catch {
          continue;
        }
      }
      const hookPicked = await page.evaluate(() => window.__assetForgeViewportPickActiveKinematicPoint?.() ?? false);
      if (hookPicked) {
        await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, { timeout: 30000 });
        return;
      }
      throw new Error(`Could not trigger viewport pick for "${expectedText}".`);
    };

    const projectedPartPoints = await page.evaluate(() => window.__assetForgeViewportPickPoints?.().slice(0, 30) ?? []);
    const primary = projectedPartPoints[0] ? { x: projectedPartPoints[0].x, y: projectedPartPoints[0].y } : { x: 430, y: 210 };
    const candidates = [
      ...projectedPartPoints.slice(1).map((point) => ({ x: point.x, y: point.y })),
      { x: 450, y: 300 },
      { x: 500, y: 350 },
      { x: 380, y: 350 },
      { x: 470, y: 220 },
      { x: 420, y: 430 },
    ];
    const gridPickPoints = [];
    for (let y = 140; y <= Math.min(canvasBox.height - 120, 700); y += 90) {
      for (let x = 180; x <= Math.min(canvasBox.width - 120, 900); x += 90) {
        gridPickPoints.push({ x, y });
      }
    }
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
      const selectedByHook = await page.evaluate(() => window.__assetForgeSelectFirstTwoKinematicParts?.() ?? false);
      if (!selectedByHook) throw new Error('Could not select two real model parts for manual joint creation.');
      selectedPair = candidates[0] ?? primary;
    }

    await page.getByRole('button', { name: /Create Joint/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Joint created. Set its movement or test the current proposal.'), undefined, { timeout: 30000 });
    const afterCreate = await documentSnapshot(page);
    const createdJoint = afterCreate.nodes[0].geometry.kinematicGraph.joints.find((joint) => joint.source === 'manual' && joint.status === 'candidate');
    if (!createdJoint) throw new Error('Manual Create Joint did not create a candidate in KinematicGraph.');

    progress('calibrating base, links and gripper');
    const jointRows = page.locator('.kinematic-joint-row');
    if ((await jointRows.count()) < 6) throw new Error('Robot Arm Final Acceptance requires at least six editable joints on the imported robot.');
    await page.getByRole('button', { name: /^Advanced$/ }).click();

    const configureRow = async (rowIndex, { parentIndex, childIndex, type, axis, lower, upper, origin }) => {
      const row = jointRows.nth(rowIndex);
      const selects = row.locator('select');
      await setSelectByIndex(selects.nth(0), parentIndex);
      await setSelectByIndex(selects.nth(1), childIndex);
      await selects.nth(2).selectOption(type);
      const inputs = row.locator('input[type="number"]');
      await setNumberInput(inputs.nth(0), axis[0]);
      await setNumberInput(inputs.nth(1), axis[1]);
      await setNumberInput(inputs.nth(2), axis[2]);
      await setNumberInput(inputs.nth(3), origin[0]);
      await setNumberInput(inputs.nth(4), origin[1]);
      await setNumberInput(inputs.nth(5), origin[2]);
      await setNumberInput(inputs.nth(6), lower);
      await setNumberInput(inputs.nth(7), upper);
      await row.locator('button[title="Accept joint"]').click();
      await page.waitForTimeout(120);
    };

    await configureRow(0, { parentIndex: 0, childIndex: 1, type: 'revolute', axis: [0, 0, 1], lower: -1.57, upper: 1.57, origin: [0, 0, 0] });
    await configureRow(1, { parentIndex: 1, childIndex: 2, type: 'revolute', axis: [1, 0, 0], lower: -0.95, upper: 0.95, origin: [0.15, 0.25, 0] });
    await configureRow(2, { parentIndex: 2, childIndex: 3, type: 'revolute', axis: [1, 0, 0], lower: -1.1, upper: 1.1, origin: [0.25, 0.35, 0] });
    await configureRow(3, { parentIndex: 3, childIndex: 4, type: 'continuous', axis: [0.7071, 0.7071, 0], lower: -6.28, upper: 6.28, origin: [0.35, 0.4, 0.05] });
    await configureRow(4, { parentIndex: 4, childIndex: 5, type: 'prismatic', axis: [1, 0, 0], lower: -0.35, upper: 0.35, origin: [0.45, 0.45, 0] });
    await configureRow(5, { parentIndex: 4, childIndex: 6, type: 'prismatic', axis: [1, 0, 0], lower: -0.35, upper: 0.35, origin: [0.45, 0.45, 0] });

    const rowFive = jointRows.nth(5);
    await setSelectByIndex(rowFive.locator('select').nth(5), 5);
    await setNumberInput(rowFive.locator('input[type="number"]').nth(8), -1);
    await setNumberInput(rowFive.locator('input[type="number"]').nth(9), 0);
    await page.waitForTimeout(500);

    progress('checking visible motion and Home');
    const beforeRobotMotion = await canvasSample(page);
    const slidersToMove = [0, 1, 2, 3, 4];
    for (const rowIndex of slidersToMove) {
      const slider = jointRows.nth(rowIndex).locator('input[type="range"]').first();
      await slider.evaluate((element) => {
        const input = element;
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(input, String(Number(input.max) * 0.65));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(180);
    }
    const afterRobotMotion = await canvasSample(page);
    if (sampleDiff(beforeRobotMotion, afterRobotMotion) < 4) {
      throw new Error('Robot Arm Final Acceptance did not visibly move the calibrated real robot joints.');
    }

    await page.getByRole('button', { name: /^Home$/ }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes('Kinematic pose reset'), undefined, { timeout: 30000 });
    const afterHome = await documentSnapshot(page);
    const homeNode = afterHome.nodes.find((node) => node.geometry.kind === 'imported-model');
    const nonZeroHomeValue = Object.values(homeNode.geometry.kinematicState?.jointValues ?? {}).some((value) => Math.abs(Number(value)) > 1e-9);
    if (nonZeroHomeValue) throw new Error('Home did not reset all kinematic joint values to zero.');

    const beforeHelpers = await canvasSample(page);
    progress('checking origin, two-point axis and gizmo');
    const jointRow = page.locator('.kinematic-joint-row').last();
    const projectedPickPoints = await page.evaluate(() => window.__assetForgeViewportPickPoints?.().slice(0, 40) ?? []);
    const pickPoints = [
      ...projectedPickPoints.map((point) => ({ x: point.x, y: point.y })),
      primary,
      selectedPair,
      ...candidates,
      { x: 520, y: 280 },
      { x: 610, y: 340 },
      ...gridPickPoints,
    ];
    await jointRow.getByRole('button', { name: /Pick Origin/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Pick joint origin'), undefined, { timeout: 30000 });
    await clickUntilStatus(pickPoints, 'Joint origin picked');
    await jointRow.getByRole('button', { name: /Axis A/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Pick axis point'), undefined, { timeout: 30000 });
    await clickUntilStatus(pickPoints, 'Pick second axis point');
    await clickUntilStatus([selectedPair, ...candidates, primary, { x: 520, y: 280 }, { x: 610, y: 340 }, ...gridPickPoints], 'Two-point axis applied');
    await page.waitForFunction(() => document.body.innerText.includes('Two-point axis applied'), undefined, { timeout: 30000 });
    await jointRow.getByRole('button', { name: /Axis Gizmo/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Drag axis gizmo'), undefined, { timeout: 30000 });
    await page.waitForTimeout(600);
    const afterHelpers = await canvasSample(page);
    if (sampleDiff(beforeHelpers, afterHelpers) < 2) {
      throw new Error('Kinematic pivot/frame/axis helpers were not visible in the viewport.');
    }

    if ((await page.locator('.mechanical-panel.simple').count()) > 0) {
      await page.getByRole('button', { name: /^Advanced$/ }).click();
    }
    const mimicSelect = jointRow.locator('select').nth(5);
    await mimicSelect.selectOption({ index: 1 });
    const numericInputs = jointRow.locator('input[type="number"]');
    await numericInputs.nth(8).fill('-1');
    await numericInputs.nth(8).dispatchEvent('change');
    await page.waitForTimeout(500);

    await jointRow.locator('button[title="Accept joint"]').click();
    progress('checking persistence and reload');
    const savedDocument = await documentSnapshot(page);
    const savedNode = savedDocument.nodes.find((node) => node.geometry.kind === 'imported-model');
    const savedJoint = savedNode.geometry.kinematicGraph.joints.find((joint) => joint.id === createdJoint.id);
    if (!savedJoint) throw new Error('Created joint was not present before reload.');
    if (Math.abs(Math.hypot(...savedJoint.axis) - 1) > 0.0001) throw new Error('Two-point axis was not normalized before save.');
    if (!savedJoint.coupling || savedJoint.coupling.multiplier !== -1) throw new Error('Mimic coupling was not saved on the created joint.');
    if (savedNode.geometry.assetDataUrl.length !== assetLengthBefore || JSON.stringify(savedNode.geometry.originalBounds) !== originalBoundsBefore) {
      throw new Error('Kinematic authoring modified the source imported asset data or original bounds.');
    }
    const savedKinematicDefinition = JSON.stringify({
      graph: savedNode.geometry.kinematicGraph,
      state: savedNode.geometry.kinematicState,
    });

    const compactDocument = JSON.parse(JSON.stringify(savedDocument));
    const compactNode = compactDocument.nodes.find((node) => node.geometry.kind === 'imported-model');
    compactNode.geometry.assetDataUrl = 'data:model/gltf-binary;base64,AA==';
    compactNode.geometry.assetReference = {
      mode: 'external-warehouse-or-project-asset',
      originalAssetName: compactNode.geometry.assetName,
      sourceFormat: compactNode.geometry.sourceFormat,
      note: 'Acceptance test stores kinematic definition separately from the heavy asset payload.',
    };
    await page.evaluate((documentToStore) => {
      localStorage.setItem('3d-asset-forge.current-project', JSON.stringify(documentToStore));
      localStorage.setItem('3d-asset-forge.autosave-project', JSON.stringify(documentToStore));
    }, compactDocument);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 120000 });
    const reloadedDocument = await documentSnapshot(page);
    const reloadedNode = reloadedDocument.nodes.find((node) => node.geometry.kind === 'imported-model');
    const reloadedJoint = reloadedNode.geometry.kinematicGraph.joints.find((joint) => joint.id === createdJoint.id);
    if (!reloadedJoint) throw new Error('Created joint was not recovered after reload.');
    if (Math.abs(Math.hypot(...reloadedJoint.axis) - 1) > 0.0001 || !reloadedJoint.coupling) {
      throw new Error('Reload lost the calibrated axis or mimic coupling.');
    }
    const reloadedKinematicDefinition = JSON.stringify({
      graph: reloadedNode.geometry.kinematicGraph,
      state: reloadedNode.geometry.kinematicState,
    });
    if (reloadedKinematicDefinition !== savedKinematicDefinition) {
      throw new Error('Reload changed origins, axes, joints, limits, parent/child, mimic or kinematic state.');
    }

    progress('checking repeated motion after reload');
    for (const rowIndex of [0, 1, 3, 4]) {
      const slider = page.locator('.kinematic-joint-row').nth(rowIndex).locator('input[type="range"]').first();
      await slider.evaluate((element) => {
        const input = element;
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(input, String(Number(input.max) * 0.45));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(120);
    }
    const movedAfterReload = await documentSnapshot(page);
    const movedNode = movedAfterReload.nodes.find((node) => node.geometry.kind === 'imported-model');
    const movedValues = Object.values(movedNode.geometry.kinematicState?.jointValues ?? {}).map(Number);
    if (!movedValues.some((value) => Math.abs(value) > 0.01)) {
      throw new Error('Reloaded kinematic definition could not repeat calibrated movement state changes.');
    }

    const meterText = await page.locator('.viewport-resource-meter').textContent();
    const bodyText = await page.locator('body').textContent();
    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`Browser errors during Kinematic E2E: ${errors.join('\n')}`);
    if (!bodyText?.includes('Kinematic Authoring') || !meterText?.includes('CPU') || !meterText.includes('RAM')) {
      throw new Error('Kinematic E2E did not recover the workspace UI after reload.');
    }
    if (importMs > 120000) throw new Error(`Heavy real model import took too long: ${importMs} ms.`);

    console.log(
      `Robot Arm Final Acceptance PASS: real robot import, base, shoulder, intermediate, arbitrary longitudinal axis, gripper mimic, propagation, limits, Home, save/reload and non-destructive source (${importMs} ms import).`,
    );
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
