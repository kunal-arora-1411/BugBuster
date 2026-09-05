/** A single symbolicated stack frame. */
export interface StackFrame {
  function: string;
  file: string;
  line: number;
  column: number;
  /** False for Node runtime internals, node_modules, and event-loop scheduling frames — see
   * `isInAppFrame`'s doc comment for why this exists and matters for fingerprinting. */
  inApp: boolean;
}

// Matches V8's "    at fn (file:line:col)" and the anonymous "    at file:line:col" forms.
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/**
 * A frame is NOT in-app when it's Node's own internal machinery (`node:internal/...`), something
 * from `node_modules` (including this SDK's own code, if it ever appears), or — the case that
 * actually forced this function to exist — event-loop resumption frames like
 * `processTicksAndRejections` or `runNextTicks`. Those last ones are the reason this matters:
 * once execution crosses an `await`, V8's captured stack reflects whichever internal scheduling
 * path (a promise microtask vs. a timer macrotask) happened to resume the function that tick —
 * which frame you get is nondeterministic and has nothing to do with the application's call path.
 * Two occurrences of the IDENTICAL bug in the IDENTICAL async function will, after an `await`,
 * often carry DIFFERENT runtime-scheduling frames above the application code — hashing those in
 * would fragment one real issue into many. Filtering to in-app frames is the standard fix (every
 * production error tracker does some version of this); it isn't optional at this depth.
 */
function isInAppFrame(file: string): boolean {
  if (file.startsWith("node:")) return false;
  if (file.includes("node_modules")) return false;
  if (file.includes("internal/")) return false;
  return true;
}

/**
 * Parses a raw `Error.stack` string into structured frames. Runs in the worker
 * (ingest-pipeline.md §3.2 — "never parse inline; hand the raw string to the worker").
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const lines = stack.split("\n").slice(1); // first line is "ErrorType: message"
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const match = FRAME_RE.exec(line);
    if (!match) continue;
    const [, fn, file, lineNo, col] = match;
    const filePath = file ?? "<unknown>";
    frames.push({
      function: fn?.trim() || "<anonymous>",
      file: filePath,
      line: Number(lineNo),
      column: Number(col),
      inApp: isInAppFrame(filePath),
    });
  }
  return frames;
}
