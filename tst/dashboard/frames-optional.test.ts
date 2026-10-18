import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frames } from '../../dashboard/frames.js';
import { CLIPS } from '../../dashboard/motion.js';
import { MONA_CLIPS, previewState } from '../../dashboard/presentation.js';

test('missing optional Mona atlas downloads leave every Copilot clip playable', async () => {
  const globals = globalThis as unknown as { fetch: typeof fetch; Image?: typeof Image };
  const previousFetch = globals.fetch;
  const previousImage = globals.Image;
  const manifest = {
    version: 1, frameSize: 320,
    clips: Object.fromEntries([...Object.keys(CLIPS), ...MONA_CLIPS].map((name) => [name, {
      frames: 36, fps: 12, columns: 8, loop: false, file: `${name}.webp`
    }]))
  };
  globals.fetch = (async () => ({ ok: true, json: async () => manifest })) as unknown as typeof fetch;
  globals.Image = class {
    naturalWidth = 2560;
    naturalHeight = 1600;
    src = '';
    async decode() {
      if (this.src.includes('/mona-')) throw new Error('Optional atlas not generated yet');
    }
  } as unknown as typeof Image;
  try {
    const player = new Frames();
    assert.equal(await player.load(), MONA_CLIPS.length);
    const ctx = { drawImage() {} };
    for (const clip of MONA_CLIPS) assert.equal(player.draw(ctx, clip, 0, 0), false);
    for (const clip of Object.keys(CLIPS)) assert.equal(player.draw(ctx, clip, 0, 0, 0), true);
  } finally {
    globals.fetch = previousFetch;
    if (previousImage === undefined) delete globals.Image;
    else globals.Image = previousImage;
  }
});

test('Copilot preview retains live mood; Mona alert preview works while offline', () => {
  assert.equal(previewState({ mood: 'tool' }, 'copilot', 'mona-pr', '', 1).mood, 'tool');
  assert.equal(previewState({ mood: 'disconnected' }, 'mona', 'mona-pr', '', 1).mood, 'reviewRequested');
  assert.equal(previewState({ mood: 'disconnected' }, 'mona', 'mona-security', '', 1).mood, 'securityAlert');
});