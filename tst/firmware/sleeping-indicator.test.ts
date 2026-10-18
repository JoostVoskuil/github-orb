import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));

test('native sleeping indicator draws fading, drifting z glyphs within framebuffer bounds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orb-sleeping-'));
  try {
    const binary = join(directory, 'sleeping-indicator');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++11', '-fsanitize=address', '-I', join(firmware, 'include'),
      join(native, 'sleeping_indicator.cpp'), '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('renderer overlays sleeping letters for idle Copilot and Mona, including without SD frames', () => {
  const source = readFileSync(join(firmware, 'src/renderer.cpp'), 'utf8');
  assert.match(source, /const bool showAvatar = state_\.mona \|\| state_\.mood == Mood::Idle \|\| state_\.mood == Mood::Done/);
  assert.match(source, /if \(state_\.mood == Mood::Idle \|\| \(state_\.mood == Mood::Done && strcmp\(stateClip\(state_\), "done"\)\)\) drawSleepingIndicator\(/);
  assert.match(source, /if \(!rendered && state_\.mona\) drawMona\(buffer\);\s*else if \(!rendered && showAvatar\) drawCopilot\([^;]+;\s*if .*drawSleepingIndicator\([^;]+;\s*drawTopBadge\(buffer\);/);
  assert.match(source, /if \(state_\.mona\) \{\s*for \(int y = -7; y <= 7; y\+\+\) for \(int x = -7; x <= 7; x\+\+\) if \(x \* x \+ y \* y <= 49\) buffer\[\(34 \+ y\) \* Board::kWidth \+ 240 \+ x\]/);
});