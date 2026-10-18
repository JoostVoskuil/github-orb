import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { CLIPS } from '../dashboard/motion.js';
import type { AnimationClip } from '../dashboard/frames.js';
import { MONA_CLIPS } from './mona-motion.js';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const out = join(root, 'media/animations');
const mona = process.argv.includes('--mona');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
type RenderManifest = {
  version: number;
  frameSize: number;
  fps: number;
  columns: number;
  clips: Record<string, AnimationClip & { duration: number }>;
  source?: unknown;
  render?: unknown;
  characters?: Record<string, unknown>;
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const path = pathname.startsWith('/three/') ? join('tools/node_modules/three', pathname.slice(7))
      : pathname === '/' ? (mona ? 'tools/mona-render.html' : 'tools/render.html') : pathname.slice(1);
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new Error('Forbidden');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser: Browser | undefined;
try {
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath && process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(chrome); executablePath = chrome; } catch {}
  }
  const args = process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  browser = await chromium.launch({ executablePath, headless: true, args });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(error));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Renderer server did not bind to a TCP port');
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.rendererReady, null, { timeout: 30_000 });
  await mkdir(out, { recursive: true });
  let manifest: RenderManifest;
  try { manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')); } catch (error) {
    if (mona || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    manifest = { version: 1, frameSize: 320, fps: 12, columns: 8, clips: {}, source: JSON.parse(await readFile(join(root, 'media/copilot/source.json'), 'utf8')) };
  }
  if (manifest.version !== 1 || manifest.frameSize !== 320 || manifest.fps !== 12 || manifest.columns !== 8) throw new Error('Incompatible existing manifest');
  const render = await page.evaluate(() => window.rendererSettings);
  if (mona) {
    manifest.characters = { ...manifest.characters, mona: {
      source: JSON.parse(await readFile(join(root, 'media/mona/source.json'), 'utf8')), render
    } };
  } else {
    manifest.render = render;
    await writeFile(join(out, 'poster.png'), Buffer.from(await page.evaluate(() => window.renderPoster()), 'base64'));
  }
  const monaPosterTimes: Record<string, number> = {
    'mona-idle': 0,
    'mona-thinking': 0.8,
    'mona-tool': 2.2,
    'mona-pr': 0,
    'mona-done': 2.04,
    'mona-workflow': 0.9,
    'mona-security': 1.1,
    'mona-offline': 0
  };
  const posters: [string, number][] = mona ? Object.keys(MONA_CLIPS).map((clip) => [clip, monaPosterTimes[clip] ?? 0.75])
    : [['thinking', 0], ['needsInput', 0], ['tool', 2.2], ['error', 0.9]];
  for (const [mood, time] of posters) {
    const encoded = await page.evaluate(
      ({ mood, time }: { mood: string; time: number }) => window.renderPoster(mood, time),
      { mood, time }
    );
    await writeFile(join(out, `${mood}-poster.png`), Buffer.from(encoded, 'base64'));
  }
  for (const [mood, spec] of Object.entries(mona ? MONA_CLIPS : CLIPS)) {
    const clip: AnimationClip & { duration: number } = { ...spec, fps: manifest.fps, frames: Math.round(spec.duration * manifest.fps), columns: manifest.columns, file: `${mood}.webp` };
    const encoded = await page.evaluate((options) => window.renderAtlas(options), { ...clip, mood });
    const bytes = Buffer.from(encoded, 'base64');
    await writeFile(join(out, clip.file), bytes);
    clip.sha256 = createHash('sha256').update(bytes).digest('hex');
    manifest.clips[mood] = clip;
    console.log(`${mood}: ${clip.frames} frames, ${(bytes.length / 1024).toFixed(0)} KiB`);
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Rendered all clips to media/animations');
} finally {
  await browser?.close();
  server.close();
}