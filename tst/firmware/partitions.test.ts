import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('SD-only flash layout preserves provisioning and app offsets without a flash filesystem', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const config = readFileSync(resolve(firmware, 'platformio.ini'), 'utf8');
  const partitionPath = config.match(/^board_build\.partitions\s*=\s*(\S+)\s*$/m)?.[1];
  assert.ok(partitionPath, 'A custom partition table is required');
  const partitions = readFileSync(resolve(firmware, partitionPath), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [name, type, subtype, offset, size] = line.split(',').map(value => value.trim());
      return { name, type, subtype, offset: Number(offset), size: Number(size) };
    });
  assert.deepEqual(partitions, [
    { name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x5000 },
    { name: 'otadata', type: 'data', subtype: 'ota', offset: 0xe000, size: 0x2000 },
    { name: 'phy_init', type: 'data', subtype: 'phy', offset: 0x10000, size: 0x1000 },
    { name: 'app0', type: 'app', subtype: 'ota_0', offset: 0x20000, size: 0x300000 },
    { name: 'app1', type: 'app', subtype: 'ota_1', offset: 0x320000, size: 0x300000 },
  ]);
  const end = Math.max(...partitions.map(partition => partition.offset + partition.size));
  assert.equal(0x1000000 - end, 0x9E0000, 'Trailing flash stays unallocated');
  assert.match(config, /^board_upload\.flash_size\s*=\s*16MB\s*$/m);
  assert.match(config, /^board_upload\.maximum_size\s*=\s*3145728\s*$/m);
  assert.doesNotMatch(config, /^board_build\.filesystem\s*=/m);
});