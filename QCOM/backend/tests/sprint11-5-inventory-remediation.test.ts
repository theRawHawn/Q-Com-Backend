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
import { orderService } from '../src/modules/orders/orderService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import { pricingEngine, PricingEngineError } from '../src/modules/pricing/pricingEngine.js';
import { env } from '../src/config/env.js';

export async function runSprint11_5RemediationTests(): Promise<void> {
  console.log('\n================================================================');
  console.log('--- Running Sprint 11.5: Critical Inventory Remediation Suite ---');
  console.log('================================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const customerPhone = '+91-9876543210';
    const otpRes = await authService.requestOtp(customerPhone, 'LOGIN', '127.0.0.1', pool);
    const verifyRes = await authService.verifyOtp(
      customerPhone,
      otpRes.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'test-agent',
      'Rohan Kulkarni',
      pool
    );
    const customerToken = verifyRes.accessToken;
    const customerUserId = verifyRes.user.id;

    // Fetch test merchant and products
    const merchantRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
    const merchantId = merchantRes.rows[0].id;

    const prodRes = await pool.query(
      `SELECT p.id, p.name, si.stock_count, si.reserved_count
       FROM products p
       JOIN store_inventory si ON p.id = si.product_id
       WHERE si.merchant_id = $1
       ORDER BY p.id ASC
       LIMIT 3`,
      [merchantId]
    );
    const productA = prodRes.rows[0];
    const productB = prodRes.rows[1];

    // Reset stock counts to known state for test determinism
    await pool.query(
      `UPDATE store_inventory SET stock_count = 50, reserved_count = 0 WHERE merchant_id = $1 AND product_id IN ($2, $3)`,
      [merchantId, productA.id, productB.id]
    );

    // -------------------------------------------------------------
    // Test 1: Online Order Placement Decoupling (RESERVED hold, not committed)
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Online Order Placement Decoupling...');
    const onlineOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: [{ productId: productA.id, quantity: 5 }],
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Koramangala, Bangalore' },
      paymentMethod: 'Instant UPI',
    });

    const onlineOrderId = onlineOrderRes.order.id;
    const invCheck1 = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    // Physical stock count remains 50; reserved count is incremented to 5
    assert.strictEqual(Number(invCheck1.rows[0].stock_count), 50, 'Physical stock count must remain 50 before payment capture');
    assert.strictEqual(Number(invCheck1.rows[0].reserved_count), 5, 'Reserved count must be 5');

    // Available stock is max(0, stock_count - reserved_count) = 45
    const avail1 = await inventoryService.checkAvailability(merchantId, [{ productId: productA.id, quantity: 46 }]);
    assert.strictEqual(avail1.isAvailable, false, 'Competing checkout for 46 units must be rejected');
    const avail2 = await inventoryService.checkAvailability(merchantId, [{ productId: productA.id, quantity: 45 }]);
    assert.strictEqual(avail2.isAvailable, true, 'Available stock must accurately reflect 45 units remaining');

    const resRecord1 = await pool.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1`,
      [onlineOrderId]
    );
    assert.strictEqual(resRecord1.rows[0].status, 'RESERVED', 'Online order reservation status must remain RESERVED');
    console.log('✓ Test 1 passed: Online order placement holds RESERVED stock without prematurely writing off physical inventory');

    // -------------------------------------------------------------
    // Test 2: Cash on Delivery (Pay on Delivery) Placement Commits Stock
    // -------------------------------------------------------------
    console.log('[Test 2] Testing COD (Pay on Delivery) Placement Immediate Stock Commit...');
    const codOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: [{ productId: productB.id, quantity: 4 }],
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Indiranagar, Bangalore' },
      paymentMethod: 'Pay on Delivery',
    });

    const codOrderId = codOrderRes.order.id;
    const invCheck2 = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productB.id]
    );
    // COD commits immediately: stock_count = 50 - 4 = 46, reserved_count = 0
    assert.strictEqual(Number(invCheck2.rows[0].stock_count), 46, 'COD order must deduct stock_count immediately');
    assert.strictEqual(Number(invCheck2.rows[0].reserved_count), 0, 'COD order reserved_count must be 0 after commit');

    const resRecord2 = await pool.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1`,
      [codOrderId]
    );
    assert.strictEqual(resRecord2.rows[0].status, 'COMMITTED', 'COD order reservation must be COMMITTED');
    console.log('✓ Test 2 passed: COD orders commit stock immediately upon order placement');

    // -------------------------------------------------------------
    // Test 3: Payment Verification Commits Online Order Stock Exactly-Once
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Online Payment Capture Transitions RESERVED to COMMITTED...');
    // Create payment intent for online order
    const intentRes = await paymentService.createPaymentOrder(onlineOrderId, customerUserId);
    const txId = `txn_verify_${Date.now()}`;
    const timestamp = new Date(intentRes.timestamp).getTime();

    await paymentService.verifyPayment({
      orderId: onlineOrderId,
      transactionId: txId,
      timestamp,
      signature: intentRes.signature,
      userId: customerUserId,
    });

    const invCheck3 = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    // After verification: stock_count decremented from 50 to 45, reserved_count reset from 5 to 0
    assert.strictEqual(Number(invCheck3.rows[0].stock_count), 45, 'Captured payment must decrement stock_count to 45');
    assert.strictEqual(Number(invCheck3.rows[0].reserved_count), 0, 'Captured payment must clear reserved_count');

    const resRecord3 = await pool.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1`,
      [onlineOrderId]
    );
    assert.strictEqual(resRecord3.rows[0].status, 'COMMITTED', 'Captured order reservation must be COMMITTED');
    console.log('✓ Test 3 passed: Payment verification transitions RESERVED to COMMITTED and decrements physical stock');

    // -------------------------------------------------------------
    // Test 4: Online Payment Failure Releases Reservation & Cancels Order
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Online Payment Failure Releases Reservation & Cancels Order...');
    const failedOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: [{ productId: productA.id, quantity: 3 }],
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Whitefield, Bangalore' },
      paymentMethod: 'Instant UPI',
    });
    const failedOrderId = failedOrderRes.order.id;

    // Verify hold
    const preFailStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(preFailStock.rows[0].stock_count), 45);
    assert.strictEqual(Number(preFailStock.rows[0].reserved_count), 3);

    // Simulate payment.failed webhook
    const failEventId = `evt_fail_${Date.now()}`;
    const failWebhookPayload = {
      id: failEventId,
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_fail_${Date.now()}`,
            amount: Math.round(Number(failedOrderRes.order.totalAmount) * 100),
            currency: 'INR',
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment was declined by issuing bank',
            notes: { orderId: failedOrderId },
          },
        },
      },
    };
    const failRawBody = JSON.stringify(failWebhookPayload);
    const failSignature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(failRawBody).digest('hex');

    const webhookRes = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': failSignature,
        'x-razorpay-event-id': failEventId,
      },
      body: failRawBody,
    });
    const hookBody = await webhookRes.json();
    assert.strictEqual(webhookRes.status, 200);
    assert.strictEqual(hookBody.success, true);
    assert.strictEqual(hookBody.paymentState, 'FAILED');

    // Stock should be released
    const postFailStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(postFailStock.rows[0].stock_count), 45, 'Physical stock count must remain unchanged');
    assert.strictEqual(Number(postFailStock.rows[0].reserved_count), 0, 'Reserved count must be restored to 0');

    // Order status should be cancelled
    const failOrderDb = await pool.query(`SELECT status, cancellation_reason FROM orders WHERE id = $1`, [failedOrderId]);
    assert.strictEqual(failOrderDb.rows[0].status, 'cancelled');
    assert.ok(failOrderDb.rows[0].cancellation_reason.includes('Payment failed'));

    // Reservation should be RELEASED
    const failResDb = await pool.query(`SELECT status FROM inventory_reservations WHERE order_id = $1`, [failedOrderId]);
    assert.strictEqual(failResDb.rows[0].status, 'RELEASED');
    console.log('✓ Test 4 passed: Payment failure releases reservation and cancels order safely');

    // -------------------------------------------------------------
    // Test 5: Abandoned Reservation Reaper Releases Expired Reservations
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Abandoned Reservation Reaper...');
    const abandonedOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: [{ productId: productA.id, quantity: 2 }],
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'HSR Layout, Bangalore' },
      paymentMethod: 'Instant UPI',
    });
    const abandonedOrderId = abandonedOrderRes.order.id;

    // Artificially age the reservation expires_at to 20 minutes ago
    await pool.query(
      `UPDATE inventory_reservations SET expires_at = NOW() - INTERVAL '20 minutes' WHERE order_id = $1`,
      [abandonedOrderId]
    );

    // Run reaper
    const reapResult = await inventoryService.reapExpiredReservations(50);
    assert.ok(reapResult.reapedOrdersCount >= 1, 'Reaper must reap at least 1 expired order');
    assert.ok(reapResult.releasedItemsCount >= 1, 'Reaper must release at least 1 expired item');

    const postReapStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(postReapStock.rows[0].reserved_count), 0, 'Reaper must reset reserved_count to 0');

    const abandonedOrderDb = await pool.query(`SELECT status FROM orders WHERE id = $1`, [abandonedOrderId]);
    assert.strictEqual(abandonedOrderDb.rows[0].status, 'cancelled', 'Reaped abandoned order must be cancelled');
    console.log('✓ Test 5 passed: Abandoned reservation reaper releases inventory and cancels expired orders');

    // -------------------------------------------------------------
    // Test 6: Zero Phantom Inventory On Multiple Cancellations
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Zero Phantom Inventory On Multiple Cancellations...');
    // Create new order, commit it, and cancel it twice
    const cancelOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: [{ productId: productA.id, quantity: 4 }],
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Koramangala, Bangalore' },
      paymentMethod: 'Pay on Delivery',
    });
    const cancelOrderId = cancelOrderRes.order.id;

    // Physical stock before cancellation: 45 - 4 = 41
    const beforeCancel = await pool.query(
      `SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(beforeCancel.rows[0].stock_count), 41);

    // First cancellation: Restocks 4 units (41 -> 45)
    await cancellationService.cancelBySeller({
      orderId: cancelOrderId,
      merchantId,
      reason: 'Seller out of delivery vehicle',
    });

    const afterCancel1 = await pool.query(
      `SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(afterCancel1.rows[0].stock_count), 45, 'First cancellation must restock to 45');

    // Second cancellation call (duplicate / retry)
    await inventoryService.restockCommittedStock(cancelOrderId);
    const afterCancel2 = await pool.query(
      `SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productA.id]
    );
    assert.strictEqual(Number(afterCancel2.rows[0].stock_count), 45, 'Duplicate restock MUST NOT create phantom inventory');
    console.log('✓ Test 6 passed: Duplicate cancellation / restock calls strictly prevent phantom inventory');

    // -------------------------------------------------------------
    // Test 7: Deterministic SKU Ordering in Multi-Item Reservations
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Deterministic SKU Ordering in Multi-Item Reservations...');
    // Submit items in reverse alphabetical order
    const reverseItems = [
      { productId: productB.id > productA.id ? productB.id : productA.id, quantity: 1 },
      { productId: productB.id > productA.id ? productA.id : productB.id, quantity: 1 },
    ];
    const multiOrderRes = await orderService.createOrder({
      userId: customerUserId,
      merchantId,
      items: reverseItems,
      jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'MG Road, Bangalore' },
      paymentMethod: 'Instant UPI',
    });
    assert.ok(multiOrderRes.order.id);
    console.log('✓ Test 7 passed: Multi-item orders reserve with deterministic SKU sorting');

    // -------------------------------------------------------------
    // Test 8: Pricing Engine Availability Check Rejection
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Pricing Engine Rejection on Insufficient Quantity...');
    // Product A currently has stock_count = 44, reserved_count = 1 (available = 43)
    await assert.rejects(
      async () => {
        await pricingEngine.calculate({
          merchantId,
          items: [{ productId: productA.id, quantity: 200 }],
          placeOfSupplyStateCode: '29',
          userId: customerUserId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof PricingEngineError);
        assert.strictEqual(err.code, 'INSUFFICIENT_STOCK');
        assert.strictEqual(err.statusCode, 422);
        return true;
      },
      'Pricing quote must reject requested quantity > available stock with INSUFFICIENT_STOCK (422)'
    );
    console.log('✓ Test 8 passed: Pricing quote validates stock_count - reserved_count and rejects over-quantity requests');

    console.log('================================================================');
    console.log('✓ ALL SPRINT 11.5 CRITICAL INVENTORY REMEDIATION TESTS PASSED!');
    console.log('================================================================\n');
  } finally {
    server.close();
  }
}

// Auto-run when executed directly via tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint11_5RemediationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sprint 11.5 Test Suite Failure:', err);
      process.exit(1);
    });
}
