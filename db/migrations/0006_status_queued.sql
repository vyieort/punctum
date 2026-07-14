-- Batch upload: an invoice waiting for background extraction.
alter type invoice_status add value if not exists 'queued';
