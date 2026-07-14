-- Support rejecting an inaccurate auto-matched image:
--   square_image_id     - the Square IMAGE object id, so a reject can delete it from Square
--   rejected_image_urls - newline-separated URLs already rejected, so re-enrichment skips them
alter table catalog_mapping add column if not exists square_image_id text;
alter table catalog_mapping add column if not exists rejected_image_urls text;
