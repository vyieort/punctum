-- 0018_vendor_profiles.sql
--
-- Shared, cross-tenant vendor parsing profiles (#42 engine). A vendor's accumulated parsing hints
-- are keyed by VENDOR (not client_id) so one studio onboarding a vendor benefits every client —
-- BVLA is BVLA for everyone. `guidance` is a freeform rules block appended to the extraction prompt;
-- `examples` holds correction few-shots (raw line -> correct reading). This is where vendor knowledge
-- that today lives hardcoded in the extraction prompt can gradually move — data, not code.

create table if not exists vendor_profiles (
  vendor_key   text primary key,               -- normalized vendor name (lowercase-slug)
  display_name text not null,
  guidance     text  not null default '',
  examples     jsonb not null default '[]'::jsonb,
  sample_count integer not null default 0,      -- how many invoices have refined this profile
  status       text not null default 'active',  -- active | draft | disabled
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
