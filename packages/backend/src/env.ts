/**
 * Reads BUGBUSTER_LOG_RETENTION_DAYS. Shared by every entry point (src/index.ts, app.ts) so they
 * cannot drift apart.
 *
 * Set-but-blank counts as unset: docker-compose and hosting dashboards routinely define a variable
 * with an empty value, and `Number("") === 0` — which means "keep forever" and would make the
 * backend DROP the TTL index, letting the logs collection grow without bound. A blank value falls
 * through to the schema default instead. Anything else non-numeric becomes NaN, which the config
 * schema rejects at startup — loudly, rather than guessing.
 */
export function parseLogRetentionDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return Number(raw);
}

/**
 * Reads BUGBUSTER_ADMIN_TOKEN. Blank counts as unset for the same reason as above — and here unset
 * is the safe direction: it disables the admin routes instead of accepting an empty token.
 */
export function parseAdminToken(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}
