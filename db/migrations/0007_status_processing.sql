-- Batch upload: an invoice the worker is currently extracting.
alter type invoice_status add value if not exists 'processing';
