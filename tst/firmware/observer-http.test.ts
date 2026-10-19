import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('firmware HTTP handler parses observer lifecycle and optional labels with ArduinoJson', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-observer-http-'));
  try {
    const source = readFileSync(join(firmware, 'src/orb_server.cpp'), 'utf8');
    const start = source.indexOf('void OrbServer::handleEvent() {');
    const end = source.indexOf('void OrbServer::handleGetState()', start);
    assert.ok(start >= 0 && end > start);
    // Exercise the production handler without the ESP32 network/OTA dependencies.
    writeFileSync(join(directory, 'event-handler.inc'), source.slice(start, end));
    const permissionStart = source.indexOf('void OrbServer::handlePermissionDecision() {');
    assert.ok(permissionStart >= 0 && permissionStart < start);
    writeFileSync(join(directory, 'permission-handler.inc'), source.slice(permissionStart, start));
    const binary = join(directory, 'observer-http');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++17', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-I', native, '-I', directory, '-I', join(firmware, 'include'),
      '-I', join(firmware, '.pio/libdeps/waveshare_s3_touch_lcd_21/ArduinoJson/src'),
      join(native, 'observer_http.cpp'), join(firmware, 'src/orb_engine.cpp'),
      '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('firmware HTTP handler injects validated demo Mona alerts', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const native = fileURLToPath(new URL('../../../tst/firmware/native/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'orb-simulate-http-'));
  try {
    const source = readFileSync(join(firmware, 'src/orb_server.cpp'), 'utf8');
    const start = source.indexOf('void OrbServer::handleSimulateAlert() {');
    const end = source.indexOf('void OrbServer::addCorsHeaders()', start);
    assert.ok(start >= 0 && end > start);
    writeFileSync(join(directory, 'simulate-handler.inc'), source.slice(start, end));
    const binary = join(directory, 'simulate-http');
    const build = spawnSync(process.env.CXX || 'c++', [
      '-std=c++17', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-I', native, '-I', directory, '-I', join(firmware, 'include'),
      '-I', join(firmware, '.pio/libdeps/waveshare_s3_touch_lcd_21/ArduinoJson/src'),
      join(native, 'simulate_alert_http.cpp'), join(firmware, 'src/orb_engine.cpp'),
      '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
