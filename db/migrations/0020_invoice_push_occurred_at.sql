-- 0020_invoice_push_occurred_at.sql
--
-- The inventory occurred_at sent to Square has two hard constraints that fight each other:
--   1. Square rejects inventory history older than 24h ("INVALID_TIME"), so it must be recent.
--   2. The inventory idempotency key is (invoice, sku), so a RETRY must send an identical occurred_at
--      or Square rejects it ("IDEMPOTENCY_KEY_REUSED").
-- Deriving it from the invoice date satisfied (2) but broke (1) once an invoice aged past a day.
-- Fix: on the first push, clamp the timestamp into the 24h window and PERSIST it here, so every
-- later retry reuses the same recent value.

alter table invoices add column if not exists push_occurred_at timestamptz;
