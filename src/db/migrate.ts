// Minimal forward-only migration runner.
//
// Applies db/migrations/*.sql in filename order, recording each in a schema_migrations
// table so re-runs are no-ops. Executor is injectable (a pg Pool in prod, PGlite in tests).

import { readdirSync, readFileSync } from 'node:fs';

export interface SqlExecutor {
  /** Run a (possibly multi-statement) SQL string. */
  exec(sql: string): Promise<void>;
  /** Run a parameterized query and return its rows. */
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export async function runMigrations(db: SqlExecutor, dir: string): Promise<string[]> {
  await db.exec(
    `create table if not exists schema_migrations (
       name       text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const doneRows = await db.query(`select name from schema_migrations`);
  const done = new Set(doneRows.map((r) => String(r.name)));

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await db.exec(readFileSync(`${dir}/${file}`, 'utf8'));
    await db.query(`insert into schema_migrations (name) values ($1)`, [file]);
    applied.push(file);
  }
  return applied;
}
