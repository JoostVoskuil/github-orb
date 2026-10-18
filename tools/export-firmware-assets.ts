import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { buildPack, encodeAlphaRle, type AnimationClip as PackClip, type AnimationFrame } from './firmware-pack.js';
import type { AnimationManifest } from '../dashboard/frames.js';

type FirmwareClip = AnimationManifest['clips'][string] & { duration: number };
interface MonaAttribution {
  attribution: string;
  repository: string;
  revision: string;
  path: string;
  license: string;
  licenseUrl: string;
  changes: string;
  rights: string;
}
type FirmwareManifest = Omit<AnimationManifest, 'clips' | 'characters'> & {
  clips: Record<string, FirmwareClip>;
  characters?: { mona?: { source: MonaAttribution } };
};

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'media/animations/manifest.json'), 'utf8')) as FirmwareManifest;
const outputArg = process.argv.indexOf('--output');
const output = resolve(outputArg >= 0 ? process.argv[outputArg + 1] : join(root, 'firmware/data/animations.orb'));
const quality = Number(process.env.ORB_JPEG_QUALITY ?? 0.74);
const maxBytes = Number(process.env.ORB_ASSET_MAX_BYTES ?? 12 * 1024 * 1024);
if (!(quality > 0 && quality <= 1)) throw new Error('ORB_JPEG_QUALITY must be greater than 0 and at most 1');

const mime: Record<string, string> = { '.json': 'application/json', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).slice(1);
    const file = resolve(root, pathname);
    if (!file.startsWith(root + sep)) throw new Error('Forbidden');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));

let browser: Browser | undefined;
try {
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath && process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(chrome); executablePath = chrome; } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Renderer server did not bind to a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  await page.goto(`${origin}/media/animations/manifest.json`);
  await page.evaluate(async ({ clips, origin }: { clips: Record<string, FirmwareClip>; origin: string }) => {
    window.orbAtlases = {};
    for (const [name, clip] of Object.entries(clips)) {
      const blob = await fetch(`${origin}/media/animations/${clip.file}`).then((response) => response.blob());
      window.orbAtlases[name] = await createImageBitmap(blob);
    }
  }, { clips: manifest.clips, origin });

  const frames: AnimationFrame[] = [];
  const clips: PackClip[] = [];
  for (const [name, clip] of Object.entries(manifest.clips)) {
    const firstFrame = frames.length;
    process.stdout.write(`${name}: `);
    for (let frame = 0; frame < clip.frames; frame++) {
      const encoded = await page.evaluate(async ({ name, frame, columns, size, quality }: {
        name: string;
        frame: number;
        columns: number;
        size: number;
        quality: number;
      }) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context unavailable');
        context.drawImage(window.orbAtlases[name], -(frame % columns) * size, -Math.floor(frame / columns) * size);
        const image = context.getImageData(0, 0, size, size);
        const alpha = new Uint8Array(size * size);
        for (let pixel = 0, source = 0; pixel < alpha.length; pixel++, source += 4) {
          alpha[pixel] = image.data[source + 3];
          if (image.data[source + 3] === 0) {
            image.data[source] = 4;
            image.data[source + 1] = 8;
            image.data[source + 2] = 24;
          }
          image.data[source + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const jpeg = await new Promise<Blob>((done, reject) => canvas.toBlob((blob) => blob ? done(blob) : reject(new Error('JPEG encoding failed')), 'image/jpeg', quality));
        const bytes = new Uint8Array(await jpeg.arrayBuffer());
        const base64 = (value: Uint8Array): string => {
          let binary = '';
          for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
          return btoa(binary);
        };
        return { jpeg: base64(bytes), alpha: base64(alpha) };
      }, { name, frame, columns: clip.columns, size: manifest.frameSize, quality }) as { jpeg: string; alpha: string };
      const alpha = encodeAlphaRle(Buffer.from(encoded.alpha, 'base64'));
      frames.push({ jpeg: Buffer.from(encoded.jpeg, 'base64'), alpha });
      if ((frame + 1) % 12 === 0) process.stdout.write('.');
    }
    process.stdout.write(` ${clip.frames} frames\n`);
    clips.push({
      name,
      firstFrame,
      frameCount: clip.frames,
      fps: clip.fps,
      loop: clip.loop,
      durationMs: Math.round(clip.duration * 1000)
    });
  }

  const pack = buildPack({ width: manifest.frameSize, height: manifest.frameSize, clips, frames });
  if (pack.length > maxBytes) {
    throw new Error(`Firmware animation pack is ${(pack.length / 1048576).toFixed(2)} MiB; limit is ${(maxBytes / 1048576).toFixed(2)} MiB. Lower ORB_JPEG_QUALITY.`);
  }
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, pack);
  const sdcard = join(root, 'dist/sdcard');
  await mkdir(sdcard, { recursive: true });
  await writeFile(join(sdcard, 'animations.orb'), pack);
  await writeFile(join(sdcard, 'sounds.json'), await readFile(join(root, 'firmware/data/sounds.json')));
  if (manifest.characters?.mona) {
    const attributionFile = resolve(output, '../ATTRIBUTION.txt');
    const existing = await readFile(attributionFile, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const source = manifest.characters.mona.source;
    const copilot = existing.split('\nMona model from octoprints')[0].trimEnd();
    await writeFile(attributionFile, `${copilot}\n\n${source.attribution}\nSource: ${source.repository}\nRevision: ${source.revision}\nSource path: ${source.path}\nLicense: ${source.license}\nLicense URL: ${source.licenseUrl}\nAdaptations: ${source.changes}\n${source.rights}\n`);
  }
  console.log(`Wrote ${output} (${(pack.length / 1048576).toFixed(2)} MiB, JPEG quality ${quality})`);
  console.log(`Published animations.orb and sounds.json to ${sdcard}`);
} finally {
  await browser?.close();
  server.close();
}