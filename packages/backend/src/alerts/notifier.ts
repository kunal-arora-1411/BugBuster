import type { OrgAlerts } from "@bugbusterhq/types";
import type { ControlDb, PublicOrg } from "../db/control.js";
import {
  clearAlertPending,
  clearAllAlertPending,
  hasEarlierTwin,
  listAlertPending,
  type IssueDocument,
} from "../db/collections/issues.js";
import { getExemplarsByIds } from "../db/collections/events.js";
import type { Mailer } from "./brevo.js";
import { renderAlertEmail, renderTestEmail, type AlertIssue } from "./email.js";

/**
 * Email alerts for new issues. Ingest marks every issue it creates as alert-pending (in the same
 * write that creates it), and marks an existing one again when it first appears in another
 * environment or service; this turns the pending issues of one org into at most one email per
 * run, then clears them. It runs right after an ingest that created an issue, from a scheduler
 * calling /internal/alerts/run, and on a timer in a long-running backend: any of them is enough,
 * and running twice at once is safe (see the lease).
 *
 * Delivery is at least once: if the email goes out and clearing the issues then fails, the next
 * run sends them again. Never the other way round, an issue cleared without its email.
 */

const LEASE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
/** Pending issues looked at per run; the rest wait for the next one. */
const MAX_PENDING_PER_RUN = 200;
/** Issues described in one email; any more are counted ("…and 12 more"). */
const MAX_LISTED = 10;
const STACK_LINES = 6;

export interface AlertRunResult {
  /** Emails sent (0 or 1). */
  emails: number;
  /** Issues those emails covered. */
  alerted: number;
  /** Pending issues dropped without an email: from before alerts were on, or filtered out. */
  skipped: number;
  /** True when issues are waiting: the hourly cap was reached, or another process is sending. */
  held: boolean;
  error?: string;
}

const NOTHING: AlertRunResult = { emails: 0, alerted: 0, skipped: 0, held: false };

export interface AlertNotifierOptions {
  dashboardUrl?: string;
  maxEmailsPerHour: number;
  now?: () => Date;
}

function matchesAny(values: readonly string[], wanted: readonly string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  return values.some((v) => wanted.includes(v));
}

/** Who an org's alerts cover, in words, for the test email. */
export function alertScope(alerts: Pick<OrgAlerts, "services" | "environments">): string {
  const services = alerts.services?.length ? alerts.services.join(", ") : "any of your services";
  const envs = alerts.environments?.length ? ` in ${alerts.environments.join(", ")}` : "";
  return services + envs;
}

function topEndpoint(doc: IssueDocument): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of Object.entries(doc.endpointCounts ?? {})) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0];
}

function stackTop(stacktrace: string | undefined): string[] {
  if (!stacktrace) return [];
  const lines = stacktrace.split("\n").map((l) => l.trim());
  const frames = lines.filter((l) => l.startsWith("at "));
  return (frames.length > 0 ? frames : lines.filter(Boolean)).slice(0, STACK_LINES);
}

export class AlertNotifier {
  constructor(
    private readonly controlDb: ControlDb,
    private readonly mailer: Mailer,
    private readonly options: AlertNotifierOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Sends one org's pending alerts, if it has any and may send now. Never throws. */
  async runForOrg(orgId: string): Promise<AlertRunResult> {
    try {
      const org = await this.controlDb.getOrg(orgId);
      if (!org) return NOTHING;
      if (!org.alerts?.enabled || org.alerts.recipients.length === 0 || org.disabled) {
        // Nobody to tell: the marks would only pile up. Switching alerts on later starts afresh.
        await clearAllAlertPending(this.controlDb.getClient().db(org.dbName));
        return NOTHING;
      }
      const leased = await this.controlDb.claimAlertLease(orgId, LEASE_MS, this.now());
      if (!leased) return { ...NOTHING, held: true };
      return await this.sendLeased(leased);
    } catch (err) {
      return { ...NOTHING, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Runs every org that has alerts switched on, one after another. */
  async runAll(): Promise<{ orgs: number; emails: number; alerted: number; errors: number }> {
    const orgs = await this.controlDb.listOrgsWithAlerts();
    const total = { orgs: orgs.length, emails: 0, alerted: 0, errors: 0 };
    for (const org of orgs) {
      const r = await this.runForOrg(org.orgId);
      total.emails += r.emails;
      total.alerted += r.alerted;
      if (r.error) total.errors++;
    }
    return total;
  }

  private async sendLeased(org: PublicOrg): Promise<AlertRunResult> {
    const alerts = org.alerts!;
    const now = this.now();
    const sentAt = (org.alertState?.sentAt ?? []).filter(
      (t) => now.getTime() - new Date(t).getTime() < HOUR_MS,
    );
    const finish = (sent: boolean, error?: string) =>
      this.controlDb.finishAlertRun(
        org.orgId,
        { sentAt: sent ? [...sentAt, now.toISOString()] : sentAt, sent, error },
        now,
      );

    try {
      const db = this.controlDb.getClient().db(org.dbName);
      const pending = await listAlertPending(db, MAX_PENDING_PER_RUN);
      const skip: string[] = [];
      const send: IssueDocument[] = [];
      for (const issue of pending) {
        const wanted =
          (issue.alertPendingAt ?? issue.firstSeen) >= alerts.since &&
          matchesAny(issue.services ?? [], alerts.services) &&
          matchesAny(issue.environments ?? [], alerts.environments);
        if (!wanted || (await hasEarlierTwin(db, issue))) skip.push(issue.fingerprint);
        else send.push(issue);
      }
      await clearAlertPending(db, skip);

      if (send.length === 0) {
        await finish(false);
        return { ...NOTHING, skipped: skip.length };
      }
      if (sentAt.length >= this.options.maxEmailsPerHour) {
        // They stay pending and go out together once the hour allows another email.
        await finish(false);
        return { ...NOTHING, skipped: skip.length, held: true };
      }

      const listed = send.slice(0, MAX_LISTED);
      const firstExamples = alerts.includeStack
        ? await getExemplarsByIds(
            db,
            listed.flatMap((i) => (i.exemplarRefs[0] ? [i.exemplarRefs[0].eventId] : [])),
          )
        : [];
      const stackById = new Map(firstExamples.map((e) => [e.eventId, e.error?.stacktrace]));
      const issues: AlertIssue[] = listed.map((i) => ({
        fingerprint: i.fingerprint,
        ...(i.title ? { title: i.title } : {}),
        services: i.services ?? [],
        environments: i.environments ?? [],
        count: i.count,
        firstSeen: i.firstSeen,
        ...(topEndpoint(i) ? { topEndpoint: topEndpoint(i) } : {}),
        stack: stackTop(i.exemplarRefs[0] ? stackById.get(i.exemplarRefs[0].eventId) : undefined),
      }));

      await this.mailer.send(
        alerts.recipients,
        renderAlertEmail({
          orgName: org.name,
          issues,
          more: send.length - listed.length,
          dashboardUrl: this.options.dashboardUrl,
        }),
      );
      await clearAlertPending(
        db,
        send.map((i) => i.fingerprint),
      );
      await finish(true);
      return { emails: 1, alerted: send.length, skipped: skip.length, held: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finish(false, message).catch(() => {});
      return { ...NOTHING, error: message };
    }
  }

  /** Sends the test email to an org's saved recipients. Throws when sending fails. */
  async sendTest(org: PublicOrg): Promise<number> {
    const alerts = org.alerts;
    if (!alerts || alerts.recipients.length === 0) return 0;
    await this.mailer.send(
      alerts.recipients,
      renderTestEmail({
        orgName: org.name,
        scope: alertScope(alerts),
        dashboardUrl: this.options.dashboardUrl,
      }),
    );
    return alerts.recipients.length;
  }
}
