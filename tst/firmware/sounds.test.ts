import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('SD notification sound patterns are valid and short', () => {
  const firmware = fileURLToPath(new URL('../../../firmware/', import.meta.url));
  const pack = JSON.parse(readFileSync(resolve(firmware, 'data/sounds.json'), 'utf8'));
  assert.equal(pack.version, 1);
  assert.deepEqual(Object.keys(pack.sounds).sort(), [
    'copilotDone', 'copilotNeedsInput', 'monaNotification', 'monaPrAssigned',
    'monaReviewRequested', 'monaSecurity', 'monaWorkflow'
  ].sort());
  for (const [name, pulses] of Object.entries(pack.sounds) as [string, number[][]][]) {
    assert.ok(pulses.length > 0 && pulses.length <= 4, `${name} pulse count`);
    let totalMs = 0;
    for (const [onMs, gapMs] of pulses) {
      assert.ok(onMs >= 30 && onMs <= 180, `${name} pulse duration`);
      assert.ok(gapMs >= 0 && gapMs <= 120, `${name} gap duration`);
      totalMs += onMs + gapMs;
    }
    assert.ok(totalMs <= 700, `${name} is a brief notification`);
  }
});
