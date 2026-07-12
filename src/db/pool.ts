// Lazy Postgres connection pool from DATABASE_URL.
//
// Created on first use, so the service starts fine even when no database is configured —
// only DB-backed endpoints (e.g. /jobs/tags/run) touch it, and they surface a clear error
// if DATABASE_URL is unset.

import pg from 'pg';

const { Pool } = pg;
export type DbPool = InstanceType<typeof Pool>;

let pool: DbPool | undefined;

export function getPool(): DbPool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
