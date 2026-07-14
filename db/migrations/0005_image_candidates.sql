-- Store the SerpAPI candidate pool from the enrich run (JSON: [{thumb, pushUrl}, ...]) so the
-- review page can offer "Review alternatives" — pick a different one, or clear — without
-- re-searching or re-running Vision (which would just re-pick the same best match).
alter table catalog_mapping add column if not exists image_candidates text;
