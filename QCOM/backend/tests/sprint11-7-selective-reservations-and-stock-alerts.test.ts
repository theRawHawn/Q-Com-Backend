import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { outboxService, registerCoreOutboxConsumers } from '../src/modules/outbox/outboxService.js';

export async function runSprint11_7SelectiveReservationsAndStockAlertsTests(): Promise<void> {
  console.log('\n================================================================');
  console.log('--- Running Sprint 11.7: Selective Stock Reservation & Seller Alert Suite ---');
  console.log('================================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  registerCoreOutboxConsumers();

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Auth Setup: Customer token & Seller Token
    const customerPhone = '+91-9876543210';
    const custOtp = await authService.requestOtp(customerPhone, 'LOGIN', '127.0.0.1', pool);
    const custAuth = await authService.verifyOtp(
      customerPhone,
      custOtp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'test-agent',
      'Rohan Kulkarni',
      pool
    );
    const customerToken = custAuth.accessToken;

    // Fetch Seller A and Merchant A
    const sellerUserRes = await pool.query(`SELECT id FROM users WHERE phone = '+91-9845012345' LIMIT 1`);
    const sellerUserId = sellerUserRes.rows[0].id;
    const sellerOtp = await authService.requestOtp('+91-9845012345', 'LOGIN', '127.0.0.1', pool);
    const sellerAuth = await authService.verifyOtp(
      '+91-9845012345',
      sellerOtp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'seller-agent',
      'Suresh Babu',
      pool
    );
    const sellerToken = sellerAuth.accessToken;

    const merchantRes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchantId = merchantRes.rows[0].id;

    // Fetch Merchant B (for tenant isolation tests)
    const merchantBRes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-02'`);
    const merchantBId = merchantBRes.rows[0].id;

    // Fetch product to test
    const prodRes = await pool.query(
      `SELECT p.id, p.name, p.sku
       FROM products p
       JOIN store_inventory si ON p.id = si.product_id
       WHERE si.merchant_id = $1
       LIMIT 1`,
      [merchantId]
    );
    const testProduct = prodRes.rows[0];
    const productId = testProduct.id;

    // -------------------------------------------------------------
    // TEST 1: Low-Stock Notification Boundary Transition (10 -> 8 -> 5)
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Low-Stock Notification Boundary Transition (10 -> 8 -> 5)...');
    {
      // Reset inventory state for clean test: physical = 10, reserved = 0, threshold = 5
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10,
            reserved_count = 0,
            low_stock_threshold = 5,
            scarce_stock_threshold = 3,
            low_stock_alert_triggered = FALSE,
            out_of_stock_alert_triggered = FALSE,
            last_alert_at = NULL,
            updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      // Step A: Reserve 2 units (available drops 10 -> 8). Above threshold 5 -> No alert!
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 2 }],
        15
      );

      const check1a = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered, out_of_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(Number(check1a.rows[0].reserved_count), 2, 'Reserved count should be 2');
      assert.strictEqual(check1a.rows[0].low_stock_alert_triggered, false, 'Low stock alert must NOT trigger above threshold (available: 8 > 5)');

      // Step B: Reserve 3 more units (available drops 8 -> 5). Crosses boundary to threshold 5 -> Trigger alert!
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 3 }],
        15
      );

      const check1b = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered, out_of_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(Number(check1b.rows[0].reserved_count), 5, 'Reserved count should be 5');
      assert.strictEqual(check1b.rows[0].low_stock_alert_triggered, true, 'Low stock alert MUST be triggered when available stock reaches threshold 5');

      // Check seller_stock_alerts table
      const alertLog = await pool.query(`
        SELECT alert_type, available_stock, threshold_value
        FROM seller_stock_alerts
        WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'LOW_STOCK'
      `, [merchantId, productId]);

      assert.strictEqual(alertLog.rows.length, 1, 'Exactly one LOW_STOCK alert record should be created');
      assert.strictEqual(Number(alertLog.rows[0].available_stock), 5, 'Recorded available stock must be 5');
      assert.strictEqual(Number(alertLog.rows[0].threshold_value), 5, 'Recorded threshold value must be 5');

      // Check transactional outbox event
      const outboxRes = await pool.query(`
        SELECT event_type, status, payload
        FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'INVENTORY_LOW_STOCK'
      `, [productId]);

      assert.strictEqual(outboxRes.rows.length, 1, 'Transactional outbox event INVENTORY_LOW_STOCK must be staged');
      console.log('✓ Test 1 passed: Low stock alert staged atomically on boundary transition (10 -> 8 -> 5).');
    }

    // -------------------------------------------------------------
    // TEST 2: Anti-Spam / Deduplication Within Same Low-Stock Episode (5 -> 4 -> 2)
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Deduplication / Anti-Spam (5 -> 4 -> 2)...');
    {
      const initialAlertCount = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId])).rows[0].cnt;

      const initialOutboxCount = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'INVENTORY_LOW_STOCK'
      `, [productId])).rows[0].cnt;

      // Reserve 1 unit (available drops 5 -> 4)
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 1 }],
        15
      );

      // Reserve 2 more units (available drops 4 -> 2)
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 2 }],
        15
      );

      const check2 = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(Number(check2.rows[0].reserved_count), 8, 'Reserved count should be 8 (2 units available)');
      assert.strictEqual(check2.rows[0].low_stock_alert_triggered, true, 'Alert flag remains true');

      const afterAlertCount = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId])).rows[0].cnt;

      const afterOutboxCount = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'INVENTORY_LOW_STOCK'
      `, [productId])).rows[0].cnt;

      assert.strictEqual(afterAlertCount, initialAlertCount, 'Zero duplicate alert rows created during 5 -> 4 -> 2 depletion');
      assert.strictEqual(afterOutboxCount, initialOutboxCount, 'Zero duplicate outbox events staged during 5 -> 4 -> 2 depletion');
      console.log('✓ Test 2 passed: Zero duplicate alerts during ongoing low-stock depletion.');
    }

    // -------------------------------------------------------------
    // TEST 3: Out-of-Stock Transition (2 -> 0)
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Out-of-Stock Transition (2 -> 0)...');
    {
      // Reserve remaining 2 units (available drops 2 -> 0)
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 2 }],
        15
      );

      const check3 = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered, out_of_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(Number(check3.rows[0].reserved_count), 10, 'All 10 units reserved');
      assert.strictEqual(check3.rows[0].out_of_stock_alert_triggered, true, 'Out of stock flag must be true');

      const oosAlertLog = await pool.query(`
        SELECT alert_type, available_stock
        FROM seller_stock_alerts
        WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'OUT_OF_STOCK'
      `, [merchantId, productId]);

      assert.strictEqual(oosAlertLog.rows.length, 1, 'Exactly one OUT_OF_STOCK alert logged');
      assert.strictEqual(Number(oosAlertLog.rows[0].available_stock), 0, 'Available stock is 0');

      // Attempting to reserve any more stock must be rejected with INSUFFICIENT_STOCK
      let errorThrown = false;
      try {
        await inventoryService.reserveStock(
          crypto.randomUUID(),
          merchantId,
          [{ productId, quantity: 1 }],
          15
        );
      } catch (err: any) {
        errorThrown = true;
        assert(err.message.includes('INSUFFICIENT_STOCK'), 'Must throw INSUFFICIENT_STOCK');
      }
      assert.strictEqual(errorThrown, true, 'Oversell attempt strictly rejected when out of stock');
      console.log('✓ Test 3 passed: Out of stock event triggered on 0 available and oversell blocked.');
    }

    // -------------------------------------------------------------
    // TEST 4: Episode Reset on Full Replenishment (0 -> 10) & Re-Alerting on Next Sales Cycle (10 -> 4)
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Episode Reset on Restocking (0 -> 10) & Re-Alerting (10 -> 4)...');
    {
      // Release prior reservations to simulate clean restocking
      await pool.query(`
        UPDATE inventory_reservations
        SET status = 'RELEASED', updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2 AND status = 'RESERVED'
      `, [merchantId, productId]);

      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 0,
            reserved_count = 0,
            updated_at = NOW()
      `);

      // Seller restocks 10 units via restockInventory
      await inventoryService.restockInventory(merchantId, productId, 10);

      const checkRestock = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered, out_of_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(Number(checkRestock.rows[0].stock_count), 10, 'Stock replenished to 10');
      assert.strictEqual(checkRestock.rows[0].low_stock_alert_triggered, false, 'low_stock_alert_triggered must reset to FALSE on restock > threshold');
      assert.strictEqual(checkRestock.rows[0].out_of_stock_alert_triggered, false, 'out_of_stock_alert_triggered must reset to FALSE on restock > threshold');

      const lowAlertsBefore = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'LOW_STOCK'
      `, [merchantId, productId])).rows[0].cnt;

      // New customer order reserves 6 units (available: 10 -> 4, crossing below 5)
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 6 }],
        15
      );

      const checkCycle2 = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(checkCycle2.rows[0].low_stock_alert_triggered, true, 'Must re-trigger alert for new episode');

      const lowAlertsAfter = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'LOW_STOCK'
      `, [merchantId, productId])).rows[0].cnt;

      assert.strictEqual(lowAlertsAfter, lowAlertsBefore + 1, 'New episode generates fresh low-stock notification');
      console.log('✓ Test 4 passed: Episode resets on replenishment and re-alerts on subsequent cycle.');
    }

    // -------------------------------------------------------------
    // TEST 5: Partial Restoration Reset Rule (0 -> 2 resets OOS, keeps Low-Stock suppressed)
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Partial Restoration Reset Rule (0 -> 2)...');
    {
      // First, bring stock to 0 to trigger OOS
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10,
            reserved_count = 10,
            low_stock_alert_triggered = TRUE,
            out_of_stock_alert_triggered = TRUE,
            updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      // Seller adds 2 units (available goes 0 -> 2, which is > 0 but <= threshold 5)
      await inventoryService.restockInventory(merchantId, productId, 2);

      const checkPartial = await pool.query(`
        SELECT stock_count, reserved_count, low_stock_alert_triggered, out_of_stock_alert_triggered
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);

      assert.strictEqual(checkPartial.rows[0].out_of_stock_alert_triggered, false, 'out_of_stock_alert_triggered resets to FALSE on partial restock > 0');
      assert.strictEqual(checkPartial.rows[0].low_stock_alert_triggered, true, 'low_stock_alert_triggered remains TRUE to avoid duplicate low-stock spam');

      const oosCountBefore = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'OUT_OF_STOCK'
      `, [merchantId, productId])).rows[0].cnt;

      // Now deplete the 2 units (available drops 2 -> 0)
      await inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantId,
        [{ productId, quantity: 2 }],
        15
      );

      const oosCountAfter = (await pool.query(`
        SELECT COUNT(*)::int as cnt FROM seller_stock_alerts WHERE merchant_id = $1 AND product_id = $2 AND alert_type = 'OUT_OF_STOCK'
      `, [merchantId, productId])).rows[0].cnt;

      assert.strictEqual(oosCountAfter, oosCountBefore + 1, 'Re-enters 0 available -> generates new OUT_OF_STOCK alert');
      console.log('✓ Test 5 passed: Partial restoration correctly resets OOS while preserving low-stock episode state.');
    }

    // -------------------------------------------------------------
    // TEST 6: Seller Threshold Configuration API & Precedence Rules
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Seller Threshold Configuration API & Precedence Rules...');
    {
      // A. Update Merchant-level defaults
      const merchUpdateRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/threshold-defaults`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          defaultLowStockThreshold: 8,
          defaultScarceStockThreshold: 4,
        }),
      });
      assert.strictEqual(merchUpdateRes.status, 200, 'Merchant default update returns 200');
      const merchData = await merchUpdateRes.json();
      assert.strictEqual(merchData.defaults.defaultLowStockThreshold, 8);
      assert.strictEqual(merchData.defaults.defaultScarceStockThreshold, 4);

      // B. Update Product-level threshold overrides
      const prodUpdateRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/inventory/${productId}/thresholds`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          lowStockThreshold: 12,
          scarceStockThreshold: 6,
        }),
      });
      assert.strictEqual(prodUpdateRes.status, 200, 'Product threshold update returns 200');
      const prodData = await prodUpdateRes.json();
      assert.strictEqual(prodData.item.lowStockThreshold, 12);
      assert.strictEqual(prodData.item.scarceStockThreshold, 6);

      // C. Precedence Verification
      const effective = await inventoryService.getEffectiveThresholds(merchantId, productId);
      assert.strictEqual(effective.effectiveLowStockThreshold, 12, 'Product threshold (12) overrides merchant default (8)');
      assert.strictEqual(effective.effectiveScarceStockThreshold, 6, 'Product scarce threshold (6) overrides merchant default (4)');

      // D. Server-side validation: Reject negative threshold values
      const invalidRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/inventory/${productId}/thresholds`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          lowStockThreshold: -5,
        }),
      });
      assert.strictEqual(invalidRes.status, 400, 'Negative threshold strictly rejected with 400');
      const invalidData = await invalidRes.json();
      assert.strictEqual(invalidData.error, 'VALIDATION_ERROR');

      console.log('✓ Test 6 passed: Product/Merchant threshold precedence and non-negative integer validation verified.');
    }

    // -------------------------------------------------------------
    // TEST 7: Multi-Tenant Security & Customer Permission Isolation
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Multi-Tenant Security & Customer Permission Isolation...');
    {
      // Customer token attempting to modify merchant threshold must be rejected with 403
      const custAttemptRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/threshold-defaults`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${customerToken}`,
        },
        body: JSON.stringify({ defaultLowStockThreshold: 2 }),
      });
      assert.strictEqual(custAttemptRes.status, 403, 'Customer token forbidden from altering seller threshold');

      // Seller A attempting to access Merchant B inventory must be rejected with 403
      const crossSellerRes = await fetch(`${baseUrl}/api/merchants/${merchantBId}/inventory`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sellerToken}`,
        },
      });
      assert.strictEqual(crossSellerRes.status, 403, 'Seller A forbidden from inspecting Merchant B inventory');

      console.log('✓ Test 7 passed: Strict multi-tenant isolation and customer restriction enforced.');
    }

    // -------------------------------------------------------------
    // TEST 8: Outbox Relayer Post-Commit Delivery & Stock Alert History API
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Outbox Relayer Delivery & Stock Alerts Query API...');
    {
      // Process pending outbox batch
      const outboxBatch = await outboxService.processOutboxBatch(50);
      assert(outboxBatch.processed >= 1, 'Outbox relayer processed pending alerts');
      assert.strictEqual(outboxBatch.failed, 0, 'Zero outbox processing failures');

      // Query seller stock alerts via API
      const alertsApiRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/stock-alerts`, {
        headers: {
          'Authorization': `Bearer ${sellerToken}`,
        },
      });
      assert.strictEqual(alertsApiRes.status, 200, 'Seller stock alerts API returns 200');
      const alertsData = await alertsApiRes.json();
      assert(Array.isArray(alertsData.alerts), 'Alerts array returned');
      assert(alertsData.alerts.length >= 1, 'Stock alerts found in seller inbox');

      // Mark an alert as read
      const firstAlertId = alertsData.alerts[0].id;
      const readRes = await fetch(`${baseUrl}/api/merchants/${merchantId}/stock-alerts/${firstAlertId}/read`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${sellerToken}`,
        },
      });
      assert.strictEqual(readRes.status, 200, 'Mark alert as read returns 200');

      console.log('✓ Test 8 passed: Outbox events successfully published and available via Seller Alert inbox API.');
    }

    console.log('\n================================================================');
    console.log('✓ ALL SPRINT 11.7 SELECTIVE RESERVATION & STOCK ALERT TESTS PASSED (8/8)!');
    console.log('================================================================\n');
  } finally {
    server.close();
  }
}
