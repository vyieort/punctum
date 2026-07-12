-- Reject at review sends the invoice back for re-parse. Add the status for it.
alter type invoice_status add value if not exists 'needs_review';
