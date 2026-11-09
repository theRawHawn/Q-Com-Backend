import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';

export async function testConstraints() {
  console.log('\n--- Running Database Constraints & Idempotency Test Suite ---');
  const { pool } = createTestDatabase();

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    // Fetch seeded merchant and product ID
    const merchRes = await pool.query('SELECT id FROM merchants LIMIT 1');
    const prodRes = await pool.query('SELECT id FROM products LIMIT 1');
    const merchantId = merchRes.rows[0].id;
    const productId = prodRes.rows[0].id;

    // 1. Test Constraint: chk_reserved_le_stock (reserved_count <= stock_count)
    let reservedCheckFailed = false;
    try {
      await pool.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, stock_count, reserved_count, bin_location) 
         VALUES ($1, $2, 100.00, 5, 10, 'Aisle 99')`,
        [merchantId, productId]
      );
    } catch (err: any) {
      reservedCheckFailed = true;
      assert.ok(
        err.message.includes('chk_reserved_le_stock') || err.message.toLowerCase().includes('check constraint'),
        `Expected check constraint violation, got: ${err.message}`
      );
    }
    assert.ok(reservedCheckFailed, 'Database must reject insert when reserved_count > stock_count');
    console.log('✓ Constraint chk_reserved_le_stock verified: rejected reserved_count (10) > stock_count (5)');

    // 2. Test Constraint: stock_count >= 0
    let negativeStockFailed = false;
    try {
      await pool.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, stock_count, reserved_count, bin_location) 
         VALUES ($1, $2, 100.00, -1, 0, 'Aisle 99')`,
        [merchantId, productId]
      );
    } catch (err: any) {
      negativeStockFailed = true;
    }
    assert.ok(negativeStockFailed, 'Database must reject negative stock_count');
    console.log('✓ Constraint stock_count >= 0 verified: rejected negative stock (-1)');

    // 3. Test Constraint: selling_price >= 0
    let negativePriceFailed = false;
    try {
      await pool.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, stock_count, reserved_count, bin_location) 
         VALUES ($1, $2, -50.00, 10, 0, 'Aisle 99')`,
        [merchantId, productId]
      );
    } catch (err: any) {
      negativePriceFailed = true;
    }
    assert.ok(negativePriceFailed, 'Database must reject negative selling_price');
    console.log('✓ Constraint selling_price >= 0 verified: rejected negative price (-₹50.00)');

    // 4. Test Constraint: uq_merchant_product UNIQUE(merchant_id, product_id)
    let duplicateInventoryFailed = false;
    try {
      // Product 1 is already seeded for this merchant in runSeeds
      await pool.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, stock_count, reserved_count, bin_location) 
         VALUES ($1, $2, 299.00, 20, 0, 'Bin A-1')`,
        [merchantId, productId]
      );
    } catch (err: any) {
      duplicateInventoryFailed = true;
      assert.ok(
        err.message.includes('uq_merchant_product') || err.message.toLowerCase().includes('unique'),
        `Expected unique constraint violation, got: ${err.message}`
      );
    }
    assert.ok(duplicateInventoryFailed, 'Database must reject duplicate (merchant_id, product_id)');
    console.log('✓ Unique Constraint uq_merchant_product verified: duplicate merchant-product mapping rejected');

    // 5. Test Constraint: idempotency_keys PRIMARY KEY
    const testIdempotencyKey = 'idem_checkout_req_998877';
    await pool.query(
      `INSERT INTO idempotency_keys 
       (idempotency_key, actor_id, endpoint, status, expires_at) 
       VALUES ($1, 'usr-1', '/api/orders/create', 'COMPLETED', NOW() + INTERVAL '24 hours')`,
      [testIdempotencyKey]
    );

    let duplicateKeyFailed = false;
    try {
      await pool.query(
        `INSERT INTO idempotency_keys 
         (idempotency_key, actor_id, endpoint, status, expires_at) 
         VALUES ($1, 'usr-2', '/api/orders/create', 'PROCESSING', NOW() + INTERVAL '24 hours')`,
        [testIdempotencyKey]
      );
    } catch (err: any) {
      duplicateKeyFailed = true;
      assert.ok(
        err.message.toLowerCase().includes('unique') || err.message.toLowerCase().includes('primary key'),
        `Expected primary key violation, got: ${err.message}`
      );
    }
    assert.ok(duplicateKeyFailed, 'Database must reject duplicate idempotency_key');
    console.log('✓ Idempotency Primary Key constraint verified: replay of identical key rejected');

    // 6. Test Constraint: idempotency_keys status CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED'))
    let invalidStatusFailed = false;
    try {
      await pool.query(
        `INSERT INTO idempotency_keys 
         (idempotency_key, actor_id, endpoint, status, expires_at) 
         VALUES ('idem_invalid_status_key', 'usr-1', '/api/orders/create', 'UNKNOWN_STATUS', NOW() + INTERVAL '24 hours')`
      );
    } catch (err: any) {
      invalidStatusFailed = true;
    }
    assert.ok(invalidStatusFailed, 'Database must reject invalid idempotency status');
    console.log('✓ Idempotency status CHECK constraint verified: rejected UNKNOWN_STATUS');

  } finally {
    await pool.end();
  }
}
