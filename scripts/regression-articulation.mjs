import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.ARTICULATION_TEST_PORT ?? 5198);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');

const allModels = [
  {
    name: 'iRobot OBJ',
    path: resolve('3d imported models', 'o1j4e9phg8w0-iRobot', 'OBJ_Robot.obj'),
    expectedText: 'OBJ_Robot.obj',
  },
  {
    name: 'Rmk3 OBJ',
    path: resolve('3d imported models', 'sk095yah4v7k-ModelRmk3', 'Rmk3.obj'),
    expectedText: 'Rmk3.obj',
  },
  {
    name: 'IRAmk4 3DS',
    path: resolve('3d imported models', 'nt2c2mxl0kqo-IRAmk4v3', 'IRAmk4.3ds'),
    expectedText: 'IRAmk4.3ds',
  },
];

const modelFilter = process.env.ARTICULATION_MODEL_FILTER?.toLowerCase();
const models = modelFilter ? allModels.filter((model) => model.name.toLowerCase().includes(modelFilter)) : allModels;

if (!models.length) {
  throw new Error(`No articulation models match filter: ${process.env.ARTICULATION_MODEL_FILTER}`);
}

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
  let total = 0;
  for (let index = 0; index < count; index += 3) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    total += diff;
    if (diff > 26) changed += 1;
  }
  return { changed, total };
};

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

try {
  if (!existsSync(viteBin)) {
    throw new Error('Vite is not installed. Run npm.cmd install first.');
  }

  for (const model of models) {
    if (!existsSync(model.path)) throw new Error(`Missing articulation model: ${model.path}`);
    const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
    if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(`Articulation model is still a Git LFS pointer: ${model.path}`);
    }
  }

  await waitForServer(`http://127.0.0.1:${port}`);

  const browser = await chromium.launch({ headless: true });
  try {
    for (const model of models) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const page = await context.newPage();
      const logs = [];
      page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
      await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 120000 });
      await page.waitForFunction(() => document.querySelectorAll('.joint-row').length > 0, { timeout: 15000 });
      await page.waitForTimeout(1800);

      const jointRows = await page.locator('.joint-row').count();
      if (!jointRows) {
        const importedSummary = await page.locator('.imported-summary').textContent().catch(() => '');
        const graphSummary = await page.locator('.kinematic-graph-panel').textContent().catch(() => '');
        const bodyText = await page.locator('body').textContent().catch(() => '');
        const jointClasses = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[class]'))
            .map((element) => String(element.getAttribute('class')))
            .filter((className) => className.includes('joint') || className.includes('motion'))
            .slice(0, 80),
        );
        throw new Error(
          `${model.name} imported without detected articulation controls. Summary: ${importedSummary || 'n/a'} Graph: ${
            graphSummary || 'n/a'
          } Classes: ${jointClasses.join(', ') || 'n/a'} Body: ${(bodyText || '').slice(0, 500)}`,
        );
      }

      const beforeDemo = await canvasSample(page);
      await page.locator('.smart-motion-button').click();
      await page.waitForTimeout(1800);
      const duringDemo = await canvasSample(page);
      const demoDiff = sampleDiff(beforeDemo, duringDemo);
      await page.locator('.smart-motion-button').click();

      if (demoDiff.changed < 4) {
        throw new Error(`${model.name} Smart Demo did not move visible geometry. Changed samples: ${demoDiff.changed}.`);
      }

      const beforeManual = await canvasSample(page);
      const firstSlider = page.locator('.joint-row input[type=range]').first();
      await firstSlider.evaluate((element) => {
        const input = element;
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(input, input.max);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(900);
      const afterManual = await canvasSample(page);
      const manualDiff = sampleDiff(beforeManual, afterManual);
      const bodyText = await page.locator('body').textContent();

      if (!bodyText?.includes(model.expectedText)) {
        throw new Error(`${model.name} disappeared from the UI after manual articulation.`);
      }

      if (manualDiff.changed < 2) {
        throw new Error(`${model.name} manual articulation did not move visible geometry. Changed samples: ${manualDiff.changed}.`);
      }

      const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
      if (errors.length) throw new Error(`${model.name} produced browser errors: ${errors.join('\n')}`);

      console.log(`${model.name}: joints ${jointRows}, demo samples ${demoDiff.changed}, manual samples ${manualDiff.changed}`);
      await context.close();
    }
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
