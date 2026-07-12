// Migration-runner test against real Postgres via PGlite: applies the migration set once,
// confirms the schema landed, and confirms a re-run is a no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations, type SqlExecutor } from '../src/db/migrate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function executor(db: PGlite): SqlExecutor {
  return {
    exec: (sql) => db.exec(sql).then(() => undefined),
    query: async (sql, params) => {
      const r = await db.query(sql, params as unknown[]);
      return r.rows as Array<Record<string, unknown>>;
    },
  };
}

test('migrate runner: applies pending migrations once, then is a no-op', async () => {
  const db = new PGlite();
  const ex = executor(db);

  const first = await runMigrations(ex, MIGRATIONS_DIR);
  assert.ok(first.includes('0001_init.sql'), `expected 0001 applied, got [${first.join(', ')}]`);

  const t = await db.query<{ n: number }>(
    `select count(*)::int n from pg_tables where schemaname='public' and tablename='catalog_mapping'`,
  );
  assert.equal(t.rows[0].n, 1);

  const second = await runMigrations(ex, MIGRATIONS_DIR);
  assert.equal(second.length, 0);

  const tracked = await db.query<{ name: string }>(`select name from schema_migrations`);
  assert.ok(tracked.rows.some((r) => r.name === '0001_init.sql'));
});
