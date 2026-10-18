import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceUpdates } from '../../dashboard/device-updates.js';
import { createDashboardServer } from '../../dashboard/serve.js';
import type { UsbSetupService } from '../../dashboard/usb-setup.js';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'orb-updates-'));
  try {
    await writeFile(join(directory, 'app.bin'), Buffer.from([0xe9, 1, 2, 3]));
    await writeFile(join(directory, 'sounds.json'), '{"version":1}');
    await writeFile(join(directory, 'animations.orb'), 'ORBA-test');
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Wi-Fi firmware, assets and captured-target restart work with USB disabled', async () => {
  await fixture(async directory => {
    const requests: Array<{ path: string; auth: string; asset: string | string[] | undefined; body: Buffer }> = [];
    const orb = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url, auth: req.headers.authorization, asset: req.headers['x-orb-asset'], body: Buffer.concat(chunks) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/restart' ? { restarting: true } : { ok: true }));
    });
    await new Promise<void>(resolve => orb.listen(0, '127.0.0.1', resolve));
    const address = orb.address();
    if (!address || typeof address === 'string') throw new Error('test_server_failed');
    let host = '127.0.0.1';
    const dashboard = createDashboardServer({
      githubPoller: false, usbSetup: false, assetDir: directory, firmwareDir: directory,
      orbConfig: async () => ({ host, port: address.port, token: 'test-private-token' })
    });
    await new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve));
    const dashboardAddress = dashboard.address();
    if (!dashboardAddress || typeof dashboardAddress === 'string') throw new Error('test_server_failed');
    const base = `http://127.0.0.1:${dashboardAddress.port}`;
    const post = async (path: string, body: unknown, origin = base) => {
      const response = await fetch(`${base}/setup/updates/${path}`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.equal((await post('target', { transport: 'wifi' }, 'https://example.test')).status, 403);
      assert.equal((await post('target', { transport: 'usb', portId: 'orb' })).body.error, 'serial_unavailable');
      assert.equal((await post('target', { transport: 'invalid' })).status, 400);
      const target = await post('target', { transport: 'wifi' });
      assert.equal(target.status, 200);
      assert.equal(JSON.stringify(target.body).includes('test-private-token'), false);
      const targetId = target.body.targetId;
      host = 'invalid.invalid';
      for (const name of ['animations.orb', 'sounds.json']) {
        const result = await post('assets', { targetId, name });
        assert.equal(result.status, 200);
        assert.equal(result.body.uploaded, name);
      }
      assert.equal((await post('firmware', { targetId })).body.ok, true);
      assert.equal((await post('restart', { targetId })).body.restarting, true);
      assert.deepEqual(requests.map(req => req.path), ['/assets?name=animations.orb', '/assets?name=sounds.json', '/ota', '/restart']);
      assert.deepEqual(requests.map(req => req.asset), ['animations.orb', 'sounds.json', undefined, undefined]);
      assert.ok(requests.every(req => req.auth === 'Bearer test-private-token'));
      assert.deepEqual(requests[2].body, Buffer.from([0xe9, 1, 2, 3]));
      assert.equal((await post('assets', { targetId, name: '../config.json' })).status, 400);
      assert.equal((await post('assets', { targetId, name: 'firmware.bin' })).status, 400);
      assert.equal((await post('restart', { targetId: 'missing' })).status, 409);
    } finally {
      await new Promise<void>(resolve => dashboard.close(() => resolve()));
      await new Promise<void>(resolve => orb.close(() => resolve()));
    }
  });
});

test('USB update actions use published files, preserve target and release busy state after failure', async () => {
  await fixture(async directory => {
    let selectedPort = 'orb-1';
    const uploads: Array<{ port: string; name: string; size: number; body: Buffer }> = [];
    let fail = false;
    const upload = async (port: string, name: string, size: number, source: AsyncIterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      if (fail) throw new Error('asset_incomplete_or_invalid');
      uploads.push({ port, name, size, body: Buffer.concat(chunks) });
    };
    const usb: UsbSetupService = {
      async listPorts() { return [{ id: selectedPort, path: selectedPort, label: 'Orb', serialNumber: null, vendorId: '303a', productId: '1001' }]; },
      async uploadAsset(port, name, size, source) { await upload(port, name, size, source); },
      async uploadFirmware(port, size, source) { await upload(port, 'firmware.bin', size, source); },
      async restart(port) { assert.equal(port, 'orb-1'); },
      getAssetUploadProgress() { return null; },
      async installObserver() { throw new Error('unexpected'); },
      async provision() { throw new Error('unexpected'); }
    };
    const service = new DeviceUpdates({
      usb, assetDir: directory, firmwareDir: directory, config: async () => { throw new Error('wifi_must_not_be_used'); }
    });
    const target = await service.target('usb', selectedPort);
    selectedPort = 'orb-2';
    await service.upload(target, 'sounds.json');
    await service.upload(target, 'firmware.bin');
    await service.restart(target);
    assert.deepEqual(uploads.map(({ port, name }) => [port, name]), [['orb-1', 'sounds.json'], ['orb-1', 'firmware.bin']]);
    assert.deepEqual(uploads[1].body, Buffer.from([0xe9, 1, 2, 3]));
    fail = true;
    await assert.rejects(service.upload(target, 'animations.orb'), /asset_incomplete_or_invalid/);
    assert.equal(service.getProgress(), null);
    fail = false;
    await service.upload(target, 'animations.orb');
    await writeFile(join(directory, 'sounds.json'), Buffer.alloc(4097));
    await assert.rejects(service.upload(target, 'sounds.json'), /asset_unavailable/);
    await writeFile(join(directory, 'sounds.json'), Buffer.alloc(4096));
    await service.upload(target, 'sounds.json');
    assert.equal(uploads.at(-1).size, 4096);
  });
});

test('Wi-Fi rejects unsupported firmware, unauthorized and invalid responses, and serializes operations', async () => {
  await fixture(async directory => {
    let status = 404;
    let responseBody = '{"error":"not_found"}';
    let release: (() => void) | undefined;
    const orb = http.createServer(async (req, res) => {
      for await (const chunk of req) { void chunk; }
      if (release) await new Promise<void>(resolve => release = resolve);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
    await new Promise<void>(resolve => orb.listen(0, '127.0.0.1', resolve));
    const address = orb.address();
    if (!address || typeof address === 'string') throw new Error('test_server_failed');
    const service = new DeviceUpdates({
      assetDir: directory, firmwareDir: directory,
      config: async () => ({ host: '127.0.0.1', port: address.port, token: 'test' })
    });
    try {
      const target = await service.target('wifi', '');
      await assert.rejects(service.upload(target, 'sounds.json'), /unsupported_firmware/);
      status = 401;
      await assert.rejects(service.upload(target, 'sounds.json'), /orb_unauthorized/);
      status = 200;
      responseBody = '{}';
      await assert.rejects(service.upload(target, 'sounds.json'), /invalid_orb_response/);
      responseBody = 'x'.repeat(4097);
      await assert.rejects(service.upload(target, 'sounds.json'), /invalid_orb_response/);
      responseBody = '{"ok":true}';
      release = () => {};
      const pending = service.upload(target, 'sounds.json');
      await assert.rejects(service.restart(target), /busy/);
      // The request must reach the fixture before its held response is released.
      while (service.getProgress()?.phase !== 'validating') await new Promise(resolve => setTimeout(resolve, 5));
      await new Promise(resolve => setTimeout(resolve, 20));
      release();
      release = undefined;
      await pending;
      assert.equal(service.getProgress(), null);
    } finally { await new Promise<void>(resolve => orb.close(() => resolve())); }
  });
});
