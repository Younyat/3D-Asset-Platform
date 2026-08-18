import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeGif } from './gif-encoder.mjs';

const root = resolve('.');
const port = Number(process.env.PIECE_MOTION_GIF_PORT ?? 5213);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const modelPath = resolve('3d imported models', 'sk095yah4v7k-ModelRmk3', 'Rmk3.obj');
const outputPath = resolve(process.env.PIECE_MOTION_GIF_OUTPUT ?? 'docs/readme-assets/piece-rotation-demo.gif');
const jointIndex = Math.max(0, Number.parseInt(process.env.PIECE_MOTION_JOINT_INDEX ?? '0', 10) || 0);

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
  if (!point) throw new Error('No active joint point for GIF capture.');
  await page.locator('canvas').click({ button: 'right', position: { x: Math.max(4, point.x), y: Math.max(4, point.y) } });
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

if (!existsSync(viteBin) || !existsSync(modelPath)) throw new Error('Missing Vite or Rmk3 test model.');

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

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
    await page.waitForFunction(() => document.body.innerText.includes('Mechanical Setup'), undefined, { timeout: 120000 });
    await page.getByRole('button', { name: /Analyze Mechanics/ }).click();
    await page.waitForSelector('.kinematic-joint-row', { timeout: 30000 });
    const jointRows = page.locator('.kinematic-joint-row');
    if ((await jointRows.count()) <= jointIndex) throw new Error(`Joint index ${jointIndex} is not available in Rmk3.`);
    await jointRows.nth(jointIndex).getByRole('button', { name: /Show Joint/ }).click();
    await page.waitForFunction(() => window.__assetForgeViewportActiveJointPoint?.(), undefined, { timeout: 30000 });
    await rightClickActiveJoint(page);
    await page.getByRole('button', { name: /Analyze piece/ }).click();
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes[0]?.geometry?.pieceReferenceCenter?.triangleCount > 0, undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /Correct reference center/ }).click();
    if (!(await page.evaluate(() => window.__assetForgeViewportPickActiveKinematicPoint?.()))) throw new Error('Could not pick the piece reference center.');
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes[0]?.geometry?.pieceReferenceCenter?.method === 'manual', undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /Dynamic piece/ }).click();
    await page.getByRole('button', { name: /One end/ }).click();
    await page.getByRole('button', { name: 'Wrong axis', exact: true }).click();
    await page.getByRole('button', { name: 'Set Z', exact: true }).click();

    const frames = [await captureCanvasFrame(page)];
    await page.getByRole('button', { name: 'Test Again', exact: true }).click();
    await page.waitForFunction(() => {
      const geometry = window.__assetForgeDocument?.nodes[0]?.geometry;
      const joint = geometry?.kinematicGraph?.joints?.[0];
      return Math.abs(joint ? geometry?.kinematicState?.jointValues?.[joint.id] ?? 0 : 0) > 0.001;
    }, undefined, { timeout: 30000 });
    await page.waitForTimeout(180);
    frames.push(await captureCanvasFrame(page));
    await page.waitForFunction(async () => {
      const geometry = window.__assetForgeDocument?.nodes[0]?.geometry;
      const joint = geometry?.kinematicGraph?.joints?.[0];
      return (joint ? geometry?.kinematicState?.jointValues?.[joint.id] ?? 0 : 0) < -0.001;
    }, undefined, { timeout: 30000 });
    await page.waitForTimeout(180);
    frames.push(await captureCanvasFrame(page));

    const decoded = frames.map((frame) => ({ width: frame.width, height: frame.height, pixels: Buffer.from(frame.pixels, 'base64') }));
    let sourceChangedPixels = 0;
    for (let index = 0; index < decoded[0].pixels.length; index += 16) {
      if (Math.abs(decoded[0].pixels[index] - decoded[1].pixels[index]) + Math.abs(decoded[0].pixels[index + 1] - decoded[1].pixels[index + 1]) + Math.abs(decoded[0].pixels[index + 2] - decoded[1].pixels[index + 2]) > 18) sourceChangedPixels += 1;
    }
    if (sourceChangedPixels < 12) throw new Error(`Captured motion is not visibly different (${sourceChangedPixels} changed samples).`);
    let indexedChangedPixels = 0;
    for (let index = 0; index < decoded[0].pixels.length; index += 16) {
      const first = (decoded[0].pixels[index] & 0xe0) | ((decoded[0].pixels[index + 1] & 0xe0) >> 3) | ((decoded[0].pixels[index + 2] & 0xc0) >> 6);
      const second = (decoded[1].pixels[index] & 0xe0) | ((decoded[1].pixels[index + 1] & 0xe0) >> 3) | ((decoded[1].pixels[index + 2] & 0xc0) >> 6);
      if (first !== second) indexedChangedPixels += 1;
    }
    if (indexedChangedPixels < 12) throw new Error(`GIF palette removes visible motion (${indexedChangedPixels} changed samples).`);
    const gif = encodeGif({ width: decoded[0].width, height: decoded[0].height, frames: decoded, delayCentiseconds: 65 });
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
    const source = `data:image/gif;base64,${gif.toString('base64')}`;
    await page.setContent(`<img id="gif-animation-validation" src="${source}" alt="Animation validation">`);
    const animation = page.locator('#gif-animation-validation');
    await animation.waitFor({ state: 'visible' });
    const firstRender = await animation.screenshot();
    await page.waitForTimeout(900);
    const secondRender = await animation.screenshot();
    let animatedBytes = 0;
    for (let index = 0; index < Math.min(firstRender.length, secondRender.length); index += 23) {
      if (firstRender[index] !== secondRender[index]) animatedBytes += 1;
    }
    if (animatedBytes < 12) throw new Error(`Generated GIF is not visibly animated (${animatedBytes} changed render samples).`);
    console.log(`Piece motion GIF written: ${outputPath} (${animatedBytes} changed render samples, joint ${jointIndex})`);
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
