import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One AsyncLocalStorage store for the whole SDK, holding one object (glossary.md §7 —
 * "having an ALS active costs per async hop"; sharing a single store minimizes that tax across
 * every `await` in the host application).
 */
export interface BugBusterContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

const storage = new AsyncLocalStorage<BugBusterContext>();

export function runWithContext<T>(ctx: BugBusterContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getCurrentContext(): BugBusterContext | undefined {
  return storage.getStore();
}
