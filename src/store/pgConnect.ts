import type { Pool } from 'pg';

/**
 * Wait for PostgreSQL to accept queries (the database container starts with
 * a readiness lag). Retries `retries` times, one second apart; closes the
 * pool and throws if it never comes up.
 */
export async function waitForConnection(pool: Pool, retries: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
  throw new Error(
    `database not reachable after ${retries} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
