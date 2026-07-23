// Follow-up for inbound emails Punctum couldn't turn into a queued invoice. When an inbound message
// fails (sender not matched to a studio, or no PDF attached) two things happen, both best-effort and
// independently removable later: an admin alert is raised so nothing vanishes silently, and — when we
// have a real reply address — a short bounce goes back to the sender explaining why.

import type { Queryable } from '../jobs/pg-rows.js';
import { raiseAndDeliver, type DeliverOps } from './notifications.js';
import type { InboundMessage, IngestInboundResult } from './inbound-email.js';

export interface InboundFailureOutcome {
  alerted: boolean; // an admin notification was created (false if deduped/suppressed)
  bounced: boolean; // a bounce email was sent to the sender
}

/** Never bounce to these — they're automated addresses, and replying invites a mail loop. */
export function isBounceableSender(sender: string): boolean {
  const e = (sender ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const local = e.split('@')[0] ?? '';
  const blocked = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'bounces', 'abuse'];
  return !blocked.some((p) => local === p || local.startsWith(p + '+') || local.startsWith(p + '-') || local.startsWith(p + '.'));
}

/** The message we send back to the sender, tailored to why we couldn't process it. */
export function bounceBody(unrouted: boolean): { subject: string; text: string } {
  if (unrouted) {
    return {
      subject: "We couldn't process your invoice email",
      text: [
        "Thanks for sending this to Punctum, but we couldn't match your email address to a studio account, so it wasn't imported.",
        '',
        'If you have a Punctum account, please send from the email address on your account.',
        "If you don't, or you think this is a mistake, just reply to this message and we'll help.",
      ].join('\n'),
    };
  }
  return {
    subject: "We couldn't find an invoice PDF in your email",
    text: [
      'Thanks for sending this to Punctum. We recognized your account, but there was no PDF attached, so there was nothing to import.',
      '',
      "Please resend with the invoice attached as a PDF and we'll take it from there.",
    ].join('\n'),
  };
}

/**
 * React to a failed inbound message: raise a (deduped) admin alert and bounce a short explanation to
 * the sender. Best-effort — email failures are swallowed; the alert still records in-app. An ok
 * result is a no-op. `ops` is the shared mailer; omit it (e.g. mailer unconfigured) to record the
 * alert in-app only and skip the bounce.
 */
export async function notifyInboundFailure(
  db: Queryable,
  msg: InboundMessage,
  result: IngestInboundResult,
  ops?: DeliverOps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InboundFailureOutcome> {
  if (result.ok) return { alerted: false, bounced: false };

  const sender = (msg.sender ?? '').trim();
  const reason = result.reason ?? 'could not process the email';
  const unrouted = !result.clientId; // no client resolved => sender not registered
  const attachments = (msg.attachments ?? []).map((a) => a.filename).filter(Boolean).join(', ') || '(none)';

  const alert = await raiseAndDeliver(
    db,
    {
      audience: 'admin',
      source: 'system',
      type: unrouted ? 'inbound_unrouted' : 'inbound_no_pdf',
      severity: unrouted ? 'warn' : 'info',
      title: unrouted
        ? `Unroutable invoice email from ${sender || 'an unknown sender'}`
        : `Invoice email with no PDF from ${sender || 'an unknown sender'}`,
      detail: reason,
      context: { sender, recipients: msg.recipients ?? [], attachments, clientId: result.clientId ?? null },
      // One open alert per sender+reason, so a repeat forwarder doesn't spam the admin.
      dedupeKey: `inbound:${unrouted ? 'unrouted' : 'nopdf'}:${sender.toLowerCase()}`,
    },
    ops,
    env,
  );

  let bounced = false;
  if (ops && isBounceableSender(sender)) {
    const { subject, text } = bounceBody(unrouted);
    try {
      await ops.send({ to: [sender], subject, text });
      bounced = true;
    } catch {
      bounced = false; // best-effort; the admin alert still captured it
    }
  }
  return { alerted: alert.created, bounced };
}
