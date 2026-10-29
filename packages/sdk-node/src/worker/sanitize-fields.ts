import { MAX_LOG_FIELDS_BYTES } from "@bugbusterhq/types";
import { redactString } from "./redact.js";

/**
 * Turns the arbitrary object a caller passed as log `fields` into something that is guaranteed to
 * be JSON-safe, bounded, and free of obvious secrets. Runs in the deferred worker pass, never on
 * the hot path (ingest-pipeline.md §3.2) — the hot path only took a shallow copy.
 *
 * Why this is more than `JSON.stringify`:
 *  - It must never throw: circular references, BigInt, throwing getters, and hostile objects are
 *    all expected in real application logs.
 *  - It is bounded: depth, keys per object, array length, string length, and total bytes all have
 *    ceilings, so one careless `log.info("req", { req })` cannot ship a megabyte per line.
 *  - It redacts by KEY NAME ("password", "token", "authorization", ...) in addition to the
 *    value-pattern redaction `redactString` does — a bare `{ password: "hunter2" }` contains no
 *    email/card/bearer pattern for the value scan to find, so key names are the only signal.
 *  - Keys are made Mongo-safe ("." and a leading "$" replaced), because fields are stored as a
 *    real sub-document on the backend and later queryable.
 */

const MAX_DEPTH = 4;
const MAX_KEYS_PER_OBJECT = 50;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_CHARS = 1024;
const MAX_STACK_CHARS = 2048;

const SENSITIVE_KEY_RE =
  /(pass(word|wd|phrase)?|secret|token|authorization|api[-_]?key|cookie|credential|private[-_]?key|ssn)/i;

export const REDACTED_VALUE = "[redacted]";

function safeKey(key: string): string {
  let k = key.replace(/\./g, "_");
  if (k.startsWith("$")) k = `_${k.slice(1)}`;
  return k.length > 0 ? k : "_";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

function toSafe(value: unknown, depth: number, ancestors: object[]): unknown {
  switch (typeof value) {
    case "string":
      return redactString(truncate(value, MAX_STRING_CHARS));
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (value === null) return null;

  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: redactString(truncate(obj.message ?? "", MAX_STRING_CHARS)),
      ...(obj.stack ? { stack: redactString(truncate(obj.stack, MAX_STACK_CHARS)) } : {}),
    };
  }
  if (ArrayBuffer.isView(obj)) return `[binary ${obj.byteLength} bytes]`;
  if (obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`;

  // `ancestors` is the current path, not "everything ever seen": the same object referenced twice
  // in siblings is legitimate and should serialize twice; only a true cycle is replaced.
  if (ancestors.includes(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? "[Array]" : "[Object]";

  ancestors.push(obj);
  try {
    if (Array.isArray(obj) || obj instanceof Set) {
      const items = Array.isArray(obj) ? obj : [...obj];
      const out = items.slice(0, MAX_ARRAY_ITEMS).map((item) => {
        const safe = toSafe(item, depth + 1, ancestors);
        return safe === undefined ? null : safe;
      });
      if (items.length > MAX_ARRAY_ITEMS) out.push(`[+${items.length - MAX_ARRAY_ITEMS} more]`);
      return out;
    }
    const entries: [string, unknown][] =
      obj instanceof Map
        ? [...obj.entries()].map(([k, v]) => [String(k), v])
        : Object.keys(obj).map((k) => [k, undefined]);
    return toSafeObject(obj, entries, depth, ancestors);
  } finally {
    ancestors.pop();
  }
}

function toSafeObject(
  source: object,
  entries: [string, unknown][],
  depth: number,
  ancestors: object[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [rawKey, mapValue] of entries) {
    if (kept >= MAX_KEYS_PER_OBJECT) {
      out["_truncatedKeys"] = entries.length - kept;
      break;
    }
    const key = safeKey(rawKey);
    if (SENSITIVE_KEY_RE.test(rawKey)) {
      out[key] = REDACTED_VALUE;
      kept++;
      continue;
    }
    let raw: unknown;
    try {
      raw = source instanceof Map ? mapValue : (source as Record<string, unknown>)[rawKey];
    } catch {
      raw = "[Unreadable]"; // a throwing getter must not take the log line down with it
    }
    const safe = toSafe(raw, depth + 1, ancestors);
    if (safe === undefined) continue;
    out[key] = safe;
    kept++;
  }
  return out;
}

/** Returns a sanitized copy of `fields`, or undefined if there is nothing worth sending. */
export function sanitizeFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (fields === undefined) return undefined;
  let result: Record<string, unknown>;
  try {
    const entries = Object.keys(fields).map((k): [string, unknown] => [k, undefined]);
    result = toSafeObject(fields, entries, 0, []);
  } catch {
    return { _unserializable: true };
  }
  if (Object.keys(result).length === 0) return undefined;

  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > MAX_LOG_FIELDS_BYTES) {
    // Too big to ship usefully: say so explicitly rather than silently clipping JSON mid-value.
    return {
      _truncated: true,
      _originalApproxBytes: bytes,
      _keys: Object.keys(result).slice(0, 20),
    };
  }
  return result;
}
