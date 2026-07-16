-- 0015_danforth_notification_email.sql
--
-- The tenant's notification email was a leftover Ritual Evolution address (admin@ritualevolution.com)
-- from the seed. Client #1 is Danforth Butchery, so point notifications at Atwell's address.
-- Idempotent.

update client_config
   set notification_emails = array['danforth.adam@gmail.com'], updated_at = now()
 where client_id = 'RE'
   and notification_emails is distinct from array['danforth.adam@gmail.com'];
