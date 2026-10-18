import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MONA_CLIPS, monaMotionAt, type MonaClipName } from '../../tools/mona-motion.js';
import { MONA_REVISION, MONA_PATH, extractMona, paintMaterial } from '../../tools/mona-model.js';
import { CLIPS, frameIndex } from '../../dashboard/motion.js';
import { validateManifest } from '../../dashboard/frames.js';
import { crc32, decodeAlphaRle } from '../../tools/firmware-pack.js';
import type { MonaMesh } from '../../tools/mona-model.js';

const load = (path: string) => readFile(new URL(path.replace(/^\.\.\//, '../../../'), import.meta.url));
const json = async (path: string) => JSON.parse(await readFile(new URL(path.replace(/^\.\.\//, '../../../'), import.meta.url), 'utf8'));

test('Bambu paint leaves and split trees decode explicitly', () => {
  assert.deepEqual(['0', '4', '8', '0C', '1C'].map((code) => paintMaterial(code)), [1, 1, 2, 3, 4]);
  assert.equal(paintMaterial('841'), 1); // two children, tied white/violet
  assert.equal(paintMaterial('88883'), 2); // four white children
});

test('malformed and unsupported paints are rejected', () => {
  for (const code of ['', 'wat', 'C', '1', '2C', '44']) assert.throws(() => paintMaterial(code));
  assert.throws(() => paintMaterial('0', 5));
});

test('all Mona clips mimic Copilot animations plus Scared Mona, with seamless loops and settled one-shots', () => {
  assert.deepEqual(Object.keys(MONA_CLIPS), [
    'mona-idle', 'mona-thinking', 'mona-tool', 'mona-pr',
    'mona-done', 'mona-workflow', 'mona-security', 'mona-offline'
  ]);
  for (const [name, spec] of Object.entries(MONA_CLIPS) as [MonaClipName, (typeof MONA_CLIPS)[MonaClipName]][]) {
    assert.match(name, /^[\x20-\x7e]{1,15}$/);
    assert.equal(spec.mascot, 'mona');
    const frames = Math.round(spec.duration * 12);
    assert.equal(monaMotionAt(name, -1).yaw, monaMotionAt(name, 0).yaw);
    if (spec.loop) {
      const start = monaMotionAt(name, 0);
      const end = monaMotionAt(name, spec.duration);
      for (const key of ['yaw', 'pitch', 'roll', 'x', 'y', 'z', 'scale', 'eyes', 'eyeLeft', 'eyeRight'] as const) {
        assert.ok(Math.abs(start[key] - end[key]) < 1e-9, `${name}.${key} loop mismatch`);
      }
      assert.equal(frameIndex({ ...spec, fps: 12, frames }, spec.duration), 0);
    } else {
      const end = monaMotionAt(name, spec.duration);
      assert.deepEqual(end, monaMotionAt(name, 2.5));
      assert.deepEqual(end, monaMotionAt(name, (frames - 1) / 12));
      assert.deepEqual(end, monaMotionAt(name, 1000));
      assert.equal(frameIndex({ ...spec, fps: 12, frames }, 100), frames - 1);
    }
    for (let frame = 0; frame < frames; frame++) {
      const pose = monaMotionAt(name, frame / 12);
      assert.deepEqual(pose, monaMotionAt(name, frame / 12));
      if (name !== 'mona-done') assert.ok(Math.abs(pose.yaw) <= 0.72, `${name} yaw out of bounds`);
      assert.ok(Math.abs(pose.pitch) <= 0.36, `${name} pitch out of bounds`);
      assert.ok(Math.abs(pose.roll) <= 0.26, `${name} roll out of bounds`);
    }
  }
  // Scared Mona (mona-security) recoils, widens eyes, shrinks pupils, trembles, and drops cold sweat.
  const scaredMid = monaMotionAt('mona-security', 1.1);
  assert.equal(scaredMid.eyeShape, 'scared');
  assert.equal(scaredMid.mouthShape, 'scared');
  assert.ok(scaredMid.z < -0.1, 'scared Mona should recoil back');
  assert.ok(scaredMid.eyeLeft > 1.25 && scaredMid.eyeRight > 1.25, 'scared Mona should widen eyes');
  assert.ok(scaredMid.pupilScale < 0.55, 'scared Mona should shrink pupils');
  assert.ok(scaredMid.sweatOpacity > 0.5, 'scared Mona should show cold sweat');
  assert.throws(() => monaMotionAt('idle', 0));
});

test('retained pinned Mona archive, mesh, license and provenance agree', async () => {
  const model = await load('../media/mona/source.3mf');
  const source = await json('../media/mona/source.json');
  const mesh = await json('../media/mona/mesh.json') as MonaMesh;
  assert.equal(model.length, 284639);
  assert.equal(source.revision, MONA_REVISION);
  assert.equal(source.path, MONA_PATH);
  assert.equal(source.sha256, createHash('sha256').update(model).digest('hex'));
  assert.equal(source.license, 'CC-BY-NC-4.0');
  assert.match((await load('../media/mona/LICENSE.txt')).toString(), /NonCommercial/i);
  assert.deepEqual(extractMona(model), mesh);
  assert.equal(mesh.vertexCount, 7498);
  assert.equal(mesh.triangleCount, 15000);
  assert.equal(mesh.splitPaintTriangles, 7);
  assert.equal(mesh.positions.length, 15000 * 9);
  assert.ok(mesh.materials.every((value) => value >= 1 && value <= 4));
});

test('compatible manifest preserves Copilot and adds hash-checked Mona atlases and posters', async () => {
  const manifest = validateManifest(await json('../media/animations/manifest.json'));
  assert.equal(manifest.frameSize, 320);
  assert.deepEqual(manifest.source, await json('../media/copilot/source.json'));
  const monaClipNames = new Set(Object.keys(MONA_CLIPS));
  for (const name of [...Object.keys(CLIPS), ...monaClipNames]) {
    const clip = manifest.clips[name];
    const bytes = await load(`../media/animations/${clip.file}`);
    assert.equal(clip.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    if (!monaClipNames.has(name)) continue;
    const spec = MONA_CLIPS[name as MonaClipName];
    assert.equal(clip.frames, Math.round(spec.duration * 12));
    assert.equal(clip.loop, spec.loop);
    assert.equal(clip.duration, spec.duration);
    assert.equal(clip.fps, 12);
    const poster = await load(`../media/animations/${name}-poster.png`);
    assert.equal(poster.readUInt32BE(16), 320);
    assert.equal(poster.readUInt32BE(20), 320);
  }
  assert.deepEqual(manifest.characters?.mona?.source, await json('../media/mona/source.json'));
});

test('firmware pack includes every clip under 12 MiB with decodable alpha and valid CRCs', async () => {
  const pack = await load('../firmware/data/animations.orb');
  const manifest = await json('../media/animations/manifest.json');
  assert.ok(pack.length <= 12 * 1024 * 1024);
  assert.equal(pack.subarray(0, 4).toString(), 'ORBA');
  assert.equal(pack.readUInt16LE(6), 320);
  assert.equal(pack.readUInt16LE(8), 320);
  assert.equal(pack.readUInt16LE(10), Object.keys(manifest.clips).length);
  const clipTable = pack.readUInt32LE(16);
  const frameTable = pack.readUInt32LE(20);
  const names = [];
  for (let clip = 0; clip < pack.readUInt16LE(10); clip++) {
    const offset = clipTable + clip * 32;
    const name = pack.subarray(offset, offset + 16).toString().split('\0')[0];
    names.push(name);
    assert.equal(pack.readUInt16LE(offset + 18), manifest.clips[name].frames);
    assert.equal(pack.readUInt16LE(offset + 22), manifest.clips[name].loop ? 1 : 0);
  }
  assert.deepEqual(names, Object.keys(manifest.clips));
  for (let frame = 0; frame < pack.readUInt32LE(12); frame++) {
    const table = frameTable + frame * 16;
    const offset = pack.readUInt32LE(table);
    const jpegEnd = offset + pack.readUInt32LE(table + 4);
    const end = jpegEnd + pack.readUInt32LE(table + 8);
    assert.ok(end <= pack.length);
    assert.equal(crc32(pack.subarray(offset, end)), pack.readUInt32LE(table + 12));
    assert.equal(pack.readUInt16BE(offset), 0xffd8);
    decodeAlphaRle(pack.subarray(jpegEnd, end), 320 * 320);
  }
  const attribution = (await load('../firmware/data/ATTRIBUTION.txt')).toString();
  assert.match(attribution, /Copilot model/);
  assert.match(attribution, /Mona model/);
});