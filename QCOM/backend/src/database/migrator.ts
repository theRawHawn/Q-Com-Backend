import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { getPool, transaction } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrationRecord {
  id: number;
  version: string;
  name: string;
  applied_at: Date;
}

/**
 * Ensures the schema_migrations table exists to track applied migrations.
 */
export async function ensureMigrationTable(client?: { query: (text: string, params?: any[]) => Promise<any> }): Promise<void> {
  const runner = client || getPool();
  try {
    const check = await runner.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'schema_migrations' LIMIT 1
    `);
    if (check.rows && check.rows.length > 0) {
      return;
    }
  } catch {
    // If information_schema lookup is not available, proceed to CREATE TABLE IF NOT EXISTS
  }

  await runner.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Returns all migration files found in the migrations directory, sorted chronologically.
 */
export function getMigrationFiles(customMigrationsDir?: string): { version: string; name: string; fullPath: string }[] {
  const migrationsDir = customMigrationsDir || path.resolve(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`[Migrator] Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  return files.map(file => {
    const parts = file.split('_');
    const version = parts[0];
    const name = file;
    return {
      version,
      name,
      fullPath: path.join(migrationsDir, file),
    };
  });
}

/**
 * Runs all pending migrations against the database.
 */
export async function runMigrations(options?: {
  migrationsDir?: string;
  poolOverride?: pg.Pool;
}): Promise<string[]> {
  const currentPool = options?.poolOverride || getPool();
  await ensureMigrationTable(currentPool);

  const appliedRes = await currentPool.query<MigrationRecord>('SELECT version FROM schema_migrations ORDER BY id ASC');
  const appliedVersions = new Set(appliedRes.rows.map(r => r.version));

  const allMigrations = getMigrationFiles(options?.migrationsDir);
  const pendingMigrations = allMigrations.filter(m => !appliedVersions.has(m.version));

  if (pendingMigrations.length === 0) {
    console.log('[Migrator] Database is already up to date. Zero pending migrations.');
    return [];
  }

  const appliedNow: string[] = [];

  for (const mig of pendingMigrations) {
    console.log(`[Migrator] Applying migration: ${mig.name}...`);
    const sql = fs.readFileSync(mig.fullPath, 'utf8');

    // Execute migration inside an atomic transaction
    const client = await currentPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())',
        [mig.version, mig.name]
      );
      await client.query('COMMIT');
      appliedNow.push(mig.name);
      console.log(`[Migrator] Successfully applied: ${mig.name}`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[Migrator] Failed applying migration ${mig.name}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  return appliedNow;
}
