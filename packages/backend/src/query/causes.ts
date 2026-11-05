import type { Db } from "mongodb";
import { SYMPTOM_MIN_SHARE, type Issue } from "@bugbusterhq/types";
import { getIssuesByFingerprints, shareOf } from "../db/collections/issues.js";
import { linksOf, strongestCauses } from "../db/collections/issue-links.js";

/**
 * Reads the cause graph around one issue (docs/architecture/root-cause-graph.md §6): what caused
 * it, what it caused, and — following the strongest cause upward while it explains most of each
 * step — the root cause.
 */

/** Neighbours listed per direction. */
export const MAX_LINKS_LISTED = 20;
/** Steps the root-cause walk takes at most; real call chains are far shorter. */
export const MAX_ROOT_CAUSE_HOPS = 8;

export interface CauseEntry {
  issue: Issue;
  count: number;
  /** For a cause: how much of THIS issue it explains. For an effect: how much of THAT issue. */
  share: number;
}

export interface CauseGraph {
  /** The issue the walk ends at, and the fingerprints walked (this issue first). Null when this
   * issue is not a symptom of anything. */
  rootCause: { issue: Issue; path: string[] } | null;
  causedBy: CauseEntry[];
  caused: CauseEntry[];
}

/**
 * Walks from `start` to its strongest cause, repeatedly, while each step's share is at least
 * SYMPTOM_MIN_SHARE. Stops at an issue with no such cause, on a cycle, or after
 * MAX_ROOT_CAUSE_HOPS. Returns the fingerprints walked, `start` first.
 */
export async function walkToRootCause(db: Db, start: Issue): Promise<string[]> {
  const path = [start.fingerprint];
  let current = start;
  for (let hop = 0; hop < MAX_ROOT_CAUSE_HOPS; hop++) {
    const link = (await strongestCauses(db, [current.fingerprint])).get(current.fingerprint);
    if (!link || shareOf(link.count, current.count) < SYMPTOM_MIN_SHARE) break;
    if (path.includes(link.cause)) break; // a cycle: A failed because B did, and B because A did
    const next = (await getIssuesByFingerprints(db, [link.cause])).get(link.cause);
    if (!next) break;
    path.push(next.fingerprint);
    current = next;
  }
  return path;
}

export async function getCauseGraph(db: Db, issue: Issue): Promise<CauseGraph> {
  const [into, outOf, path] = await Promise.all([
    linksOf(db, "causesOf", issue.fingerprint, MAX_LINKS_LISTED),
    linksOf(db, "effectsOf", issue.fingerprint, MAX_LINKS_LISTED),
    walkToRootCause(db, issue),
  ]);
  const rootFingerprint = path.length > 1 ? path[path.length - 1]! : undefined;
  const neighbours = await getIssuesByFingerprints(db, [
    ...into.map((l) => l.cause),
    ...outOf.map((l) => l.effect),
    ...(rootFingerprint ? [rootFingerprint] : []),
  ]);

  const causedBy: CauseEntry[] = [];
  for (const link of into) {
    const cause = neighbours.get(link.cause);
    if (cause)
      causedBy.push({ issue: cause, count: link.count, share: shareOf(link.count, issue.count) });
  }
  const caused: CauseEntry[] = [];
  for (const link of outOf) {
    const effect = neighbours.get(link.effect);
    if (effect)
      caused.push({ issue: effect, count: link.count, share: shareOf(link.count, effect.count) });
  }
  const root = rootFingerprint ? neighbours.get(rootFingerprint) : undefined;
  return { rootCause: root ? { issue: root, path } : null, causedBy, caused };
}
