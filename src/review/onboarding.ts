// Onboarding wizard: the first thing a new studio sees after signup. It derives its state live from
// the tenant (is Square connected? is the catalog seeded?), so it's resumable — refreshing always
// shows the next real step, and it never lies about progress.

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface OnboardingState {
  email: string | null;
  clientId: string;
  squareConnected: boolean;
  catalogCount: number;
  pricingReviewed: boolean;
}

interface Step {
  title: string;
  desc: string;
  done: boolean;
  actionHref: string;
  actionLabel: string;
}

export function renderOnboardingPage(s: OnboardingState): string {
  const steps: Step[] = [
    {
      title: 'Connect your Square account',
      desc: 'Punctum reads and updates your Square catalog and inventory. You authorize it once — we never see your Square password.',
      done: s.squareConnected,
      actionHref: '/oauth/square/start',
      actionLabel: s.squareConnected ? 'Reconnect' : 'Connect Square',
    },
    {
      title: 'Import your existing catalog',
      desc: 'Seed Punctum from a Square library export so reorders restock the right items instead of creating duplicates. Run once.',
      done: s.catalogCount > 0,
      actionHref: '/library/import',
      actionLabel: s.catalogCount > 0 ? `Re-import (${s.catalogCount} items)` : 'Import catalog',
    },
    {
      title: 'Set your pricing',
      desc: 'Confirm how retail prices are calculated from wholesale cost — the gold and default multipliers and rounding. You can change these anytime.',
      done: s.pricingReviewed,
      actionHref: '/settings',
      actionLabel: s.pricingReviewed ? 'Review pricing' : 'Set pricing',
    },
    {
      title: "You're ready",
      desc: 'Upload a vendor invoice and Punctum drafts the catalog changes for your review — then pushes them to Square.',
      done: s.squareConnected && s.catalogCount > 0 && s.pricingReviewed,
      actionHref: '/invoices/batch',
      actionLabel: 'Upload an invoice',
    },
  ];

  const doneCount = steps.filter((x) => x.done).length;
  // The first not-yet-done step is the "current" one to highlight.
  const currentIdx = steps.findIndex((x) => !x.done);

  const cards = steps
    .map((step, i) => {
      const state = step.done ? 'done' : i === currentIdx ? 'current' : 'todo';
      const badge = step.done ? '&#10003;' : String(i + 1);
      const btnClass = i === currentIdx && !step.done ? 'act primary' : 'act';
      return `<div class="step ${state}">
        <div class="num">${badge}</div>
        <div class="body">
          <div class="t">${esc(step.title)}</div>
          <div class="d">${esc(step.desc)}</div>
          <a class="${btnClass}" href="${esc(step.actionHref)}">${esc(step.actionLabel)}</a>
        </div>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get started &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2.5rem auto;max-width:640px;color:#1a1a1a;padding:0 1.25rem}
  .userbar{display:flex;justify-content:space-between;align-items:center;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .8rem;font-size:13px;color:#374151;margin-bottom:1.5rem}
  .userbar a{color:#b91c1c;font-weight:600;font-size:13px;text-decoration:none}
  h1{margin:0 0 .25rem;font-size:24px} .tag{color:#6b7280;margin:0 0 1.5rem;font-size:14px}
  .prog{font-size:13px;color:#6b7280;margin-bottom:1rem}
  .step{display:flex;gap:.9rem;align-items:flex-start;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;margin-bottom:.8rem;background:#fff}
  .step.current{border-color:#166534;box-shadow:0 0 0 2px rgba(22,101,52,.12)}
  .step.done{background:#f6fdf9;border-color:#bbf7d0}
  .num{flex:0 0 28px;height:28px;border-radius:999px;background:#e5e7eb;color:#374151;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
  .step.done .num{background:#166534;color:#fff}
  .step.current .num{background:#166534;color:#fff}
  .body{flex:1}
  .t{font-weight:600;margin-bottom:.15rem}
  .d{color:#555;font-size:13px;margin-bottom:.6rem}
  a.act{display:inline-block;font:inherit;font-size:13px;text-decoration:none;padding:.4rem .8rem;border-radius:6px;border:1px solid #d1d5db;color:#374151;background:#fff}
  a.act.primary{border-color:#166534;background:#166534;color:#fff}
  a.act:hover{border-color:#166534}
  .step.done a.act{border-color:#bbf7d0;color:#166534}
  .skip{margin-top:1rem;font-size:13px}
  .skip a{color:#6b7280}
</style></head>
<body>
  <div class="userbar"><span>Signed in as <strong>${esc(s.email ?? 'you')}</strong></span><a href="/logout">Log out</a></div>
  <h1>Welcome to Punctum</h1>
  <p class="tag">Two quick steps and your studio is ready to turn vendor invoices into Square catalog updates.</p>
  <div class="prog">${doneCount} of ${steps.length} complete</div>
  ${cards}
  <div class="skip"><a href="/">Skip for now &rarr; go to the dashboard</a></div>
</body></html>`;
}
