-- 0001_init.sql — Punctum Phase 0 schema
--
-- System of record for the invoice → Square inventory pipeline. Multi-tenant: every
-- business row carries client_id. Faithful to the Rebuild Plan §2 (data model) and §7
-- (vendor registry). Run in the Supabase SQL Editor, or via a migration runner.
--
-- Access model: the service connects to Postgres DIRECTLY (pg-boss + a pg client) using
-- the connection string, so it bypasses RLS. If "automatic RLS" is on, these tables get
-- RLS enabled with no policies = locked to the Data API until the portal phase adds
-- policies. That is the intended safe default; the pipeline is unaffected.

-- gen_random_uuid() is in core Postgres (v13+) and on Supabase; no extension needed.

-- ---------------------------------------------------------------- enums

do $$ begin
  create type invoice_status as enum
    ('received','parsed','in_review','approved','importing','done','error');
exception when duplicate_object then null; end $$;

-- col J lifecycle from the mapping sheet
do $$ begin
  create type mapping_status as enum
    ('PENDING','TAGGED','ENRICHED','NO_IMAGE','NEEDS_REVIEW','ACCESSORY','PUSHED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type square_environment as enum ('sandbox','production');
exception when duplicate_object then null; end $$;

do $$ begin
  create type review_mode as enum ('portal','shim');
exception when duplicate_object then null; end $$;

do $$ begin
  create type support_tier as enum ('tier0','tier1','tier2');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- updated_at helper

create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ---------------------------------------------------------------- tenants

create table if not exists clients (
  id            text primary key,                 -- e.g. 'RE'
  name          text not null,
  status        text not null default 'active',
  contact_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- everything currently hardcoded per-studio
create table if not exists client_config (
  client_id           text primary key references clients(id) on delete cascade,
  pricing_rules       jsonb  not null default '{}'::jsonb,   -- multipliers + rounding
  naming_prefs        jsonb  not null default '{}'::jsonb,
  notification_emails text[] not null default '{}',
  review_mode         review_mode not null default 'shim',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- SECRETS: per-client Square auth. Keep the service-role/direct connection only.
create table if not exists square_accounts (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null references clients(id) on delete cascade,
  environment   square_environment not null,      -- guards every Square call
  merchant_id   text,
  location_id   text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, environment)
);

-- ---------------------------------------------------------------- catalog config

-- replaces Make data store 92123, now per-client
create table if not exists category_map (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null references clients(id) on delete cascade,
  path               text not null,                -- 'Threadless > Ends > Prong-Set'
  square_category_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (client_id, path)
);

-- ---------------------------------------------------------------- invoices

create table if not exists invoices (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null references clients(id) on delete cascade,
  vendor           text,
  invoice_number   text,
  invoice_date     date,
  pdf_storage_path text,
  subtotal         numeric(12,2),
  total            numeric(12,2),
  status           invoice_status not null default 'received',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists invoices_client_status_idx on invoices (client_id, status);

-- replaces the review sheet. RETAIN permanently (wholesale/qty/dates power reporting).
create table if not exists invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references invoices(id) on delete cascade,
  line_no        int,
  description    text,
  quantity       numeric(12,3),
  wholesale      numeric(12,2),
  gems           text,
  notes          text,
  backorder      boolean not null default false,
  synthetic_sku  text,
  is_product     boolean not null default true,
  review_status  text,
  reviewer_edits jsonb  not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id);

-- ---------------------------------------------------------------- catalog mapping

-- replaces the SKU-Square Mapping sheet (cols A–Z). Column letters noted for the migration.
create table if not exists catalog_mapping (
  id                  uuid primary key default gen_random_uuid(),
  seq                 bigint generated always as identity unique,  -- stable row identity + insert order
  source_row          int,                -- original sheet row (migrated data); null for new rows
  client_id           text not null references clients(id) on delete cascade,
  vendor              text,               -- A
  vendor_sku          text,               -- B
  internal_ref        text,               -- C
  square_item_id      text,               -- D  (catalog id; tagger groups by this)
  square_variation_id text,               -- E
  item_description    text,               -- F
  item_name           text,               -- G  (Square Item)
  variation_name      text,               -- H  (Square Variation)
  times_ordered       int,                -- I
  status              mapping_status not null default 'PENDING',  -- J
  tags                text,               -- K
  image_name          text,               -- L
  image_url           text,               -- M
  wholesale_price     numeric(12,2),      -- N
  retail_price        numeric(12,2),      -- O
  first_seen          date,               -- P
  last_ordered        date,               -- Q
  gems                text,               -- R
  notes               text,               -- S
  orientation         text,               -- T
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists catalog_mapping_client_item_idx   on catalog_mapping (client_id, square_item_id);
create index if not exists catalog_mapping_client_status_idx on catalog_mapping (client_id, status);

-- ---------------------------------------------------------------- vendor registry (global)

create table if not exists vendors (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null unique,
  aliases        text[] not null default '{}',   -- invoice-header spellings
  support_tier   support_tier not null default 'tier0',
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists vendor_profiles (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  version    int  not null default 1,
  profile    jsonb not null default '{}'::jsonb,  -- parsing/sku_grammar/classification/vocabulary/image_search
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, version)
);

-- ---------------------------------------------------------------- updated_at triggers

do $$
declare t text;
begin
  foreach t in array array[
    'clients','client_config','square_accounts','category_map',
    'invoices','invoice_lines','catalog_mapping','vendors','vendor_profiles'
  ] loop
    execute format('drop trigger if exists %1$I_set_updated_at on %1$I', t);
    execute format(
      'create trigger %1$I_set_updated_at before update on %1$I
         for each row execute function set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- security posture
-- Enforced in SQL so the state holds regardless of the project-creation checkboxes.
-- The pipeline connects to Postgres directly (bypasses RLS); this only locks the Data API.

-- 1) Enable RLS on every table (deny-by-default until the portal phase adds policies).
do $$
declare t text;
begin
  foreach t in array array[
    'clients','client_config','square_accounts','category_map',
    'invoices','invoice_lines','catalog_mapping','vendors','vendor_profiles'
  ] loop
    execute format('alter table %1$I enable row level security', t);
  end loop;
end $$;

-- 2) Keep the Data API roles (anon/authenticated) out. Supabase-only; guarded so it
--    no-ops on a plain Postgres. Equivalent to unchecking "automatically expose new tables".
do $$
declare t text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    foreach t in array array[
      'clients','client_config','square_accounts','category_map',
      'invoices','invoice_lines','catalog_mapping','vendors','vendor_profiles'
    ] loop
      execute format('revoke all on %1$I from anon, authenticated', t);
    end loop;
  end if;
end $$;
