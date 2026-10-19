import assert from 'node:assert/strict';
import test from 'node:test';
import { ObserverReducer, permissionAttention } from '../../observer/observer-reducer.js';
import { ATTENTION_KINDS, DISPLAY_ONLY_ATTENTION, validAttention } from '../../observer/observer-protocol.js';

// Expected objects are deliberately written in canonical order, unlike the SDK input.
const cases = [
  { name: 'write', kind: 'write', preview: 'config.json',
    request: { kind: 'write', intention: 'Update config', fileName: '/workspace/full/config.json', content: 'all content' },
    expected: { content: 'all content', fileName: '/workspace/full/config.json', intention: 'Update config', kind: 'write' } },
  { name: 'read', kind: 'read', preview: 'config.json',
    request: { path: 'C:\\workspace\\full\\config.json', kind: 'read', intention: 'Read config', recursive: false },
    expected: { intention: 'Read config', kind: 'read', path: 'C:\\workspace\\full\\config.json', recursive: false } },
  { name: 'read paths', kind: 'read', preview: 'config.json',
    request: { paths: ['/workspace/a/config.json', '/workspace/b/config.json'], kind: 'path', accessKind: 'read' },
    expected: { accessKind: 'read', kind: 'path', paths: ['/workspace/a/config.json', '/workspace/b/config.json'] } },
  { name: 'write paths', kind: 'write', preview: 'config.json',
    request: { paths: ['/workspace/a/config.json', '/workspace/b/config.json'], kind: 'path', accessKind: 'write' },
    expected: { accessKind: 'write', kind: 'path', paths: ['/workspace/a/config.json', '/workspace/b/config.json'] } },
  { name: 'URL including query and fragment', kind: 'url', preview: 'example.com',
    request: { url: 'https://example.com/full/path?query=one&other=two#section', method: 'POST', kind: 'url' },
    expected: { kind: 'url', method: 'POST', url: 'https://example.com/full/path?query=one&other=two#section' } },
  { name: 'MCP with nested arguments', kind: 'mcp', preview: 'github/Create issue',
    request: { toolName: 'create_issue', toolTitle: 'Create issue', serverName: 'github', kind: 'mcp',
      args: { title: 'Full title', options: { labels: ['z', 'a'], draft: false }, count: 0 } },
    expected: { args: { count: 0, options: { draft: false, labels: ['z', 'a'] }, title: 'Full title' },
      kind: 'mcp', serverName: 'github', toolName: 'create_issue', toolTitle: 'Create issue' } },
  { name: 'memory', kind: 'memory', preview: 'Project notes',
    request: { subject: 'Project notes', kind: 'memory', entries: [{ value: null, key: 'note' }], operation: 'write' },
    expected: { entries: [{ key: 'note', value: null }], kind: 'memory', operation: 'write', subject: 'Project notes' } },
  { name: 'custom tool with nested arguments', kind: 'custom-tool', preview: 'local_gate',
    request: { toolName: 'local_gate', toolDescription: 'Review local gate', kind: 'custom-tool',
      args: { paths: ['/workspace/full/config.json'], options: { write: true, count: 0 } } },
    expected: { args: { options: { count: 0, write: true }, paths: ['/workspace/full/config.json'] },
      kind: 'custom-tool', toolDescription: 'Review local gate', toolName: 'local_gate' } }
];

test('known non-shell permissions review every field as recursively sorted pretty JSON', async t => {
  for (const { name, kind, preview, request, expected } of cases) {
    await t.test(name, () => {
      const command = JSON.stringify(expected, null, 2);
      assert.ok(Buffer.byteLength(command) <= 1024);
      for (const field of ['promptRequest', 'permissionRequest']) {
        const attention = permissionAttention({ [field]: request, requestId: 'private-outer-sdk-id' }, true);
        assert.equal(attention.kind, kind);
        assert.equal(attention.preview, preview);
        assert.equal(attention.actionable, true);
        assert.equal(attention.command, command);
        assert.deepEqual(JSON.parse(attention.command!), request);
        assert.equal(attention.command!.includes('private-outer-sdk-id'), false);
        assert.equal(validAttention({ ...attention, id: 'aaaaaaaaaaaaaaaa', pending: 1 }), true);
        for (const enabled of [undefined, false]) {
          const readOnly = permissionAttention({ [field]: request }, enabled);
          assert.equal(readOnly.actionable, undefined);
          assert.equal(readOnly.command, undefined);
        }
      }
      for (const source of ['event', 'poll']) {
        const reducer = new ObserverReducer({ permissionDecisions: true, nonce: () => 'aaaaaaaaaaaaaaaa' });
        const state = source === 'poll'
          ? reducer.syncPermissions([{ requestId: 'private-outer-sdk-id', request }])
          : reducer.accept({ type: 'permission.requested', data: { requestId: 'private-outer-sdk-id', promptRequest: request } });
        assert.equal(state?.attention?.command, command);
        assert.equal(JSON.stringify(state).includes('private-outer-sdk-id'), false);
        assert.equal(reducer.permissionRequestId('aaaaaaaaaaaaaaaa'), 'private-outer-sdk-id');
        assert.equal(reducer.permissionRequestId('private-outer-sdk-id'), undefined);
      }
    });
  }
});

test('structured review limits count complete pretty JSON UTF-8 bytes, never a truncated preview', async t => {
  for (const { name, request } of cases) {
    await t.test(name, () => {
      const base = { ...request, padding: '' };
      const overhead = Buffer.byteLength(JSON.stringify(base, null, 2));
      const available = 1024 - overhead;
      const padding = 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2);
      const boundary = { ...base, padding };
      const details = permissionAttention({ promptRequest: boundary }, true);
      assert.equal(Buffer.byteLength(details.command!), 1024);
      assert.equal(details.actionable, true);
      assert.deepEqual(JSON.parse(details.command!), boundary);
      for (const suffix of ['x', 'é']) {
        const oversized = permissionAttention({ promptRequest: { ...boundary, padding: padding + suffix } }, true);
        assert.equal(oversized.actionable, undefined);
        assert.equal(oversized.command, undefined);
        assert.equal(oversized.preview, details.preview);
      }
    });
  }
  const circular: Record<string, unknown> = { kind: 'mcp', toolName: 'loop' };
  circular.args = circular;
  for (const request of [circular, { kind: 'custom-tool', args: { count: 1n } }, { kind: 'future-kind', args: {} }]) {
    const attention = permissionAttention({ promptRequest: request }, true);
    assert.equal(attention.actionable, undefined);
    assert.equal(attention.command, undefined);
  }
});

test('matchesPermission rejects changed full paths, queries and arguments despite identical previews', async t => {
  const changes = [
    [{ kind: 'write', fileName: '/safe/config.json' }, { kind: 'write', fileName: '/different/config.json' }],
    [{ kind: 'read', path: 'C:\\safe\\config.json' }, { kind: 'read', path: 'C:\\different\\config.json' }],
    [{ kind: 'path', paths: ['/safe/config.json', '/safe/other'] }, { kind: 'path', paths: ['/safe/config.json', '/different/other'] }],
    [{ kind: 'url', url: 'https://example.com/path?q=one' }, { kind: 'url', url: 'https://example.com/path?q=two' }],
    [{ kind: 'mcp', serverName: 'github', toolName: 'update', args: { options: { value: 1 } } },
      { kind: 'mcp', serverName: 'github', toolName: 'update', args: { options: { value: 2 } } }],
    [{ kind: 'custom-tool', toolName: 'update', args: { paths: ['/safe/config.json'] } },
      { kind: 'custom-tool', toolName: 'update', args: { paths: ['/different/config.json'] } }],
    [{ kind: 'memory', subject: 'Notes', content: 'one' }, { kind: 'memory', subject: 'Notes', content: 'two' }]
  ];
  for (const [request, changed] of changes) {
    await t.test(request.kind, () => {
      const reducer = new ObserverReducer({ permissionDecisions: true });
      const attention = reducer.syncPermissions([{ requestId: 'private', request }])!.attention!;
      assert.equal(attention.preview, permissionAttention({ promptRequest: changed }, true).preview);
      assert.equal(reducer.matchesPermission(attention.id, request), true);
      assert.equal(reducer.matchesPermission(attention.id, changed), false);
    });
  }
});

test('matchesPermission ignores nested object key order but preserves array order and extra fields', () => {
  const request = { kind: 'mcp', serverName: 'github', toolName: 'update',
    args: { z: [{ b: 2, a: 1 }], a: { y: false, x: null } } };
  const reordered = { args: { a: { x: null, y: false }, z: [{ a: 1, b: 2 }] },
    toolName: 'update', serverName: 'github', kind: 'mcp' };
  const reducer = new ObserverReducer({ permissionDecisions: true });
  const attention = reducer.syncPermissions([{ requestId: 'private', request }])!.attention!;
  assert.equal(reducer.matchesPermission(attention.id, reordered), true);
  assert.equal(reducer.matchesPermission(attention.id, { ...reordered, extra: false }), false);
  assert.equal(reducer.matchesPermission('bbbbbbbbbbbbbbbb', reordered), false);
  const arrayRequest = { ...request, args: { paths: ['/first', '/second'] } };
  const arrays = new ObserverReducer({ permissionDecisions: true });
  const arrayAttention = arrays.syncPermissions([{ requestId: 'array', request: arrayRequest }])!.attention!;
  assert.equal(arrays.matchesPermission(arrayAttention.id, { ...arrayRequest, args: { paths: ['/second', '/first'] } }), false);
});

test('every actionable attention kind requires a complete valid command', async t => {
  for (const kind of ATTENTION_KINDS) {
    await t.test(kind, () => {
      const attention = { id: 'aaaaaaaaaaaaaaaa', kind, pending: 1, actionable: true };
      assert.equal(validAttention(attention), false);
      for (const command of [undefined, '', ' \t\r\n', 'x'.repeat(1025), 'é'.repeat(513), '\u0000']) {
        assert.equal(validAttention({ ...attention, command }), false);
      }
      const actionable = !DISPLAY_ONLY_ATTENTION.includes(kind);
      assert.equal(validAttention({ ...attention, command: 'complete review' }), actionable);
      assert.equal(validAttention({ ...attention, command: 'é'.repeat(512) }), actionable);
      assert.equal(validAttention({ ...attention, actionable: false }), true);
    });
  }
});