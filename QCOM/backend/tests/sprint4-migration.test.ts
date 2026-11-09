import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { routingService } from '../src/modules/routing/routingService.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';

export async function runSprint4MigrationTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 4: Consolidated Domain Migration Suite ---');
  console.log('===========================================================');

  // 1. Setup Isolated pg-mem DB
  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply all 12 migrations
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  // Spin up temporary local server on ephemeral port for standard HTTP testing
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const testPhone = '+91-9876543210';
    // Authenticate via authService to get real valid token and session in DB
    const otpRes = await authService.requestOtp(testPhone, 'LOGIN', '127.0.0.1', pool);
    const verifyRes = await authService.verifyOtp(
      testPhone,
      otpRes.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'test-agent',
      'Rohan Kulkarni',
      pool
    );
    const customerToken = verifyRes.accessToken;

    // -------------------------------------------------------------
    // Test 1: Customer Auth & Profile Contract Verification
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Customer Auth Verification & Profile Contract...');
    const otpReqRes = await fetch(`${baseUrl}/api/auth/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+91-9876500000' }),
    });
    const otpReqBody = await otpReqRes.json();
    assert.strictEqual(otpReqRes.status, 200);
    assert.strictEqual(otpReqBody.success, true);

    const getProfileRes = await fetch(`${baseUrl}/api/profile`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const profileBody = await getProfileRes.json();
    assert.strictEqual(getProfileRes.status, 200);
    assert.strictEqual(profileBody.success, true);
    assert.strictEqual(profileBody.profile.phone, '+91-9876543210');
    console.log('✓ Test 1 passed: Customer Profile & Auth contract verified');

    // -------------------------------------------------------------
    // Test 2: Multi-GSTIN Management & 15-char Format Validation
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Business Multi-GSTIN & Statutory Validation...');
    const invalidGstinRes = await fetch(`${baseUrl}/api/profile/saved-gstin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        gstin: 'INVALID-GST',
        legalBusinessName: 'Test Works',
        billingAddress: 'Peenya Industrial Area',
        state: 'Karnataka',
        stateCode: '29',
      }),
    });
    assert.strictEqual(invalidGstinRes.status, 400);

    const validGstinRes = await fetch(`${baseUrl}/api/profile/saved-gstin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        gstin: '29ABCDE1234F1Z5',
        legalBusinessName: 'Kulkarni Electro-Mech Pvt Ltd',
        billingAddress: '42, Phase 1, Peenya Industrial Area, Bengaluru',
        state: 'Karnataka',
        stateCode: '29',
        pincode: '560058',
        isDefault: true,
      }),
    });
    const gstinBody = await validGstinRes.json();
    assert.strictEqual(validGstinRes.status, 200);
    assert.strictEqual(gstinBody.success, true);
    assert.strictEqual(gstinBody.savedGstin.gstin, '29ABCDE1234F1Z5');
    console.log('✓ Test 2 passed: Statutory GSTIN validation and persistence verified');

    // -------------------------------------------------------------
    // Test 3: Commercial Configs & 100m Distance Rounding
    // -------------------------------------------------------------
    console.log('[Test 3] Testing 100m Distance Rounding & Dynamic Commercial Slabs...');
    assert.strictEqual(routingService.roundTo100Meters(2149), 2100);
    assert.strictEqual(routingService.roundTo100Meters(2150), 2200);
    assert.strictEqual(routingService.roundTo100Meters(49), 0);
    assert.strictEqual(routingService.roundTo100Meters(50), 100);

    const configRes = await fetch(`${baseUrl}/api/checkout/pricing-config`);
    const configBody = await configRes.json();
    assert.strictEqual(configRes.status, 200);
    assert.strictEqual(configBody.config.freeDeliveryThreshold, 499);
    assert.strictEqual(configBody.config.handlingFee, 10);
    console.log('✓ Test 3 passed: 100m distance rounding and commercial config verified');

    // -------------------------------------------------------------
    // Test 4: Authoritative Order Placement & Pricing Snapshot Linkage
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Authoritative Order Placement & Stock Reservation...');
    const prodRes = await pool.query(`SELECT id, name FROM products LIMIT 1`);
    const testProduct = prodRes.rows[0];

    const createOrderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
        'Idempotency-Key': 'idem-sprint4-order-001',
      },
      body: JSON.stringify({
        items: [{ id: testProduct.id, quantity: 2 }],
        jobSite: {
          address: 'Site #14, Whitefield Tech Corridor',
          siteContactName: 'Rohan Site Engineer',
          sitePhone: '+91-9876543210',
          latitude: 12.9716,
          longitude: 77.5946,
        },
        paymentMethod: 'Instant UPI',
        couponCode: 'PROBUILD',
      }),
    });

    const orderBody = await createOrderRes.json();
    if (createOrderRes.status !== 200) {
      console.error('ORDER CREATION ERROR RESPONSE:', JSON.stringify(orderBody, null, 2));
    }
    assert.strictEqual(createOrderRes.status, 200);
    assert.strictEqual(orderBody.success, true);
    const placedOrder = orderBody.order;
    assert.ok(placedOrder.id);
    assert.strictEqual(placedOrder.status, 'placed');
    assert.strictEqual(placedOrder.paymentStatus, 'PENDING');
    console.log(`✓ Test 4 passed: Order ${placedOrder.orderNumber} created with frozen pricing snapshot`);

    // -------------------------------------------------------------
    // Test 5: Payment Intent & HMAC-SHA256 Verification with Replay Defense
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Payment Intent & Replay-Protected Verification...');
    const payIntentRes = await fetch(`${baseUrl}/api/payment/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ orderId: placedOrder.id }),
    });

    const intentBody = await payIntentRes.json();
    assert.strictEqual(payIntentRes.status, 200);
    const { paymentOrder } = intentBody;
    assert.ok(paymentOrder.signature);

    // Verify Payment
    const txId = `txn_${Date.now()}`;
    const timestamp = new Date(paymentOrder.timestamp).getTime();
    const verifyPayRes = await fetch(`${baseUrl}/api/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        orderId: placedOrder.id,
        transactionId: txId,
        timestamp,
        signature: paymentOrder.signature,
        amount: paymentOrder.amount,
      }),
    });

    const verifyBody = await verifyPayRes.json();
    if (verifyPayRes.status !== 200) {
      console.error('PAYMENT VERIFY ERROR RESPONSE:', JSON.stringify(verifyBody, null, 2));
    }
    assert.strictEqual(verifyPayRes.status, 200);
    assert.strictEqual(verifyBody.success, true);
    assert.strictEqual(verifyBody.order.payment_status, 'PAID');

    // Replay Attack Test (Same transactionId)
    const replayRes = await fetch(`${baseUrl}/api/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        orderId: placedOrder.id,
        transactionId: txId,
        timestamp,
        signature: paymentOrder.signature,
        amount: paymentOrder.amount,
      }),
    });
    assert.strictEqual(replayRes.status, 409);
    console.log('✓ Test 5 passed: Cryptographic HMAC signature and replay attack protection verified');

    // -------------------------------------------------------------
    // Test 6: Double-Entry Financial Ledger Balances
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Double-Entry Ledger Journal Invariant...');
    const ledgerRes = await pool.query(`
      SELECT 
        SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) as total_debits,
        SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) as total_credits
      FROM general_ledger_entries
    `);
    const { total_debits, total_credits } = ledgerRes.rows[0];
    assert.strictEqual(parseFloat(total_debits), parseFloat(total_credits));
    console.log(`✓ Test 6 passed: Double-entry ledger verified: Total Debits (₹${total_debits}) == Total Credits (₹${total_credits})`);

    // -------------------------------------------------------------
    // Test 7: Statutory GST Invoices & 64-char IRN Generation
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Form GST INV-1 & 64-character SHA-256 IRN...');
    const invRes = await fetch(`${baseUrl}/api/invoices/order/${placedOrder.id}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const invBody = await invRes.json();

    assert.strictEqual(invRes.status, 200);
    assert.strictEqual(invBody.invoices.length, 2); // Form GST INV-1 and QCOM Platform Invoice
    const sellerInv = invBody.invoices.find((i: any) => i.invoiceType === 'SELLER_TAX_INVOICE');
    assert.ok(sellerInv);
    assert.strictEqual(sellerInv.irn.length, 64);
    console.log(`✓ Test 7 passed: Statutory Form GST INV-1 generated with IRN ${sellerInv.irn.slice(0, 16)}...`);

    // -------------------------------------------------------------
    // Test 8: Routing & Snapping
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Multi-Candidate Routing & Snapping...');
    const routeRes = await fetch(`${baseUrl}/api/routing/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerLocation: { latitude: 12.9716, longitude: 77.5946 },
        customerLocation: { latitude: 12.9800, longitude: 77.6000 },
        vehicleType: 'two_wheeler',
      }),
    });
    const routeBody = await routeRes.json();
    assert.strictEqual(routeRes.status, 200);
    assert.ok(routeBody.selectedRoute.distanceMeters > 0);
    assert.strictEqual(routeBody.selectedRoute.routeType, 'BIKE_COURIER');
    console.log('✓ Test 8 passed: Multi-candidate routing and corridor calculation verified');

    // -------------------------------------------------------------
    // Test 9: Delivery Economics & Subsidy Threshold
    // -------------------------------------------------------------
    console.log('[Test 9] Testing Delivery Economics & Contribution Margin...');
    const econRes = await fetch(`${baseUrl}/api/delivery/economics/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveryCoordinates: { latitude: 12.9716, longitude: 77.5946 },
        cartItems: [{ productId: testProduct.id, quantity: 2 }],
        cartTotal: 650,
      }),
    });
    const econBody = await econRes.json();
    assert.strictEqual(econRes.status, 200);
    assert.strictEqual(econBody.success, true);
    console.log('✓ Test 9 passed: Delivery economics evaluation verified');

    // -------------------------------------------------------------
    // Test 10: AI Hardware Services
    // -------------------------------------------------------------
    console.log('[Test 10] Testing AI Hardware Part Matcher & Emergency Planner...');
    const aiPartRes = await fetch(`${baseUrl}/api/part-finder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Need double pole MCB breaker', tradeType: 'Electrical' }),
    });
    const aiPartBody = await aiPartRes.json();
    assert.strictEqual(aiPartRes.status, 200);
    assert.ok(aiPartBody.confidenceScore >= 0.85);

    const aiKitRes = await fetch(`${baseUrl}/api/emergency-kit-planner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emergencyDescription: 'Major burst pipe water leak' }),
    });
    const aiKitBody = await aiKitRes.json();
    assert.strictEqual(aiKitRes.status, 200);
    assert.ok(aiKitBody.suggestedItems.length > 0);
    console.log('✓ Test 10 passed: AI hardware tools verified');

    // -------------------------------------------------------------
    // Test 11: Order Creation Idempotency & Retry Lifecycle
    // -------------------------------------------------------------
    console.log('[Test 11] Testing Order Creation Idempotency & Replay Protection...');
    const idemKeyOrder = 'idem-order-test-unique-999';
    const initialOrderPayload = {
      items: [{ id: testProduct.id, quantity: 1 }],
      jobSite: {
        address: 'Site #50, Whitefield Industrial Area',
        siteContactName: 'Kulkarni Site Supervisor',
        sitePhone: '+91-9876543210',
        latitude: 12.9716,
        longitude: 77.5946,
      },
      paymentMethod: 'Instant UPI',
    };

    // 1st request -> Creates order
    const firstOrderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
        'Idempotency-Key': idemKeyOrder,
      },
      body: JSON.stringify(initialOrderPayload),
    });
    const firstOrderBody = await firstOrderRes.json();
    if (firstOrderRes.status !== 200) {
      console.error('TEST 11 ORDER CREATION FAILED:', JSON.stringify(firstOrderBody, null, 2));
    }
    assert.strictEqual(firstOrderRes.status, 200);
    assert.strictEqual(firstOrderBody.success, true);
    const createdOrderId = firstOrderBody.order.id;

    // 2nd request with same key and same payload -> Must return cached order without creating a duplicate
    const retryOrderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
        'Idempotency-Key': idemKeyOrder,
      },
      body: JSON.stringify(initialOrderPayload),
    });
    const retryOrderBody = await retryOrderRes.json();
    assert.strictEqual(retryOrderRes.status, 200);
    assert.strictEqual(retryOrderBody.order.id, createdOrderId);

    // Verify exactly one order exists in DB for this order
    const orderCountRes = await pool.query(
      `SELECT COUNT(*) as cnt FROM orders WHERE id = $1`,
      [createdOrderId]
    );
    assert.strictEqual(Number(orderCountRes.rows[0].cnt), 1);
    console.log('✓ Test 11 passed: Order creation idempotency lifecycle & duplicate suppression verified');

    // -------------------------------------------------------------
    // Test 12: Order Idempotency Payload Mismatch Rejection
    // -------------------------------------------------------------
    console.log('[Test 12] Testing Order Idempotency Payload Mismatch Rejection...');
    const mismatchedPayload = {
      ...initialOrderPayload,
      items: [{ id: testProduct.id, quantity: 5 }], // Materially different quantity
    };
    const mismatchRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
        'Idempotency-Key': idemKeyOrder,
      },
      body: JSON.stringify(mismatchedPayload),
    });
    const mismatchBody = await mismatchRes.json();
    assert.strictEqual(mismatchRes.status, 422);
    assert.strictEqual(mismatchBody.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    console.log('✓ Test 12 passed: Same Idempotency-Key with different payload rejected with HTTP 422');

    // -------------------------------------------------------------
    // Test 13: Inventory Hardening - Sufficient Stock, Commit & Release
    // -------------------------------------------------------------
    console.log('[Test 13] Testing Inventory Hardening: Stock Reservation, Commit & Release...');
    const invRowRes = await pool.query(
      `SELECT merchant_id, product_id, stock_count, reserved_count 
       FROM store_inventory 
       WHERE stock_count >= 10 
       ORDER BY stock_count DESC
       LIMIT 1`
    );
    const testMerchantId = invRowRes.rows[0].merchant_id;
    const testInvProductId = invRowRes.rows[0].product_id;
    const initialStock = Number(invRowRes.rows[0].stock_count);
    const initialReserved = Number(invRowRes.rows[0].reserved_count || 0);

    // Reserve 3 units
    const testOrderGuid1 = crypto.randomUUID();
    const resResult = await inventoryService.reserveStock(
      testOrderGuid1,
      testMerchantId,
      [{ productId: testInvProductId, quantity: 3 }]
    );
    assert.strictEqual(resResult.length, 1);
    assert.strictEqual(resResult[0].status, 'RESERVED');

    // Check reserved_count incremented
    const afterResStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [testMerchantId, testInvProductId]
    );
    assert.strictEqual(Number(afterResStock.rows[0].reserved_count), initialReserved + 3);

    // Release stock
    await inventoryService.releaseStock(testOrderGuid1);
    const afterReleaseStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [testMerchantId, testInvProductId]
    );
    assert.strictEqual(Number(afterReleaseStock.rows[0].reserved_count), initialReserved);

    // Re-reserve with new GUID and commit
    const testOrderGuid2 = crypto.randomUUID();
    await inventoryService.reserveStock(
      testOrderGuid2,
      testMerchantId,
      [{ productId: testInvProductId, quantity: 2 }]
    );
    await inventoryService.commitStock(testOrderGuid2);
    const afterCommitStock = await pool.query(
      `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
      [testMerchantId, testInvProductId]
    );
    assert.strictEqual(Number(afterCommitStock.rows[0].stock_count), initialStock - 2);
    assert.strictEqual(Number(afterCommitStock.rows[0].reserved_count), initialReserved);
    console.log('✓ Test 13 passed: Inventory reservation, commit, and release cycles verified');

    // -------------------------------------------------------------
    // Test 14: Inventory Hardening - Missing Row & Zero Stock Invariants
    // -------------------------------------------------------------
    console.log('[Test 14] Testing Inventory Hardening: Missing Row & Insufficient Stock...');
    // Missing row should fail explicitly with INVENTORY_NOT_FOUND (no auto-upsert)
    const fakeProductGuid = '99999999-8888-7777-6666-555555555555';
    await assert.rejects(
      async () => {
        await inventoryService.reserveStock(
          '99999999-0000-0000-0000-000000000001',
          testMerchantId,
          [{ productId: fakeProductGuid, quantity: 1 }]
        );
      },
      /INVENTORY_NOT_FOUND/,
      'Missing inventory row must throw INVENTORY_NOT_FOUND'
    );

    // Insufficient stock check
    await assert.rejects(
      async () => {
        await inventoryService.reserveStock(
          crypto.randomUUID(),
          testMerchantId,
          [{ productId: testProduct.id, quantity: 999999 }]
        );
      },
      /INSUFFICIENT_STOCK/,
      'Over-reservation must throw INSUFFICIENT_STOCK'
    );
    console.log('✓ Test 14 passed: Missing inventory rows rejected and over-reservation prevented');

    // -------------------------------------------------------------
    // Test 15: Transaction Rollback on Failure Invariant
    // -------------------------------------------------------------
    console.log('[Test 15] Testing Transaction Rollback on Order Creation Failure...');
    const preRollbackReservations = await pool.query(`SELECT COUNT(*) as cnt FROM inventory_reservations`);
    const preCount = Number(preRollbackReservations.rows[0].cnt);

    try {
      await transaction(async (client) => {
        await inventoryService.reserveStock(
          crypto.randomUUID(),
          testMerchantId,
          [{ productId: testProduct.id, quantity: 1 }],
          15,
          client
        );
        throw new Error('SIMULATED_TRANSACTION_FAILURE');
      });
    } catch (err: any) {
      assert.strictEqual(err.message, 'SIMULATED_TRANSACTION_FAILURE');
    }

    const postRollbackReservations = await pool.query(`SELECT COUNT(*) as cnt FROM inventory_reservations`);
    assert.strictEqual(Number(postRollbackReservations.rows[0].cnt), preCount);
    console.log('✓ Test 15 passed: Transaction rollback completely reverts inventory reservations');

    console.log('===========================================================');
    console.log('✓ ALL SPRINT 4 CONSOLIDATED MIGRATION TESTS PASSED!');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}
