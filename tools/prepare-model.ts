import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const out = fileURLToPath(new URL('../../media/copilot/', import.meta.url));
const repository = 'martinwoodward/octoprints';
type XmlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): XmlRecord[] {
  return (Array.isArray(value) ? value : [value]).filter(isRecord);
}

function childRecord(parent: XmlRecord | undefined, key: string): XmlRecord | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function attribute(value: XmlRecord, name: string): string | undefined {
  const candidate = value[`@_${name}`];
  return typeof candidate === 'string' ? candidate : undefined;
}

const api = await fetch(`https://api.github.com/repos/${repository}/commits/main`);
if (!api.ok) throw new Error(`Resolve source revision: HTTP ${api.status}`);
const revision = (await api.json()).sha;
const base = `https://raw.githubusercontent.com/${repository}/${revision}`;

async function download(path: string): Promise<Uint8Array> {
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const [model, license] = await Promise.all([
  download('models/copilot/copilot_multicolor.3mf'), download('LICENSE')
]);
const zip = unzipSync(model);
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const positions: number[] = [];
const paint: string[] = [];
for (const [name, bytes] of Object.entries(zip)) {
  if (!name.endsWith('.model')) continue;
  const parsed: unknown = parser.parse(strFromU8(bytes));
  const model = childRecord(childRecord(isRecord(parsed) ? parsed : undefined, 'model'), 'resources');
  for (const object of records(model?.object)) {
    const mesh = childRecord(object, 'mesh');
    if (!mesh) continue;
    const vertices = records(childRecord(mesh, 'vertices')?.vertex);
    const triangles = records(childRecord(mesh, 'triangles')?.triangle);
    for (const triangle of triangles) {
      for (const key of ['v1', 'v2', 'v3']) {
        const vertexIndex = Number(attribute(triangle, key));
        if (!Number.isInteger(vertexIndex)) throw new Error(`Invalid vertex index in ${name}`);
        const vertex = vertices[vertexIndex];
        if (!vertex) throw new Error(`Invalid vertex index in ${name}`);
        for (const axis of ['x', 'y', 'z']) {
          const coordinate = Number(attribute(vertex, axis));
          if (!Number.isFinite(coordinate)) throw new Error(`Invalid coordinate in ${name}`);
          positions.push(coordinate);
        }
      }
      const color = attribute(triangle, 'paint_color') ?? '4';
      if (!['4', '8', '0C'].includes(color)) throw new Error(`Unsupported split triangle paint: ${color}`);
      paint.push(color);
    }
  }
}
if (!paint.length || positions.some((value) => !Number.isFinite(value))) throw new Error('Invalid mesh');

await mkdir(out, { recursive: true });
await Promise.all([
  writeFile(`${out}/source.3mf`, model),
  writeFile(`${out}/LICENSE.txt`, license),
  writeFile(`${out}/mesh.json`, JSON.stringify({ positions, paint })),
  writeFile(`${out}/source.json`, JSON.stringify({
    repository: `https://github.com/${repository}`, revision,
    path: 'models/copilot/copilot_multicolor.3mf',
    license: 'CC-BY-NC-4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    attribution: 'Copilot model from octoprints by Martin Woodward and contributors. GitHub mascot.',
    changes: 'Mesh extracted from 3MF; custom display materials, lighting and procedural animation.'
  }, null, 2) + '\n')
]);
console.log(`Prepared ${paint.length} triangles at revision ${revision}`);