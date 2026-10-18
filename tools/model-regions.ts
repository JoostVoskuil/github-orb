interface MeshData {
  positions: number[];
  paint: string[];
}

type Point = [number, number, number];
type HeapEntry = [distance: number, vertexId: number];
type RegionLabel = 'eyeLeft' | 'eyeRight' | 'shell' | 'face' | 'lensLeft' | 'lensRight';

export interface ModelRegions {
  labels: RegionLabel[];
  weights: number[];
  components: number[];
}

export function rimWeight(distance: number): number {
  const t = Math.max(0, Math.min(1, (distance - 1.4) / 1.2));
  return 1 - t * t * (3 - 2 * t);
}

class MinHeap {
  values: HeapEntry[] = [];

  push(value: HeapEntry): void {
    const heap = this.values;
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= value[0]) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = value;
  }
  pop(): HeapEntry | undefined {
    const heap = this.values;
    const first = heap[0];
    if (!first) return undefined;
    const last = heap.pop();
    if (!last) return first;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (last[0] <= heap[child][0]) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  }
}

export function modelRegions(data: MeshData): ModelRegions {
  if (data.positions.length !== data.paint.length * 9 || data.positions.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid triangle mesh');
  }
  const vertices: Point[] = [];
  const lookup = new Map<string, number>();
  const ids: number[] = [];
  for (let i = 0; i < data.positions.length; i += 3) {
    const point: Point = [data.positions[i], data.positions[i + 1], data.positions[i + 2]];
    const key = point.map((value) => Math.round(value * 1000)).join(',');
    let id = lookup.get(key);
    if (id === undefined) {
      id = vertices.length;
      lookup.set(key, id);
      vertices.push(point);
    }
    ids.push(id);
  }
  const parent = data.paint.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const owners = new Map<number, number>();
  const graph: Map<number, number>[] = vertices.map(() => new Map<number, number>());
  for (let triangle = 0; triangle < data.paint.length; triangle++) {
    const face = ids.slice(triangle * 3, triangle * 3 + 3);
    if (data.paint[triangle] === '8') {
      for (const vertex of face) {
        const owner = owners.get(vertex);
        if (owner !== undefined) parent[find(triangle)] = find(owner);
        else owners.set(vertex, triangle);
      }
    }
    for (let i = 0; i < 3; i++) {
      const a = face[i], b = face[(i + 1) % 3];
      const distance = Math.hypot(...vertices[a].map((value, axis) => value - vertices[b][axis]));
      graph[a].set(b, distance);
      graph[b].set(a, distance);
    }
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < data.paint.length; i++) {
    if (data.paint[i] !== '8') continue;
    const root = find(i);
    const region = components.get(root);
    if (region) region.push(i);
    else components.set(root, [i]);
  }
  const regions = [...components.values()].sort((a, b) => b.length - a.length);
  if (regions.length !== 3) throw new Error(`Expected a face and two lens regions, found ${regions.length}`);
  const faceRegion = regions[0];
  if (!faceRegion) throw new Error('Missing face region');
  const labels: RegionLabel[] = data.paint.map((paint, triangle) => paint === '0C'
    ? (data.positions[triangle * 9] < 0 ? 'eyeLeft' : 'eyeRight') : 'shell');
  for (const triangle of faceRegion) labels[triangle] = 'face';
  for (const lens of regions.slice(1)) {
    const x = lens.reduce((sum, triangle) => sum + data.positions[triangle * 9], 0) / lens.length;
    for (const triangle of lens) labels[triangle] = x < 0 ? 'lensLeft' : 'lensRight';
  }
  const distances = vertices.map(() => Infinity);
  const heap = new MinHeap();
  // Seed both lens boundaries, then measure surface distance to blend the surrounding shell into the lenses.
  for (const lens of regions.slice(1)) {
    for (const triangle of lens) {
      for (const id of ids.slice(triangle * 3, triangle * 3 + 3)) {
        if (distances[id] === 0) continue;
        distances[id] = 0;
        heap.push([0, id]);
      }
    }
  }
  while (heap.values.length) {
    const entry = heap.pop();
    if (!entry) break;
    const [distance, id] = entry;
    // Distances beyond this radius cannot affect the rim blend, so avoid traversing the rest of the mesh.
    if (distance !== distances[id] || distance > 2.6) continue;
    for (const [neighbor, length] of graph[id]) {
      const next = distance + length;
      if (next >= distances[neighbor]) continue;
      distances[neighbor] = next;
      heap.push([next, neighbor]);
    }
  }
  return { labels, weights: ids.map((id) => rimWeight(distances[id])), components: regions.map((region) => region.length) };
}
