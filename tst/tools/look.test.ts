import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelRegions, rimWeight } from '../../tools/model-regions.js';

interface MeshData {
  positions: number[];
  paint: string[];
}

test('reference look uses retained artwork and a sharper bounded export', async () => {
  const look = JSON.parse(await readFile(new URL('../../../media/copilot/reference-look.json', import.meta.url), 'utf8')) as {
    reference: string; samples: Record<string, string>; palette: Record<string, string>;
    frameSize: number; supersampling: number; webpQuality: number;
  };
  assert.match(look.reference, /^\/media\/images\/[\w-]+\.png$/);
  const image = await readFile(new URL(`../../..${look.reference}`, import.meta.url));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  for (const color of [...Object.values(look.samples), ...Object.values(look.palette)]) assert.match(color, /^#[0-9a-f]{6}$/i);
  assert.equal(look.frameSize, 320);
  assert.ok(look.supersampling >= 2 && look.supersampling <= 4);
  assert.ok(look.webpQuality >= 0.95 && look.webpQuality <= 1);
});

test('goggles use complete connected lenses rather than triangle height cutoffs', async () => {
  const data = JSON.parse(await readFile(new URL('../../../media/copilot/mesh.json', import.meta.url), 'utf8')) as MeshData;
  const regions = modelRegions(data);
  assert.deepEqual(regions.components, [733, 79, 79]);
  assert.equal(regions.labels.filter((part) => part === 'lensLeft').length, 79);
  assert.equal(regions.labels.filter((part) => part === 'lensRight').length, 79);
  assert.equal(regions.labels.filter((part) => part === 'face').length, 733);
  assert.ok(regions.labels.some((part, triangle) => part === 'face' && data.positions[triangle * 9 + 2] > 0.5));
  assert.ok(regions.weights.some((weight) => weight > 0 && weight < 1));
  assert.ok(regions.weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1));
  const shared = new Map<string, number>();
  for (let i = 0; i < regions.weights.length; i++) {
    const key = data.positions.slice(i * 3, i * 3 + 3).map((value) => Math.round(value * 1000)).join(',');
    if (shared.has(key)) assert.equal(regions.weights[i], shared.get(key));
    else shared.set(key, regions.weights[i]);
  }
});

test('rim tint is continuous and fades outside the goggle frame', () => {
  assert.equal(rimWeight(0), 1);
  assert.equal(rimWeight(Infinity), 0);
  assert.equal(rimWeight(1.4), 1);
  assert.equal(rimWeight(3), 0);
  assert.ok(Math.abs(rimWeight(1) - rimWeight(1.001)) < 0.002);
});
