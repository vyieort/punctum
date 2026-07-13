-- The merged single-pass intake classifies each line at upload; store that classification
-- so the import (after approval) is fully deterministic — no second AI call.
alter table invoice_lines add column if not exists classification jsonb not null default '{}'::jsonb;
