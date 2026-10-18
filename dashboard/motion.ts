export const CLIPS = {
  idle: { duration: 8, loop: true },
  thinking: { duration: 8, loop: true },
  tool: { duration: 8, loop: true },
  needsInput: { duration: 8, loop: true },
  done: { duration: 3, loop: false },
  error: { duration: 3, loop: false },
  disconnected: { duration: 8, loop: true }
};

export function frameIndex(clip, elapsedSec) {
  const elapsed = Math.max(0, elapsedSec);
  return clip.loop
    ? Math.floor(elapsed * clip.fps) % clip.frames
    : Math.min(clip.frames - 1, Math.floor(elapsed * clip.fps));
}

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

// Smooth step-and-hold plateau: rises over [riseStart, riseEnd], holds 1.0, falls over [fallStart, fallEnd].
function plateau(t: number, riseStart: number, riseEnd: number, fallStart: number, fallEnd: number): number {
  if (t <= riseStart || t >= fallEnd) return 0;
  if (t < riseEnd) return quintic((t - riseStart) / (riseEnd - riseStart));
  if (t <= fallStart) return 1;
  return 1 - quintic((t - fallStart) / (fallEnd - fallStart));
}

export function motionAt(mood, time) {
  const clip = CLIPS[mood] ?? CLIPS.idle;
  const t = clip.loop ? Math.max(0, time) % clip.duration : Math.min(clip.duration, Math.max(0, time));
  const phase = (t / clip.duration) * Math.PI * 2;
  const wave = Math.sin(phase);
  const cos = Math.cos(phase);
  const blinkDistance = Math.abs(t - 4);
  const blink = clip.loop ? Math.max(0.08, Math.min(1, blinkDistance / 0.12)) : 1;
  const base = {
    yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, scale: 1,
    eyes: blink, eyeLeft: 1, eyeRight: 1, eyeLookX: 0, eyeLookY: 0,
    eyeSlant: 0, eyeBiasY: 0, eyeShape: 'normal',
    eyeGlow: 1, sweatOpacity: 0, sweatFall: 0
  };

  switch (mood) {
    case 'idle': {
      // Deep sleeping: minimal side-to-side turnaround, cozy pillow roll, slow breathing nod, closed eyes.
      const breath = -cos;
      return {
        ...base,
        yaw: wave * 0.075,
        pitch: 0.18 + breath * 0.065 + Math.sin(phase * 2) * 0.02,
        roll: 0.12 + wave * 0.035,
        x: wave * 0.012,
        y: -0.018 + cos * 0.018,
        z: -0.04 + cos * 0.025,
        scale: 1 + cos * 0.0035,
        eyes: 0.12 + 0.025 * cos,
        eyeLeft: 1,
        eyeRight: 1,
        eyeLookY: -0.05,
        eyeShape: 'sleeping',
        eyeGlow: 0.68 + 0.08 * cos
      };
    }
    case 'thinking': {
      // Human cognitive gaze model: rapid eye saccades lead damped head turns into still fixation holds,
      // with asymmetric squinting during recall/synthesis, a transition blink at 4s, and an "aha!" double nod.
      const e1 = plateau(t, 0.06, 0.26, 1.66, 1.90); // Saccade 1: upper-right visual recall
      const h1 = plateau(t, 0.18, 0.68, 1.74, 2.20); // Head follows ~140ms behind eyes and holds
      const m1 = pulseWindow(t, 0.95, 1.35);         // Mid-fixation micro-saccade

      const e2 = plateau(t, 1.80, 2.02, 3.65, 3.90); // Saccade 2: downward analytical verification
      const h2 = plateau(t, 1.94, 2.46, 3.68, 4.18); // Head pitches down-forward and holds
      const m2 = pulseWindow(t, 2.70, 3.12);

      const e3 = plateau(t, 3.92, 4.15, 6.12, 6.36); // Saccade 3 (at blink): upper-left counter-hypothesis
      const h3 = plateau(t, 4.08, 4.62, 6.18, 6.66); // Head sweeps upper-left and locks into fixation hold
      const m3 = pulseWindow(t, 5.05, 5.48);

      const e4 = plateau(t, 6.32, 6.54, 7.46, 7.82); // Saccade 4: snap to center for "aha!" synthesis
      const nod1 = pulseWindow(t, 6.58, 7.00);
      const nod2 = pulseWindow(t, 7.00, 7.42);
      const ahaNod = nod1 + 0.75 * nod2;

      return {
        ...base,
        yaw: 0.04 + 0.42 * h1 + 0.02 * m1 + 0.18 * h2 - 0.49 * h3 - 0.02 * m3 - 0.04 * e4,
        pitch: -0.06 - 0.22 * h1 + 0.29 * h2 - 0.18 * h3 + 0.14 * ahaNod,
        roll: 0.02 + 0.12 * h1 - 0.08 * h2 - 0.15 * h3 + 0.04 * nod1,
        x: 0.03 * h1 + 0.015 * h2 - 0.035 * h3,
        y: 0.012 * h1 - 0.014 * h2 + 0.012 * h3 + 0.022 * e4 - 0.016 * ahaNod,
        z: 0.11 + 0.05 * h1 + 0.09 * h2 + 0.06 * h3 + 0.08 * e4,
        scale: 1 + 0.003 * e4,
        eyeLeft: 0.72 - 0.16 * h1 - 0.02 * h2 + 0.22 * h3 + 0.28 * e4,
        eyeRight: 0.92 + 0.04 * h1 - 0.16 * h2 - 0.32 * h3 + 0.12 * e4,
        eyeLookX: 0.05 + 0.14 * e1 + 0.04 * m1 - 0.11 * e2 + 0.05 * m2 - 0.20 * e3 - 0.04 * m3 - 0.05 * e4,
        eyeLookY: 0.185 + 0.08 * e1 + 0.03 * m1 - 0.24 * e2 + 0.06 * e3 + 0.03 * m3 - 0.08 * e4,
        eyeShape: 'thinking',
        eyeGlow: 1.12 + 0.14 * h1 + 0.10 * h2 + 0.16 * h3 + 0.26 * e4
      };
    }
    case 'tool': {
      // Industrious working: forward workbench lean, rhythmic nods & lateral task scan, narrowed focus, sweat on effort.
      const drop = (t % 4 - 1.2) / 2;
      const sweating = drop > 0 && drop < 1;
      const workNod = Math.sin(phase * 4);
      return {
        ...base,
        yaw: wave * 0.46 - Math.sin(phase * 3) * 0.08,
        pitch: 0.05 - cos * 0.24 + workNod * 0.045,
        roll: -Math.sin(phase * 2) * 0.09,
        x: wave * 0.028,
        y: -Math.abs(Math.sin(phase * 2)) * 0.018,
        z: 0.10 + 0.04 * (1 - Math.cos(phase * 2)),
        scale: 1 + 0.0025 * Math.sin(phase * 2),
        eyeLeft: 0.78 + 0.04 * Math.cos(phase * 2),
        eyeRight: 0.78 + 0.04 * Math.cos(phase * 2),
        eyeLookX: cos * 0.12,
        eyeLookY: -0.11 - 0.03 * Math.abs(workNod),
        eyeShape: 'working',
        eyeGlow: 1.06,
        sweatOpacity: sweating ? Math.sin(drop * Math.PI) ** 2 : 0,
        sweatFall: sweating ? drop * 0.28 : 0
      };
    }
    case 'needsInput': {
      // Asking / seeking-permission face:
      // Keeps direct eye contact with the user (minimal yaw, counter-tracked gaze), leans in close,
      // alternates between a tucked-chin puppy-eyed plea (/ \ eye slant + hopeful "yes?" double-nod),
      // a brief glance down at the prompt/action below, and a cocked-head questioning "may I?" lift.
      const pleaseHold = (1 - quintic((t - 2.85) / 0.45)) + quintic((t - 7.25) / 0.50);
      const yesNod1 = pulseWindow(t, 1.75, 2.20);
      const yesNod2 = pulseWindow(t, 2.20, 2.68);
      const yesNod = yesNod1 + 0.85 * yesNod2;
      const glanceDown = plateau(t, 3.05, 3.32, 3.68, 3.96); // Glances down at the approval button/task
      const questionCock = plateau(t, 4.10, 4.55, 6.45, 7.05); // Opposite-side questioning head-cock ("huh? / okay?")
      const hmLift = pulseWindow(t, 6.55, 7.35);               // Upward "may I?" chin perk
      const flutter = Math.max(0.18, Math.min(1, Math.abs(t - 5.35) / 0.09));

      const yaw = 0.09 * pleaseHold - 0.05 * glanceDown - 0.14 * questionCock + 0.04 * hmLift;
      return {
        ...base,
        yaw,
        pitch: 0.13 * pleaseHold - 0.11 * yesNod + 0.22 * glanceDown - 0.09 * questionCock - 0.14 * hmLift,
        roll: -0.22 * pleaseHold - 0.03 * yesNod + 0.21 * questionCock - 0.10 * hmLift,
        x: 0.025 * pleaseHold - 0.03 * questionCock,
        y: 0.012 * pleaseHold + 0.028 * yesNod - 0.018 * glanceDown + 0.016 * questionCock + 0.024 * hmLift,
        z: 0.19 + 0.04 * yesNod - 0.03 * glanceDown + 0.03 * questionCock + 0.03 * hmLift,
        scale: 1 + 0.003 * yesNod + 0.002 * hmLift,
        eyes: Math.min(blink, flutter),
        eyeLeft: 1.16 + 0.08 * yesNod - 0.12 * glanceDown - 0.06 * questionCock + 0.05 * hmLift,
        eyeRight: 1.22 + 0.08 * yesNod - 0.12 * glanceDown + 0.04 * questionCock + 0.06 * hmLift,
        eyeLookX: -yaw * 0.45,
        eyeLookY: 0.18 * pleaseHold + 0.05 * yesNod - 0.16 * glanceDown + 0.15 * questionCock + 0.16 * hmLift,
        eyeSlant: 0.15 * pleaseHold + 0.05 * yesNod + 0.11 * questionCock + 0.12 * hmLift,
        eyeBiasY: 0.022 * pleaseHold + 0.038 * questionCock + 0.03 * hmLift,
        eyeShape: 'curious',
        eyeGlow: 1.16 + 0.14 * yesNod + 0.10 * questionCock + 0.12 * hmLift
      };
    }
    case 'done': {
      // Celebratory full 360-degree spin with a joyful hop, landing facing front into a playful one-eye wink.
      const spinDuration = 1.6;
      const spinProgress = quintic(t / spinDuration);
      const spinWave = t < spinDuration ? Math.sin((t / spinDuration) * Math.PI * 2) : 0;
      const spinEnv = t < spinDuration ? Math.sin((t / spinDuration) * Math.PI) : 0;
      const wink = pulseWindow(t, 1.72, 2.36);
      const hop = t < 1.35
        ? Math.sin((t / 1.35) * Math.PI) ** 2 * 0.13
        : t < 1.85
          ? Math.sin(((t - 1.35) / 0.5) * Math.PI) ** 2 * 0.032
          : 0;
      return {
        ...base,
        yaw: spinProgress * Math.PI * 2 - wink * 0.09,
        pitch: -spinWave * 0.25 - wink * 0.065,
        roll: spinWave * 0.16 + wink * 0.15,
        x: Math.sin(spinProgress * Math.PI * 2) * 0.03 * spinEnv,
        y: hop + wink * 0.018,
        z: spinEnv * 0.10 + wink * 0.11,
        scale: 1,
        eyes: 1,
        eyeLeft: 1 + wink * 0.08,
        eyeRight: 1 - wink * 0.92,
        eyeLookX: wink * 0.04,
        eyeLookY: wink * 0.05,
        eyeShape: 'happy',
        eyeGlow: 1.12 + wink * 0.18
      };
    }
    case 'error': {
      // Impatient, frustrated shaking: rapid side-to-side head shakes, tense roll jitter, vertical stomp, persistent X eyes.
      const activeEnd = 2.5;
      const env = t < activeEnd ? Math.sin((t / activeEnd) * Math.PI) ** 1.15 : 0;
      const rapid = Math.sin(t * Math.PI * 2 * 2.5);
      const stomp = -Math.abs(Math.sin(t * Math.PI * 4)) * 0.04 * env;
      return {
        ...base,
        yaw: rapid * 0.52 * env,
        pitch: Math.sin((t / activeEnd) * Math.PI * 2) * 0.25 * env,
        roll: Math.cos(t * Math.PI * 2 * 2.5) * 0.15 * env,
        x: rapid * 0.025 * env,
        y: stomp,
        z: 0.14 * env,
        scale: 1,
        eyes: 1,
        eyeLeft: 0.88,
        eyeRight: 0.88,
        eyeShape: 'x',
        eyeGlow: 1.05 + 0.25 * env
      };
    }
    case 'disconnected':
      return {
        ...base,
        yaw: wave * 0.22,
        pitch: 0.08 - cos * 0.12,
        roll: wave * 0.04,
        scale: 1,
        y: 0,
        eyes: 0.55,
        eyeGlow: 0.55
      };
    default:
      return base;
  }
}
