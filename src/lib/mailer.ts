// Outbound transactional email via Postmark. Low volume, high importance — an alert that lands in
// spam is the same as no alert, which is why this goes through a reputable sender rather than
// straight from the app server. fetch is injectable so tests never touch the network.

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface MailerConfig {
  token?: string;
  from?: string;
  replyTo?: string;
  stream?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface ResolvedMailer {
  token: string;
  from: string;
  replyTo: string;
  stream: string;
  doFetch: typeof globalThis.fetch;
}

/** True when email is configured. Delivery is skipped (not failed) when it isn't, so alerts still
 *  record in-app before the provider is wired up. */
export function isMailerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.ALERT_FROM_EMAIL);
}

export function mailerFromEnv(cfg: MailerConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedMailer {
  const token = cfg.token ?? env.POSTMARK_SERVER_TOKEN;
  const from = cfg.from ?? env.ALERT_FROM_EMAIL;
  if (!token || !from) throw new Error('POSTMARK_SERVER_TOKEN / ALERT_FROM_EMAIL not set');
  return {
    token,
    from,
    // Replies should reach a human inbox, not vanish into a no-reply void.
    replyTo: cfg.replyTo ?? env.ALERT_REPLY_TO ?? '',
    stream: cfg.stream ?? env.POSTMARK_STREAM ?? 'outbound',
    doFetch: cfg.fetchImpl ?? globalThis.fetch,
  };
}

/** DeliverOps for the notification pipeline, or undefined when email isn't configured (so callers
 *  record alerts in-app without a hard dependency on the mailer being set up). */
export function mailerOps(env: NodeJS.ProcessEnv = process.env): { send: (m: MailMessage) => Promise<{ messageId: string }> } | undefined {
  return isMailerConfigured(env) ? { send: (m) => sendEmail(m) } : undefined;
}

export async function sendEmail(msg: MailMessage, cfg: MailerConfig = {}): Promise<{ messageId: string }> {
  const m = mailerFromEnv(cfg);
  const to = Array.isArray(msg.to) ? msg.to.filter(Boolean).join(', ') : msg.to;
  if (!to) throw new Error('sendEmail: no recipients');

  const body: Record<string, unknown> = {
    From: m.from,
    To: to,
    Subject: msg.subject,
    TextBody: msg.text,
    MessageStream: m.stream,
  };
  if (msg.html) body.HtmlBody = msg.html;
  const replyTo = msg.replyTo ?? m.replyTo;
  if (replyTo) body.ReplyTo = replyTo;

  const res = await m.doFetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Postmark-Server-Token': m.token,
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Postmark returns a numeric ErrorCode + Message that's worth surfacing verbatim.
    throw new Error(`Postmark ${res.status}: ${String(j.Message ?? JSON.stringify(j)).slice(0, 300)}`);
  }
  return { messageId: String(j.MessageID ?? '') };
}
