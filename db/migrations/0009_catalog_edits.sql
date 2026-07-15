-- Batch item editing + the learning loop.
--
-- catalog_mapping.category_path: the current category as a human-readable path (e.g.
-- "Threadless > Threadless Ends > Bezel-Set"), written at import by reversing category_map. It's
-- what the edit grid shows and edits, and what lets a recategorization log a meaningful old->new.
--
-- catalog_edits: an audit log of every operator correction. This is the signal that turns manual
-- edits into import-rule improvements — recurring corrections (same vendor + product_type moved
-- the same way) point at a category_map or tagger rule that should be fixed at the source, rather
-- than being re-fixed by hand on every invoice.

alter table catalog_mapping add column if not exists category_path text;

create table if not exists catalog_edits (
  id                  uuid primary key default gen_random_uuid(),
  client_id           text not null references clients(id) on delete cascade,
  square_item_id      text,
  square_variation_id text,
  vendor_sku          text,
  field               text not null,      -- 'retail_price' | 'category' | 'item_name' | 'description'
  old_value           text,
  new_value           text,
  vendor              text,               -- for pattern mining
  product_type        text,               -- classification product_type, for pattern mining
  diverged            boolean not null default false, -- name edit structurally departs from the convention
  edited_at           timestamptz not null default now()
);

create index if not exists catalog_edits_client_field_idx on catalog_edits (client_id, field, edited_at);
