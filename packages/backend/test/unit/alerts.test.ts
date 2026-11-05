import { describe, expect, it } from "vitest";
import { BrevoMailer } from "../../src/alerts/brevo.js";
import { parseAlertsConfig, parseCronSecret } from "../../src/env.js";

const EMAIL = { subject: "New error", html: "<p>hi</p>", text: "hi" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("BrevoMailer", () => {
  it("sends one transactional email, one copy per recipient, with the API key header", async () => {
    const { calls, fetchImpl } = fakeFetch(201, { messageId: "<1@relay>" });
    const mailer = new BrevoMailer({
      apiKey: "xkeysib-test",
      from: "alerts@example.com",
      fromName: "BugBuster",
      fetch: fetchImpl,
    });
    await mailer.send(["a@x.io", "b@x.io"], EMAIL);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sender: { email: "alerts@example.com", name: "BugBuster" },
      subject: "New error",
      htmlContent: "<p>hi</p>",
      textContent: "hi",
      messageVersions: [{ to: [{ email: "a@x.io" }] }, { to: [{ email: "b@x.io" }] }],
    });
  });

  it("throws Brevo's reason on a refusal, never the key", async () => {
    const { fetchImpl } = fakeFetch(401, { code: "unauthorized", message: "Key not found" });
    const mailer = new BrevoMailer({
      apiKey: "xkeysib-secret",
      from: "alerts@example.com",
      fromName: "BugBuster",
      fetch: fetchImpl,
    });
    const err = await mailer.send(["a@x.io"], EMAIL).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Brevo refused the email (HTTP 401: Key not found)");
    expect((err as Error).message).not.toContain("xkeysib-secret");
  });

  it("sends nothing to nobody", async () => {
    const { calls, fetchImpl } = fakeFetch(201, {});
    await new BrevoMailer({ apiKey: "k", from: "a@x.io", fromName: "B", fetch: fetchImpl }).send(
      [],
      EMAIL,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("parseAlertsConfig", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);

  it("is off without a Brevo key", () => {
    expect(parseAlertsConfig({}, warn)).toBeUndefined();
    expect(parseAlertsConfig({ BUGBUSTER_BREVO_API_KEY: "  " }, warn)).toBeUndefined();
  });

  it("reads the key, sender and options", () => {
    expect(
      parseAlertsConfig(
        {
          BUGBUSTER_BREVO_API_KEY: "xkeysib-1",
          BUGBUSTER_ALERTS_FROM: "alerts@example.com",
          BUGBUSTER_DASHBOARD_URL: "https://dash.example.com",
          BUGBUSTER_ALERTS_MAX_PER_HOUR: "5",
        },
        warn,
      ),
    ).toEqual({
      brevoApiKey: "xkeysib-1",
      from: "alerts@example.com",
      fromName: "BugBuster",
      dashboardUrl: "https://dash.example.com",
      maxEmailsPerHour: 5,
    });
  });

  it("a mistake turns alerts off with a warning instead of stopping the backend", () => {
    warnings.length = 0;
    expect(
      parseAlertsConfig(
        { BUGBUSTER_BREVO_API_KEY: "xkeysib-1", BUGBUSTER_ALERTS_FROM: "nope" },
        warn,
      ),
    ).toBeUndefined();
    expect(warnings[0]).toMatch(/^Email alerts are off: .*from/);
    expect(warnings[0]).not.toContain("xkeysib-1");
  });
});

describe("parseCronSecret", () => {
  it("reads BUGBUSTER_CRON_SECRET, or Vercel's CRON_SECRET", () => {
    expect(parseCronSecret({ BUGBUSTER_CRON_SECRET: "0123456789abcdef" })).toBe("0123456789abcdef");
    expect(parseCronSecret({ CRON_SECRET: "fedcba9876543210" })).toBe("fedcba9876543210");
    expect(parseCronSecret({})).toBeUndefined();
  });

  it("is off when too short", () => {
    const warnings: string[] = [];
    expect(parseCronSecret({ CRON_SECRET: "short" }, (m) => void warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
