import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native firmware permission queue, stale identity, TTL, and lossless command pages', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-permission-'));
  try {
    const binary = join(directory, 'permission-review');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++11', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-I', native, '-I', join(firmware, 'include'),
      join(native, 'permission_review.cpp'), join(firmware, 'src/orb_engine.cpp'), '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production firmware touch handlers cancel swipes, returned drags, and stale presses', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-touch-'));
  try {
    const source = readFileSync(join(firmware, 'src/renderer.cpp'), 'utf8');
    const start = source.indexOf('void Renderer::touch(');
    const end = source.indexOf('void Renderer::drawOverlay(', start);
    assert.ok(start >= 0 && end > start);
    writeFileSync(join(directory, 'touch-handler.inc'), source.slice(start, end));
    const binary = join(directory, 'renderer-touch');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++11', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-I', directory, '-I', join(firmware, 'include'),
      join(native, 'renderer_touch.cpp'), '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});