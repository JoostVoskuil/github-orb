import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listLinuxSerialPorts, NodeUsbSetupService, isControlResponse, type ControlResponse, type UsbControlSession } from '../../dashboard/usb-setup.js';

test('serial update replies validate capability and byte acknowledgement shapes', () => {
  const reply = { orb: 'control', v: 1, id: 'host-1', ok: true,
    result: { configured: true, connected: true, port: 7420, usbFirmwareUpdate: true, updateReceived: 4096 } };
  assert.equal(isControlResponse(reply), true);
  assert.equal(isControlResponse({ ...reply, result: { ...reply.result, updateReceived: -1 } }), false);
  assert.equal(isControlResponse({ ...reply, result: { ...reply.result, updateReceived: 1.5 } }), false);
  assert.equal(isControlResponse({ ...reply, result: { ...reply.result, usbFirmwareUpdate: 'true' } }), false);
});

function serialFixture(supported = true) {
  const commands: string[] = [];
  const bytes: Buffer[] = [];
  let received = 0;
  let closed = false;
  let failCommit = false;
  const session: UsbControlSession = {
    async request(command): Promise<ControlResponse> {
      commands.push(command);
      if (command === 'firmware_commit' && failCommit) throw new Error('invalid_firmware');
      return { orb: 'control', v: 1, id: 'test', ok: true,
        result: { usbFirmwareUpdate: supported, updateReceived: received } };
    },
    async writeBytes(part) { bytes.push(Buffer.from(part)); received += part.byteLength; },
    async close() { closed = true; }
  };
  const service = new NodeUsbSetupService({
    openSession: async () => session,
    listPorts: async () => [{ id: 'orb', path: '/dev/orb', label: 'Orb', serialNumber: null, vendorId: '303a', productId: '1001' }]
  });
  return { service, commands, bytes, closed: () => closed, failCommit: () => failCommit = true };
}

test('USB firmware uses bounded acknowledged chunks and commits only the declared size', async () => {
  const fixture = serialFixture();
  const payload = Buffer.alloc(8193, 0xe9);
  await fixture.service.uploadFirmware('orb', payload.length, (async function* () { yield payload; })());
  assert.deepEqual(Buffer.concat(fixture.bytes), payload);
  assert.deepEqual(fixture.bytes.map(chunk => chunk.length), [4096, 4096, 1]);
  assert.equal(fixture.commands.filter(command => command === 'update_chunk').length, 3);
  assert.equal(fixture.commands.filter(command => command === 'update_status').length, 3);
  assert.equal(fixture.commands.at(-1), 'firmware_commit');
  assert.equal(fixture.closed(), true);
  assert.equal(fixture.service.getAssetUploadProgress(), null);
});

test('USB firmware rejects legacy support before bytes and cleans up failed or incomplete uploads', async () => {
  const legacy = serialFixture(false);
  await assert.rejects(legacy.service.uploadFirmware('orb', 1, (async function* () { yield Buffer.from([0xe9]); })()), /unsupported_firmware/);
  assert.equal(legacy.bytes.length, 0);
  assert.equal(legacy.closed(), true);
  const invalid = serialFixture();
  invalid.failCommit();
  await assert.rejects(invalid.service.uploadFirmware('orb', 1, (async function* () { yield Buffer.from([0xe9]); })()), /invalid_firmware/);
  assert.equal(invalid.commands.at(-1), 'update_abort');
  const incomplete = serialFixture();
  await assert.rejects(incomplete.service.uploadFirmware('orb', 4, (async function* () { yield Buffer.from([0xe9]); })()), /asset_size_mismatch/);
  assert.ok(!incomplete.commands.includes('firmware_commit'));
  assert.equal(incomplete.commands.at(-1), 'update_abort');
  await assert.rejects(incomplete.service.uploadFirmware('orb', 0x300001, (async function* () {})()), /invalid_firmware_size/);
  await assert.rejects(incomplete.service.uploadFirmware('orb', 0, (async function* () {})()), /invalid_firmware_size/);
});

test('USB upload busy guard is held before async port enumeration', async () => {
  const fixture = serialFixture();
  let release: () => void;
  const pending = fixture.service.uploadFirmware('orb', 1, (async function* () {
    await new Promise<void>(resolve => release = resolve);
    yield Buffer.from([0xe9]);
  })());
  await assert.rejects(fixture.service.uploadFirmware('orb', 1, (async function* () {})()), /busy/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await pending;
});

test('Linux serial enumeration reads USB identity from sysfs without udevadm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orb-usb-'));
  const sysRoot = join(root, 'sys');
  const devRoot = join(root, 'dev');
  const ttyRoot = join(sysRoot, 'class', 'tty');
  await mkdir(ttyRoot, { recursive: true });
  await mkdir(devRoot);

  async function addPort(name: string, busId: string, vendorId: string, productId: string) {
    const usbRoot = join(sysRoot, 'devices', 'usb1', busId);
    const interfaceRoot = join(usbRoot, `${busId}:1.0`);
    await mkdir(interfaceRoot, { recursive: true });
    await writeFile(join(usbRoot, 'idVendor'), vendorId);
    await writeFile(join(usbRoot, 'idProduct'), productId);
    await writeFile(join(usbRoot, 'manufacturer'), 'Espressif');
    await writeFile(join(usbRoot, 'serial'), 'orb-serial');
    const classEntry = join(ttyRoot, name);
    await mkdir(classEntry);
    await symlink(interfaceRoot, join(classEntry, 'device'));
    await writeFile(join(devRoot, name), '');
  }

  try {
    await addPort('ttyACM0', '1-1', '303A', '1001');
    await addPort('ttyACM1', '1-2', '10C4', 'EA60');
    const ports = await listLinuxSerialPorts(sysRoot, devRoot);
    assert.equal(ports.length, 2);
    assert.deepEqual(ports.map(({ vendorId, productId }) => [vendorId, productId]), [
      ['303a', '1001'],
      ['10c4', 'ea60']
    ]);
    assert.equal(ports[0].path, join(devRoot, 'ttyACM0'));
    assert.equal(ports[0].label, `Espressif (${join(devRoot, 'ttyACM0')})`);
    assert.equal(ports[0].serialNumber, 'orb-serial');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('USB Orb connection is read for the demo without saving it', async () => {
  const commands: string[] = [];
  let closed = false;
  const session: UsbControlSession = {
    async request(command): Promise<ControlResponse> {
      commands.push(command);
      const result = command === 'status' ? { configured: true, connected: true, ip: '192.0.2.5', port: 7420 }
        : command === 'token' ? { token: 'usb-secret' } : {};
      return { orb: 'control', v: 1, id: 'test', ok: true, result };
    },
    async writeBytes() {},
    async close() { closed = true; }
  };
  const port = { id: 'orb', path: '/dev/orb', label: 'Orb', serialNumber: null, vendorId: '303a', productId: '1001' };
  const service = new NodeUsbSetupService({ openSession: async () => session, listPorts: async () => [port] });
  assert.deepEqual(await service.readOrbConnection(), { host: '192.0.2.5', port: 7420, token: 'usb-secret' });
  assert.deepEqual(commands, ['hello', 'status', 'token']);
  assert.equal(closed, true);
  await assert.rejects(new NodeUsbSetupService({ listPorts: async () => [] }).readOrbConnection(), /device_not_found/);
  await assert.rejects(new NodeUsbSetupService({ listPorts: async () => [port, { ...port, id: 'b', path: '/dev/b' }] })
    .readOrbConnection(), /multiple_devices/);
});
