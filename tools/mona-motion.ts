import { motionAt } from '../dashboard/motion.js';

export const MONA_CLIPS = {
  'mona-idle': { duration: 8, loop: true, mascot: 'mona', kind: 'idle', mood: 'idle' },
  'mona-thinking': { duration: 8, loop: true, mascot: 'mona', kind: 'thinking', mood: 'thinking' },
  'mona-tool': { duration: 8, loop: true, mascot: 'mona', kind: 'tool', mood: 'tool' },
  'mona-pr': { duration: 8, loop: true, mascot: 'mona', kind: 'pr', mood: 'needsInput' },
  'mona-done': { duration: 3, loop: false, mascot: 'mona', kind: 'done', mood: 'done' },
  'mona-workflow': { duration: 3, loop: false, mascot: 'mona', kind: 'workflow', mood: 'error' },
  'mona-security': { duration: 3, loop: false, mascot: 'mona', kind: 'security', mood: 'error' },
  'mona-offline': { duration: 8, loop: true, mascot: 'mona', kind: 'offline', mood: 'disconnected' }
} as const;

export type MonaClipName = keyof typeof MONA_CLIPS;
export type MonaEyeShape = 'normal' | 'sleeping' | 'thinking' | 'working' | 'curious' | 'happy' | 'x' | 'scared';
export type MonaMouthShape = 'smile' | 'sleeping' | 'thinking' | 'flat' | 'curious' | 'happy' | 'wavy' | 'scared';

export interface MonaPose {
  yaw: number;
  roll: number;
  pitch: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  eyes: number;
  eyeLeft: number;
  eyeRight: number;
  eyeLookX: number;
  eyeLookY: number;
  eyeSlant: number;
  eyeBiasY: number;
  eyeShape: MonaEyeShape;
  pupilScale: number;
  mouthShape: MonaMouthShape;
  sweatOpacity: number;
  sweatFall: number;
}

const CLIP_COPILOT_MOOD: Record<MonaClipName, string> = {
  'mona-idle': 'idle',
  'mona-thinking': 'thinking',
  'mona-tool': 'tool',
  'mona-pr': 'needsInput',
  'mona-done': 'done',
  'mona-workflow': 'error',
  'mona-security': 'error',
  'mona-offline': 'disconnected'
};

const CLIP_MOUTH: Record<MonaClipName, MonaMouthShape> = {
  'mona-idle': 'sleeping',
  'mona-thinking': 'thinking',
  'mona-tool': 'flat',
  'mona-pr': 'curious',
  'mona-done': 'happy',
  'mona-workflow': 'wavy',
  'mona-security': 'scared',
  'mona-offline': 'flat'
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function quintic(u: number): number {
  const c = clamp01(u);
  return c * c * c * (10 - 15 * c + 6 * c * c);
}

function pulseWindow(t: number, start: number, end: number): number {
  if (t <= start || t >= end) return 0;
  return Math.sin(((t - start) / (end - start)) * Math.PI) ** 2;
}

function plateau(t: number, riseStart: number, riseEnd: number, fallStart: number, fallEnd: number): number {
  if (t <= riseStart || t >= fallEnd) return 0;
  if (t < riseEnd) return quintic((t - riseStart) / (riseEnd - riseStart));
  if (t <= fallStart) return 1;
  return 1 - quintic((t - fallStart) / (fallEnd - fallStart));
}

const zero = (value: number): number => (value === 0 ? 0 : value);

export function monaMotionAt(clip: string, time: number): MonaPose {
  if (!Object.hasOwn(MONA_CLIPS, clip)) throw new Error(`Unknown Mona clip: ${clip}`);
  const name = clip as MonaClipName;

  if (name === 'mona-idle') {
    // Cozy resting/sleeping Mona: gentle head tilt so her face stays upright and readable,
    // soft rhythmic breathing nod, and peaceful closed sleeping eyes.
    const t = Math.max(0, time) % MONA_CLIPS[name].duration;
    const phase = (t / MONA_CLIPS[name].duration) * Math.PI * 2;
    const wave = Math.sin(phase);
    const cos = Math.cos(phase);
    const breath = -cos;
    return {
      yaw: zero(wave * 0.065),
      pitch: zero(0.055 + breath * 0.045 + Math.sin(phase * 2) * 0.012),
      roll: zero(0.11 + wave * 0.03),
      x: zero(wave * 0.01),
      y: zero(-0.012 + cos * 0.016),
      z: zero(-0.025 + cos * 0.02),
      scale: zero(1 + cos * 0.0035),
      eyes: zero(0.12 + 0.02 * cos),
      eyeLeft: 1,
      eyeRight: 1,
      eyeLookX: 0,
      eyeLookY: -0.04,
      eyeSlant: 0,
      eyeBiasY: 0,
      eyeShape: 'sleeping',
      pupilScale: 1,
      mouthShape: 'sleeping',
      sweatOpacity: 0,
      sweatFall: 0
    };
  }
  if (name === 'mona-security') {
    // Scared Mona: startled pullback, wide shocked eyes with tiny trembling pupils,
    // nervous high-frequency shiver, darting glances, gasped mouth, and cold sweat drop.
    // Settles at 2.5s leaving 6 stable closing frames at 12 fps.
    const t = Math.min(MONA_CLIPS[name].duration, Math.max(0, time));
    const activeEnd = 2.5;
    const shiverEnv = t < activeEnd ? Math.sin((t / activeEnd) * Math.PI) ** 1.15 : 0;
    const startle = pulseWindow(t, 0.02, 0.38);
    const recoil = plateau(t, 0.04, 0.24, 2.02, 2.48);
    const dartLeft = plateau(t, 0.48, 0.66, 1.02, 1.22);
    const dartRight = plateau(t, 1.26, 1.44, 1.82, 2.04);
    const shiverYaw = Math.sin(t * Math.PI * 2 * 5.5) * 0.12 * shiverEnv;
    const shiverRoll = Math.cos(t * Math.PI * 2 * 5.5) * 0.09 * shiverEnv;
    const sweatDrop = clamp01((t - 0.35) / 1.85);
    const sweating = t > 0.35 && t < 2.2;
    return {
      yaw: zero((dartLeft - dartRight) * 0.22 + shiverYaw),
      pitch: zero(-0.11 * startle + 0.14 * recoil + Math.sin(t * Math.PI * 2 * 4) * 0.03 * shiverEnv),
      roll: zero(shiverRoll + (dartLeft - dartRight) * 0.05),
      x: zero((dartLeft - dartRight) * 0.018 + shiverYaw * 0.08),
      y: zero(0.042 * startle - 0.028 * recoil),
      z: zero(-0.15 * recoil),
      scale: zero(1 - 0.003 * recoil),
      eyes: 1,
      eyeLeft: zero(1.24 + 0.08 * shiverEnv),
      eyeRight: zero(1.24 + 0.08 * shiverEnv),
      eyeLookX: zero((dartLeft - dartRight) * 0.16 + Math.sin(t * Math.PI * 2 * 7) * 0.025 * shiverEnv),
      eyeLookY: zero(0.06 * recoil - 0.04 * startle),
      eyeSlant: zero(0.18 + 0.06 * shiverEnv),
      eyeBiasY: zero(0.02 * recoil),
      eyeShape: 'scared',
      pupilScale: zero(0.56 - 0.10 * shiverEnv),
      mouthShape: 'scared',
      sweatOpacity: zero(sweating ? Math.sin(sweatDrop * Math.PI) ** 2 : 0),
      sweatFall: zero(sweating ? sweatDrop * 0.28 : 0)
    };
  }

  const base = motionAt(CLIP_COPILOT_MOOD[name], time);
  return {
    yaw: zero(base.yaw),
    pitch: zero(base.pitch),
    roll: zero(base.roll),
    x: zero(base.x ?? 0),
    y: zero(base.y),
    z: zero(base.z ?? 0),
    scale: zero(base.scale),
    eyes: zero(base.eyes),
    eyeLeft: zero(base.eyeLeft),
    eyeRight: zero(base.eyeRight),
    eyeLookX: zero(base.eyeLookX),
    eyeLookY: zero(base.eyeLookY),
    eyeSlant: zero(base.eyeSlant ?? 0),
    eyeBiasY: zero(base.eyeBiasY ?? 0),
    eyeShape: (base.eyeShape as MonaEyeShape) ?? 'normal',
    pupilScale: name === 'mona-pr' ? 1.06 : 1,
    mouthShape: CLIP_MOUTH[name],
    sweatOpacity: zero(base.sweatOpacity ?? 0),
    sweatFall: zero(base.sweatFall ?? 0)
  };
}
