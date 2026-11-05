/**
 * Sends alert emails through Brevo's transactional email API, from the operator's own Brevo
 * account. One HTTPS call per email, no SDK: https://developers.brevo.com/reference/sendtransacemail
 */

export interface AlertEmail {
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  /** Sends one email to each recipient. Throws when the provider refuses it. */
  send(to: readonly string[], email: AlertEmail): Promise<void>;
}

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
/** Long enough for a slow API, short enough that one bad send can't hold an org's lease. */
const SEND_TIMEOUT_MS = 10_000;

export interface BrevoMailerOptions {
  apiKey: string;
  from: string;
  fromName: string;
  /** For tests. */
  url?: string;
  fetch?: typeof fetch;
}

export class BrevoMailer implements Mailer {
  constructor(private readonly options: BrevoMailerOptions) {}

  async send(to: readonly string[], email: AlertEmail): Promise<void> {
    if (to.length === 0) return;
    const doFetch = this.options.fetch ?? fetch;
    const res = await doFetch(this.options.url ?? BREVO_SEND_URL, {
      method: "POST",
      headers: {
        "api-key": this.options.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: this.options.from, name: this.options.fromName },
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
        // One copy per recipient, so nobody sees the other recipients' addresses.
        messageVersions: to.map((address) => ({ to: [{ email: address }] })),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Brevo explains itself in `message`; the API key never appears in the error.
      const detail = await res
        .json()
        .then((body: unknown) => (body as { message?: unknown } | null)?.message)
        .catch(() => undefined);
      throw new Error(
        `Brevo refused the email (HTTP ${res.status}` +
          (typeof detail === "string" && detail ? `: ${detail.slice(0, 200)}` : "") +
          ")",
      );
    }
  }
}
