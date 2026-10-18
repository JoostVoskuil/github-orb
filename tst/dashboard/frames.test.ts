import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPS, frameIndex, motionAt } from '../../dashboard/motion.js';
import { Frames, validateManifest } from '../../dashboard/frames.js';

const manifest = () => ({
  version: 1, frameSize: 320,
  clips: Object.fromEntries(Object.entries(CLIPS).map(([mood, clip]) => [mood, {
    ...clip, frames: clip.duration * 12, fps: 12, columns: 8, file: `${mood}.webp`
  }]))
});

test('looped clips wrap and one-shot clips hold their final frame', () => {
  const loop = manifest().clips.thinking;
  const once = manifest().clips.done;
  assert.equal(frameIndex(loop, 0), 0);
  assert.equal(frameIndex(loop, -2), 0);
  assert.equal(frameIndex(loop, 8), 0);
  assert.equal(frameIndex(once, 30), once.frames - 1);
});

test('all loops are seamless and use 3D rotation, depth, and breathing bounds', () => {
  for (const [mood, clip] of Object.entries(CLIPS)) {
    if (clip.loop) {
      const start = motionAt(mood, 0);
      const end = motionAt(mood, clip.duration);
      for (const key of Object.keys(start)) {
        if (typeof start[key] === 'number') {
          assert.ok(Math.abs(start[key] - end[key]) < 1e-9, `${mood}.${key} loop mismatch: ${start[key]} vs ${end[key]}`);
        } else {
          assert.equal(start[key], end[key]);
        }
      }
    }
    let minYaw = Infinity;
    let maxYaw = -Infinity;
    let minPitch = Infinity;
    let maxPitch = -Infinity;
    for (let time = 0; time <= clip.duration; time += 0.05) {
      const pose = motionAt(mood, time);
      minYaw = Math.min(minYaw, pose.yaw);
      maxYaw = Math.max(maxYaw, pose.yaw);
      minPitch = Math.min(minPitch, pose.pitch);
      maxPitch = Math.max(maxPitch, pose.pitch);
      if (mood !== 'done') assert.ok(Math.abs(pose.yaw) <= 0.72, `${mood} yaw exceeded limit at ${time}s`);
      assert.ok(Math.abs(pose.pitch) <= 0.36, `${mood} pitch exceeded limit at ${time}s`);
      assert.ok(Math.abs(pose.roll) <= 0.26, `${mood} roll exceeded limit at ${time}s`);
      assert.ok(Math.abs(pose.y) <= (mood === 'done' ? 0.14 : 0.05));
      assert.ok(Math.abs(pose.z) <= 0.25, `${mood} z exceeded limit at ${time}s`);
      assert.ok(Math.abs(pose.scale - 1) < 0.004);
    }
    if (mood === 'idle') {
      // Resting is a calm sleeping pose with minimal side-to-side turnaround.
      assert.ok(maxYaw <= 0.08 && minYaw >= -0.08, 'idle should minimize yaw turnaround while sleeping');
      assert.ok(minPitch > 0.08 && maxPitch > 0.22, 'idle should droop forward in sleep');
    } else if (mood === 'needsInput') {
      // Asking face keeps direct eye contact with the user while cocking its head and nodding/glancing.
      assert.ok(maxYaw <= 0.15 && minYaw >= -0.16, 'needsInput should keep eye contact rather than turning away');
      assert.ok(maxPitch > 0.2 && minPitch < -0.12, 'needsInput should nod and glance down at the prompt');
    } else if (clip.loop && mood !== 'disconnected') {
      assert.ok(maxYaw > 0.4 && minYaw < -0.35, `${mood} should reveal both 3D sides`);
      assert.ok(maxPitch > 0.2 && minPitch < -0.18, `${mood} should reveal top and underside`);
    }
  }
});

test('done spins a full 360 degrees with a hop, winks one eye, and settles', () => {
  const start = motionAt('done', 0);
  const midSpin = motionAt('done', 0.8);
  const wink = motionAt('done', 2.04);
  const end = motionAt('done', CLIPS.done.duration);
  assert.equal(start.eyeShape, 'happy');
  assert.ok(Math.abs(start.yaw) < 0.001);
  // Halfway through the spin, Copilot faces backward (~pi radians) and hops upward.
  assert.ok(midSpin.yaw > 2.8 && midSpin.yaw < 3.5);
  assert.ok(motionAt('done', 0.65).y > 0.12);
  // During the wink, the right eye closes while the left eye stays open with a playful head tilt.
  assert.ok(wink.eyeRight < 0.15, `expected right eye to wink shut, got ${wink.eyeRight}`);
  assert.ok(wink.eyeLeft > 1.0, `expected left eye to remain open, got ${wink.eyeLeft}`);
  assert.ok(wink.roll > 0.1);
  // Settles facing front (2*pi) with both eyes open.
  assert.ok(Math.abs(end.yaw - Math.PI * 2) < 0.001);
  assert.equal(end.y, 0);
  assert.equal(end.eyeLeft, 1);
  assert.equal(end.eyeRight, 1);
  assert.deepEqual(end, motionAt('done', 30));
});

test('idle sleeps, needsInput is pleasy, error shakes impatiently, and thinking shows brainpower', () => {
  const idle = motionAt('idle', 0);
  assert.equal(idle.eyeShape, 'sleeping');
  assert.ok(idle.eyes < 0.2, 'sleeping eyes should stay nearly closed');
  assert.ok(idle.roll > 0.1, 'sleeping head should rest on a cozy tilt');

  const pleasy = motionAt('needsInput', 0);
  const yesNod = motionAt('needsInput', 2.0);
  const glanceDown = motionAt('needsInput', 3.5);
  const otherCock = motionAt('needsInput', 5.0);
  assert.equal(pleasy.eyeShape, 'curious');
  assert.ok(pleasy.roll < -0.2);
  assert.ok(pleasy.z >= 0.18, 'needsInput should lean forward toward the user');
  assert.ok(pleasy.eyeLeft > 1.14 && pleasy.eyeRight > 1.2, 'needsInput should have wide puppy eyes');
  assert.ok(pleasy.eyeLookY > 0.15, 'needsInput should look up pleadingly');
  assert.ok(pleasy.eyeSlant > 0.14 && pleasy.eyeBiasY > 0.02, 'needsInput eyes should angle into an asking expression');
  assert.ok(yesNod.pitch < pleasy.pitch && yesNod.eyeLookY > 0.22, 'needsInput should give a hopeful yes-nod');
  assert.ok(glanceDown.eyeLookY < -0.14 && glanceDown.pitch > 0.2, 'needsInput should glance down at the prompt');
  assert.ok(otherCock.roll > 0.2 && otherCock.eyeBiasY > 0.03, 'needsInput should cock its head the other way inquisitively');

  // Impatient error shakes rapidly across multiple left/right reversals and stomps downward.
  assert.ok(motionAt('error', 0.5).yaw > 0.25);
  assert.ok(motionAt('error', 0.7).yaw < -0.25);
  assert.ok(motionAt('error', 0.9).yaw > 0.35);
  assert.ok(motionAt('error', 1.1).yaw < -0.35);
  assert.ok(motionAt('error', 0.625).y < -0.02);
  assert.ok(Math.abs(motionAt('error', 3).yaw) < 0.001);
  assert.deepEqual(motionAt('error', 3), motionAt('error', 30));

  // Human thinking: eyes saccade ahead of the head, hold fixation plateaus, flip squint, and nod at "aha!".
  const saccade1 = motionAt('thinking', 0.26);
  const hold1 = motionAt('thinking', 0.8);
  assert.equal(hold1.eyeShape, 'thinking');
  assert.ok(saccade1.eyeLookX > 0.18 && saccade1.yaw < 0.1, 'eyes must lead the head turn on a saccade');
  assert.ok(Math.abs(hold1.yaw - motionAt('thinking', 1.5).yaw) < 0.001, 'head holds a steady fixation plateau');
  assert.ok(hold1.eyeLeft < 0.6 && hold1.eyeRight > 0.9, 'left eye squints during upper-right recall');
  assert.ok(hold1.eyeLookY > 0.25 && hold1.z > 0.15 && hold1.eyeGlow > 1.2);

  const saccade3 = motionAt('thinking', 4.2);
  const hold3 = motionAt('thinking', 5.0);
  assert.ok(saccade3.eyeLookX < -0.14 && saccade3.yaw > -0.1, 'eyes lead the upper-left counter-hypothesis saccade');
  assert.ok(Math.abs(hold3.yaw - motionAt('thinking', 5.8).yaw) < 0.001, 'head holds the upper-left fixation plateau');
  assert.ok(hold3.eyeRight < 0.65 && hold3.eyeLeft > 0.9, 'squint mirrors when pondering the opposite side');

  const aha = motionAt('thinking', 6.8);
  assert.ok(aha.eyeLeft >= 1.0 && aha.eyeRight >= 1.0 && aha.eyeGlow > 1.35, 'eyes widen and brighten on the aha moment');
});

test('manifest validates required moods and rejects unsafe atlas paths', () => {
  assert.equal(validateManifest(manifest()).version, 1);
  const missing = manifest();
  delete missing.clips.idle;
  assert.throws(() => validateManifest(missing), /idle/);
  const unsafe = manifest();
  unsafe.clips.idle.file = '../config.json';
  assert.throws(() => validateManifest(unsafe), /idle/);
});

test('working effort includes bounded sweat and active nods only during tool animations', () => {
  const working = motionAt('tool', 2.2);
  assert.equal(working.eyeShape, 'working');
  assert.ok(working.eyeLookY < -0.1);
  assert.ok(working.z >= 0.1);
  assert.ok(working.sweatOpacity > 0.99);
  assert.ok(working.sweatFall > 0.1 && working.sweatFall < 0.2);
  assert.equal(motionAt('tool', 0).sweatOpacity, 0);
  assert.equal(motionAt('tool', 3.3).sweatOpacity, 0);
  for (const mood of Object.keys(CLIPS)) {
    if (mood !== 'tool') assert.equal(motionAt(mood, 2.2).sweatOpacity, 0);
  }
});

test('error X eyes persist after the impatient shake settles', () => {
  assert.equal(motionAt('error', 0).eyeShape, 'x');
  assert.equal(motionAt('error', 30).eyeShape, 'x');
  assert.ok(Math.abs(motionAt('error', 30).yaw) < 0.001);
});

test('atlas player picks the correct crop and missing clips fall back', () => {
  const player = new Frames();
  assert.equal(player.draw(null, 'idle', 0, 0), false);
  player.manifest = manifest();
  player.atlases.set('thinking', {} as HTMLImageElement);
  let draw: unknown[] = [];
  const ctx = { drawImage(...args: unknown[]) { draw = args; } } as unknown as CanvasRenderingContext2D;
  assert.equal(player.draw(ctx, 'thinking', 1000, 0), true);
  assert.deepEqual(draw.slice(1, 5), [1280, 320, 320, 320]);
});

function blendingPlayer() {
  const canvases = [];
  const player = new Frames(() => {
    const stack = [];
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over', draws: [],
      clearRect() { this.draws = []; },
      translate() {},
      save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
      restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
      drawImage(...args) { this.draws.push({ args, alpha: this.globalAlpha, operation: this.globalCompositeOperation }); }
    };
    const canvas = { getContext: () => ctx };
    canvases.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  });
  player.manifest = manifest();
  for (const mood of Object.keys(CLIPS)) player.atlases.set(mood, { mood } as unknown as HTMLImageElement);
  return { player, canvases, ctx: { drawImage() {}, globalAlpha: 1 } as unknown as CanvasRenderingContext2D };
}

test('mood changes ease between opaque frames without dimming or changing caller alpha', () => {
  const { player, ctx } = blendingPlayer();
  ctx.globalAlpha = 0.7;
  player.draw(ctx, 'idle', 1000, 0);
  player.draw(ctx, 'thinking', 1000, 1000, 400);
  const { from, blend } = player.transition;
  assert.equal(from.getContext('2d').draws[0].args[0].mood, 'idle');
  player.draw(ctx, 'thinking', 1100, 1000, 400);
  const draws = blend.getContext('2d').draws;
  assert.equal(draws[0].alpha, 0.84375);
  assert.equal(draws[1].alpha, 0.15625);
  assert.equal(draws[1].operation, 'lighter');
  assert.equal(draws[1].args[0].mood, 'thinking');
  assert.equal(ctx.globalAlpha, 0.7);
  player.draw(ctx, 'thinking', 1400, 1000, 400);
  assert.equal(player.transition, null);
});

test('interrupted transitions start from the displayed blend, not the previous mood', () => {
  const { player, ctx } = blendingPlayer();
  player.draw(ctx, 'idle', 0, 0);
  player.draw(ctx, 'thinking', 100, 100, 400);
  const previousBlend = player.transition.blend;
  player.draw(ctx, 'needsInput', 300, 300, 400);
  const snapshotDraw = player.transition.from.getContext('2d').draws[0];
  assert.equal(snapshotDraw.args[0], previousBlend);
  assert.deepEqual(previousBlend.getContext('2d').draws.map((draw) => draw.alpha), [0.5, 0.5]);
  player.draw(ctx, 'needsInput', 700, 300, 400);
  assert.equal(player.transition, null);
});

test('same mood updates preserve playback and unavailable clips clear stale transitions', () => {
  const { player, canvases, ctx } = blendingPlayer();
  player.draw(ctx, 'idle', 0, 0);
  player.draw(ctx, 'idle', 500, 0);
  assert.equal(canvases.length, 0);
  player.draw(ctx, 'thinking', 600, 600, 0);
  assert.equal(player.transition, null);
  player.draw(ctx, 'done', 700, 700, 400);
  player.atlases.delete('error');
  assert.equal(player.draw(ctx, 'error', 800, 800), false);
  assert.equal(player.transition, null);
  assert.equal(player.current, null);
  player.draw(ctx, 'done', 30_000, 700);
  assert.equal(player.transition, null);
  assert.equal(frameIndex(player.manifest.clips.done, (30_000 - 700) / 1000), 35);
});
