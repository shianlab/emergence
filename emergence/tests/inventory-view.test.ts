import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventoryPage } from '../src/core/domain/inventory-view.ts';
import type { Capability, Inventory } from '../src/core/domain/planning.ts';
import { toolContract } from '../src/core/domain/tool-contract.ts';

test('inventory pagination retains permission facts without duplicating catalogs or mutating authority', () => {
  const capabilities: Capability[] = Array.from({ length: 105 }, (_, n) => ({
    id: `tool:control-${n}`,
    kind: 'tool',
    registered: true,
    callable: true,
    connected: null,
    verified: false,
    detail: 'x'.repeat(500),
    contract: toolContract('emergence_plan'),
  }));
  capabilities.push({ ...capabilities[0], id: 'tool:write', contract: toolContract('write') });
  const inventory: Inventory = {
    mode: 'independent',
    currentWindow: 'main',
    diagnostics: [],
    snapshot: { version: 1, revision: 'fixed' },
    capabilities,
    windows: Array.from({ length: 16 }, (_, n) => ({
      id: String(n),
      session: String(n),
      project: '/p',
      model: 'model',
      dispatchable: n > 0,
      capabilities: n ? capabilities.map((c) => c.id) : [],
      capabilityFacts: capabilities,
    })),
  };
  const original = JSON.stringify(inventory);
  const first = inventoryPage(inventory);
  assert.equal(first.capabilities[0].id, 'tool:write');
  assert.equal(first.windows.length, 4);
  assert.deepEqual(first.windows[0].capabilities, []);
  assert.ok(first.windows[1].capabilities.includes('tool:write'));
  assert.ok(first.windows.every((w) => !('capabilityFacts' in w)));
  assert.ok(JSON.stringify(first).length < 20000, 'large catalogs must remain inline');
  const seen: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = inventoryPage(inventory, offset);
    seen.push(...page.capabilities.map((c) => c.id));
    offset = page.nextOffset;
  }
  assert.equal(new Set(seen).size, capabilities.length);
  assert.equal(seen.length, capabilities.length);
  assert.equal(inventoryPage(inventory, 0, 12).nextWindowOffset, null);
  assert.equal(JSON.stringify(inventory), original, 'host authority must not be truncated or reordered');
  assert.throws(() => inventoryPage(inventory, -1));
  assert.throws(() => inventoryPage(inventory, 0, 0.5));
});
