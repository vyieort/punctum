-- 0016_rename_client_key_danforth.sql
--
-- Retire the legacy placeholder tenant key. Client #1 used id 'RE' (a Ritual Evolution leftover)
-- even though the tenant is Danforth Butchery. New studios now get real slug ids at signup
-- (src/auth/provision.ts); this migrates the one remaining legacy row's KEY to a real id too.
--
-- The client_id FKs are ON DELETE CASCADE (not ON UPDATE), so we can't just UPDATE clients.id.
-- Instead: create the new clients row, repoint every child table, then delete the old (now childless)
-- row. Wrapped in a transaction and idempotent — a re-run finds no 'RE' and no-ops.

begin;

insert into clients (id, name, status, contact_email, created_at, updated_at)
  select 'danforth-butchery', name, status, contact_email, created_at, now()
    from clients where id = 'RE'
  on conflict (id) do nothing;

update client_config   set client_id = 'danforth-butchery' where client_id = 'RE';
update square_accounts set client_id = 'danforth-butchery' where client_id = 'RE';
update category_map    set client_id = 'danforth-butchery' where client_id = 'RE';
update invoices        set client_id = 'danforth-butchery' where client_id = 'RE';
update catalog_mapping set client_id = 'danforth-butchery' where client_id = 'RE';
update catalog_edits   set client_id = 'danforth-butchery' where client_id = 'RE';
update client_members  set client_id = 'danforth-butchery' where client_id = 'RE';

delete from clients where id = 'RE';

commit;
