import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createDashboardServer } from '../dashboard/serve.js';

const server = createDashboardServer({ githubPoller: false, usbSetup: false });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let executablePath = process.env.CHROME_PATH;
if (!executablePath && process.platform === 'darwin') {
  const path = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    await access(path);
    executablePath = path;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let device = {
    sound: true, volume: 0.35, brightness: 0.7,
    quietHours: { enabled: true, start: '23:00', end: '07:30' },
    timezone: 'UTC0', githubPollSec: 90, githubConfigured: true
  };
  const deviceWrites: Record<string, unknown>[] = [];
  const wifiWrites: Record<string, unknown>[] = [];
  const dashboardTokenWrites: string[] = [];
  let dashboardExtensionInstalls = 0;
  let rejectSettings = false;
  let soundTests = 0;
  let soundError = '';
  await page.route('**/setup/audio/test', route => {
    soundTests++;
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().headers()['content-type'], 'application/json');
    assert.deepEqual(route.request().postDataJSON(), {});
    return route.fulfill(soundError
      ? { status: 409, json: { error: soundError } }
      : { status: 202, json: { scheduled: true } });
  });
  await page.route('**/github/status', (route) => route.fulfill({
    json: { enabled: false, status: 'disabled', lastSuccessMs: null, error: null, source: 'none', configurationError: null }
  }));
  await page.route('**/github/token', (route) => {
    const { token } = route.request().postDataJSON() as { token: string };
    dashboardTokenWrites.push(token);
    return route.fulfill({
      json: { enabled: !!token, status: token ? 'starting' : 'disabled', source: token ? 'saved' : 'none', configurationError: null }
    });
  });
  await page.route('**/setup/install-dashboard-observer', (route) => {
    dashboardExtensionInstalls++;
    return route.fulfill({ json: { host: '127.0.0.1', port: 7420, extensionPath: '/.copilot/extensions/github-orb/extension.mjs' } });
  });
  await page.route('**/setup/observer', route => route.fulfill({ json: {
    installed: true, configPath: '/private/orb/config.json', error: null,
    destinations: [
      { kind: 'orb', host: '192.0.2.42', port: 7420, status: 'reachable', activeSessions: 1 },
      { kind: 'dashboard', host: '127.0.0.1', port: 7420, status: 'reachable', activeSessions: 1 }
    ]
  } }));
  await page.route('**/setup/ports', (route) => route.fulfill({
    json: { ports: [{ id: 'test-orb', label: 'Test Orb (USB)' }] }
  }));
  await page.route('**/setup/provision', (route) => {
    wifiWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { host: '192.0.2.42', port: 7420, configSaved: true } });
  });
  await page.route('**/setup/settings', (route) => {
    if (rejectSettings)
      return route.fulfill({ status: 502, json: { error: 'orb_unreachable' } });
    if (route.request().method() === 'PUT') {
      const update = route.request().postDataJSON();
      deviceWrites.push(update);
      device = { ...device, ...update, githubConfigured: update.githubPat === undefined ? device.githubConfigured : !!update.githubPat };
    }
    const { sound, volume, brightness, quietHours, timezone, githubPollSec, githubConfigured } = device;
    return route.fulfill({ json: { sound, volume, brightness, quietHours, timezone, githubPollSec, githubConfigured } });
  });
  await page.goto(`${base}/dashboard/`);
  await page.locator('.site-banner h1').filter({ hasText: 'GitHub Orb' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.site-banner img, .site-footer img')]
    .every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator('.site-footer a[href="https://polyformproject.org/licenses/noncommercial/1.0.0"]').count(), 1);
  assert.equal(await page.locator('.site-footer a[href="https://github.com/martinwoodward/octoprints"]').count(), 1);
  assert.equal(await page.locator('.site-footer a[href="https://creativecommons.org/licenses/by-nc/4.0/"]').count(), 1);
  assert.match(await page.locator('.site-footer').innerText(), /Copyright.*2026/);
  assert.match(await page.locator('.site-footer').innerText(), /Third-party model and mascot assets retain their own licenses/);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'live');
  await page.getByText('Settings loaded from the physical Orb.', { exact: true }).waitFor();
  assert.equal(await page.locator('#qh-start').inputValue(), '23:00');
  assert.equal(await page.locator('#github-poll-sec').inputValue(), '90');
  for (const id of ['github-token', 'qh-enabled', 'brightness'])
    assert.equal(await page.locator(`#live-settings #${id}`).count(), 1);
  assert.equal(await page.locator('#usb-port').inputValue(), '', 'USB selection must be explicit');
  assert.equal(await page.locator('#wifi-connect').isDisabled(), true);
  assert.equal(await page.locator('#usb-install-observer').isDisabled(), true);
  await page.getByText('Configured for both ESP32 and dashboard', { exact: true }).waitFor();
  assert.equal(await page.locator('#observer-destinations li').count(), 2);
  assert.equal(await page.locator('#device-maintenance summary').count(), 0);
  assert.equal(await page.locator('#device-management-heading').textContent(), 'Device management');
  assert.equal(await page.locator('#device-maintenance #update-transport').isVisible(), true);
  assert.equal(await page.locator('#orb-sidebar > :first-child').getAttribute('id'), 'activity-log');
  assert.equal(await page.locator('#puck').isVisible(), false, 'Live Orb must not show the local Dashboard Orb preview');
  assert.equal(await page.locator('#orb-panel #audio-unlock').count(), 0);
  assert.equal(await page.locator('#dashboard-panel #audio-unlock').count(), 1);
  await page.locator('#orb-audio-test').click();
  await page.getByText('Sound scheduled on the physical Orb. Listen for a brief buzzer notification.', { exact: true }).waitFor();
  assert.equal(soundTests, 1);
  for (const [code, message] of [
    ['sound_muted', 'Enable sound and set volume above zero'],
    ['quiet_hours_active', 'Quiet hours are active'],
    ['sound_assets_unavailable', 'Upload animations and sounds'],
    ['audio_test_unsupported', 'Update the Orb firmware']
  ]) {
    soundError = code;
    await page.locator('#orb-audio-test').click();
    await page.getByText(`Could not test Orb sound: ${message}`, { exact: false }).waitFor();
  }
  soundError = '';

  await page.locator('#usb-port').selectOption('test-orb');
  assert.equal(await page.locator('#wifi-connect').isEnabled(), true);
  assert.equal(await page.locator('#usb-install-observer').isEnabled(), true);
  await page.locator('#wifi-connection > summary').click();
  await page.locator('#wifi-ssid').fill('Test WiFi');
  await page.locator('#wifi-password').fill('test-passphrase');
  await page.locator('#wifi-connect').click();
  await page.getByText('Wi-Fi connected and settings loaded. Continue with Copilot and your preferences below.', { exact: true }).waitFor();
  assert.equal(deviceWrites.length, 0, 'Connecting Wi-Fi must not save default or stale settings');
  await page.locator('#github-token').fill('test-pat-for-ui');
  await page.locator('#qh-start').fill('21:30');
  const testsBeforeDirty = soundTests;
  await page.locator('#orb-audio-test').click();
  await page.getByText('Save to Orb before testing so the buzzer uses your new settings.', { exact: true }).waitFor();
  assert.equal(soundTests, testsBeforeDirty);
  await page.locator('#github-poll-sec').fill('120');
  await page.locator('#orb-settings-save').click();
  await page.getByText('All settings saved to the physical Orb.', { exact: true }).waitFor();
  assert.deepEqual(wifiWrites, [{ portId: 'test-orb', wifiSsid: 'Test WiFi', wifiPassword: 'test-passphrase' }]);
  assert.deepEqual(deviceWrites[0], {
    sound: true, volume: 0.35, brightness: 0.7,
    quietHours: { enabled: true, start: '21:30', end: '07:30' },
    timezone: 'UTC0', githubPollSec: 120, githubPat: 'test-pat-for-ui'
  });
  assert.equal(await page.locator('#wifi-password').inputValue(), '');
  assert.equal(await page.locator('#github-token').inputValue(), '');
  assert.equal(await page.locator('#wifi-ssid').inputValue(), '');
  await page.locator('#orb-settings-save').click();
  await page.getByText('All settings saved to the physical Orb.', { exact: true }).waitFor();
  assert.equal(wifiWrites.length, 1, 'Saving settings must not reconfigure Wi-Fi');
  assert.equal('githubPat' in deviceWrites[1], false, 'Blank PAT preserves the saved token');
  await page.locator('#github-token-clear').check();
  assert.equal(await page.locator('#github-token').isDisabled(), true);
  await page.locator('#orb-settings-save').click();
  await page.getByText('All settings saved to the physical Orb.', { exact: true }).waitFor();
  assert.equal(deviceWrites[2].githubPat, '');
  assert.equal(await page.locator('#github-token').isEnabled(), true);
  await page.getByText('Orb: no GitHub PAT saved; polling is disabled.', { exact: true }).waitFor();

  await page.locator('#qh-start').fill('20:45');
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/state');
  assert.equal(await page.locator('#qh-start').inputValue(), '20:45', 'Live polling must not overwrite unsaved settings');
  await page.locator('#orb-settings-load').click();
  await page.getByText('Settings loaded from the physical Orb.', { exact: true }).waitFor();
  assert.equal(await page.locator('#qh-start').inputValue(), '21:30');
  const writesBeforeInvalid = deviceWrites.length;
  await page.locator('#qh-start').fill('25:00');
  await page.locator('#orb-settings-save').click();
  assert.equal(deviceWrites.length, writesBeforeInvalid, 'Invalid times must block submission');
  await page.locator('#qh-start').fill('21:30');

  rejectSettings = true;
  await page.locator('#wifi-connection > summary').click();
  await page.locator('#wifi-ssid').fill('Test WiFi');
  await page.locator('#wifi-password').fill('test-passphrase');
  await page.locator('#wifi-connect').click();
  await page.getByText('Wi-Fi connected, but settings could not be loaded. Retry the connection above.', { exact: true }).waitFor();
  assert.equal(await page.locator('#orb-settings-save').isDisabled(), true);
  assert.equal(await page.locator('#wifi-password').inputValue(), '');
  rejectSettings = false;
  await page.locator('#orb-settings-load').click();
  await page.getByText('Settings loaded from the physical Orb.', { exact: true }).waitFor();
  rejectSettings = true;
  await page.locator('#github-token').fill('test-pat-failed-save');
  await page.locator('#orb-settings-save').click();
  await page.locator('#orb-settings-status').filter({ hasText: 'Orb settings were not saved: orb_unreachable' }).waitFor();
  assert.equal(await page.locator('#wifi-password').inputValue(), '');
  assert.equal(await page.locator('#github-token').inputValue(), '');
  assert.equal(await page.locator('#orb-settings-save').isEnabled(), true);
  await page.locator('#orb-settings-load').click();
  await page.locator('#orb-settings-status').filter({ hasText: 'Could not load Orb settings: orb_unreachable' }).waitFor();
  rejectSettings = false;
  await page.locator('#orb-settings-save').click();
  await page.getByText('All settings saved to the physical Orb.', { exact: true }).waitFor();
  assert.equal(wifiWrites.length, 2, 'Retrying settings must preserve the successful Wi-Fi change');
  const storedSecrets = await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage), document.getElementById('log')?.textContent].join('\n'));
  assert.equal(/test-passphrase|test-pat-for-ui|test-pat-failed-save/.test(storedSecrets), false);

  for (const width of [1200, 920, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      orb: document.getElementById('puck')!.getBoundingClientRect(),
      panel: document.querySelector('.panel')!.getBoundingClientRect(),
      settings: document.querySelector('.orb-settings-column')!.getBoundingClientRect(),
      sidebar: document.getElementById('orb-sidebar')!.getBoundingClientRect()
    }));
    assert.ok(dimensions.content <= dimensions.viewport, `Settings layout must not overflow at ${width}px`);
    if (width > 900) assert.ok(dimensions.orb.right <= dimensions.panel.left, 'Orb and settings must not overlap');
    if (width > 900) assert.ok(dimensions.settings.right <= dimensions.sidebar.left, 'Live Orb settings and management must use separate columns');
    else assert.ok(dimensions.settings.bottom <= dimensions.sidebar.top, 'Live Orb columns must stack on small screens');
  }
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Live Orb', 'Live Dashboard', 'Animations']);
  await page.getByRole('tab', { name: 'Live Dashboard', exact: true }).click();
  await page.locator('#dashboard-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.stage #activity-log').count(), 1, 'Dashboard log must return beside the preview');
  assert.equal(await page.locator('#puck').isVisible(), true, 'Live Dashboard retains its Orb preview');
  await page.locator('#dashboard-install-observer').click();
  await page.getByText(/Copilot events now go to this dashboard/).waitFor();
  assert.equal(dashboardExtensionInstalls, 1);
  await page.locator('#dashboard-github-token').fill('test-dashboard-pat');
  await page.locator('#dashboard-github-save').click();
  await page.getByText('GitHub notifications enabled. Polling: starting.', { exact: true }).waitFor();
  assert.deepEqual(dashboardTokenWrites, ['test-dashboard-pat']);
  assert.equal(await page.locator('#dashboard-github-token').inputValue(), '');
  await page.locator('#dashboard-github-clear').click();
  await page.getByText('GitHub notifications disabled; the saved token was removed.', { exact: true }).waitFor();
  assert.deepEqual(dashboardTokenWrites, ['test-dashboard-pat', '']);

  await page.getByRole('tab', { name: 'Animations', exact: true }).click();
  assert.equal(await page.locator('#puck').isVisible(), true);
  assert.equal(await page.locator('#activity-log').isVisible(), false, 'Animations must hide the activity log');
  await page.locator('[data-scenario="approval"]').click();
  await page.waitForFunction(() => document.getElementById('mood-now')?.textContent === 'copilot: needsInput');
  assert.equal(deviceWrites.length, writesBeforeInvalid + 1, 'Preview must not persist device settings');
  await page.getByRole('tab', { name: 'Live Orb', exact: true }).click();
  assert.equal(await page.locator('#orb-sidebar #activity-log').count(), 1, 'Live Orb log must share the management column');
  assert.equal(await page.locator('#activity-log').isVisible(), true, 'Live tabs must retain the activity log');
  assert.equal(await page.locator('#qh-start').inputValue(), '21:30');
  rejectSettings = true;
  await page.reload();
  await page.locator('#orb-settings-status').filter({ hasText: 'Could not load Orb settings: orb_unreachable' }).waitFor();
  assert.equal(await page.locator('#orb-settings-save').isDisabled(), true, 'An unavailable Orb must not expose editable defaults');
  assert.equal(await page.locator('#wifi-connection').getAttribute('open'), '');
  assert.equal(await page.locator('#wifi-connect').isDisabled(), true, 'First-time setup must select USB before Wi-Fi');
  await page.locator('#usb-port').selectOption('test-orb');
  assert.equal(await page.locator('#wifi-connect').isEnabled(), true, 'Wi-Fi setup must remain available when settings cannot load');
  rejectSettings = false;
  await page.locator('#orb-settings-load').click();
  await page.getByText('Settings loaded from the physical Orb.', { exact: true }).waitFor();
  assert.equal(await page.locator('#orb-settings-save').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: Observer destinations on screen, explicit USB selection, separate Wi-Fi setup, settings gating/retry, extension/GitHub setup, credential preservation/removal, polling and animation isolation, responsive layout at 320–1200px; no browser errors.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
