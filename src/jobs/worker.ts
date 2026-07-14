// Background worker for the batch-upload queue. Claims one 'queued' invoice at a time, extracts
// it, and moves on — so N invoices grind through without any request staying open. A single
// in-process guard keeps ticks from overlapping (one replica); a restart re-queues anything left
// mid-'processing'.

import type { Queryable } from './pg-rows.js';
import { processQueuedInvoice, type Extractor } from './intake.js';

/** Claim the oldest queued invoice and process it. Returns whether one was processed. */
export async function processNextQueued(
  db: Queryable,
  extract?: Extractor,
): Promise<{ processed: boolean; invoiceId?: string }> {
  const claim = await db.query(
    `update invoices set status = 'processing', updated_at = now()
      where id = (select id from invoices where status = 'queued' order by created_at limit 1)
      returning id`,
  );
  if (claim.rows.length === 0) return { processed: false };
  const invoiceId = String((claim.rows[0] as { id: string }).id);
  await processQueuedInvoice(db, invoiceId, extract);
  return { processed: true, invoiceId };
}

/** Start the polling loop. Drains the queue each tick; ticks never overlap. */
export function startWorker(db: Queryable, intervalMs = 5000): NodeJS.Timeout {
  // Recover invoices a previous run left mid-processing.
  db.query(`update invoices set status = 'queued' where status = 'processing'`).catch(() => {});

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        let r = await processNextQueued(db);
        while (r.processed) r = await processNextQueued(db);
      } catch {
        // swallow; next tick retries
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
