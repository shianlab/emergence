import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationWindowManager, type ConfigurationWindow } from '../src/app/model-config-window.ts';
import { startModelConfiguration } from '../src/app/model-config.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('configuration window startup is shared and shutdown owns even a late native window', async () => {
  const ready = deferred<ConfigurationWindow>(),
    exited = deferred<void>();
  let starts = 0,
    closes = 0;
  const manager = new ConfigurationWindowManager(() => {
    starts++;
    return ready.promise;
  });
  const first = manager.open(),
    second = manager.open();
  assert.equal(first, second);
  assert.equal(starts, 1);
  const closing = manager.close();
  await assert.rejects(manager.open(), /已关闭/);
  ready.resolve({
    closed: exited.promise,
    async focus() {
      return true;
    },
    async close() {
      closes++;
      exited.resolve();
    },
  });
  await first;
  await closing;
  await manager.wait();
  assert.equal(closes, 1);
  await manager.close();
  assert.equal(closes, 1);
});

test('closing during a stale native focus cannot start a replacement window', async () => {
  const focus = deferred<boolean>();
  let starts = 0,
    closes = 0;
  const manager = new ConfigurationWindowManager(async () => {
    starts++;
    return {
      closed: Promise.resolve(),
      focus: () => focus.promise,
      async close() {
        closes++;
      },
    };
  });
  await manager.open();
  const reopening = manager.open(),
    closing = manager.close();
  focus.resolve(false);
  await reopening;
  await closing;
  assert.equal(starts, 1);
  assert.equal(closes, 1);
});

test('slow authenticated request bodies reserve admission and service shutdown drains them promptly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-config-lifecycle-')),
    service = await startModelConfiguration(home);
  const token = new URLSearchParams(new URL(service.url).hash.slice(1)).get('session')!;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const pending = request(service.origin + '/api/models/save', { method: 'POST', headers }, (res) =>
    res.resume(),
  );
  pending.on('error', () => {});
  pending.write('{');
  try {
    let blocked = false;
    for (let n = 0; n < 30; n++) {
      const response = await fetch(service.origin + '/api/models/save', {
        method: 'POST',
        headers,
        body: '{}',
      });
      await response.text();
      if (response.status === 409) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.ok(blocked, 'a request body in progress must count as an active mutation');
    const start = Date.now();
    await service.close();
    assert.ok(Date.now() - start < 1500, 'shutdown must not wait for the client to finish its JSON');
    await assert.rejects(service.open(), /已关闭/);
  } finally {
    pending.destroy();
    await service.close();
  }
});

test('malformed and unknown configuration requests release admission without changing configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-config-lifecycle-')),
    service = await startModelConfiguration(home);
  const token = new URLSearchParams(new URL(service.url).hash.slice(1)).get('session')!;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const before = await service.configuration.state();
    assert.equal(
      (await fetch(service.origin + '/api/models/save', { method: 'POST', headers, body: '{' })).status,
      400,
    );
    assert.equal(
      (await fetch(service.origin + '/api/unknown', { method: 'POST', headers, body: '{}' })).status,
      404,
    );
    const result = await fetch(service.origin + '/api/defaults', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        revision: before.revision,
        defaultModel: before.defaultModel,
        windowModels: before.windowModels,
      }),
    });
    assert.equal(result.status, 200);
    assert.equal((await service.configuration.state()).revision, before.revision);
  } finally {
    await service.close();
  }
});
