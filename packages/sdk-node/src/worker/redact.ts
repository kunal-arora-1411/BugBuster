/**
 * PII redaction, run in the worker (ingest-pipeline.md §3.2 — "worker's job. Mark the record's
 * trust level at capture so the worker knows what to scrub."). v1 covers the common, cheap
 * patterns; this is the seam where stricter per-org redaction rules would plug in later.
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_TOKEN_RE = /\b(Bearer|token)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,16}\b/g;

export function redactString(input: string): string {
  return input
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(BEARER_TOKEN_RE, "[redacted-token]")
    .replace(CREDIT_CARD_RE, "[redacted-number]");
}
