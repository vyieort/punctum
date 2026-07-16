-- 0014_rename_client_display_name.sql
--
-- Punctum's client #1 is Danforth Butchery (Atwell's own Square account), NOT Ritual Evolution.
-- RE will be client #2, onboarded later via self-serve OAuth. Correct the display name on the
-- existing tenant row. Its sandbox may be seeded with RE backup data for realistic testing, but
-- the tenant is Danforth Butchery.
--
-- NOTE: only the display NAME is corrected here. The tenant KEY stays the legacy placeholder 'RE'
-- for now — renaming the key is a cross-table FK migration on live data (7 tables cascade off
-- clients.id) plus a reseed of every test, so it's deferred to the onboarding work (#26) where
-- real tenant ids get assigned. Idempotent.

update clients
   set name = 'Danforth Butchery', updated_at = now()
 where id = 'RE' and name <> 'Danforth Butchery';
