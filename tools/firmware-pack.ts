export const PACK_MAGIC = 'ORBA';
export const PACK_VERSION = 1;
export const HEADER_SIZE = 32;
export const CLIP_ENTRY_SIZE = 32;
export const FRAME_ENTRY_SIZE = 16;

export interface AnimationClip {
  name: string;
  firstFrame: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  durationMs: number;
}

export interface AnimationFrame {
  jpeg: Uint8Array;
  alpha: Uint8Array;
}

export interface AnimationPack {
  width: number;
  height: number;
  clips: AnimationClip[];
  frames: AnimationFrame[];
}

function assertIntegerRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function encodeAlphaRle(alpha: Uint8Array): Buffer {
  const out: number[] = [];
  for (let i = 0; i < alpha.length;) {
    const value = Math.round(alpha[i] / 17) & 0x0f;
    let run = 1;
    while (i + run < alpha.length && run < 4096 && (Math.round(alpha[i + run] / 17) & 0x0f) === value) run++;
    // Store the four-bit alpha value beside the high bits of (run length - 1).
    const encoded = run - 1;
    out.push((value << 4) | (encoded >> 8), encoded & 0xff);
    i += run;
  }
  return Buffer.from(out);
}

export function decodeAlphaRle(encoded: Uint8Array, pixelCount: number): Buffer {
  assertIntegerRange(pixelCount, 0, 0xffffffff, 'pixelCount');
  const alpha = Buffer.alloc(pixelCount);
  let cursor = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    if (i + 1 >= encoded.length) throw new Error('Truncated alpha stream');
    const value = encoded[i] >> 4;
    const run = (((encoded[i] & 0x0f) << 8) | encoded[i + 1]) + 1;
    if (cursor + run > pixelCount) throw new Error('Alpha stream exceeds frame');
    alpha.fill(value * 17, cursor, cursor + run);
    cursor += run;
  }
  if (cursor !== pixelCount) throw new Error(`Alpha stream decoded ${cursor} of ${pixelCount} pixels`);
  return alpha;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildPack({ width, height, clips, frames }: AnimationPack): Buffer {
  assertIntegerRange(width, 1, 0xffff, 'width');
  assertIntegerRange(height, 1, 0xffff, 'height');
  assertIntegerRange(clips.length, 0, 0xffff, 'clip count');
  assertIntegerRange(frames.length, 0, 0xffffffff, 'frame count');
  for (const clip of clips) {
    if (!/^[\x20-\x7e]{1,15}$/.test(clip.name)) throw new Error('Clip name must contain 1-15 printable ASCII characters');
    assertIntegerRange(clip.firstFrame, 0, 0xffff, 'firstFrame');
    assertIntegerRange(clip.frameCount, 1, 0xffff, 'frameCount');
    assertIntegerRange(Math.round(clip.fps * 100), 1, 0xffff, 'fps x 100');
    assertIntegerRange(clip.durationMs, 0, 0xffffffff, 'durationMs');
    if (clip.firstFrame + clip.frameCount > frames.length) throw new RangeError('Clip frames exceed the frame table');
  }
  let dataSize = 0;
  for (const frame of frames) {
    assertIntegerRange(frame.jpeg.length, 0, 0xffffffff, 'JPEG frame size');
    assertIntegerRange(frame.alpha.length, 0, 0xffffffff, 'alpha frame size');
    const frameSize = frame.jpeg.length + frame.alpha.length;
    if (frameSize > 0xffffffff - dataSize) throw new RangeError('Animation data exceeds the 32-bit pack limit');
    dataSize += frameSize;
  }

  const clipTableOffset = HEADER_SIZE;
  const frameTableOffset = clipTableOffset + clips.length * CLIP_ENTRY_SIZE;
  const dataOffset = frameTableOffset + frames.length * FRAME_ENTRY_SIZE;
  if (dataOffset > 0xffffffff - dataSize) throw new RangeError('Animation pack exceeds the 32-bit pack limit');
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(PACK_MAGIC, 0, 'ascii');
  header.writeUInt16LE(PACK_VERSION, 4);
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header.writeUInt16LE(clips.length, 10);
  header.writeUInt32LE(frames.length, 12);
  header.writeUInt32LE(clipTableOffset, 16);
  header.writeUInt32LE(frameTableOffset, 20);
  header.writeUInt32LE(dataOffset, 24);

  const clipTable = Buffer.alloc(clips.length * CLIP_ENTRY_SIZE);
  clips.forEach((clip, index) => {
    const offset = index * CLIP_ENTRY_SIZE;
    clipTable.write(clip.name, offset, 'ascii');
    clipTable.writeUInt16LE(clip.firstFrame, offset + 16);
    clipTable.writeUInt16LE(clip.frameCount, offset + 18);
    clipTable.writeUInt16LE(Math.round(clip.fps * 100), offset + 20);
    clipTable.writeUInt16LE(clip.loop ? 1 : 0, offset + 22);
    clipTable.writeUInt32LE(clip.durationMs, offset + 24);
  });

  const frameTable = Buffer.alloc(frames.length * FRAME_ENTRY_SIZE);
  const payloads: Buffer[] = [];
  let cursor = dataOffset;
  frames.forEach((frame, index) => {
    const payload = Buffer.concat([frame.jpeg, frame.alpha]);
    const offset = index * FRAME_ENTRY_SIZE;
    frameTable.writeUInt32LE(cursor, offset);
    frameTable.writeUInt32LE(frame.jpeg.length, offset + 4);
    frameTable.writeUInt32LE(frame.alpha.length, offset + 8);
    frameTable.writeUInt32LE(crc32(payload), offset + 12);
    payloads.push(payload);
    cursor += payload.length;
  });
  return Buffer.concat([header, clipTable, frameTable, ...payloads]);
}