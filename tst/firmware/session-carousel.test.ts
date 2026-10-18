import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native session carousel queues activity, holds attention, animates, and handles millis rollover', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-carousel-'));
  try {
    const binary = join(directory, 'session-carousel');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++11', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-I', native, '-I', join(firmware, 'include'), join(native, 'session_carousel.cpp'), '-o', binary
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
