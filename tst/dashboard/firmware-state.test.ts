import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('firmware presentation helpers match identity and fresh-ID playback rules', (t) => {
  const compiler = process.env.CXX || 'c++';
  const probe = spawnSync(compiler, ['--version']);
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('Host C++ compiler unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'orb-state-'));
  try {
    const binary = join(directory, 'presentation');
    const result = spawnSync(compiler, ['-std=c++11', '-include', 'initializer_list',
      '-I', fileURLToPath(new URL('../../../tst/dashboard/native/', import.meta.url)),
      '-I', fileURLToPath(new URL('../../../firmware/include/', import.meta.url)),
      fileURLToPath(new URL('../../../tst/dashboard/native/presentation.cpp', import.meta.url)), '-o', binary], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});