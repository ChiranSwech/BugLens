import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,                      // Maximum pool connections
  idleTimeoutMillis: 30_000,    // Remove idle connections after 30s
  connectionTimeoutMillis: 5_000, // Fail fast if no connection in 5s
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

// Verify connection on startup
pool.on('connect', (client) => {
  // Enforce UTC and prevent accidental full-table scans by setting a statement timeout
  client.query("SET timezone = 'UTC'; SET statement_timeout = '30s';").catch(() => {
    // Silently ignore — the pool will retry
  });
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
  // Don't exit — the pool will attempt to reconnect
});

/**
 * Execute a parameterised query. NEVER use string concatenation for queries.
 *
 * @example
 *   const result = await query('SELECT * FROM bugs WHERE id = $1 AND org_id = $2', [bugId, orgId]);
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`[DB] Slow query (${duration}ms): ${text.slice(0, 100)}`);
  }

  return result;
}

/**
 * Run multiple queries in a single transaction.
 * Automatically rolls back on any error.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
