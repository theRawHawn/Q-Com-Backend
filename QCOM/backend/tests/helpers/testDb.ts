import { newDb } from 'pg-mem';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export function createTestDatabase(): { db: any; pool: Pool } {
  const db = newDb();

  // Register stub language for DO $$ PL/pgSQL blocks
  db.registerLanguage('plpgsql', () => () => {});

  // Register dynamic UUID generation function with impure: true so each row receives a distinct UUID
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid' as any,
    impure: true,
    implementation: () => uuidv4(),
  });

  // Create an adapter pg.Pool from pg-mem
  const { Pool: MemPool } = db.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  (pool as any).__pgMemDb = db;

  return { db, pool };
}
