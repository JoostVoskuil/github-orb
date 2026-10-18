import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createDashboardServer } from '../../dashboard/serve.js';
import type { UsbSetupService } from '../../dashboard/usb-setup.js';

test('maintenance selector gates both actions, reports partial assets and restarts the captured target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-update-ui-'));
  let releaseUpload: () => void;
  const uploads: string[] = [];
  const restarts: string[] = [];
  const usb: UsbSetupService = {
    async listPorts() { return [{ id: 'orb-original', path: '/dev/orb', label: 'Test Orb', serialNumber: null, vendorId: '303a', productId: '1001' }]; },
    async uploadAsset(port, name, size, source) {
      for await (const chunk of source) { void chunk; }
      assert.equal(port, 'orb-original');
      if (name === 'sounds.json') throw new Error('sd_unavailable');
      await new Promise<void>(resolve => releaseUpload = resolve);
      uploads.push(name);
    },
    async uploadFirmware() { throw new Error('unexpected_usb_firmware'); },
    getAssetUploadProgress() { return null; },
    async restart(port) { restarts.push(port); },
    async provision() { throw new Error('unexpected_provision'); },
    async installObserver() { throw new Error('unexpected_install'); }
  };
  let wifiFirmware = 0;
  const orb = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    assert.equal(req.url, '/ota');
    wifiFirmware++;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true,"restarting":true}');
  });
  await new Promise<void>(resolve => orb.listen(0, '127.0.0.1', resolve));
  const orbAddress = orb.address();
  if (!orbAddress || typeof orbAddress === 'string') throw new Error('test_server_failed');
  const dashboard = createDashboardServer({
    githubPoller: false, usbSetup: usb, assetDir: directory, firmwareDir: directory,
    orbConfig: async () => ({ host: '127.0.0.1', port: orbAddress.port, token: 'test' })
  });
  await new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const address = dashboard.address();
  if (!address || typeof address === 'string') throw new Error('test_server_failed');
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath && process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(chrome);
    executablePath = chrome;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await writeFile(join(directory, 'app.bin'), Buffer.from([0xe9, 1, 2]));
    await writeFile(join(directory, 'animations.orb'), 'ORBA-test');
    await writeFile(join(directory, 'sounds.json'), '{}');
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/setup/settings', route => route.fulfill({ status: 503, json: { error: 'test_settings_unavailable' } }));
    await page.goto(`http://127.0.0.1:${address.port}/dashboard/`);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#orb-settings-load').disabled);
    assert.equal(await page.locator('input[name="update-transport"][value="wifi"]').isChecked(), true);
    await page.locator('input[name="update-transport"][value="usb"]').check();
    await page.locator('#asset-upload-button').click();
    await page.waitForFunction(() => document.querySelector('#asset-status').textContent.includes('Select a connected USB Orb'));
    await page.locator('#usb-port').selectOption('orb-original');
    await page.locator('#asset-upload-button').click();
    await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('#update-transport').disabled);
    assert.equal(await page.locator('#firmware-upload-button').isDisabled(), true);
    assert.equal(await page.locator('#usb-port').isDisabled(), true);
    assert.equal(await page.locator('#usb-install-observer').isDisabled(), true);
    while (!releaseUpload) await new Promise(resolve => setImmediate(resolve));
    releaseUpload();
    await page.waitForFunction(() => document.querySelector('#asset-status').textContent.includes('Already updated: animations.orb'));
    assert.deepEqual(uploads, ['animations.orb']);
    assert.equal(await page.locator('#asset-restart-button').isEnabled(), true);
    await page.locator('input[name="update-transport"][value="wifi"]').check();
    await page.locator('#asset-restart-button').click();
    await page.waitForFunction(() => document.querySelector('#asset-status').textContent.startsWith('Orb restarting.'));
    assert.deepEqual(restarts, ['orb-original']);
    assert.equal(await page.locator('#asset-restart-button').isDisabled(), true);
    await page.locator('#firmware-upload-button').click();
    await page.waitForFunction(() => document.querySelector('#firmware-status').textContent.startsWith('Firmware verified and uploaded.'));
    assert.equal(wifiFirmware, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => dashboard.close(() => resolve()));
    await new Promise<void>(resolve => orb.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
