-- Per-line exclude at review. Some product lines shouldn't become catalog items (consignment
-- bundles, "misc" non-catalog lines). The operator marks them excluded at review; the import then
-- skips them — instead of the all-or-nothing approve/reject. Default false = included as before.

alter table invoice_lines add column if not exists excluded boolean not null default false;
