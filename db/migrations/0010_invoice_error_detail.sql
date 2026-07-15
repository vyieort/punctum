-- Persist the reason a Square push failed. The background approve->import path used to discard
-- runImport's per-item errors, so the review page could only say "push failed, retry" with no
-- reason. Store the error detail (JSON array of {item, error}) so the operator sees exactly what
-- Square rejected — important for a non-technical owner who can't read server logs.

alter table invoices add column if not exists error_detail text;
