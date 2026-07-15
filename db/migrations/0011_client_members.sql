-- Multi-tenant access foundation: map an authenticated Supabase user to their client (tenant).
--
-- A logged-in user resolves to a client_id here, which replaces the ?client=RE query param as the
-- source of tenant scope. user_id is the Supabase auth user id (auth.users.id) — no cross-schema
-- FK, since the auth schema is Supabase-managed (and this stays portable for PGlite tests).
--
-- RLS enforcement (policies keyed on a per-request `app.current_client` GUC) is added in a later
-- migration once the app connects with a non-owner role + sets the tenant per request; enabling it
-- here would be a no-op for the owner connection and could mask that wiring.

create table if not exists client_members (
  user_id    uuid not null,
  client_id  text not null references clients(id) on delete cascade,
  email      text,
  role       text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

create index if not exists client_members_user_idx on client_members (user_id);
create index if not exists client_members_client_idx on client_members (client_id);
