-- 0021_notification_escalated_at.sql
--
-- Escalation: a client-facing alert (e.g. a push failure) that stays unresolved past a grace window
-- gets re-raised to the platform admin. We stamp escalated_at on the ORIGINAL so it escalates exactly
-- once — the sweep skips anything already stamped, so it can run as often as it likes without nagging.

alter table notifications add column if not exists escalated_at timestamptz;
