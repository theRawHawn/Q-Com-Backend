import { runMigrations } from '../src/database/migrator.js';
import { closePool } from '../src/database/connection.js';

async function main() {
  console.log('[Migration CLI] Starting QCOM database migration...');
  try {
    const applied = await runMigrations();
    console.log(`[Migration CLI] Done. Applied ${applied.length} migrations.`);
  } catch (err: any) {
    console.error('[Migration CLI] Migration run failed:', err.message);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
