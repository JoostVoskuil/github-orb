import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MONA_PATH, MONA_REVISION, extractMona } from './mona-model.js';

const repository = 'https://github.com/martinwoodward/octoprints';
const base = `https://raw.githubusercontent.com/martinwoodward/octoprints/${MONA_REVISION}`;
async function download(path: string): Promise<Uint8Array> {
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
const [model, license] = await Promise.all([download(MONA_PATH), download('LICENSE')]);
if (model.length !== 284639) throw new Error('Unexpected pinned Mona source size');
const mesh = extractMona(model);
const source = {
  repository, revision: MONA_REVISION, path: MONA_PATH,
  sourceBytes: model.length, sha256: createHash('sha256').update(model).digest('hex'),
  license: 'CC-BY-NC-4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
  attribution: 'Mona model from octoprints by Martin Woodward and contributors. GitHub mascot.',
  changes: `Mesh extracted from 3MF; intrinsic orientation retained rather than print-bed placement; ${mesh.splitPaintTriangles} split-painted micro-faces collapsed to modal decoded filament (ties use lowest index); smooth display normals, source filament colors, lighting, calm news poses, transparent frame rendering, JPEG conversion and alpha-mask compression.`,
  rights: 'Noncommercial use only under CC BY-NC 4.0; commercial distribution requires separate permission. No GitHub affiliation or trademark permission is implied.',
  mesh: { vertices: mesh.vertexCount, triangles: mesh.triangleCount, splitPaintTriangles: mesh.splitPaintTriangles }
};
const out = fileURLToPath(new URL('../../media/mona/', import.meta.url));
await mkdir(out, { recursive: true });
await Promise.all([
  writeFile(`${out}/source.3mf`, model), writeFile(`${out}/LICENSE.txt`, license),
  writeFile(`${out}/mesh.json`, JSON.stringify(mesh)),
  writeFile(`${out}/source.json`, JSON.stringify(source, null, 2) + '\n')
]);
console.log(`Prepared Mona: ${mesh.triangleCount} triangles, ${mesh.splitPaintTriangles} split-painted micro-faces, ${model.length} source bytes`);