import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ObservationDeadline, observeUntil, stopOwnedProcess } from './fixtures/observation.ts';

test('observation expiry records last state and kills its own live process, including descendants on Windows', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let ended = false,
    grandchild = 0;
  child.on('exit', () => {
    ended = true;
  });
  child.stdout.on('data', (bytes) => {
    grandchild = Number(String(bytes).trim());
  });
  try {
    for (let i = 0; i < 50 && !grandchild; i++) await delay(20);
    assert.ok(grandchild > 0);
    const snapshot = { phase: 'waiting_user', approvalMs: 40, productionTimeout: null };
    await assert.rejects(
      observeUntil('fixture', async () => false, {
        limitMs: 100,
        snapshot: async () => snapshot,
        stop: () =>
          stopOwnedProcess(
            {
              pid: child.pid!,
              kill: () => {
                child.kill();
              },
            },
            () => ended,
          ),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ObservationDeadline);
        assert.equal(error.cleanupError, undefined);
        assert.deepEqual(error.lastState, snapshot);
        return true;
      },
    );
    assert.equal(ended, true);
    if (process.platform === 'win32') assert.throws(() => process.kill(grandchild, 0));
  } finally {
    if (!ended)
      await stopOwnedProcess(
        {
          pid: child.pid!,
          kill: () => {
            child.kill();
          },
        },
        () => ended,
      );
    if (grandchild && process.platform !== 'win32') {
      try {
        process.kill(grandchild);
      } catch {}
    }
  }
});

test('observation timeout is not reported as success when cleanup fails', async () => {
  await assert.rejects(
    observeUntil('stuck predicate', async () => new Promise(() => {}), {
      limitMs: 10,
      snapshot: async () => ({ phase: 'model-wait' }),
      stop: async () => {
        throw new Error('stop failed');
      },
    }),
    (error: unknown) => error instanceof ObservationDeadline && !!error.cleanupError,
  );
});
