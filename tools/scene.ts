import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { motionAt } from '../dashboard/motion.js';
import { modelRegions } from './model-regions.js';

const look = await (await fetch('/media/copilot/reference-look.json')).json();
const { palette, samples } = look;
const size = look.frameSize;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('render'), alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(size, size);
renderer.setPixelRatio(look.supersampling);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1.65, 1.65, 1.65, -1.65, 0.1, 30);
camera.position.set(0, 0.1, 8);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xcbd6ff, 0x151025, 1.2));
const light = (color: THREE.ColorRepresentation, power: number, position: [number, number, number]) => {
  const lamp = new THREE.DirectionalLight(color, power);
  lamp.position.set(...position);
  scene.add(lamp);
};
light(0xf6d1ff, 2.5, [-3, 5, 5]);
light(samples.rimHighlight, 1.7, [4, 1, 3]);
light(samples.shellHighlight, 2.8, [1, 3, -4]);

function texture(paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  paint(canvas.getContext('2d'));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return map;
}

const lensMap = texture((ctx) => {
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, samples.lens);
  gradient.addColorStop(1, palette.lensBase);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = `${samples.shellHighlight}28`;
  ctx.beginPath();
  ctx.ellipse(90, -65, 260, 190, -0.16, 0, Math.PI * 2);
  ctx.fill();
});
const faceMap = texture((ctx) => {
  const gradient = ctx.createRadialGradient(45, 240, 5, 128, 128, 230);
  gradient.addColorStop(0, '#172da0');
  gradient.addColorStop(0.5, samples.face);
  gradient.addColorStop(1, palette.faceEdge);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
});
const eyeMap = texture((ctx) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, samples.eye);
  gradient.addColorStop(1, samples.eyeHighlight);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#006a8945';
  for (let y = 0; y < 256; y += 16) ctx.fillRect(0, y, 256, 5);
});

const data = await (await fetch('/media/copilot/mesh.json')).json();
const regions = modelRegions(data);
const whole = new THREE.BufferGeometry();
whole.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
whole.rotateX(-Math.PI / 2);
const welded = mergeVertices(whole, 0.001);
welded.computeVertexNormals();
const normals = welded.toNonIndexed().getAttribute('normal');
const pools = { shell: [], face: [], lensLeft: [], lensRight: [], eyeLeft: [], eyeRight: [] };
const normalPools = Object.fromEntries(Object.keys(pools).map((part) => [part, []]));
const shellColors = [];
const shellColor = new THREE.Color(palette.shell);
const trimColor = new THREE.Color(palette.trim);
for (let i = 0; i < data.paint.length; i++) {
  const triangle = data.positions.slice(i * 9, i * 9 + 9);
  const part = regions.labels[i];
  pools[part].push(...triangle);
  for (let vertex = i * 3; vertex < i * 3 + 3; vertex++) {
    normalPools[part].push(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex));
    if (part === 'shell') {
      const color = shellColor.clone().lerp(trimColor, regions.weights[vertex]);
      shellColors.push(color.r, color.g, color.b);
    }
  }
}
const materials = {
  shell: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0, clearcoat: 0.25 }),
  face: new THREE.MeshPhysicalMaterial({ map: faceMap, roughness: 0.65, metalness: 0 }),
  lenses: new THREE.MeshBasicMaterial({ map: lensMap, toneMapped: false }),
  eyes: new THREE.MeshBasicMaterial({ map: eyeMap, toneMapped: false })
};
const head = new THREE.Group();
const model = new THREE.Group();
const eyeParts = [];
let faceBounds;
for (const [part, vertices] of Object.entries(pools)) {
  const isEye = part === 'eyeLeft' || part === 'eyeRight';
  const isLens = part === 'lensLeft' || part === 'lensRight';
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  raw.rotateX(-Math.PI / 2);
  raw.setAttribute('normal', new THREE.Float32BufferAttribute(normalPools[part], 3));
  if (part === 'shell') raw.setAttribute('color', new THREE.Float32BufferAttribute(shellColors, 3));
  if (part === 'face' || isLens || isEye) {
    raw.computeBoundingBox();
    const bounds = raw.boundingBox;
    if (part === 'face') faceBounds = bounds.clone();
    const positions = raw.getAttribute('position');
    const uv = [];
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const u = (x - bounds.min.x) / width;
      uv.push(u, (positions.getY(i) - bounds.min.y) / height);
    }
    raw.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  const geometry = mergeVertices(raw, 0.001);
  const mesh = new THREE.Mesh(geometry, isEye ? materials.eyes : isLens ? materials.lenses : materials[part]);
  if (isEye) {
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    mesh.position.copy(center);
    const backingGeometry = geometry.clone();
    const backingPositions = backingGeometry.getAttribute('position');
    const backingUV = [];
    for (let i = 0; i < backingPositions.count; i++) {
      backingUV.push(
        (backingPositions.getX(i) + center.x - faceBounds.min.x) / (faceBounds.max.x - faceBounds.min.x),
        (backingPositions.getY(i) + center.y - faceBounds.min.y) / (faceBounds.max.y - faceBounds.min.y)
      );
    }
    backingGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(backingUV, 2));
    const backing = new THREE.Mesh(backingGeometry, materials.face);
    backing.position.copy(center);
    backing.position.z -= 0.005;
    model.add(backing);
    // The print mesh is a curved surface patch, not a movable eye rig.
    // Project its outline onto a plane in front of the panel so squinting,
    // blinking and looking around cannot push triangles through the face.
    const eyePositions = geometry.getAttribute('position');
    for (let i = 0; i < eyePositions.count; i++) eyePositions.setZ(i, 0);
    eyePositions.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    mesh.position.z = faceBounds.max.z + 0.015;
    const points = Array.from({ length: 17 }, (_, i) => {
      const u = i / 16;
      return new THREE.Vector3((u - 0.5) * size.x * 1.3, Math.sin(u * Math.PI) * size.x * 0.55 - size.x * 0.2, 0);
    });
    const arc = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, size.x * 0.13, 8, false), materials.eyes);
    arc.position.copy(center);
    arc.position.z += size.z / 2 + 0.05;
    arc.visible = false;
    model.add(arc);
    const crossed = new THREE.Group();
    const radius = size.x * 0.12;
    const half = size.x * 0.6;
    for (const direction of [-1, 1]) {
      const a = new THREE.Vector3(-half, -half * direction, 0);
      const b = new THREE.Vector3(half, half * direction, 0);
      crossed.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, radius, 8, false), materials.eyes));
      for (const point of [a, b]) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), materials.eyes);
        cap.position.copy(point);
        crossed.add(cap);
      }
    }
    crossed.position.copy(arc.position);
    crossed.visible = false;
    model.add(crossed);
    eyeParts.push({ mesh, arc, crossed, anchor: mesh.position.clone(), arcAnchor: arc.position.clone(), side: part });
  }
  model.add(mesh);
}
const bounds = new THREE.Box3().setFromObject(model);
const center = bounds.getCenter(new THREE.Vector3());
model.position.copy(center).negate();
const normalization = new THREE.Group();
normalization.add(model);
normalization.scale.setScalar(2.75 / bounds.getSize(new THREE.Vector3()).x);
head.add(normalization);
scene.add(head);

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
head.add(sweat);

function renderFrame(mood, time) {
  const motion = motionAt(mood, time);
  head.rotation.order = 'YXZ';
  head.rotation.set(motion.pitch, motion.yaw, motion.roll);
  const depthScale = 1 + (motion.z ?? 0) * 0.16;
  head.scale.setScalar(motion.scale * depthScale);
  head.position.set(motion.x ?? 0, motion.y, motion.z ?? 0);
  for (const eye of eyeParts) {
    const happy = motion.eyeShape === 'happy';
    const crossed = motion.eyeShape === 'x';
    const isLeft = eye.side === 'eyeLeft';
    const openness = motion.eyes * motion[eye.side];
    const slant = (motion.eyeSlant ?? 0) * (isLeft ? 1 : -1);
    const biasY = (motion.eyeBiasY ?? 0) * (isLeft ? -1 : 1);
    eye.mesh.visible = !happy && !crossed;
    eye.arc.visible = happy;
    eye.crossed.visible = crossed;
    eye.mesh.scale.set(1 + Math.max(0, 1 - openness) * 0.08, openness, 1);
    eye.mesh.rotation.z = slant;
    eye.mesh.position.copy(eye.anchor);
    eye.mesh.position.x += motion.eyeLookX;
    eye.mesh.position.y += motion.eyeLookY + biasY;
    eye.arc.scale.set(1 + Math.max(0, 1 - openness) * 0.14, openness, 1);
    eye.arc.rotation.z = slant;
    eye.arc.position.copy(eye.arcAnchor);
    eye.arc.position.x += motion.eyeLookX;
    eye.arc.position.y += motion.eyeLookY + biasY;
  }
  sweat.visible = motion.sweatOpacity > 0.001;
  sweatMaterial.opacity = motion.sweatOpacity * 0.9;
  sweat.position.set(0.9, 0.4 - motion.sweatFall, 1.0);
  materials.eyes.color.setScalar(mood === 'disconnected' ? 0.55 : (motion.eyeGlow ?? 1));
  renderer.render(scene, camera);
}

window.renderAtlas = ({ mood, frames, fps, columns }) => {
  const atlas = document.createElement('canvas');
  atlas.width = columns * size;
  atlas.height = Math.ceil(frames / columns) * size;
  const ctx = atlas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let frame = 0; frame < frames; frame++) {
    renderFrame(mood, frame / fps);
    ctx.drawImage(renderer.domElement, frame % columns * size, Math.floor(frame / columns) * size, size, size);
  }
  return atlas.toDataURL('image/webp', look.webpQuality).split(',')[1];
};
window.renderPoster = (mood = 'thinking', time = 0) => {
  renderFrame(mood, time);
  return renderer.domElement.toDataURL('image/png').split(',')[1];
};
renderFrame('thinking', 0);
window.rendererSettings = look;
window.rendererReady = true;