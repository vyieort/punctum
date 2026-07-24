-- 0022_vendor_profiles_shared_schema.sql
--
-- Fix a schema collision. 0001_init.sql creates a LEGACY `vendor_profiles` (id / vendor_id / version
-- / profile jsonb), so 0018's `create table if not exists vendor_profiles (...)` silently no-ops on
-- any database that ran 0001 first — i.e. production. The #42 code (vendor-profile.ts) expects the
-- SHARED schema keyed by `vendor_key`, so every getVendorProfile/upsertVendorProfile there hit
-- "column vendor_key does not exist" and vendor learning was quietly dead. (Tests missed it because
-- vendor-profile.test.ts seeds 0018 alone, creating the new schema fresh with no 0001 to collide.)
--
-- Replace the legacy table with the shared one. Safe + idempotent: it only drops when the legacy
-- shape is actually present (has vendor_id, lacks vendor_key). The legacy table was never written by
-- the app, so there is nothing to preserve. On a DB that already has the correct schema, this is a
-- no-op.

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'vendor_profiles' and column_name = 'vendor_id')
     and not exists (select 1 from information_schema.columns
              where table_name = 'vendor_profiles' and column_name = 'vendor_key')
  then
    drop table vendor_profiles cascade;
  end if;
end $$;

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

-- Match the deny-by-default posture 0001 set on the legacy table (app connects directly and bypasses
-- RLS; this only locks the Supabase Data API). Shared table, so no per-tenant policy is needed.
alter table vendor_profiles enable row level security;
