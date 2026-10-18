import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native AnimationPack rejects JPEG dimension mismatches and clips callback rectangles', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const jpeg = process.env.JPEGDEC_SRC || join(firmware, '.pio/libdeps/waveshare_s3_touch_lcd_21/JPEGDEC/src');
  assert.ok(existsSync(join(jpeg, 'JPEGDEC.cpp')), 'Run the firmware build first, or set JPEGDEC_SRC');
  const directory = mkdtempSync(join(tmpdir(), 'orb-decoder-'));
  try {
    const binary = join(directory, 'animation-pack');
    const args = ['-std=c++11', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      ...(process.platform === 'linux' ? ['-D__LINUX__'] : []),
      '-I', native, '-I', join(firmware, 'include'), '-I', jpeg,
      join(native, 'animation_pack.cpp'), join(firmware, 'src/animation_pack.cpp'),
      join(jpeg, 'JPEGDEC.cpp'), '-o', binary];
    const build = spawnSync(process.env.CXX || 'c++', args, { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [join(firmware, 'data/animations.orb')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});