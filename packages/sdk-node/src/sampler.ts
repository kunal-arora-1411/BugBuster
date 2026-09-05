import type { SampleDirective } from "@bugbuster/types";

export type CaptureKind = keyof SampleDirective; // "error" | "log" | "span"

/**
 * Applies the backend's X-BB-Sample-Directive (ingest-pipeline.md §7.1). The sampler is the
 * mechanism that makes the SDK "stop generating, not just stop sending" — updateRates() is called
 * by directives.ts after every response, and every subsequent capture() obeys the new rate
 * immediately, in-process.
 */
export interface Sampler {
  keep(kind: CaptureKind): boolean;
  updateRates(next: Partial<SampleDirective>): void;
  getRates(): SampleDirective;
}

export function createSampler(initial: SampleDirective): Sampler {
  let rates: SampleDirective = { ...initial };

  return {
    keep(kind) {
      return Math.random() < rates[kind];
    },
    updateRates(next) {
      rates = { ...rates, ...next };
    },
    getRates() {
      return { ...rates };
    },
  };
}
