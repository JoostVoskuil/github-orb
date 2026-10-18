import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import type { AnimationManifest } from '../dashboard/frames.js';
import { createDashboardServer } from '../dashboard/serve.js';

const token = process.env.ORB_TOKEN || 'dashboard-preview-token';
let localServer: ReturnType<typeof createDashboardServer> | undefined;
let base = process.env.ORB_VERIFY_URL || '';
if (!base) {
  localServer = createDashboardServer({ token, githubPoller: false, usbSetup: false });
  await new Promise<void>((resolve) => localServer!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = localServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}
let executablePath = process.env.CHROME_PATH;
if (!executablePath && process.platform === 'darwin') {
  const path = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(path); executablePath = path; } catch {}
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/dashboard/`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'live');
  const manifest = await (await page.request.get(`${base}/media/animations/manifest.json`)).json() as AnimationManifest;
  for (const [, clip] of Object.entries(manifest.clips)) {
    const response = await page.request.get(`${base}/media/animations/${clip.file}`);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /image\/webp/);
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), clip.sha256);
    const dimensions = await page.evaluate(async (file) => {
      const image = new Image();
      image.src = `/media/animations/${file}`;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, clip.file);
    assert.deepEqual(dimensions, [clip.columns * manifest.frameSize, Math.ceil(clip.frames / clip.columns) * manifest.frameSize]);
  }
  const authHeaders = { Authorization: `Bearer ${token}` };
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Live Orb', 'Live Dashboard', 'Animations']);
  await page.getByRole('tab', { name: 'Live Dashboard', exact: true }).click();
  await page.locator('#dashboard-panel').waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Animations', exact: true }).click();
  const liveBeforePreview = await page.request.get(`${base}/state`, { headers: authHeaders });
  assert.equal(liveBeforePreview.status(), 200);
  assert.equal((await liveBeforePreview.json()).mood, 'idle');

  const scenarios: Array<[string, string]> = [
    ['activity', 'copilot: thinking'],
    ['approval', 'copilot: needsInput'],
    ['sessions', 'copilot: needsInput'],
    ['done', 'done (local)'],
    ['error', 'error (local)'],
    ['monaIdle', 'mona: idle'],
    ['monaThinking', 'mona: thinking'],
    ['monaTool', 'mona: tool'],
    ['prAssigned', 'mona: prAssigned'],
    ['monaDone', 'mona: done'],
    ['workflowFailure', 'mona: workflowFailure'],
    ['criticalSecurity', 'mona: securityAlert'],
    ['monaScared', 'mona: scared'],
    ['monaOffline', 'mona: disconnected'],
    ['resting', 'idle (local)']
  ];
  for (const [scenario, expected] of scenarios) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    await page.waitForFunction((text) => document.getElementById('mood-now')?.textContent?.startsWith(text), expected);
    await page.waitForFunction(() => {
      const canvas = document.getElementById('display') as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (!context) return false;
      const data = context.getImageData(180, 180, 120, 120).data;
      return data.some((channel, i) => i % 4 !== 3 && channel > 40);
    });
  }

  await page.locator('[data-scenario="sessions"]').click();
  await page.waitForFunction(() => document.getElementById('mood-now')?.textContent === 'copilot: needsInput');
  await page.waitForFunction(() => {
    const canvas = document.getElementById('display') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const pixels = ctx.getImageData(0, 0, 480, 480).data;
    let visibleRingPixels = 0;
    for (let y = 0; y < 480; y++) {
      for (let x = 0; x < 480; x++) {
        if (Math.abs(Math.hypot(x - 240, y - 240) - 230) > 5) continue;
        const i = (y * 480 + x) * 4;
        if (pixels[i] > 35 || pixels[i + 1] > 35 || pixels[i + 2] > 35) visibleRingPixels++;
      }
    }
    return visibleRingPixels > 1000;
  });
  const display = page.locator('#display');
  const bounds = await display.boundingBox();
  if (!bounds) throw new Error('Display is not visible');
  await page.mouse.click(bounds.x + 440 / 480 * bounds.width, bounds.y + 240 / 480 * bounds.height);
  await page.waitForFunction(() => document.getElementById('mood-now')?.textContent === 'copilot: thinking');
  await page.waitForFunction(() => document.getElementById('mood-now')?.textContent === 'copilot: needsInput', null, { timeout: 10_000 });

  const liveAfterPreview = await page.request.get(`${base}/state`, { headers: authHeaders });
  assert.equal((await liveAfterPreview.json()).mood, 'idle', 'Preview scenarios must not change Live state');

  const animationChecks = await page.evaluate(async () => {
    const framesModuleUrl = '/dist/dashboard/frames.js';
    const { Frames } = await import(framesModuleUrl);
    const player = new Frames();
    await player.load();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = player.manifest.frameSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    const size = canvas.width;
    const half = size / 2;
    ctx.translate(half, half);
    const draw = (mood: string, now: number, enteredAt: number, duration: number): Uint8ClampedArray => {
      ctx.clearRect(-half, -half, size, size);
      player.draw(ctx, mood, now, enteredAt, duration);
      return ctx.getImageData(0, 0, size, size).data;
    };
    const countCyan = (pixels: Uint8ClampedArray, x0 = 0, x1 = size) => {
      let cyan = 0;
      for (let y = 0; y < size; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * size + x) * 4;
          if (pixels[i] < 130 && pixels[i + 1] > 160 && pixels[i + 2] > 170 && pixels[i + 3] > 180) cyan++;
        }
      }
      return cyan;
    };
    const eyes = [];
    for (const mood of ['thinking', 'needsInput']) {
      for (const time of [0, 2, 4, 6]) {
        eyes.push({ mood, time, cyan: countCyan(draw(mood, time * 1000, 0, 0)) });
      }
    }
    const sleepingCyan = [0, 2, 4, 6].map((time) => countCyan(draw('idle', time * 1000, 0, 0)));
    const doneBack = draw('done', 800, 0, 0);
    const doneWink = draw('done', 2040, 0, 0);
    const doneSpinAndWink = {
      backCyan: countCyan(doneBack),
      winkLeftCyan: countCyan(doneWink, 0, half),
      winkRightCyan: countCyan(doneWink, half, size)
    };
    const identical = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean =>
      a.length === b.length && a.every((value, i) => value === b[i]);
    const oneShotsSettled = (['done', 'error', 'mona-done', 'mona-workflow', 'mona-security'] as const).map(clip => {
      const end = player.manifest.clips[clip].frames / player.manifest.clips[clip].fps * 1000;
      return { clip, settled: identical(draw(clip, end, 0, 0), draw(clip, end + 10000, 0, 0)) };
    });
    const before = draw('idle', 8000, 8000, 0);
    const startContinuous = identical(before, draw('thinking', 8000, 8000, 450));
    const midway = draw('thinking', 8200, 8000, 450);
    const interruptionContinuous = identical(midway, draw('needsInput', 8200, 8200, 450));
    draw('needsInput', 8700, 8200, 450);
    return { eyes, sleepingCyan, doneSpinAndWink, oneShotsSettled, startContinuous, interruptionContinuous, settled: player.transition === null };
  });
  for (const { mood, time, cyan } of animationChecks.eyes) {
    if (time === 4) assert.ok(cyan < 150, `${mood}: blink must close`);
    else assert.ok(cyan > (mood === 'thinking' ? 500 : 850), `${mood} at ${time}s: eye surface is occluded`);
  }
  for (const cyan of animationChecks.sleepingCyan) {
    assert.ok(cyan < 200, `idle sleeping eyes should stay nearly closed, got ${cyan}`);
  }
  assert.equal(animationChecks.doneSpinAndWink.backCyan, 0, 'done 360 spin should face away at midpoint');
  assert.ok(animationChecks.doneSpinAndWink.winkLeftCyan > 70, 'done wink should keep left eye open');
  assert.ok(animationChecks.doneSpinAndWink.winkRightCyan < 15, 'done wink should close right eye');
  assert.ok(animationChecks.startContinuous, 'Mood transition must start at the outgoing frame');
  assert.ok(animationChecks.interruptionContinuous, 'Interrupted blend must not jump');
  assert.ok(animationChecks.settled, 'Mood blend must settle');
  for (const clip of animationChecks.oneShotsSettled) assert.ok(clip.settled, `${clip.clip} must hold its final frame`);

  await page.locator('[data-scenario="offline"]').click();
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'offline');
  await page.locator('[data-mode="orb"]').click();
  const accepted = await page.request.post(`${base}/event`, {
    headers: authHeaders,
    data: { source: 'sim', sessionId: 'browser-verifier', event: 'UserPromptSubmit', title: 'Brainpower check' }
  });
  assert.equal(accepted.status(), 202);
  await page.waitForFunction(() => document.getElementById('mood-now')?.textContent?.startsWith('copilot: thinking'));
  await page.locator('#puck').screenshot({ path: new URL('../../media/animations/preview.png', import.meta.url).pathname });
  const traversal = await page.request.get(`${base}/media/..%2Fpackage.json`);
  assert.equal(traversal.status(), 403);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#log').getByText(/unavailable/).count(), 0);
  console.log('PASS: Three-tab flow and animation isolation, 6 Copilot moods + 4 Mona moods, atlases/hashes/dimensions, sleeping/brainpower/pleasy/working/360+wink/impatient-error checks, one-shot settling, continuous/interrupted blends, offline animation preview, traversal; no browser errors.');
} finally {
  await browser.close();
  if (localServer) await new Promise<void>((resolve) => localServer!.close(() => resolve()));
}
