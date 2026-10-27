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
import { refundService } from '../src/modules/payments/refundService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { outboxService, registerCoreOutboxConsumers } from '../src/modules/outbox/outboxService.js';
import { FinancialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { env } from '../src/config/env.js';

export async function runSprint11_8ConcurrencyAndIntegrityTests(): Promise<void> {
  console.log('\n================================================================');
  console.log('--- Running Sprint 11.8: Concurrency Stress & Financial Integrity Suite ---');
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
    const customerUserId = custAuth.user.id;

    // Customer 2 for competing concurrent checkout
    const customer2Phone = '+91-9876543211';
    const cust2Otp = await authService.requestOtp(customer2Phone, 'LOGIN', '127.0.0.1', pool);
    const cust2Auth = await authService.verifyOtp(
      customer2Phone,
      cust2Otp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'test-agent-2',
      'Priya Sharma',
      pool
    );
    const customer2Token = cust2Auth.accessToken;
    const customer2UserId = cust2Auth.user.id;

    // Seller Auth
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

    // Fetch Merchant A and Merchant B
    const merchantRes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchantId = merchantRes.rows[0].id;

    const merchantBRes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-02'`);
    const merchantBId = merchantBRes.rows[0].id;

    // Fetch test products
    const prodRes = await pool.query(
      `SELECT p.id, p.name, p.sku 
       FROM products p 
       JOIN store_inventory si ON p.id = si.product_id 
       WHERE si.merchant_id = $1 
       ORDER BY p.id ASC 
       LIMIT 3`,
      [merchantId]
    );
    const productA = prodRes.rows[0];
    const productB = prodRes.rows[1];
    const productC = prodRes.rows[2];

    const defaultJobSite = { latitude: 12.9716, longitude: 77.5946, address: 'Koramangala, Bangalore' };

    // =============================================================
    // TEST A — LAST-UNIT CONCURRENCY
    // =============================================================
    console.log('[Test A] Testing Last-Unit Concurrency Across Multiple Iterations...');
    {
      const iterations = 5;
      const concurrentUsers = 6;
      let totalSuccessful = 0;
      let totalRejected = 0;

      for (let iter = 1; iter <= iterations; iter++) {
        // Reset stock to exactly 1, reserved to 0
        await pool.query(`
          UPDATE store_inventory
          SET stock_count = 1, reserved_count = 0, updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productA.id]);

        await pool.query(`
          UPDATE inventory_reservations
          SET status = 'RELEASED', updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2 AND status = 'RESERVED'
        `, [merchantId, productA.id]);

        // Compete concurrently
        const promises = Array.from({ length: concurrentUsers }, (_, idx) => {
          return orderService.createOrder({
            userId: idx % 2 === 0 ? customerUserId : customer2UserId,
            merchantId,
            items: [{ productId: productA.id, quantity: 1 }],
            jobSite: defaultJobSite,
            paymentMethod: 'Instant UPI',
          });
        });

        const results = await Promise.allSettled(promises);
        const successes = results.filter(r => r.status === 'fulfilled');
        const failures = results.filter(r => r.status === 'rejected');

        assert.strictEqual(successes.length, 1, `Iteration ${iter}: Exactly 1 checkout must succeed`);
        assert.strictEqual(failures.length, concurrentUsers - 1, `Iteration ${iter}: Remaining ${concurrentUsers - 1} must fail`);

        // Check error messages
        for (const f of failures) {
          if (f.status === 'rejected') {
            assert(f.reason.message.includes('INSUFFICIENT_STOCK') || f.reason.message.includes('chk_reserved_le_stock'), 'Failed checkout must receive INSUFFICIENT_STOCK or chk_reserved_le_stock violation');
          }
        }

        // Verify stock counters: physical stock = 1, reserved = 1, available = 0
        const stockRes = await pool.query(`
          SELECT stock_count, reserved_count FROM store_inventory
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productA.id]);
        const s = stockRes.rows[0];
        assert.strictEqual(Number(s.stock_count), 1, 'Physical stock unchanged during reservation');
        assert.strictEqual(Number(s.reserved_count), 1, 'Reserved stock strictly equals 1');
        assert(Number(s.stock_count) >= Number(s.reserved_count), 'Invariant: reserved <= stock');

        totalSuccessful += successes.length;
        totalRejected += failures.length;
      }

      console.log(`✓ Test A passed: ${iterations} iterations with ${concurrentUsers} competitors: ${totalSuccessful} succeeded, ${totalRejected} rejected with zero overselling.`);
    }

    // =============================================================
    // TEST B — MULTI-UNIT HIGH-CONTENTION CHECKOUT (10, 25, 50 Users)
    // =============================================================
    console.log('[Test B] Testing Multi-Unit High-Contention Checkout (10, 25, 50 Users)...');
    {
      const levels = [10, 25, 50];
      for (const concurrency of levels) {
        // Reset SKU A stock to 100
        await pool.query(`
          UPDATE store_inventory
          SET stock_count = 100, reserved_count = 0, updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productA.id]);

        await pool.query(`
          UPDATE inventory_reservations
          SET status = 'RELEASED', updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2 AND status = 'RESERVED'
        `, [merchantId, productA.id]);

        // Each customer attempts to buy 4 units. Total demand = concurrency * 4.
        const orderPromises = Array.from({ length: concurrency }, (_, idx) => {
          return orderService.createOrder({
            userId: idx % 2 === 0 ? customerUserId : customer2UserId,
            merchantId,
            items: [{ productId: productA.id, quantity: 4 }],
            jobSite: defaultJobSite,
            paymentMethod: 'Instant UPI',
          });
        });

        const results = await Promise.allSettled(orderPromises);
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        const stockRes = await pool.query(`
          SELECT stock_count, reserved_count FROM store_inventory
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productA.id]);
        const currentStock = Number(stockRes.rows[0].stock_count);
        const currentReserved = Number(stockRes.rows[0].reserved_count);

        assert.strictEqual(currentStock, 100, 'Physical stock remains 100 during online hold');
        assert(currentReserved <= 100, `Reserved count (${currentReserved}) must never exceed stock (100)`);
        assert.strictEqual(currentReserved, fulfilled.length * 4, 'Reserved count matches successful reservations');

        // Check aggregate vs individual reservations
        const activeResSum = await pool.query(`
          SELECT COALESCE(SUM(quantity), 0)::int as total
          FROM inventory_reservations
          WHERE merchant_id = $1 AND product_id = $2 AND status = 'RESERVED'
        `, [merchantId, productA.id]);
        assert.strictEqual(Number(activeResSum.rows[0].total), currentReserved, 'Database aggregate matches reserved_count');
      }

      console.log('✓ Test B passed: Concurrency levels 10, 25, and 50 executed safely with aggregate invariants preserved.');
    }

    // =============================================================
    // TEST C — MULTI-SKU CHECKOUT AND DEADLOCK PREVENTION
    // =============================================================
    console.log('[Test C] Testing Multi-SKU Checkout and Deadlock Prevention...');
    {
      // Reset SKU A, B, and C
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 50, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id IN ($2, $3, $4)
      `, [merchantId, productA.id, productB.id, productC.id]);

      await pool.query(`
        UPDATE inventory_reservations
        SET status = 'RELEASED', updated_at = NOW()
        WHERE merchant_id = $1 AND status = 'RESERVED'
      `, [merchantId]);

      // Request 1: [A, B]
      // Request 2: [B, A] (reverse order)
      // Request 3: [A, C]
      // Request 4: [C, B]
      const promises = [
        orderService.createOrder({
          userId: customerUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 2 }, { productId: productB.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
        orderService.createOrder({
          userId: customer2UserId,
          merchantId,
          items: [{ productId: productB.id, quantity: 2 }, { productId: productA.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
        orderService.createOrder({
          userId: customerUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 2 }, { productId: productC.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
        orderService.createOrder({
          userId: customer2UserId,
          merchantId,
          items: [{ productId: productC.id, quantity: 2 }, { productId: productB.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
      ];

      const results = await Promise.allSettled(promises);
      const errors = results.filter(r => r.status === 'rejected');
      for (const err of errors) {
        if (err.status === 'rejected') {
          assert(!err.reason.message.includes('deadlock'), `Deadlock detected: ${err.reason.message}`);
          assert(!err.reason.message.includes('40P01'), `PostgreSQL 40P01 detected: ${err.reason.message}`);
        }
      }
      assert.strictEqual(errors.length, 0, 'All multi-SKU orders succeeded with zero deadlocks');

      // Test all-or-nothing rollback when one SKU has insufficient stock
      // Set SKU C available stock to 0
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 0, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productC.id]);

      const reservedBeforeA = (await pool.query(`
        SELECT reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id])).rows[0].reserved_count;

      let atomicFailed = false;
      try {
        await orderService.createOrder({
          userId: customerUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 5 }, { productId: productC.id, quantity: 1 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        });
      } catch (err: any) {
        atomicFailed = true;
        assert(err.message.toLowerCase().includes('insufficient stock') || (err as any).code === 'INSUFFICIENT_STOCK' || err.message.includes('chk_reserved_le_stock'));
      }
      assert.strictEqual(atomicFailed, true, 'Order failed due to SKU C deficiency');

      const reservedAfterA = (await pool.query(`
        SELECT reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id])).rows[0].reserved_count;

      assert.strictEqual(reservedAfterA, reservedBeforeA, 'SKU A reservation was rolled back completely (atomic all-or-nothing)');
      console.log('✓ Test C passed: Multi-SKU sorting eliminates 40P01 deadlocks and enforces atomic all-or-nothing allocation.');
    }

    // =============================================================
    // TEST D — RESERVATION EXPIRATION RACES
    // =============================================================
    console.log('[Test D] Testing Reservation Expiration Races...');
    {
      // Reset SKU A to 10 stock
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      // Scenario 1: Expire reservation before payment
      const expOrder = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 2 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });
      const expOrderId = expOrder.order.id;

      // Force expires_at to past
      await pool.query(`
        UPDATE inventory_reservations
        SET expires_at = NOW() - INTERVAL '1 minute'
        WHERE order_id = $1
      `, [expOrderId]);

      // Run reaper
      const reapResult = await inventoryService.reapExpiredReservations(10);
      assert(reapResult.reapedOrdersCount >= 1, 'Reaper processed expired reservation');

      const expResCheck = await pool.query(`
        SELECT status FROM inventory_reservations WHERE order_id = $1
      `, [expOrderId]);
      assert.strictEqual(expResCheck.rows[0].status, 'RELEASED', 'Expired reservation marked RELEASED');

      const expOrderCheck = await pool.query(`SELECT status FROM orders WHERE id = $1`, [expOrderId]);
      assert.strictEqual(expOrderCheck.rows[0].status, 'cancelled', 'Expired order marked cancelled');

      // Scenario 3: Expiration worker runs twice for the same reservation (Idempotence)
      const reapResult2 = await inventoryService.reapExpiredReservations(10);
      assert.strictEqual(reapResult2.reapedOrdersCount, 0, 'Reaper second run finds 0 candidates (idempotent)');

      // Check reserved_count restored to 0
      const stockAfterReap = await pool.query(`
        SELECT reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterReap.rows[0].reserved_count), 0, 'Reserved count restored to 0');

      console.log('✓ Test D passed: Expiration worker handles timeouts, idempotency, and state cleanup correctly.');
    }

    // =============================================================
    // TEST E — PAYMENT WEBHOOK RACES AND IDEMPOTENCY
    // =============================================================
    console.log('[Test E] Testing Payment Webhook Races & Idempotency...');
    {
      // Reset SKU A stock to 10
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      const testOrder = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 2 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });
      const orderId = testOrder.order.id;
      const totalAmount = testOrder.order.totalAmount;

      const payOrder = await paymentService.createPaymentOrder(orderId, customerUserId);

      const eventId = `evt_wh_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const providerPaymentId = `pay_${Date.now()}`;
      const rawPayload = JSON.stringify({
        id: eventId,
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: providerPaymentId,
              order_id: payOrder.providerOrderId,
              amount: Math.round(totalAmount * 100),
              status: 'captured',
              notes: { orderId },
            },
          },
        },
      });

      const validSig = crypto
        .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawPayload)
        .digest('hex');

      // 1. Invalid signature check
      let sigFailed = false;
      try {
        await paymentService.processWebhook({
          rawBody: rawPayload,
          signature: 'invalid_hex_signature_123',
          gateway: 'RAZORPAY',
        });
      } catch (err: any) {
        sigFailed = true;
        assert(err.message.includes('INVALID_WEBHOOK_SIGNATURE'));
      }
      assert.strictEqual(sigFailed, true, 'Invalid signature rejected strictly');

      // 2. First delivery of valid webhook
      const wh1 = await paymentService.processWebhook({
        rawBody: rawPayload,
        signature: validSig,
        gateway: 'RAZORPAY',
      });
      assert.strictEqual(wh1.success, true);
      assert.strictEqual(wh1.duplicate, false);

      const orderAfterWh1 = await pool.query(`SELECT payment_status, status FROM orders WHERE id = $1`, [orderId]);
      assert.strictEqual(orderAfterWh1.rows[0].payment_status, 'PAID');

      const stockAfterWh1 = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterWh1.rows[0].stock_count), 8, 'Physical stock decremented to 8');
      assert.strictEqual(Number(stockAfterWh1.rows[0].reserved_count), 0, 'Reserved count cleared to 0');

      // 3. Duplicate delivery of the exact same webhook
      const wh2 = await paymentService.processWebhook({
        rawBody: rawPayload,
        signature: validSig,
        gateway: 'RAZORPAY',
      });
      assert.strictEqual(wh2.success, true);
      assert.strictEqual(wh2.duplicate, true, 'Duplicate webhook returns duplicate: true');

      // Invariant: Physical stock must not be decremented again!
      const stockAfterWh2 = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterWh2.rows[0].stock_count), 8, 'Physical stock remains 8 on duplicate webhook');

      console.log('✓ Test E passed: Webhook signature verification and durable deduplication verified.');
    }

    // =============================================================
    // TEST F — PAYMENT SUCCESS AFTER CANCELLATION (10-Step Workflow)
    // =============================================================
    console.log('[Test F] Testing Payment Success After Cancellation (10-Step Workflow)...');
    {
      // Reset SKU A to 1 stock
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 1, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      // Step 1: Customer A places online order
      const orderA = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });
      const orderIdA = orderA.order.id;

      // Step 2 & 3: Reservation made, payment intent created
      const payA = await paymentService.createPaymentOrder(orderIdA, customerUserId);

      // Step 4 & 5: Customer cancels order within grace window
      await cancellationService.cancelByCustomer({
        orderId: orderIdA,
        userId: customerUserId,
        reason: 'Customer changed mind',
      });

      const cancelCheck = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderIdA]);
      assert.strictEqual(cancelCheck.rows[0].status, 'cancelled');

      // Step 6: Customer B reserves the newly available unit
      const orderB = await orderService.createOrder({
        userId: customer2UserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Pay on Delivery',
      });
      const orderIdB = orderB.order.id;

      // Physical stock is now committed to Customer B (stock: 0, reserved: 0)
      const stockB = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockB.rows[0].stock_count), 0, 'Physical stock is 0 (Customer B purchased)');
      assert.strictEqual(Number(stockB.rows[0].reserved_count), 0);

      // Step 7 & 8: Original payment webhook arrives for Customer A
      const rawPayloadA = JSON.stringify({
        id: `evt_late_${Date.now()}`,
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: `pay_late_${Date.now()}`,
              order_id: payA.providerOrderId,
              amount: Math.round(orderA.order.totalAmount * 100),
              status: 'captured',
              notes: { orderId: orderIdA },
            },
          },
        },
      });

      const sigA = crypto
        .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawPayloadA)
        .digest('hex');

      const lateWhRes = await paymentService.processWebhook({
        rawBody: rawPayloadA,
        signature: sigA,
        gateway: 'RAZORPAY',
      });
      assert.strictEqual(lateWhRes.success, true);

      // Step 9: Webhook delivered again
      const lateWhDup = await paymentService.processWebhook({
        rawBody: rawPayloadA,
        signature: sigA,
        gateway: 'RAZORPAY',
      });
      assert.strictEqual(lateWhDup.success, true);
      assert.strictEqual(lateWhDup.duplicate, true);

      // Step 10: Financial recovery worker runs
      const recoveryWorker = new FinancialRecoveryWorker();
      await recoveryWorker.runRecoveryCycle();

      // Assertions:
      // 1. Order A remains cancelled
      const finalA = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderIdA]);
      assert.strictEqual(finalA.rows[0].status, 'cancelled');
      assert.ok(finalA.rows[0].payment_status === 'REFUNDED' || finalA.rows[0].payment_status === 'REFUND_PENDING', 'Customer A payment status must be REFUNDED or REFUND_PENDING');

      // 2. Customer B order intact
      const finalB = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderIdB]);
      assert.strictEqual(finalB.rows[0].status, 'placed');

      // 3. Physical stock never dropped below 0
      const finalStock = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(finalStock.rows[0].stock_count), 0);
      assert.strictEqual(Number(finalStock.rows[0].reserved_count), 0);

      // 4. Automated refund created for Customer A
      const refundA = await pool.query(`SELECT * FROM refunds WHERE order_id = $1`, [orderIdA]);
      assert.strictEqual(refundA.rows.length, 1, 'Exactly one refund record created');

      console.log('✓ Test F passed: 10-step late payment capture handled with zero overselling and automatic refund.');
    }

    // =============================================================
    // TEST G — PAYMENT FAILURE AND INVENTORY RESTORATION
    // =============================================================
    console.log('[Test G] Testing Payment Failure & Inventory Restoration...');
    {
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      const failOrder = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 3 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });
      const orderId = failOrder.order.id;

      // Verify hold
      const holdCheck = await pool.query(`SELECT reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productA.id]);
      assert.strictEqual(Number(holdCheck.rows[0].reserved_count), 3);

      const payFail = await paymentService.createPaymentOrder(orderId, customerUserId);

      // Deliver payment.failed webhook
      const failPayload = JSON.stringify({
        id: `evt_fail_${Date.now()}`,
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: `pay_fail_${Date.now()}`,
              order_id: payFail.providerOrderId,
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Payment failed at bank gateway.',
              notes: { orderId },
            },
          },
        },
      });

      const failSig = crypto
        .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
        .update(failPayload)
        .digest('hex');

      await paymentService.processWebhook({
        rawBody: failPayload,
        signature: failSig,
        gateway: 'RAZORPAY',
      });

      // Assertions:
      // Order cancelled
      const ordCheck = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      assert.strictEqual(ordCheck.rows[0].status, 'cancelled');

      // Reservation released
      const resCheck = await pool.query(`SELECT status FROM inventory_reservations WHERE order_id = $1`, [orderId]);
      assert.strictEqual(resCheck.rows[0].status, 'RELEASED');

      // Reserved count restored to 0
      const stockCheck = await pool.query(`SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productA.id]);
      assert.strictEqual(Number(stockCheck.rows[0].reserved_count), 0);
      assert.strictEqual(Number(stockCheck.rows[0].stock_count), 10);

      console.log('✓ Test G passed: Payment failure releases reservation and cancels order cleanly.');
    }

    // =============================================================
    // TEST H — CANCELLATION AND STOCK RESTORATION ACROSS ALL STATES
    // =============================================================
    console.log('[Test H] Testing Cancellation Across RESERVED, COMMITTED, and RELEASED States...');
    {
      // 1. Cancellation in RESERVED state (Online order before payment)
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      const resOrder = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 2 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });
      await cancellationService.cancelByCustomer({
        orderId: resOrder.order.id,
        userId: customerUserId,
        reason: 'Customer cancelled before payment',
      });

      const stockResState = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockResState.rows[0].stock_count), 10, 'Physical stock unchanged');
      assert.strictEqual(Number(stockResState.rows[0].reserved_count), 0, 'Reservation released');

      // 2. Cancellation in COMMITTED state (COD order committed at placement)
      const codOrder = await orderService.createOrder({
        userId: customerUserId,
        merchantId,
        items: [{ productId: productA.id, quantity: 2 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Pay on Delivery',
      });
      // Stock was decremented from 10 to 8
      const stockAfterCod = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterCod.rows[0].stock_count), 8);

      // Cancel committed order
      await cancellationService.cancelBySeller({
        orderId: codOrder.order.id,
        merchantId,
        reason: 'Seller out of delivery staff',
      });

      const stockAfterCommCancel = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterCommCancel.rows[0].stock_count), 10, 'Physical stock restored to 10');

      // 3. Repeated cancellation attempt must not double-restore stock
      let repeatFailed = false;
      try {
        await cancellationService.cancelBySeller({
          orderId: codOrder.order.id,
          merchantId,
          reason: 'Duplicate cancellation attempt',
        });
      } catch (err: any) {
        repeatFailed = true;
        assert(err.message.includes('ORDER_ALREADY_CANCELLED'));
      }
      assert.strictEqual(repeatFailed, true);

      const stockAfterRepeat = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterRepeat.rows[0].stock_count), 10, 'Zero phantom inventory created');

      console.log('✓ Test H passed: Cancellation lifecycle correctly distinguishes reservation vs committed stock.');
    }

    // =============================================================
    // TEST I — FINANCIAL LEDGER INTEGRITY (Debits == Credits)
    // =============================================================
    console.log('[Test I] Testing Financial Ledger Integrity & Double-Entry Equality...');
    {
      const ledgerBalances = await pool.query(`
        SELECT journal_batch_id,
               SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) as total_debit,
               SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) as total_credit
        FROM general_ledger_entries
        GROUP BY journal_batch_id
      `);

      for (const batch of ledgerBalances.rows) {
        const debit = parseFloat(batch.total_debit);
        const credit = parseFloat(batch.total_credit);
        assert.strictEqual(debit, credit, `Ledger batch ${batch.journal_batch_id} must have equal debits and credits: ${debit} == ${credit}`);
      }

      console.log(`✓ Test I passed: Verified all ${ledgerBalances.rows.length} general ledger batches strictly adhere to double-entry balance (Debits == Credits).`);
    }

    // =============================================================
    // TEST J — DATABASE FAILURE AND TRANSACTION ROLLBACK
    // =============================================================
    console.log('[Test J] Testing Database Failure & Transaction Rollback...');
    {
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 10, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      let txRollbackCaught = false;
      try {
        await transaction(async (client) => {
          // Mutate stock
          await client.query(`
            UPDATE store_inventory
            SET reserved_count = reserved_count + 3
            WHERE merchant_id = $1 AND product_id = $2
          `, [merchantId, productA.id]);

          // Simulate database error / unhandled exception midway
          throw new Error('DATABASE_CONNECTION_LOST: Simulated connection failure');
        });
      } catch (err: any) {
        txRollbackCaught = true;
        assert(err.message.includes('DATABASE_CONNECTION_LOST'));
      }
      assert.strictEqual(txRollbackCaught, true);

      // Verify no partial mutation was persisted
      const stockAfterRollback = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(stockAfterRollback.rows[0].reserved_count), 0, 'Rollback safely discarded uncommitted reservation');

      console.log('✓ Test J passed: Database transaction rollback safely discards uncommitted inventory mutations.');
    }

    // =============================================================
    // TEST K — TRANSACTIONAL OUTBOX CRASH RECOVERY
    // =============================================================
    console.log('[Test K] Testing Transactional Outbox Crash Recovery & Deduplication...');
    {
      // Drain any pre-existing outbox events staged during prior checkout tests
      while (true) {
        const drain = await outboxService.processOutboxBatch(50);
        if (drain.processed === 0) break;
      }

      await transaction(async (client) => {
        await outboxService.stageEvent(client, {
          eventType: 'INVENTORY_LOW_STOCK',
          aggregateType: 'INVENTORY',
          aggregateId: productA.id,
          payload: {
            merchantId,
            productId: productA.id,
            productName: productA.name,
            sku: productA.sku,
            availableStock: 2,
            physicalStock: 5,
            reservedStock: 3,
            threshold: 5,
            alertType: 'LOW_STOCK',
            timestamp: new Date().toISOString(),
          },
        });
      });

      // Claim and process
      const batchResult = await outboxService.processOutboxBatch(10);
      assert.strictEqual(batchResult.processed, 1, 'Outbox worker processed exactly the staged event');
      assert.strictEqual(batchResult.failed, 0);
      assert.strictEqual(batchResult.succeeded, 1);

      // Re-running processOutboxBatch finds 0 pending items
      const batch2 = await outboxService.processOutboxBatch(10);
      assert.strictEqual(batch2.processed, 0, 'No duplicate processing of published events');

      console.log('✓ Test K passed: Outbox events processed durably with zero duplicate re-execution.');
    }

    // =============================================================
    // TEST L — RESTOCKING AND CHECKOUT CONCURRENCY
    // =============================================================
    console.log('[Test L] Testing Restocking & Checkout Concurrency...');
    {
      // Set initial stock = 2
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 2, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);

      // Concurrently: 1 customer checkouts 2 units, seller restocks 10 units
      const [checkoutRes, restockRes] = await Promise.allSettled([
        orderService.createOrder({
          userId: customerUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Pay on Delivery',
        }),
        inventoryService.restockInventory(merchantId, productA.id, 10),
      ]);

      assert.strictEqual(checkoutRes.status, 'fulfilled', 'Checkout completed successfully');
      assert.strictEqual(restockRes.status, 'fulfilled', 'Restock completed successfully');

      // Final stock should be: initial(2) - checkout(2) + restock(10) = 10
      const finalStock = await pool.query(`
        SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productA.id]);
      assert.strictEqual(Number(finalStock.rows[0].stock_count), 10, 'Final physical stock strictly equals 10');
      assert.strictEqual(Number(finalStock.rows[0].reserved_count), 0, 'Reserved count is 0');

      console.log('✓ Test L passed: Concurrent checkout and restocking preserve exact stock arithmetic.');
    }

    // =============================================================
    // TEST M — UNRELATED SKU INDEPENDENCE
    // =============================================================
    console.log('[Test M] Testing Unrelated SKU Independence (No Global Lock)...');
    {
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 100, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id IN ($2, $3)
      `, [merchantId, productA.id, productB.id]);

      // 10 concurrent requests for SKU A
      const skuAPromises = Array.from({ length: 10 }, () => {
        return orderService.createOrder({
          userId: customerUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 1 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        });
      });

      // Simultaneous request for unrelated SKU B
      const skuBStart = Date.now();
      const skuBPromise = orderService.createOrder({
        userId: customer2UserId,
        merchantId,
        items: [{ productId: productB.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });

      const [skuBResult, ...skuAResults] = await Promise.all([skuBPromise, ...skuAPromises]);
      const skuBDuration = Date.now() - skuBStart;

      assert.ok(skuBResult.order.id, 'SKU B checkout succeeded independently');
      assert.strictEqual(skuAResults.length, 10, 'All SKU A orders completed');
      assert(skuBDuration < 2000, `SKU B checkout completed without queue blocking (${skuBDuration}ms)`);

      console.log(`✓ Test M passed: Unrelated SKU B executed independently in ${skuBDuration}ms without global locking.`);
    }

    // =============================================================
    // TEST N — SELLER ISOLATION AND INVENTORY ALERTS
    // =============================================================
    console.log('[Test N] Testing Seller Isolation and Inventory Alert Security...');
    {
      // 1. Cross-merchant inventory read
      const crossRead = await fetch(`${baseUrl}/api/merchants/${merchantBId}/inventory`, {
        headers: { 'Authorization': `Bearer ${sellerToken}` },
      });
      assert.strictEqual(crossRead.status, 403, 'Seller A forbidden from reading Merchant B inventory');

      // 2. Cross-merchant threshold update
      const crossPatch = await fetch(`${baseUrl}/api/merchants/${merchantBId}/threshold-defaults`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({ defaultLowStockThreshold: 10 }),
      });
      assert.strictEqual(crossPatch.status, 403, 'Seller A forbidden from modifying Merchant B thresholds');

      // 3. Customer token access to merchant inventory
      const custRead = await fetch(`${baseUrl}/api/merchants/${merchantId}/inventory`, {
        headers: { 'Authorization': `Bearer ${customerToken}` },
      });
      assert.strictEqual(custRead.status, 403, 'Customer token forbidden from accessing merchant inventory');

      // 4. Cross-merchant stock alerts
      const crossAlerts = await fetch(`${baseUrl}/api/merchants/${merchantBId}/stock-alerts`, {
        headers: { 'Authorization': `Bearer ${sellerToken}` },
      });
      assert.strictEqual(crossAlerts.status, 403, 'Seller A forbidden from viewing Merchant B stock alerts');

      console.log('✓ Test N passed: Strict multi-tenant isolation and customer restriction enforced.');
    }

    console.log('\n================================================================');
    console.log('✓ ALL SPRINT 11.8 CONCURRENCY & INTEGRITY TESTS PASSED (14/14)!');
    console.log('================================================================\n');
  } finally {
    server.close();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('sprint11-8-concurrency-and-integrity.test.ts')) {
  runSprint11_8ConcurrencyAndIntegrityTests().catch((err) => {
    console.error('Sprint 11.8 Tests FAILED:', err);
    process.exit(1);
  });
}
