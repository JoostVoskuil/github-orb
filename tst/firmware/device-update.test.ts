import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native shared update lifecycle validates sizes, ownership, images and preserves failed SD replacements', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/update-native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-update-'));
  try {
    const binary = join(directory, 'device-update');
    const build = spawnSync(process.env.CXX || 'c++', ['-std=c++17', '-g', '-fsanitize=address',
      '-I', native, '-I', join(firmware, 'include'),
      '-I', join(firmware, '.pio/libdeps/waveshare_s3_touch_lcd_21/ArduinoJson/src'),
      join(native, 'device_update.cpp'), join(firmware, 'src/device_update.cpp'), '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
