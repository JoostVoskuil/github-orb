export const POSES = {
  front: 'copilot-looking-frontal.png',
  left: 'copilot-looking-center-left.png',
  right: 'copilot-looking-center-right.png',
  side: 'copilot-looking-left.png',
  down: 'copilot-looking-down.png',
  downLeft: 'copilot-looking-down-left3.png',
  sideSoft: 'copilot-looking-left2.png',
  downRight: 'copilot-looking-right-down.png',
  glow: 'copilot-front.png',
  drop: 'copilot-drop.png'
};

const SEQUENCES = {
  idle: ['down'],
  thinking: ['front', 'left', 'front', 'right'],
  tool: ['downRight'],
  needsInput: ['front'],
  done: ['glow'],
  error: ['down'],
  disconnected: ['down']
};

export function poseAt(mood, elapsedSec) {
  const sequence = SEQUENCES[mood] ?? SEQUENCES.idle;
  const holdSec = 8;
  return sequence[Math.floor(Math.max(0, elapsedSec) / holdSec) % sequence.length];
}

export function alphaBounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export class Artwork {
  assets: Map<string, { canvas: HTMLCanvasElement; bounds: { x: number; y: number; width: number; height: number } }>;
  weights: Map<string, number>;
  lastFrame: number | null;

  constructor() {
    this.assets = new Map();
    this.weights = new Map();
    this.lastFrame = null;
  }

  async load() {
    const results = await Promise.allSettled(Object.entries(POSES).map(async ([pose, filename]) => {
      const image = new Image();
      image.src = `/media/images/${filename}`;
      await image.decode();
      const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const bounds = alphaBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (!bounds) throw new Error(`Empty artwork: ${filename}`);
      this.assets.set(pose, { canvas, bounds });
    }));
    return results.filter((result) => result.status === 'rejected').length;
  }

  drawAsset(ctx, pose: string) {
    const { canvas, bounds: b } = this.assets.get(pose);
    const scale = Math.min(320 / b.width, 310 / b.height);
    const width = b.width * scale, height = b.height * scale;
    ctx.drawImage(canvas, b.x, b.y, b.width, b.height, -width / 2, -height / 2, width, height);
  }

  drawPose(ctx, mood, now, enteredAt) {
    if (!this.assets.size) return false;
    const desired = poseAt(mood, Math.max(0, now - enteredAt) / 1000);
    this.drawAsset(ctx, this.assets.has(desired) ? desired : this.assets.has('front') ? 'front' : this.assets.keys().next().value);
    return true;
  }

  draw(ctx, mood, now, enteredAt, transitionMs) {
    if (!this.assets.size) return false;
    const elapsed = Math.max(0, (now - enteredAt) / 1000);
    const desired = poseAt(mood, elapsed);
    const target = this.assets.has(desired) ? desired : this.assets.has('front') ? 'front' : this.assets.keys().next().value;
    const dt = this.lastFrame == null ? 0 : Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.weights.size) this.weights.set(target, 1);
    if (!this.weights.has(target)) this.weights.set(target, 0);
    const blend = 1 - Math.exp(-dt * 1000 / Math.max(30, transitionMs / 3));
    for (const [pose, weight] of this.weights) {
      const next = weight + ((pose === target ? 1 : 0) - weight) * blend;
      if (next < 0.001 && pose !== target) this.weights.delete(pose);
      else this.weights.set(pose, next);
    }

    ctx.save();
    const breath = 1 + Math.sin(now / 1000 * 0.7) * (mood === 'idle' ? 0.006 : 0.002);
    ctx.scale(breath, breath);
    // Additive blending preserves opaque pixels while two transparent poses overlap.
    ctx.globalCompositeOperation = 'lighter';
    for (const [pose, weight] of this.weights) {
      ctx.globalAlpha = weight;
      this.drawAsset(ctx, pose);
    }
    ctx.restore();
    return true;
  }
}