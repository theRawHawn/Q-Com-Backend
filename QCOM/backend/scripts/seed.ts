import { runSeeds } from '../seeds/seedData.js';
import { closePool } from '../src/database/connection.js';

async function main() {
  console.log('[Seed CLI] Starting QCOM database seeding...');
  try {
    await runSeeds();
    console.log('[Seed CLI] Seed finished successfully.');
  } catch (err: any) {
    console.error('[Seed CLI] Seed run failed:', err.message);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
