import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alphaBounds, poseAt, POSES, Artwork } from '../../dashboard/artwork.js';

test('every mood cycles through existing artwork poses', () => {
  for (const mood of ['idle', 'thinking', 'tool', 'needsInput', 'done', 'error', 'disconnected']) {
    for (let sec = 0; sec < 60; sec++) assert.ok(POSES[poseAt(mood, sec)]);
  }
  assert.equal(poseAt('thinking', 0), poseAt('thinking', 7.9));
  assert.notEqual(poseAt('thinking', 0), poseAt('thinking', 8));
  assert.equal(poseAt('disconnected', 40), 'down');
  assert.equal(poseAt('done', 0), 'glow');
  for (const mood of ['idle', 'tool', 'needsInput', 'done', 'error']) {
    assert.equal(poseAt(mood, 0), poseAt(mood, 60));
  }
  assert.equal(poseAt('unknown', -1), poseAt('idle', 0));
});

test('alpha bounds crop padding and ignore faint pixels', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  data[3] = 1;
  data[(1 * 4 + 1) * 4 + 3] = 255;
  data[(2 * 4 + 2) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(data, 4, 4), { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(alphaBounds(new Uint8ClampedArray(16), 2, 2), null);
});

test('empty artwork falls back without touching the canvas', () => {
  assert.equal(new Artwork().draw(null, 'idle', 100, 0, 300), false);
});

test('pose transitions settle quickly and retain normalized opacity', () => {
  const artwork = new Artwork();
  const asset = { canvas: {} as HTMLCanvasElement, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  artwork.assets.set('front', asset);
  artwork.assets.set('left', asset);
  const ctx = { save() {}, restore() {}, scale() {}, drawImage() {} };
  artwork.draw(ctx, 'thinking', 0, 0, 900);
  for (let now = 8000; now <= 8900; now += 30) artwork.draw(ctx, 'thinking', now, 0, 900);
  assert.ok(artwork.weights.get('left') > 0.95);
  assert.ok(Math.abs([...artwork.weights.values()].reduce((sum, w) => sum + w, 0) - 1) < 0.001);
});