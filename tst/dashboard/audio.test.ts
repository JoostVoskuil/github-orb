import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours } from '../../dashboard/audio.js';

const at = (hour: number, minute: number) => new Date(2026, 0, 1, hour, minute);

test('quiet hours use local 24-hour boundaries, including overnight ranges', () => {
  const overnight = { enabled: true, start: '22:00', end: '08:00' };
  assert.equal(inQuietHours(overnight, at(21, 59)), false);
  assert.equal(inQuietHours(overnight, at(22, 0)), true);
  assert.equal(inQuietHours(overnight, at(7, 59)), true);
  assert.equal(inQuietHours(overnight, at(8, 0)), false);
  assert.equal(inQuietHours({ ...overnight, start: '09:00', end: '17:00' }, at(12, 0)), true);
});
