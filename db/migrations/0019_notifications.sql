-- 0019_notifications.sql
--
-- One table for everything that needs a human: system-raised alerts (a push failed, an invoice is
-- stuck, a new vendor appeared) AND user-raised reports ("this looks wrong"). They're the same
-- shape — a record, an audience, context, an action link, and a resolved state — so they share one
-- pipeline instead of two.
--
-- audience: 'client' = the studio's problem, 'admin' = the platform's problem (client_id may be set
-- for context, or null for platform-wide). Escalation just re-raises with audience='admin'.

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  client_id    text references clients(id) on delete cascade,  -- null = platform-level
  audience     text not null default 'client',                 -- 'client' | 'admin'
  source       text not null default 'system',                 -- 'system' | 'user'
  type         text not null,                                  -- 'push_failed', 'new_vendor', 'user_report', …
  severity     text not null default 'warn',                   -- 'info' | 'warn' | 'error'
  title        text not null,
  detail       text,
  context      jsonb not null default '{}'::jsonb,             -- invoice id, page, error detail, …
  action_url   text,                                           -- where to go to actually fix it
  dedupe_key   text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  delivered_at timestamptz                                     -- set once emailed (channel comes later)
);

create index if not exists notifications_client_open_idx   on notifications (client_id, created_at desc) where resolved_at is null;
create index if not exists notifications_audience_open_idx on notifications (audience,  created_at desc) where resolved_at is null;

-- At most ONE open notification per dedupe key, so a failure that repeats every minute doesn't
-- become a thousand rows. Re-raising while it's still open is a silent no-op; once resolved, the
-- same key can fire again.
create unique index if not exists notifications_dedupe_open_idx
  on notifications (dedupe_key) where dedupe_key is not null and resolved_at is null;
