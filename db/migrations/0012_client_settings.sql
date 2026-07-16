-- Per-client preferences JSON (first real one: auto_enrich_images). Studios that shoot their own
-- product photography can turn image auto-enrichment (SerpAPI + Vision) off and rely on manual
-- uploads. Default {} => enabled (current behavior). Extensible for future toggles.

alter table client_config add column if not exists settings jsonb not null default '{}'::jsonb;
