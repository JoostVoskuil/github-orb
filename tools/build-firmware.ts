import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const environment = 'waveshare_s3_touch_lcd_21';
const build = ['run', '-d', 'firmware', '-e', environment];
const candidates = [
  process.env.PLATFORMIO,
  process.env.PIO,
  'platformio',
  'pio',
  join(homedir(), '.platformio', 'penv', 'bin', 'platformio')
].filter((candidate): candidate is string => Boolean(candidate));

let built = false;
for (const executable of candidates) {
  const result = spawnSync(executable, build, { cwd: root, stdio: 'inherit' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') continue;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PlatformIO firmware build failed (${result.status ?? 'unknown exit status'}).`);
  built = true;
  break;
}
if (!built) throw new Error('PlatformIO was not found. Set PIO or PLATFORMIO to its executable path.');

const source = join(root, 'firmware', '.pio', 'build', environment, 'firmware.bin');
const info = await stat(source);
if (!info.isFile() || info.size <= 0 || info.size > 0x300000) {
  throw new Error(`Firmware binary size is invalid for the 3 MiB OTA slot (${info.size} bytes).`);
}

const output = join(root, 'dist', 'firmware');
await mkdir(output, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const filename = `firmware-${timestamp}.bin`;
await copyFile(source, join(output, filename));
console.log(`Published ${filename} (${info.size} bytes) to dist/firmware.`);
