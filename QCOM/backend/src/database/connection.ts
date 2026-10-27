import pg from 'pg';
import { env, sanitizeConnectionString } from '../config/env.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
  command: string;
}

export type TransactionClient = pg.PoolClient;

/**
 * Returns the active PostgreSQL connection pool, initializing it if necessary.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = env.DATABASE_POOL_URL || env.DATABASE_URL;
    pool = new Pool({
      connectionString,
      max: env.DATABASE_MAX_POOL_SIZE,
      idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
      ssl: env.NODE_ENV === 'production' && !connectionString.includes('localhost') 
        ? {
            rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
            ca: env.DATABASE_CA_CERT || undefined,
          } 
        : undefined,
    });

    pool.on('error', (err) => {
      console.error('[Database Pool Error] Unexpected idle client error:', err.message);
    });
  }
  return pool;
}

/**
 * Allows injecting a custom pool (e.g. for testing with pg-mem or test harness).
 */
export function setPool(customPool: pg.Pool | null): void {
  pool = customPool;
}

/**
 * Executes a parameterized SQL query against the connection pool.
 */
export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const currentPool = getPool();
  const start = Date.now();
  try {
    const res = await currentPool.query(text, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount,
      command: res.command,
    };
  } catch (err: any) {
    const duration = Date.now() - start;
    // Log query failure without leaking database password or credentials
    console.error(`[Database Query Error] [${duration}ms] Error: ${err.message}. SQL snippet: "${text.slice(0, 100)}..."`);
    throw err;
  }
}

/**
 * Executes a callback within a managed ACID transaction.
 * Automatically issues BEGIN, COMMIT, or ROLLBACK and safely releases the client.
 */
let memDbMutex: Promise<any> = Promise.resolve();

export async function transaction<T>(
  callback: (client: TransactionClient) => Promise<T>,
  poolOverride?: pg.Pool
): Promise<T> {
  const currentPool = poolOverride || getPool();
  const memDb = (currentPool as any).__pgMemDb;

  if (memDb) {
    const runInQueue = async () => {
      let memDbBackup: any = null;
      if (memDb) {
        memDbBackup = memDb.backup();
      }
      const client = await currentPool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        if (memDbBackup) {
          try {
            memDbBackup.restore();
          } catch (restoreErr: any) {
            console.error('[pg-mem Restore Error]', restoreErr.message);
          }
        }
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr: any) {
          console.error('[Database Rollback Error] Failed to rollback transaction:', rollbackErr.message);
        }
        throw err;
      } finally {
        client.release();
      }
    };

    const next = memDbMutex.then(runInQueue, runInQueue);
    memDbMutex = next.catch(() => {});
    return next;
  }

  const client = await currentPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr: any) {
      console.error('[Database Rollback Error] Failed to rollback transaction:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Checks PostgreSQL connectivity for readiness probes.
 */
export async function checkDatabaseHealth(): Promise<{ alive: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const currentPool = getPool();
    await currentPool.query('SELECT 1 AS alive');
    return {
      alive: true,
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      alive: false,
      latencyMs: Date.now() - start,
      error: err.message || 'Database unreachable',
    };
  }
}

/**
 * Drains and gracefully closes the connection pool.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
