import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations, getMigrationFiles } from '../src/database/migrator.js';

export async function testMigrations() {
  console.log('\n--- Running Migrations Test Suite ---');
  const { pool } = createTestDatabase();

  try {
    // 1. Verify migration files discovery
    const files = getMigrationFiles();
    assert.ok(files.length >= 11, `Expected at least 11 SQL migration files, found ${files.length}`);
    console.log(`✓ Discovered ${files.length} migration files in order: ${files.map(f => f.version).join(', ')}`);

    // 2. Apply migrations
    const applied = await runMigrations({ poolOverride: pool });
    assert.equal(applied.length, files.length, `Expected ${files.length} migrations to be applied on a fresh database`);
    console.log(`✓ Successfully executed all ${applied.length} migrations in transaction`);

    // 3. Verify schema_migrations table
    const migRes = await pool.query('SELECT version, name FROM schema_migrations ORDER BY id ASC');
    assert.equal(migRes.rows.length, files.length);
    console.log('✓ schema_migrations audit ledger verified');

    // 4. Verify all core tables exist (including Sprint 2 Auth & Session tables, Sprint 3 Pricing tables)
    const expectedTables = [
      'users',
      'roles',
      'permissions',
      'role_permissions',
      'user_roles',
      'saved_gstins',
      'saved_addresses',
      'merchants',
      'merchant_stores',
      'store_staff',
      'products',
      'store_inventory',
      'orders',
      'order_items',
      'riders',
      'delivery_trips',
      'general_ledger_accounts',
      'general_ledger_entries',
      'seller_ledgers',
      'rider_ledgers',
      'idempotency_keys',
      'webhook_events',
      'audit_logs',
      'statutory_tax_rules',
      'statutory_withholding_rules',
      'gst_tcs_rules',
      'auth_sessions',
      'refresh_tokens',
      'otp_challenges',
      'pricing_delivery_rules',
      'pricing_calculation_snapshots',
      'seller_product_tax',
      'coupons',
      'outbox_events',
      'user_device_tokens',
      'notification_preferences',
      'notification_campaigns',
      'notification_deliveries',
      'notification_event_metrics',
      'refunds',
      'order_returns',
      'order_return_items',
    ];

    for (const table of expectedTables) {
      const res = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
      assert.equal(Number(res.rows[0].count), 0, `Table ${table} should be queryable and empty before seed`);
    }
    console.log(`✓ Verified schema presence and queryability of all ${expectedTables.length} relational tables`);

    // 5. Test idempotency: re-running migrations should apply 0
    const secondRun = await runMigrations({ poolOverride: pool });
    assert.equal(secondRun.length, 0, 'Subsequent migration run should apply 0 pending migrations');
    console.log('✓ Migration idempotency verified');

  } finally {
    await pool.end();
  }
}
