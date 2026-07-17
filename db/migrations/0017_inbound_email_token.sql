-- 0017_inbound_email_token.sql
--
-- Email-to-Punctum ingestion (#27): each tenant gets a unique inbound email address of the form
-- <token>@<inbound-domain>. Vendor invoice PDFs forwarded there are auto-queued for review. The
-- token is the routing key the inbound webhook resolves back to a client. Nullable (backfilled
-- lazily / at signup); unique when set.

alter table client_config add column if not exists inbound_token text;

create unique index if not exists client_config_inbound_token_idx
  on client_config (inbound_token) where inbound_token is not null;
