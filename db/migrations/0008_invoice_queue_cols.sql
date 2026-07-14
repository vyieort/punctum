-- Batch upload: hold the (compressed) source PDF + its filename until the worker processes it.
alter table invoices add column if not exists pdf_bytes bytea;
alter table invoices add column if not exists filename text;
