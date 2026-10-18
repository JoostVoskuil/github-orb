import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIP_ENTRY_SIZE, FRAME_ENTRY_SIZE, HEADER_SIZE, PACK_MAGIC, buildPack, crc32,
  decodeAlphaRle, encodeAlphaRle
} from '../../tools/firmware-pack.js';

test('4-bit alpha RLE round-trips quantized opacity', () => {
  const source = Buffer.from([0, 1, 16, 17, 18, 127, 128, 254, 255, ...new Array(5000).fill(255)]);
  const encoded = encodeAlphaRle(source);
  const decoded = decodeAlphaRle(encoded, source.length);
  assert.deepEqual([...decoded], [...source].map((value) => Math.round(value / 17) * 17));
  assert.ok(encoded.length < source.length);
});

test('pack tables contain stable clip and frame offsets', () => {
  const jpeg = Buffer.from([1, 2, 3]);
  const alpha = Buffer.from([4, 5]);
  const pack = buildPack({
    width: 320,
    height: 320,
    clips: [{ name: 'idle', firstFrame: 0, frameCount: 1, fps: 12, loop: true, durationMs: 8000 }],
    frames: [{ jpeg, alpha }]
  });
  assert.equal(pack.subarray(0, 4).toString(), PACK_MAGIC);
  assert.equal(pack.readUInt16LE(6), 320);
  assert.equal(pack.readUInt16LE(10), 1);
  assert.equal(pack.readUInt32LE(12), 1);
  const frameTable = HEADER_SIZE + CLIP_ENTRY_SIZE;
  const dataOffset = frameTable + FRAME_ENTRY_SIZE;
  assert.equal(pack.readUInt32LE(frameTable), dataOffset);
  assert.equal(pack.readUInt32LE(frameTable + 4), jpeg.length);
  assert.equal(pack.readUInt32LE(frameTable + 8), alpha.length);
  assert.equal(pack.readUInt32LE(frameTable + 12), crc32(Buffer.concat([jpeg, alpha])));
  assert.deepEqual(pack.subarray(dataOffset), Buffer.concat([jpeg, alpha]));
});

test('decoder rejects malformed alpha streams', () => {
  assert.throws(() => decodeAlphaRle(Buffer.from([0]), 1), /Truncated/);
  assert.throws(() => decodeAlphaRle(Buffer.from([0, 2]), 2), /exceeds/);
  assert.throws(() => decodeAlphaRle(Buffer.alloc(0), -1), /pixelCount/);
});

test('packer rejects values that cannot be represented by the firmware format', () => {
  assert.throws(() => buildPack({
    width: 0,
    height: 320,
    clips: [],
    frames: []
  }), /width/);
  assert.throws(() => buildPack({
    width: 320,
    height: 320,
    clips: [{ name: 'clip name is too long', firstFrame: 0, frameCount: 1, fps: 12, loop: true, durationMs: 1000 }],
    frames: [{ jpeg: Buffer.alloc(1), alpha: Buffer.alloc(1) }]
  }), /Clip name/);
});