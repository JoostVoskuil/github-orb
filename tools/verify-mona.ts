import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MONA_CLIPS } from './mona-motion.js';

let executablePath = process.env.CHROME_PATH;
if (!executablePath && process.platform === 'darwin') {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(chrome); executablePath = chrome; } catch {}
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  for (const [name, spec] of Object.entries(MONA_CLIPS)) {
    const frames = Math.round(spec.duration * 12);
    const atlas = await readFile(new URL(`../../media/animations/${name}.webp`, import.meta.url));
    const poster = await readFile(new URL(`../../media/animations/${name}-poster.png`, import.meta.url));
    const result = await page.evaluate(async ({ atlas, poster, frames, loop }: {
      atlas: string; poster: string; frames: number; loop: boolean;
    }) => {
      const image = async (type: 'webp' | 'png', bytes: string): Promise<ImageBitmap> => {
        const blob = await fetch(`data:image/${type};base64,${bytes}`).then((response) => response.blob());
        return createImageBitmap(blob);
      };
      const bitmap = await image('webp', atlas);
      const png = await image('png', poster);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas 2D context unavailable');
      const pixels = (frame: number): Uint8ClampedArray => {
        context.clearRect(0, 0, 320, 320);
        context.drawImage(bitmap, -(frame % 8) * 320, -Math.floor(frame / 8) * 320);
        return context.getImageData(0, 0, 320, 320).data;
      };
      const last = pixels(frames - 1);
      const first = pixels(0);
      const settled = pixels(loop ? frames - 1 : frames - 6);
      const midFrame = loop ? Math.floor(frames * 0.28) : 9;
      const pixelsMid = pixels(midFrame);
      let changed = 0, difference = 0, samples = 0;
      for (let i = 0; i < last.length; i += 4) {
        if (last[i + 3] > 240 && settled[i + 3] > 240) {
          for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(last[i + channel] - settled[i + channel]);
            samples++;
          }
        }
        if (Math.abs(first[i + 3] - pixelsMid[i + 3]) > 32 ||
            Math.abs(first[i] - pixelsMid[i]) + Math.abs(first[i + 1] - pixelsMid[i + 1]) + Math.abs(first[i + 2] - pixelsMid[i + 2]) > 48) {
          changed++;
        }
      }
      context.clearRect(0, 0, 320, 320);
      context.drawImage(png, 0, 0);
      const data = context.getImageData(0, 0, 320, 320).data;
      let visible = 0, violet = 0, pink = 0, white = 0, dark = 0;
      const bounds = { left: 320, right: 0, top: 320, bottom: 0 };
      for (let pixel = 0; pixel < 320 * 320; pixel++) {
        const i = pixel * 4;
        if (data[i + 3] < 240) continue;
        visible++;
        const x = pixel % 320, y = Math.floor(pixel / 320);
        bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
        bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
        const [r, g, b] = data.slice(i, i + 3);
        if (b > g * 1.15 && r > g * 1.05) violet++;
        if (r > g * 1.3 && r > b * 1.1) pink++;
        if (Math.min(r, g, b) > 200) white++;
        if (Math.max(r, g, b) < 100) dark++;
      }
      return { width: bitmap.width, height: bitmap.height, posterWidth: png.width,
        posterHeight: png.height, changed, settledMeanDifference: difference / samples,
        visible, violet, pink, white, dark, bounds };
    }, { atlas: atlas.toString('base64'), poster: poster.toString('base64'), frames, loop: spec.loop });
    assert.equal(result.width, 2560);
    assert.equal(result.height, Math.ceil(frames / 8) * 320);
    assert.equal(result.posterWidth, 320);
    assert.equal(result.posterHeight, 320);
    assert.ok(result.visible > 15000, `${name}: character not visible`);
    assert.ok(result.changed > 100, `${name}: missing gesture`);
    assert.ok(result.settledMeanDifference < 2, `${name}: final pose not stable`);
    for (const color of ['violet', 'pink', 'dark'] as const) {
      assert.ok(result[color] > 50, `${name}: missing ${color}`);
    }
    if (name !== 'mona-idle') {
      assert.ok(result.white > 50, `${name}: missing white`);
    }
    assert.ok(result.bounds.left > 5 && result.bounds.right < 314 && result.bounds.top > 5 && result.bounds.bottom < 314, `${name}: clipped poster`);
    console.log(`${name}: ${JSON.stringify(result)}`);
  }
} finally {
  await browser.close();
}