import { frameIndex, CLIPS } from './motion.js';

export interface AnimationClip {
  frames: number;
  fps: number;
  columns: number;
  loop: boolean;
  file: string;
  sha256?: string;
  duration?: number;
}

export interface AnimationManifest {
  version: number;
  frameSize: number;
  clips: Record<string, AnimationClip>;
  source?: unknown;
  characters?: Record<string, { source?: unknown }>;
  render?: unknown;
  fps?: number;
  columns?: number;
}

export function validateManifest(manifest: any): AnimationManifest {
  if (manifest.version !== 1 || !Number.isInteger(manifest.frameSize) || manifest.frameSize < 1 || manifest.frameSize > 1024) {
    throw new Error('Unsupported animation manifest');
  }
  for (const mood of Object.keys(CLIPS)) {
    if (!manifest.clips?.[mood]) throw new Error(`Invalid animation clip: ${mood}`);
  }
  for (const mood of Object.keys(manifest.clips)) {
    const clip = manifest.clips?.[mood];
    if (!clip || !Number.isInteger(clip.frames) || clip.frames < 1 || !Number.isInteger(clip.columns) || clip.columns < 1 ||
      !Number.isFinite(clip.fps) || clip.fps <= 0 || typeof clip.loop !== 'boolean' || !/^[\w-]+\.webp$/.test(clip.file)) {
      throw new Error(`Invalid animation clip: ${mood}`);
    }
  }
  return manifest as AnimationManifest;
}

export class Frames {
  manifest: AnimationManifest | null;
  atlases: Map<string, HTMLImageElement>;
  createCanvas: () => HTMLCanvasElement;
  current: any;
  transition: any;

  constructor(createCanvas = () => document.createElement('canvas')) {
    this.manifest = null;
    this.atlases = new Map();
    this.createCanvas = createCanvas;
    this.current = null;
    this.transition = null;
  }

  async load() {
    const response = await fetch('/media/animations/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Frame manifest: HTTP ${response.status}`);
    this.manifest = validateManifest(await response.json());
    const results = await Promise.allSettled(Object.entries(this.manifest.clips).map(async ([mood, clip]) => {
      const image = new Image();
      image.src = `/media/animations/${clip.file}${clip.sha256 ? `?v=${clip.sha256}` : ''}`;
      await image.decode();
      const size = this.manifest.frameSize;
      if (image.naturalWidth !== clip.columns * size || image.naturalHeight !== Math.ceil(clip.frames / clip.columns) * size) {
        throw new Error(`Wrong atlas size: ${mood}`);
      }
      this.atlases.set(mood, image);
    }));
    return results.filter((result) => result.status === 'rejected').length;
  }

  drawClip(ctx, mood, now, enteredAt) {
    const image = this.atlases.get(mood);
    if (!image) return false;
    const clip = this.manifest.clips[mood];
    const index = frameIndex(clip, (now - enteredAt) / 1000);
    const size = this.manifest.frameSize;
    ctx.drawImage(image, index % clip.columns * size, Math.floor(index / clip.columns) * size, size, size,
      -size / 2, -size / 2, size, size);
    return true;
  }

  canvas() {
    const canvas = this.createCanvas();
    canvas.width = canvas.height = this.manifest.frameSize;
    return canvas;
  }

  paint(ctx, now) {
    const size = this.manifest.frameSize;
    const transition = this.transition;
    if (!transition) return this.drawClip(ctx, this.current.mood, now, this.current.enteredAt);
    const progress = Math.max(0, Math.min(1, (now - transition.at) / transition.duration));
    if (progress === 1) {
      this.transition = null;
      return this.drawClip(ctx, this.current.mood, now, this.current.enteredAt);
    }
    const weight = progress * progress * (3 - 2 * progress);
    const blend = transition.blend.getContext('2d');
    blend.clearRect(0, 0, size, size);
    blend.save();
    blend.translate(size / 2, size / 2);
    // Add premultiplied pixels offscreen: ordinary source-over crossfades
    // darken the overlapping opaque parts of the character halfway through.
    blend.globalAlpha = 1 - weight;
    blend.drawImage(transition.from, -size / 2, -size / 2);
    blend.globalCompositeOperation = 'lighter';
    blend.globalAlpha = weight;
    this.drawClip(blend, this.current.mood, now, this.current.enteredAt);
    blend.restore();
    ctx.drawImage(transition.blend, -size / 2, -size / 2);
    return true;
  }

  draw(ctx, mood, now, enteredAt, transitionMs = 450) {
    if (!this.atlases.has(mood)) {
      this.current = null;
      this.transition = null;
      return false;
    }
    if (!this.current || this.current.mood !== mood || this.current.enteredAt !== enteredAt) {
      if (this.current && transitionMs > 0) {
        const from = this.canvas();
        const snapshot = from.getContext('2d');
        snapshot.translate(from.width / 2, from.height / 2);
        this.paint(snapshot, now);
        this.transition = { from, blend: this.canvas(), at: now, duration: transitionMs };
      } else {
        this.transition = null;
      }
      this.current = { mood, enteredAt };
    }
    return this.paint(ctx, now);
  }
}