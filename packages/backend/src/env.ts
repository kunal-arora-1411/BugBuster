import { BackendConfigSchema, type BackendConfig } from "@bugbusterhq/types";

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

const blank = (raw: string | undefined) =>
  raw === undefined || raw.trim() === "" ? undefined : raw.trim();

/**
 * Reads the email alert settings: BUGBUSTER_BREVO_API_KEY turns alerts on, BUGBUSTER_ALERTS_FROM
 * is the sender (verified in Brevo), and BUGBUSTER_ALERTS_FROM_NAME, BUGBUSTER_DASHBOARD_URL and
 * BUGBUSTER_ALERTS_MAX_PER_HOUR are optional.
 *
 * Unlike the settings above, a mistake here does not stop the backend: alerts are optional, so a
 * bad sender address turns alerts off (and says why) rather than taking ingest down with it.
 */
export function parseAlertsConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.error,
): BackendConfig["alerts"] {
  const brevoApiKey = blank(env.BUGBUSTER_BREVO_API_KEY);
  if (!brevoApiKey) return undefined;
  const maxPerHour = blank(env.BUGBUSTER_ALERTS_MAX_PER_HOUR);
  const parsed = BackendConfigSchema.shape.alerts.safeParse({
    brevoApiKey,
    from: blank(env.BUGBUSTER_ALERTS_FROM),
    fromName: blank(env.BUGBUSTER_ALERTS_FROM_NAME),
    dashboardUrl: blank(env.BUGBUSTER_DASHBOARD_URL),
    maxEmailsPerHour: maxPerHour === undefined ? undefined : Number(maxPerHour),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".") || "alerts"}: ${i.message}`)
      .join("; ");
    warn(`Email alerts are off: the alert settings are not valid (${problems}).`);
    return undefined;
  }
  return parsed.data;
}

/**
 * Reads the secret for /internal/alerts/run: BUGBUSTER_CRON_SECRET, or Vercel's own CRON_SECRET
 * (which Vercel Cron sends as a bearer token). Too short turns the route off, with a warning.
 */
export function parseCronSecret(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.error,
): string | undefined {
  const secret = blank(env.BUGBUSTER_CRON_SECRET) ?? blank(env.CRON_SECRET);
  if (secret === undefined) return undefined;
  if (!BackendConfigSchema.shape.cronSecret.safeParse(secret).success) {
    warn("The alerts cron route is off: its secret must be at least 16 characters.");
    return undefined;
  }
  return secret;
}
