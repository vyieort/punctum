// CLI: apply pending migrations to DATABASE_URL.
//
// No-ops (exit 0) when DATABASE_URL is unset, so it's safe to wire into CI before the
// secret is configured. Run locally with:  DATABASE_URL=... npm run migrate

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runMigrations, type SqlExecutor } from '../src/db/migrate.js';
import { getPool } from '../src/db/pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping migrations.');
    return;
  }
  const pool = getPool();
  const db: SqlExecutor = {
    exec: async (sql) => {
      await pool.query(sql);
    },
    query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
  };
  try {
    const applied = await runMigrations(db, MIGRATIONS_DIR);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
