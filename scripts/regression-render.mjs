import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.RENDER_TEST_PORT ?? 5197);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');

const models = [
  {
    name: 'Audi R8 FBX',
    path: resolve('3d imported models', 'gw4c6lw7or28-AudiR8', 'Audi R8', 'Models', 'Audi R8.fbx'),
    expectedText: 'Audi R8.fbx',
  },
  {
    name: 'Audi R8 DAE',
    path: resolve('3d imported models', 'gw4c6lw7or28-AudiR8', 'Audi R8', 'Models', 'Audi R8.dae'),
    expectedText: 'Audi R8.dae',
  },
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

const countVisiblePixels = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return 0;

    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let visiblePixels = 0;
    for (let y = 0; y < canvas.height; y += 8) {
      for (let x = 0; x < canvas.width; x += 8) {
        const index = (y * canvas.width + x) * 4;
        const diff = Math.abs(pixels[index] - 32) + Math.abs(pixels[index + 1] - 35) + Math.abs(pixels[index + 2] - 38);
        if (diff > 45) visiblePixels += 1;
      }
    }
    return visiblePixels;
  });

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}

for (const model of models) {
  if (!existsSync(model.path)) {
    console.error(`Missing regression model: ${model.path}`);
    process.exit(1);
  }
  const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
  if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
    console.error(`Regression model is still a Git LFS pointer: ${model.path}`);
    process.exit(1);
  }
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
      await page.waitForTimeout(1800);

      const visiblePixels = await countVisiblePixels(page);
      const bodyText = await page.locator('body').textContent();
      const sceneItemCount = await page.locator('.scene-item').count();
      const graphText = await page.locator('.kinematic-graph-panel').textContent().catch(() => '');
      const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));

      if (errors.length) {
        throw new Error(`${model.name} produced browser errors: ${errors.join('\\n')}`);
      }

      if (!bodyText?.includes(model.expectedText)) {
        throw new Error(`${model.name} did not appear in the scene tree.`);
      }

      if (bodyText.includes('Game Box') || sceneItemCount !== 1) {
        throw new Error(`${model.name} import should replace the untouched starter placeholder.`);
      }

      if (!graphText.includes('Kinematic Graph')) {
        throw new Error(`${model.name} did not render the non-destructive Kinematic Graph panel.`);
      }

      if (visiblePixels < 350) {
        throw new Error(`${model.name} render appears blank or severely occluded; visible pixel score ${visiblePixels}.`);
      }

      console.log(`${model.name}: visible pixel score ${visiblePixels}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
