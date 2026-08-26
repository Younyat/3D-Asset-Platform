import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeGif } from './gif-encoder.mjs';

const root = resolve('.');
const port = Number(process.env.ROBOT_ARM_GIF_PORT ?? 5221);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const modelPath = resolve(
  process.env.ROBOT_ARM_MODEL_PATH ??
    '3d imported models/nuewrobot/brazo-robot-industrial/brazo-robot-industrial.obj',
);
const outputPath = resolve(process.env.ROBOT_ARM_GIF_OUTPUT ?? 'docs/readme-assets/robot-arm-full-motion.gif');

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

const captureCanvasFrame = (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL context unavailable for GIF capture.');
    const width = 640;
    const height = Math.max(1, Math.round((canvas.height / canvas.width) * width));
    const source = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const frame = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(canvas.height - 1, canvas.height - 1 - Math.floor((y / height) * canvas.height));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(canvas.width - 1, Math.floor((x / width) * canvas.width));
        const sourceOffset = (sourceY * canvas.width + sourceX) * 4;
        const targetOffset = (y * width + x) * 4;
        frame[targetOffset] = source[sourceOffset];
        frame[targetOffset + 1] = source[sourceOffset + 1];
        frame[targetOffset + 2] = source[sourceOffset + 2];
        frame[targetOffset + 3] = 255;
      }
    }
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < frame.length; index += chunkSize) binary += String.fromCharCode(...frame.subarray(index, index + chunkSize));
    return { width, height, pixels: btoa(binary) };
  });

const changedPixelSamples = (a, b) => {
  const count = Math.min(a.length, b.length);
  let changed = 0;
  for (let index = 0; index < count; index += 24) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 24) changed += 1;
  }
  return changed;
};

if (!existsSync(viteBin)) throw new Error('Vite is not installed. Run npm.cmd install first.');
if (!existsSync(modelPath)) throw new Error(`Robot arm model not found: ${modelPath}`);

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
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('input[accept*=".3ds"]').setInputFiles(modelPath);
    await page.waitForFunction(() => document.body.innerText.includes('7 joints') && document.body.innerText.includes('3 animations'), undefined, {
      timeout: 120000,
    });
    await page.waitForFunction(() => window.__assetForgeViewportPrepareCapture?.(), undefined, { timeout: 30000 });
    await page.waitForFunction(() => window.__assetForgeViewportSetCamera?.({ position: [8.2, 3.35, -7.35], target: [-0.18, 1.02, -0.08] }), undefined, {
      timeout: 30000,
    });
    await page.waitForTimeout(900);

    const frames = [await captureCanvasFrame(page)];
    await page.getByRole('button', { name: /Auto brazo completo/ }).click();
    for (let index = 0; index < 16; index += 1) {
      await page.waitForTimeout(650);
      frames.push(await captureCanvasFrame(page));
    }

    const decoded = frames.map((frame) => ({ width: frame.width, height: frame.height, pixels: Buffer.from(frame.pixels, 'base64') }));
    const maxChanged = decoded.slice(1).reduce((best, frame) => Math.max(best, changedPixelSamples(decoded[0].pixels, frame.pixels)), 0);
    if (maxChanged < 80) throw new Error(`Captured robot motion is not visibly different (${maxChanged} changed samples).`);

    const gif = encodeGif({ width: decoded[0].width, height: decoded[0].height, frames: decoded, delayCentiseconds: 55 });
    const gifDimensions = await page.evaluate(
      (source) =>
        new Promise((resolveImage, rejectImage) => {
          const image = new Image();
          image.onload = () => resolveImage([image.naturalWidth, image.naturalHeight]);
          image.onerror = () => rejectImage(new Error('Generated GIF could not be decoded by Chromium.'));
          image.src = source;
        }),
      `data:image/gif;base64,${gif.toString('base64')}`,
    );
    if (!Array.isArray(gifDimensions) || gifDimensions[0] !== decoded[0].width || gifDimensions[1] !== decoded[0].height) {
      throw new Error('Generated GIF dimensions are invalid.');
    }
    writeFileSync(outputPath, gif);

    await page.setContent(`<img id="gif-validation" src="data:image/gif;base64,${gif.toString('base64')}" alt="Robot arm motion validation">`);
    const image = page.locator('#gif-validation');
    await image.waitFor({ state: 'visible' });
    const firstRender = await image.screenshot();
    await page.waitForTimeout(900);
    const secondRender = await image.screenshot();
    let animatedBytes = 0;
    for (let index = 0; index < Math.min(firstRender.length, secondRender.length); index += 29) {
      if (firstRender[index] !== secondRender[index]) animatedBytes += 1;
    }
    if (animatedBytes < 12) throw new Error(`Generated GIF is not visibly animated (${animatedBytes} changed render samples).`);
    console.log(`Robot arm motion GIF written: ${outputPath} (${maxChanged} changed samples, ${animatedBytes} animated render samples)`);
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  if (server.exitCode === 1 && serverLogs.length) console.error(serverLogs.join('\n'));
}
