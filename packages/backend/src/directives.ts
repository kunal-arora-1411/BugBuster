import type { Directives } from "@bugbuster/types";

/**
 * v1 reality: at pilot scale (2-3 orgs, no measured load pressure), there is nothing to sample
 * down and nothing to suppress — §10's growth triggers for quota/rate-limiting haven't fired.
 * This returns the honest "keep everything" directive rather than fabricating adaptive logic
 * with no signal driving it. The WIRE mechanism (the SDK obeys these headers unconditionally) is
 * real and tested in @bugbuster/sdk-node; only the decision behind the numbers is trivial for now.
 */
export function computeDirectives(configVersion: number): Directives {
  return {
    sample: { error: 1, log: 1, span: 1 },
    suppressFingerprints: [],
    configVersion,
  };
}
