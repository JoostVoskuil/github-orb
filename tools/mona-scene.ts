import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { monaMotionAt, type MonaPose } from './mona-motion.js';

const size = 320;
const settings = { frameSize: size, supersampling: 2, webpQuality: 0.98,
  orientation: 'Z-up to Y-up, front negative Y to positive Z', palette: 'Source Bambu filament colors' };
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('render') as HTMLCanvasElement, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(size, size);
renderer.setPixelRatio(settings.supersampling);
renderer.setClearColor(0, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1.65, 1.65, 1.65, -1.65, 0.1, 30);
camera.position.set(0, 0.02, 8);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xe2ddff, 0x342850, 1.8));
for (const [color, intensity, position] of [
  [0xfff1ed, 2.4, [-3, 5, 5]], [0xc7d6ff, 1.1, [4, 1, 3]], [0xd5b6ff, 1.6, [1, 3, -4]]
]) {
  const light = new THREE.DirectionalLight(color as THREE.ColorRepresentation, Number(intensity));
  light.position.set(...(position as [number, number, number]));
  scene.add(light);
}

const response = await fetch('/media/mona/mesh.json');
if (!response.ok) throw new Error(`Mona mesh: HTTP ${response.status}`);
const data = await response.json();

// Weld the mesh and classify hood, inner ears, 3D nose, and animated front face dome.
const raw = new THREE.BufferGeometry();
raw.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
raw.rotateX(-Math.PI / 2);
const welded = mergeVertices(raw, 0.00001);
const weldedPos = welded.getAttribute('position');
const weldedIdx = welded.getIndex()!;
const vertexCount = weldedPos.count;
const triangleCount = data.materials.length;

const triVerts: [number, number, number][] = [];
for (let t = 0; t < triangleCount; t++) {
  triVerts.push([weldedIdx.getX(t * 3), weldedIdx.getX(t * 3 + 1), weldedIdx.getX(t * 3 + 2)]);
}

// Find the main violet hood component (largest connected component of material 1).
const m1Tris: number[] = [];
for (let t = 0; t < triangleCount; t++) {
  if (data.materials[t] === 1) m1Tris.push(t);
}
const parent = m1Tris.map((_, i) => i);
const find = (i: number): number => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
};
const owner = new Map<number, number>();
m1Tris.forEach((t, idx) => {
  for (const v of triVerts[t]) {
    const prev = owner.get(v);
    if (prev !== undefined) parent[find(idx)] = find(prev);
    else owner.set(v, idx);
  }
});
const compCounts = new Map<number, number>();
m1Tris.forEach((_, idx) => {
  const r = find(idx);
  compCounts.set(r, (compCounts.get(r) ?? 0) + 1);
});
const hoodRoot = [...compCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const hoodTris = new Set(m1Tris.filter((_, idx) => find(idx) === hoodRoot));

// Classify triangles:
// - hood: main violet shell & whiskers
// - ears: pink inner ears (material 4 with y > 1.8)
// - nose: 3D black nose (|x| < 0.5 && y > -2.0 on the front face)
// - face: pink face dome + eye/mouth patches (receives dynamic facial expression texture)
const patchTris = new Set<number>();
const noseTris = new Set<number>();
const earTris = new Set<number>();
for (let t = 0; t < triangleCount; t++) {
  if (hoodTris.has(t)) continue;
  const v0 = triVerts[t][0];
  const x = weldedPos.getX(v0);
  const y = weldedPos.getY(v0);
  if (data.materials[t] === 4) {
    if (y > 1.8) earTris.add(t);
    continue;
  }
  if (Math.abs(x) < 0.5 && y > -2.0) {
    noseTris.add(t);
  } else {
    patchTris.add(t);
  }
}

// Smooth the tiny recessed eye/mouth steps and interpolate harmonic vertex normals across the face dome
// so animated eyes and mouths never leave static cutout shadows behind them.
const adj = Array.from({ length: vertexCount }, () => new Set<number>());
for (const [a, b, c] of triVerts) {
  adj[a].add(b); adj[a].add(c);
  adj[b].add(a); adj[b].add(c);
  adj[c].add(a); adj[c].add(b);
}
const patchVerts = new Set<number>();
for (const t of patchTris) {
  for (const v of triVerts[t]) patchVerts.add(v);
}
const smoothSet = new Set<number>(patchVerts);
for (const v of patchVerts) for (const n of adj[v]) smoothSet.add(n);
for (const v of [...smoothSet]) for (const n of adj[v]) smoothSet.add(n);

for (let iter = 0; iter < 40; iter++) {
  const nextZ = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) nextZ[v] = weldedPos.getZ(v);
  for (const v of smoothSet) {
    let sz = 0, count = 0;
    for (const n of adj[v]) {
      sz += weldedPos.getZ(n);
      count++;
    }
    if (count > 0) nextZ[v] = sz / count;
  }
  for (const v of smoothSet) weldedPos.setZ(v, nextZ[v]);
}

const vNorms = Array.from({ length: vertexCount }, () => [0, 0, 0]);
for (let t = 0; t < triangleCount; t++) {
  if (patchTris.has(t)) continue;
  const [ia, ib, ic] = triVerts[t];
  const ax = weldedPos.getX(ia), ay = weldedPos.getY(ia), az = weldedPos.getZ(ia);
  const ux = weldedPos.getX(ib) - ax, uy = weldedPos.getY(ib) - ay, uz = weldedPos.getZ(ib) - az;
  const vx = weldedPos.getX(ic) - ax, vy = weldedPos.getY(ic) - ay, vz = weldedPos.getZ(ic) - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const idx of [ia, ib, ic]) {
    vNorms[idx][0] += nx;
    vNorms[idx][1] += ny;
    vNorms[idx][2] += nz;
  }
}
for (let v = 0; v < vertexCount; v++) {
  const [nx, ny, nz] = vNorms[v];
  const len = Math.hypot(nx, ny, nz);
  vNorms[v] = len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 1];
}
for (let iter = 0; iter < 50; iter++) {
  const nextN = vNorms.map((n) => [...n]);
  for (const v of smoothSet) {
    let sx = 0, sy = 0, sz = 0;
    for (const n of adj[v]) {
      sx += vNorms[n][0];
      sy += vNorms[n][1];
      sz += vNorms[n][2];
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    nextN[v] = [sx / len, sy / len, sz / len];
  }
  for (const v of smoothSet) vNorms[v] = nextN[v];
}

// Dynamic 1024x1024 canvas texture for Mona's animated face dome (isotropic 7.6-unit UV span).
const TEX_SIZE = 1024;
const UV_SPAN = 7.6;
const UV_X0 = -3.8;
const UV_Y0 = -4.9;
const PX_PER_UNIT = TEX_SIZE / UV_SPAN;
const px = (x: number) => (x - UV_X0) * PX_PER_UNIT;
const py = (y: number) => (UV_Y0 + UV_SPAN - y) * PX_PER_UNIT;
const ps = (d: number) => d * PX_PER_UNIT;

const faceCanvas = document.createElement('canvas');
faceCanvas.width = faceCanvas.height = TEX_SIZE;
const faceCtx = faceCanvas.getContext('2d')!;
const faceTexture = new THREE.CanvasTexture(faceCanvas);
faceTexture.colorSpace = THREE.SRGBColorSpace;
faceTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

const violetColor = data.palette[0];
const whiteColor = data.palette[1];
const blackColor = data.palette[2];
const pinkColor = data.palette[3];

function paintFace(pose: MonaPose) {
  faceCtx.fillStyle = pinkColor;
  faceCtx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Draw both eyes
  const sides = [
    { isLeft: true, cx: -1.72, cy: -0.75, pupilOffsetX: 0.12 },
    { isLeft: false, cx: 1.72, cy: -0.75, pupilOffsetX: -0.12 }
  ];

  for (const { isLeft, cx, cy, pupilOffsetX } of sides) {
    const sideOpen = isLeft ? pose.eyeLeft : pose.eyeRight;
    const openness = Math.max(0.08, pose.eyes * sideOpen);
    const slant = (pose.eyeSlant ?? 0) * (isLeft ? -1 : 1);
    const biasY = (pose.eyeBiasY ?? 0) * (isLeft ? -1 : 1);
    const baseTilt = isLeft ? 0.06 : -0.06;

    const ex = px(cx);
    const ey = py(cy + biasY * 1.4);
    const rx = ps(0.82);
    const ry = ps(1.01);

    if (pose.eyeShape === 'happy' && openness < 0.35) {
      // Winking happy eye arch
      faceCtx.save();
      faceCtx.translate(ex, ey);
      faceCtx.rotate(slant * 0.6);
      faceCtx.lineCap = 'round';
      faceCtx.strokeStyle = whiteColor;
      faceCtx.lineWidth = ps(0.28);
      faceCtx.beginPath();
      faceCtx.arc(0, ps(0.25), rx * 0.78, Math.PI * 1.15, Math.PI * 1.85);
      faceCtx.stroke();
      faceCtx.strokeStyle = blackColor;
      faceCtx.lineWidth = ps(0.20);
      faceCtx.beginPath();
      faceCtx.arc(0, ps(0.25), rx * 0.78, Math.PI * 1.15, Math.PI * 1.85);
      faceCtx.stroke();
      faceCtx.restore();
      continue;
    }

    if (pose.eyeShape === 'sleeping' || openness < 0.22) {
      // Peaceful closed sleeping / blinking eye: clean curved lash arc with outer lash flick
      faceCtx.save();
      faceCtx.translate(ex, ey + ps(0.08));
      faceCtx.rotate((isLeft ? 0.05 : -0.05) + slant * 0.3);
      faceCtx.strokeStyle = blackColor;
      faceCtx.lineWidth = ps(0.19);
      faceCtx.lineCap = 'round';
      faceCtx.lineJoin = 'round';
      const w = rx * 0.78;
      const dip = ps(0.28);
      faceCtx.beginPath();
      faceCtx.moveTo(-w, -dip * 0.15);
      faceCtx.quadraticCurveTo(0, dip, w, -dip * 0.15);
      faceCtx.stroke();
      // Cute outer eyelash flick
      const lashSign = isLeft ? -1 : 1;
      faceCtx.lineWidth = ps(0.14);
      faceCtx.beginPath();
      faceCtx.moveTo(lashSign * w * 0.88, -dip * 0.02);
      faceCtx.lineTo(lashSign * (w * 1.12), -dip * 0.38);
      faceCtx.stroke();
      faceCtx.restore();
      continue;
    }

    // Standard / expressive open sclera
    const scaleX = pose.eyeShape === 'scared' ? 1.08 : 1 + Math.max(0, 1 - openness) * 0.04;
    const scaleY = pose.eyeShape === 'scared'
      ? Math.min(1.32, openness)
      : Math.max(0.52, Math.min(1.24, 0.45 + openness * 0.55));

    faceCtx.save();
    faceCtx.translate(ex, ey);
    faceCtx.rotate(baseTilt + slant * 0.45);

    // Clip to white sclera oval
    faceCtx.beginPath();
    faceCtx.ellipse(0, 0, rx * scaleX, ry * scaleY, 0, 0, Math.PI * 2);
    faceCtx.fillStyle = whiteColor;
    faceCtx.fill();
    faceCtx.save();
    faceCtx.clip();

    const lookX = ps(pupilOffsetX + pose.eyeLookX * 1.45);
    const lookY = ps(0.18 - pose.eyeLookY * 1.55);

    if (pose.eyeShape === 'x') {
      // Bold black X inside the white sclera for error/workflowFailure
      faceCtx.save();
      faceCtx.translate(lookX * 0.35, ps(0.05));
      faceCtx.strokeStyle = blackColor;
      faceCtx.lineWidth = ps(0.26);
      faceCtx.lineCap = 'round';
      const arm = ps(0.46);
      faceCtx.beginPath();
      faceCtx.moveTo(-arm, -arm);
      faceCtx.lineTo(arm, arm);
      faceCtx.moveTo(arm, -arm);
      faceCtx.lineTo(-arm, arm);
      faceCtx.stroke();
      faceCtx.restore();
    } else {
      // Black pupil (stays round rather than squashing flat during squints/half-lids)
      const pScale = pose.pupilScale ?? 1;
      const prx = ps(0.69) * pScale;
      const pry = ps(0.76) * pScale;
      const pyOffset = pose.eyeShape === 'scared' ? ps(0.02 - pose.eyeLookY * 1.2) : lookY;
      faceCtx.fillStyle = blackColor;
      faceCtx.beginPath();
      faceCtx.ellipse(lookX, pyOffset, prx, pry, 0, 0, Math.PI * 2);
      faceCtx.fill();

      // Specular catchlight inside pupil
      if (pose.eyeShape === 'scared') {
        faceCtx.fillStyle = whiteColor;
        faceCtx.beginPath();
        faceCtx.arc(lookX - prx * 0.32, pyOffset - pry * 0.32, ps(0.11), 0, Math.PI * 2);
        faceCtx.arc(lookX + prx * 0.28, pyOffset + pry * 0.24, ps(0.06), 0, Math.PI * 2);
        faceCtx.fill();
      } else {
        faceCtx.fillStyle = whiteColor;
        faceCtx.beginPath();
        faceCtx.arc(lookX - prx * 0.28, pyOffset - pry * 0.30, ps(pose.eyeShape === 'curious' || pose.eyeShape === 'happy' ? 0.15 : 0.11), 0, Math.PI * 2);
        faceCtx.fill();
      }

      // Happy lower eyelid smile curve
      if (pose.eyeShape === 'happy') {
        faceCtx.fillStyle = pinkColor;
        faceCtx.beginPath();
        faceCtx.ellipse(0, ry * scaleY * 0.95, rx * 1.05, ry * 0.55, 0, 0, Math.PI * 2);
        faceCtx.fill();
      }

      // Upper eyelid droop when squinting, working, or half-lidded (offline)
      const lidDroop = pose.eyeShape === 'working'
        ? 0.34
        : openness < 0.88
          ? Math.min(0.55, (0.92 - openness) * 0.85)
          : 0;
      if (lidDroop > 0.02) {
        const lidY = -ry * scaleY + ry * scaleY * lidDroop * 1.35;
        faceCtx.fillStyle = pinkColor;
        faceCtx.fillRect(-rx * 1.2, -ry * 1.4, rx * 2.4, lidY + ry * 1.4);
        faceCtx.strokeStyle = blackColor;
        faceCtx.lineWidth = ps(0.14);
        faceCtx.beginPath();
        faceCtx.moveTo(-rx * 1.05, lidY);
        faceCtx.quadraticCurveTo(0, lidY + ps(0.06), rx * 1.05, lidY);
        faceCtx.stroke();
      }
    }

    faceCtx.restore(); // unclip sclera
    faceCtx.restore();

    // Expressive eyebrow / lid accents for scared, error, curious, thinking
    if (pose.eyeShape === 'scared' || pose.eyeShape === 'curious') {
      faceCtx.save();
      faceCtx.translate(ex, ey - ry * Math.min(1.18, scaleY) - ps(0.18));
      faceCtx.rotate((isLeft ? -0.28 : 0.28) * (pose.eyeShape === 'scared' ? 1.15 : 0.75));
      faceCtx.strokeStyle = blackColor;
      faceCtx.lineWidth = ps(0.14);
      faceCtx.lineCap = 'round';
      faceCtx.beginPath();
      faceCtx.arc(0, ps(0.35), rx * 0.65, Math.PI * 1.22, Math.PI * 1.78);
      faceCtx.stroke();
      faceCtx.restore();
    } else if (pose.eyeShape === 'x') {
      faceCtx.save();
      faceCtx.translate(ex, ey - ry * scaleY - ps(0.12));
      faceCtx.rotate(isLeft ? 0.26 : -0.26);
      faceCtx.strokeStyle = blackColor;
      faceCtx.lineWidth = ps(0.15);
      faceCtx.lineCap = 'round';
      faceCtx.beginPath();
      faceCtx.moveTo(-rx * 0.55, 0);
      faceCtx.lineTo(rx * 0.55, 0);
      faceCtx.stroke();
      faceCtx.restore();
    }
  }

  // Draw mouth around (x = 0.08, y = -2.46)
  const mx = px(0.06);
  const my = py(-2.46);
  faceCtx.save();
  faceCtx.translate(mx, my);
  faceCtx.strokeStyle = blackColor;
  faceCtx.fillStyle = blackColor;
  faceCtx.lineCap = 'round';
  faceCtx.lineJoin = 'round';

  switch (pose.mouthShape) {
    case 'scared': {
      // Wide trembling gasped 'O' mouth
      const w = ps(0.46);
      const h = ps(0.32);
      faceCtx.beginPath();
      faceCtx.ellipse(0, ps(0.04), w, h, 0, 0, Math.PI * 2);
      faceCtx.fill();
      break;
    }
    case 'wavy': {
      // Distressed wavy mouth for workflow/error
      const w = ps(0.56);
      const a = ps(0.11);
      faceCtx.lineWidth = ps(0.16);
      faceCtx.beginPath();
      faceCtx.moveTo(-w, a * 0.4);
      faceCtx.bezierCurveTo(-w * 0.45, -a * 1.4, -w * 0.1, a * 1.4, 0, 0);
      faceCtx.bezierCurveTo(w * 0.1, -a * 1.4, w * 0.45, a * 1.4, w, -a * 0.4);
      faceCtx.stroke();
      break;
    }
    case 'happy': {
      // Joyful open smile
      const w = ps(0.62);
      faceCtx.lineWidth = ps(0.17);
      faceCtx.beginPath();
      faceCtx.arc(0, -ps(0.18), w, Math.PI * 0.14, Math.PI * 0.86);
      faceCtx.stroke();
      break;
    }
    case 'curious': {
      // Hopeful cat ':3' / pleading curve
      const r = ps(0.28);
      faceCtx.lineWidth = ps(0.15);
      faceCtx.beginPath();
      faceCtx.arc(-r * 0.9, -ps(0.06), r, Math.PI * 0.12, Math.PI * 0.88);
      faceCtx.arc(r * 0.9, -ps(0.06), r, Math.PI * 0.12, Math.PI * 0.88);
      faceCtx.stroke();
      break;
    }
    case 'flat': {
      // Focused working flat mouth
      const w = ps(0.42);
      faceCtx.lineWidth = ps(0.15);
      faceCtx.beginPath();
      faceCtx.moveTo(-w, 0);
      faceCtx.quadraticCurveTo(0, ps(0.05), w, -ps(0.02));
      faceCtx.stroke();
      break;
    }
    case 'sleeping': {
      // Sweet, peaceful little cat smile 'ω' while sleeping
      const r = ps(0.22);
      faceCtx.lineWidth = ps(0.14);
      faceCtx.beginPath();
      faceCtx.arc(-r * 0.88, -ps(0.05), r, Math.PI * 0.15, Math.PI * 0.85);
      faceCtx.arc(r * 0.88, -ps(0.05), r, Math.PI * 0.15, Math.PI * 0.85);
      faceCtx.stroke();
      break;
    }
    default: {
      // Signature Mona asymmetric smile (shifts slightly with gaze during thinking)
      const shift = ps(pose.eyeLookX * 0.25);
      const w = ps(0.55);
      faceCtx.lineWidth = ps(0.16);
      faceCtx.beginPath();
      faceCtx.moveTo(-w * 0.85 + shift, -ps(0.02));
      faceCtx.quadraticCurveTo(w * 0.1 + shift, ps(0.22), w + shift, -ps(0.12));
      faceCtx.stroke();
      break;
    }
  }
  faceCtx.restore();
  faceTexture.needsUpdate = true;
}

function buildPartGeometry(filter: (t: number) => boolean, withUv = false): THREE.BufferGeometry {
  const vertices: number[] = [];
  const normalValues: number[] = [];
  const uvs: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    if (!filter(t)) continue;
    for (const v of triVerts[t]) {
      const x = weldedPos.getX(v), y = weldedPos.getY(v), z = weldedPos.getZ(v);
      vertices.push(x, y, z);
      normalValues.push(vNorms[v][0], vNorms[v][1], vNorms[v][2]);
      if (withUv) {
        uvs.push((x - UV_X0) / UV_SPAN, (y - UV_Y0) / UV_SPAN);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalValues, 3));
  if (withUv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

const model = new THREE.Group();
model.add(new THREE.Mesh(
  buildPartGeometry((t) => hoodTris.has(t)),
  new THREE.MeshStandardMaterial({ color: violetColor, roughness: 0.72, metalness: 0 })
));
model.add(new THREE.Mesh(
  buildPartGeometry((t) => earTris.has(t)),
  new THREE.MeshStandardMaterial({ color: pinkColor, roughness: 0.72, metalness: 0 })
));
model.add(new THREE.Mesh(
  buildPartGeometry((t) => noseTris.has(t)),
  new THREE.MeshStandardMaterial({ color: blackColor, roughness: 0.72, metalness: 0 })
));
model.add(new THREE.Mesh(
  buildPartGeometry((t) => !hoodTris.has(t) && !earTris.has(t) && !noseTris.has(t), true),
  new THREE.MeshStandardMaterial({ map: faceTexture, roughness: 0.72, metalness: 0 })
));

const bounds = new THREE.Box3().setFromObject(model);
const center = bounds.getCenter(new THREE.Vector3());
const extent = bounds.getSize(new THREE.Vector3());
model.position.copy(center).negate();
const normalization = new THREE.Group();
normalization.add(model);
normalization.scale.setScalar(2.46 / Math.max(extent.x, extent.y));
const character = new THREE.Group();
character.add(normalization);
scene.add(character);

// 3D glossy blue sweat drop (used in mona-tool effort and mona-security scared)
const dropShape = new THREE.Shape();
dropShape.moveTo(0, 0.14);
dropShape.bezierCurveTo(-0.025, 0.055, -0.075, 0.01, -0.07, -0.035);
dropShape.bezierCurveTo(-0.065, -0.105, 0.065, -0.105, 0.07, -0.035);
dropShape.bezierCurveTo(0.075, 0.01, 0.025, 0.055, 0, 0.14);
const sweatMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x37bfff, roughness: 0.22, metalness: 0, clearcoat: 0.8,
  transparent: true, opacity: 0, depthWrite: false
});
const sweat = new THREE.Mesh(new THREE.ExtrudeGeometry(dropShape, {
  depth: 0.02, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3, curveSegments: 20
}), sweatMaterial);
sweat.rotation.z = -0.15;
character.add(sweat);

const POSTER_TIMES: Record<string, number> = {
  'mona-idle': 0,
  'mona-thinking': 0.8,
  'mona-tool': 2.2,
  'mona-pr': 0,
  'mona-done': 2.04,
  'mona-workflow': 0.9,
  'mona-security': 1.1,
  'mona-offline': 0
};

function renderFrame(clip: string, time: number) {
  const pose = monaMotionAt(clip, time);
  paintFace(pose);
  character.rotation.order = 'YXZ';
  character.rotation.set(pose.pitch, pose.yaw, pose.roll);
  const depthScale = 1 + (pose.z ?? 0) * 0.10;
  character.scale.setScalar(pose.scale * depthScale);
  character.position.set(pose.x ?? 0, pose.y, pose.z ?? 0);
  sweat.visible = pose.sweatOpacity > 0.001;
  sweatMaterial.opacity = pose.sweatOpacity * 0.92;
  sweat.position.set(0.86, 0.32 - pose.sweatFall, 0.95);
  renderer.render(scene, camera);
}
window.renderAtlas = ({ mood, frames, fps, columns }) => {
  const atlas = document.createElement('canvas');
  atlas.width = columns * size;
  atlas.height = Math.ceil(frames / columns) * size;
  const context = atlas.getContext('2d')!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  for (let frame = 0; frame < frames; frame++) {
    renderFrame(mood, frame / fps);
    context.drawImage(renderer.domElement, frame % columns * size, Math.floor(frame / columns) * size, size, size);
  }
  return atlas.toDataURL('image/webp', settings.webpQuality).split(',')[1];
};
window.renderPoster = (clip = 'mona-pr', time?: number) => {
  renderFrame(clip, time ?? POSTER_TIMES[clip] ?? 0.75);
  const poster = document.createElement('canvas');
  poster.width = poster.height = size;
  const context = poster.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(renderer.domElement, 0, 0, size, size);
  return poster.toDataURL('image/png').split(',')[1];
};
renderFrame('mona-pr', 0);
window.rendererSettings = settings;
window.rendererReady = true;
