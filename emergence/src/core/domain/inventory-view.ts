import type { Inventory } from './planning.ts';

/** Model-facing projection only. Admission always re-reads the complete live inventory. */
export function inventoryPage(inventory: Inventory, offset = 0, windowOffset = 0) {
  for (const value of [offset, windowOffset])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('分页位置必须是非负整数');
  // Execution primitives come before orchestration controls and method catalogs.
  // Ordering is deterministic across pages of the same snapshot.
  const rank = (item: Inventory['capabilities'][number]) =>
    item.kind === 'tool' && item.contract && item.contract.operation !== 'control' ? 0 : 1;
  const capabilities = inventory.capabilities.toSorted((a, b) => rank(a) - rank(b));
  const selected = capabilities.slice(offset, offset + 30);
  const ids = new Set(selected.map((item) => item.id));
  return {
    snapshot: inventory.snapshot ?? null,
    mode: inventory.mode,
    currentWindow: inventory.currentWindow,
    diagnostics: inventory.diagnostics,
    capabilities: selected.map(({ contract, detail, ...item }) => ({
      ...item,
      detail: detail.slice(0, 160),
      contract: contract
        ? {
            operation: contract.operation,
            permission: contract.permission,
            sideEffect: contract.sideEffect,
            cancellation: contract.cancellation,
          }
        : null,
    })),
    total: capabilities.length,
    nextOffset: offset + 30 < capabilities.length ? offset + 30 : null,
    windows: inventory.windows
      .slice(windowOffset, windowOffset + 4)
      .map(({ capabilityFacts: _facts, capabilities: available, ...window }) => ({
        ...window,
        capabilities: available.filter((id) => ids.has(id)),
        capabilitiesPageOnly: true,
      })),
    totalWindows: inventory.windows.length,
    nextWindowOffset: windowOffset + 4 < inventory.windows.length ? windowOffset + 4 : null,
  };
}
