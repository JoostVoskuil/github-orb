import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export const MONA_REVISION = '981a85f0bec9d1a9c280fd5719d0d797852229c4';
export const MONA_PATH = 'models/mona/mona_multicolor.3mf';

type XmlRecord = Record<string, unknown>;

export interface MonaMesh {
  positions: number[];
  paint: string[];
  materials: number[];
  palette: string[];
  vertexCount: number;
  triangleCount: number;
  splitPaintTriangles: number;
  componentTransform: string;
  printTransform: string;
  orientation: string;
}

function isRecord(value: unknown): value is XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): XmlRecord[] {
  // The XML parser represents repeated elements as arrays and singletons as objects.
  return (Array.isArray(value) ? value : [value]).filter(isRecord);
}

function childRecord(parent: XmlRecord | undefined, key: string): XmlRecord | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function attribute(value: unknown, name: string): string | undefined {
  const candidate = isRecord(value) ? value[`@_${name}`] : undefined;
  return typeof candidate === 'string' ? candidate : undefined;
}

// Bambu stores a depth-first nibble tree, least significant nibble first.
// Leaves 0..2 fit one nibble; leaf 3+ uses an extension after nibble C.
// Display adaptation: collapse each tiny split-painted face to its modal leaf.
// Retain the complete original encoding in mesh.json and the untouched 3MF.
export function paintMaterial(encoded: string, fallback = 1): number {
  if (!/^[0-9a-f]+$/i.test(encoded) || !Number.isInteger(fallback) || fallback < 1 || fallback > 4) {
    throw new Error('Invalid Bambu paint');
  }
  const nibbles = [...encoded].reverse().map((value) => parseInt(value, 16));
  let cursor = 0;
  const counts = new Map<number, number>();
  const next = (): number => {
    if (cursor >= nibbles.length) throw new Error('Truncated Bambu paint');
    return nibbles[cursor++];
  };
  const visit = (depth = 0): void => {
    if (depth > 64) throw new Error('Bambu paint nesting exceeds limit');
    const code = next();
    const sides = code & 3;
    if (sides) {
      for (let child = 0; child < sides + 1; child++) visit(depth + 1);
    } else {
      let state = code >> 2;
      if (state === 3) {
        let extension: number;
        while ((extension = next()) === 15) state += 15;
        state += extension;
      }
      if (state > 4) throw new Error(`Unknown Mona filament ${state}`);
      state ||= fallback;
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
  };
  visit();
  if (cursor !== nibbles.length) throw new Error('Trailing Bambu paint data');
  const mostCommon = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!mostCommon) throw new Error('Bambu paint contains no material');
  return mostCommon[0];
}

export function extractMona(bytes: Uint8Array): MonaMesh {
  const zip = unzipSync(bytes);
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const xml = (name: string): XmlRecord => {
    if (!zip[name]) throw new Error(`Missing ${name}`);
    const parsed: unknown = parser.parse(strFromU8(zip[name]));
    if (!isRecord(parsed)) throw new Error(`Invalid XML document: ${name}`);
    return parsed;
  };
  const assembly = childRecord(xml('3D/3dmodel.model'), 'model');
  const assemblyResources = childRecord(assembly, 'resources');
  const assemblyObject = records(assemblyResources?.object)[0];
  const components = childRecord(assemblyObject, 'components');
  const component = records(components?.component)[0];
  const componentPath = attribute(component, 'path');
  const componentTransform = attribute(component, 'transform');
  if (componentPath !== '/3D/Objects/object_3.model' ||
      componentTransform !== '1 0 0 0 1 0 0 0 1 0 0 0') {
    throw new Error('Unexpected Mona component transform');
  }
  const meshModel = childRecord(xml('3D/Objects/object_3.model'), 'model');
  const meshResources = childRecord(meshModel, 'resources');
  const meshObject = records(meshResources?.object)[0];
  const mesh = childRecord(meshObject, 'mesh');
  const vertices = records(childRecord(mesh, 'vertices')?.vertex);
  const triangles = records(childRecord(mesh, 'triangles')?.triangle);
  if (vertices.length !== 7498 || triangles.length !== 15000) throw new Error('Unexpected Mona mesh counts');
  const settingsBytes = zip['Metadata/project_settings.config'];
  if (!settingsBytes) throw new Error('Missing Metadata/project_settings.config');
  const settings: unknown = JSON.parse(strFromU8(settingsBytes));
  const paletteValue = isRecord(settings) ? settings.filament_colour : undefined;
  if (!Array.isArray(paletteValue) || !paletteValue.every((value): value is string => typeof value === 'string')) {
    throw new Error('Unexpected Mona source palette');
  }
  const palette = paletteValue;
  if (JSON.stringify(palette) !== JSON.stringify(['#5E43B7', '#FFFFFF', '#000000', '#F5547C'])) {
    throw new Error('Unexpected Mona source palette');
  }
  const positions: number[] = [];
  const paint: string[] = [];
  const materials: number[] = [];
  let splitPaintTriangles = 0;
  for (const triangle of triangles) {
    for (const key of ['v1', 'v2', 'v3']) {
      const vertexIndex = Number(attribute(triangle, key));
      if (!Number.isInteger(vertexIndex)) throw new Error('Invalid Mona vertex index');
      const vertex = vertices[vertexIndex];
      if (!vertex) throw new Error('Invalid Mona vertex index');
      for (const axis of ['x', 'y', 'z']) {
        const coordinate = Number(attribute(vertex, axis));
        if (!Number.isFinite(coordinate)) throw new Error('Invalid Mona coordinates');
        positions.push(coordinate);
      }
    }
    const encoded = attribute(triangle, 'paint_color') ?? '0';
    paint.push(encoded);
    materials.push(paintMaterial(encoded));
    if (parseInt(encoded[encoded.length - 1], 16) & 3) splitPaintTriangles++;
  }
  const buildItem = records(childRecord(assembly, 'build')?.item)[0];
  const printTransform = attribute(buildItem, 'transform');
  if (!printTransform) throw new Error('Missing Mona print transform');
  return { positions, paint, materials, palette, vertexCount: vertices.length,
    triangleCount: triangles.length, splitPaintTriangles,
    componentTransform, printTransform,
    orientation: 'Intrinsic Z-up, front negative Y; display rotates X by -pi/2. Print-bed placement not applied.' };
}