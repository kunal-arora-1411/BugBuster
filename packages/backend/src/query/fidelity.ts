import type { Issue } from "@bugbuster/types";

/**
 * "Every response carries its own fidelity metadata" (blueprint plate 01) —
 * `dashboard never displays a sampled count as absolute truth` (Appendix A, FIDELITY).
 */
export interface IssueWithFidelity extends Issue {
  fidelity: {
    isExact: boolean;
    adjustedCount: number;
  };
}

export function attachFidelity(issue: Issue): IssueWithFidelity {
  return {
    ...issue,
    fidelity: {
      isExact: issue.adjustedCount === 1.0,
      adjustedCount: issue.adjustedCount,
    },
  };
}
