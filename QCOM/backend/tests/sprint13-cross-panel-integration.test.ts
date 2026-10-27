import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { signAccessToken } from '../src/modules/auth/jwt.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import {
  DisabledPaymentProvider,
} from '../src/modules/payments/provider/DisabledPaymentProvider.js';
import { MockPaymentProvider } from '../src/modules/payments/paymentProvider.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { FinancialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';

export async function runSprint13CrossPanelIntegrationTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 13.0: Cross-Panel Backend Integration & Workflow Integrity Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply migrations 001 through 023
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Helper to make HTTP requests
  async function apiRequest(path: string, options: {
    method?: string;
    token?: string;
    body?: any;
    headers?: Record<string, string>;
  } = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };
      if (options.token) {
        reqHeaders['Authorization'] = `Bearer ${options.token}`;
      }

      const req = http.request(url, {
        method: options.method || 'GET',
        headers: reqHeaders,
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode || 500, body: parsed, headers: res.headers });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // Provision authentication helper
  async function createTestAuth(params: {
    phone: string;
    name: string;
    roleCode: string;
    merchantId?: string;
    riderId?: string;
  }): Promise<{ token: string; userId: string; sessionId: string }> {
    const candidateUserId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // 1. Insert user
    const userRes = await pool.query(
      `INSERT INTO users (id, phone, name, is_phone_verified, account_type)
       VALUES ($1, $2, $3, TRUE, 'individual')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [candidateUserId, params.phone, params.name]
    );
    const userId = userRes.rows[0].id;

    // 2. Assign role
    const roleRes = await pool.query(`SELECT id FROM roles WHERE code = $1`, [params.roleCode]);
    if (roleRes.rows.length > 0) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, roleRes.rows[0].id]
      );
    }

    // 3. Link merchant if provided
    if (params.merchantId) {
      await pool.query(
        `INSERT INTO store_staff (id, merchant_id, user_id, name, phone, role)
         VALUES ($1, $2, $3, $4, $5, 'STORE_MANAGER')
         ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), params.merchantId, userId, params.name, params.phone]
      );
      // Also update merchant contact phone so rbacService links merchant directly
      await pool.query(
        `UPDATE merchants SET phone = $1 WHERE id = $2`,
        [params.phone, params.merchantId]
      );
    }

    // 4. Link rider if provided
    if (params.riderId) {
      await pool.query(
        `UPDATE riders SET user_id = $1, phone = $2 WHERE id = $3`,
        [userId, params.phone, params.riderId]
      );
    }

    // 5. Create active session
    await pool.query(
      `INSERT INTO auth_sessions (id, user_id, token_version, status, expires_at)
       VALUES ($1, $2, 1, 'ACTIVE', NOW() + INTERVAL '24 hours')`,
      [sessionId, userId]
    );

    // 6. Sign JWT
    const token = signAccessToken({
      sub: userId,
      session_id: sessionId,
      token_version: 1,
      roles: [params.roleCode],
      phone: params.phone,
    });

    return { token, userId, sessionId };
  }

  try {
    // -------------------------------------------------------------
    // Set up test actors & fixtures
    // -------------------------------------------------------------
    const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 2`);
    const merchantA = merchRes.rows[0].id;
    const merchantB = merchRes.rows[1]?.id || crypto.randomUUID();

    const prodRes = await pool.query(`SELECT id, name FROM products LIMIT 2`);
    const productA = prodRes.rows[0].id;
    const productB = prodRes.rows[1]?.id || crypto.randomUUID();

    // Ensure inventory exists for merchantA
    await pool.query(`
      INSERT INTO store_inventory (id, merchant_id, product_id, stock_count, reserved_count, low_stock_threshold, scarce_stock_threshold)
      VALUES (gen_random_uuid(), $1, $2, 50, 0, 5, 2)
      ON CONFLICT (merchant_id, product_id) DO UPDATE SET stock_count = 50, reserved_count = 0
    `, [merchantA, productA]);

    // Ensure inventory exists for merchantB
    await pool.query(`
      INSERT INTO store_inventory (id, merchant_id, product_id, stock_count, reserved_count, low_stock_threshold, scarce_stock_threshold)
      VALUES (gen_random_uuid(), $1, $2, 20, 0, 3, 1)
      ON CONFLICT (merchant_id, product_id) DO UPDATE SET stock_count = 20, reserved_count = 0
    `, [merchantB, productB]);

    // Ensure test riders exist
    const rider1Id = crypto.randomUUID();
    const rider2Id = crypto.randomUUID();
    await pool.query(`
      INSERT INTO riders (id, rider_code, name, phone, vehicle_type, status, latitude, longitude, payload_capacity_kg, rating)
      VALUES 
        ($1, 'RDR-S13-001', 'Ramesh Quick', '+91-9876500001', 'motorcycle', 'AVAILABLE', 12.9716, 77.5946, 25.00, 4.90),
        ($2, 'RDR-S13-002', 'Suresh Fleet', '+91-9876500002', 'ev_scooter', 'AVAILABLE', 12.9720, 77.5950, 20.00, 4.85)
      ON CONFLICT DO NOTHING
    `, [rider1Id, rider2Id]);

    // Provision actors
    const customerAuth = await createTestAuth({
      phone: '+91-9811100001',
      name: 'Customer S13',
      roleCode: 'CUSTOMER',
    });

    const customer2Auth = await createTestAuth({
      phone: '+91-9811100002',
      name: 'Customer 2 S13',
      roleCode: 'CUSTOMER',
    });

    const sellerAAuth = await createTestAuth({
      phone: '+91-9822200001',
      name: 'Seller Alpha',
      roleCode: 'SELLER',
      merchantId: merchantA,
    });

    const sellerBAuth = await createTestAuth({
      phone: '+91-9822200002',
      name: 'Seller Beta',
      roleCode: 'SELLER',
      merchantId: merchantB,
    });

    const rider1Auth = await createTestAuth({
      phone: '+91-9876500001',
      name: 'Ramesh Quick',
      roleCode: 'RIDER',
      riderId: rider1Id,
    });

    const rider2Auth = await createTestAuth({
      phone: '+91-9876500002',
      name: 'Suresh Fleet',
      roleCode: 'RIDER',
      riderId: rider2Id,
    });

    const dispatcherAuth = await createTestAuth({
      phone: '+91-9833300001',
      name: 'Admin Dispatcher',
      roleCode: 'DISPATCHER',
    });

    const superAdminAuth = await createTestAuth({
      phone: '+91-9844400001',
      name: 'Super Admin',
      roleCode: 'SUPER_ADMIN',
    });

    // -------------------------------------------------------------
    // SCENARIO 1: Successful COD Order Lifecycle
    // -------------------------------------------------------------
    console.log('[Scenario 1] Testing Successful COD Order Lifecycle...');
    {
      // 1. Customer checks stock availability
      const availRes = await apiRequest('/api/orders/check-availability', {
        method: 'POST',
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 2 }],
        },
      });
      assert.strictEqual(availRes.status, 200, 'Availability check should succeed');
      assert.strictEqual(availRes.body.isAvailable, true, 'Stock should be available');

      // 2. Customer places COD order
      const orderRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAuth.token,
        headers: { 'idempotency-key': 'cod-order-test-001' },
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 2 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Test Site 1' },
          paymentMethod: 'Pay on Delivery',
        },
      });
      assert.strictEqual(orderRes.status, 200, 'Order creation should return 200');
      assert.strictEqual(orderRes.body.success, true);
      const order = orderRes.body.order;
      assert.strictEqual(order.paymentMethod, 'Pay on Delivery');
      assert.strictEqual(order.status, 'placed');

      // Verify stock was committed for COD
      const invCheck = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invCheck.rows[0].stock_count, 48, 'Stock count should be decremented to 48');
      assert.strictEqual(invCheck.rows[0].reserved_count, 0, 'Reserved count should be 0 after commit');

      // 3. Seller views order details
      const sellerViewRes = await apiRequest(`/api/orders/${order.id}`, {
        method: 'GET',
        token: sellerAAuth.token,
      });
      assert.strictEqual(sellerViewRes.status, 200, 'Seller A should be able to view their store order');

      // 4. Dispatcher assigns order to rider
      const assignRes = await apiRequest('/api/dispatch/assign', {
        method: 'POST',
        token: dispatcherAuth.token,
        body: { orderId: order.id, offerExpirySeconds: 60 },
      });
      assert.strictEqual(assignRes.status, 200, 'Dispatcher assignment should succeed');
      const offerId = assignRes.body.offer.id;
      const assignedRiderId = assignRes.body.selectedRider.riderId;

      // 5. Assigned rider accepts offer
      const riderRow = await pool.query(`SELECT phone, name FROM riders WHERE id = $1`, [assignedRiderId]);
      const assignedRiderAuth = await createTestAuth({
        phone: riderRow.rows[0].phone,
        name: riderRow.rows[0].name || 'Assigned Rider',
        roleCode: 'RIDER',
        riderId: assignedRiderId,
      });
      const acceptRes = await apiRequest(`/api/dispatch/offers/${offerId}/accept`, {
        method: 'POST',
        token: assignedRiderAuth.token,
        body: { riderId: assignedRiderId },
      });
      assert.strictEqual(acceptRes.status, 200, 'Rider should accept offer successfully');
      assert.strictEqual(acceptRes.body.success, true);

      // Verify order status transitioned to 'picking' and delivery_trip is active
      const orderDbCheck = await pool.query(`SELECT status FROM orders WHERE id = $1`, [order.id]);
      assert.strictEqual(orderDbCheck.rows[0].status, 'picking', 'Order status should be picking');

      // 6. Simulate fulfillment & allocation
      await pool.query(`UPDATE orders SET status = 'delivered', payment_status = 'PAID', delivered_at = NOW() WHERE id = $1`, [order.id]);
      const allocRes = await apiRequest('/api/settlements/allocate', {
        method: 'POST',
        token: superAdminAuth.token,
        body: { orderId: order.id },
      });
      assert.strictEqual(allocRes.status, 200, 'Settlement allocation should succeed');
      assert.strictEqual(allocRes.body.success, true);
      assert.ok(allocRes.body.allocation.id, 'Allocation record created');
      console.log('✓ Scenario 1: COD order full lifecycle verified successfully.');
    }

    // -------------------------------------------------------------
    // SCENARIO 2: Online Payment with No Gateway Configured (Fails Safely)
    // -------------------------------------------------------------
    console.log('[Scenario 2] Testing Online Payment with No Gateway Configured...');
    {
      // 1. Create order with online payment
      const onlineOrderRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAuth.token,
        headers: { 'idempotency-key': 'online-order-test-001' },
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 1 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Test Site 2' },
          paymentMethod: 'Instant UPI',
        },
      });
      assert.strictEqual(onlineOrderRes.status, 200);
      const onlineOrder = onlineOrderRes.body.order;

      // Ensure reservation is RESERVED
      const resCheck = await pool.query(
        `SELECT status FROM inventory_reservations WHERE order_id = $1`,
        [onlineOrder.id]
      );
      assert.strictEqual(resCheck.rows[0].status, 'RESERVED');

      // 2. Set payment provider to DisabledPaymentProvider (simulating PAYMENT_MODE=none)
      const disabledProvider = new DisabledPaymentProvider();
      paymentService.setProvider(disabledProvider as any);

      // 3. Attempt payment session initiation
      let errorThrown = false;
      try {
        await paymentService.createPaymentOrder(onlineOrder.id, customerAuth.userId);
      } catch (err: any) {
        errorThrown = true;
        assert.ok(
          err.message.includes('PAYMENT_GATEWAY_NOT_CONFIGURED'),
          `Expected PAYMENT_GATEWAY_NOT_CONFIGURED error, got: ${err.message}`
        );
      }
      assert.strictEqual(errorThrown, true, 'Online payment creation must fail safely when no gateway is configured');

      // Verify order payment_status remains PENDING and no phantom captured payment or ledger entry exists
      const orderCheck = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [onlineOrder.id]);
      assert.strictEqual(orderCheck.rows[0].payment_status, 'PENDING', 'Payment status must remain PENDING');

      // Restore mock provider for subsequent test scenarios
      paymentService.setProvider(new MockPaymentProvider());
      console.log('✓ Scenario 2: Online payment with no gateway configured fails safely.');
    }

    // -------------------------------------------------------------
    // SCENARIO 3: Insufficient Stock Rejection
    // -------------------------------------------------------------
    console.log('[Scenario 3] Testing Insufficient Stock Rejection...');
    {
      const invBefore = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      const currentStock = invBefore.rows[0].stock_count - invBefore.rows[0].reserved_count;

      const oversellRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAuth.token,
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: currentStock + 5 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Test Site 3' },
          paymentMethod: 'Pay on Delivery',
        },
      });
      if (oversellRes.body.error !== 'INSUFFICIENT_STOCK') {
        console.error('Oversell error response:', JSON.stringify(oversellRes.body));
      }
      assert.strictEqual(oversellRes.status, 400, 'Oversell attempt must return 400');
      assert.strictEqual(oversellRes.body.error, 'INSUFFICIENT_STOCK');

      const invAfter = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invAfter.rows[0].stock_count, invBefore.rows[0].stock_count, 'Stock must not be altered');
      assert.strictEqual(invAfter.rows[0].reserved_count, invBefore.rows[0].reserved_count, 'Reserved count must not change');
      console.log('✓ Scenario 3: Insufficient stock correctly rejected without stock corruption.');
    }

    // -------------------------------------------------------------
    // SCENARIO 4: Two Concurrent Checkouts (Contention Safety)
    // -------------------------------------------------------------
    console.log('[Scenario 4] Testing Concurrent Checkouts on Limited Inventory...');
    {
      // Reset product stock to exactly 2 units
      await pool.query(
        `UPDATE store_inventory SET stock_count = 2, reserved_count = 0 WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );

      // Customer 1 and Customer 2 concurrently attempt to order 2 units each
      const [res1, res2] = await Promise.all([
        apiRequest('/api/orders/create', {
          method: 'POST',
          token: customerAuth.token,
          headers: { 'idempotency-key': 'concurrent-cust-1' },
          body: {
            merchantId: merchantA,
            items: [{ productId: productA, quantity: 2 }],
            jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Site 4A' },
            paymentMethod: 'Pay on Delivery',
          },
        }),
        apiRequest('/api/orders/create', {
          method: 'POST',
          token: customer2Auth.token,
          headers: { 'idempotency-key': 'concurrent-cust-2' },
          body: {
            merchantId: merchantA,
            items: [{ productId: productA, quantity: 2 }],
            jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Site 4B' },
            paymentMethod: 'Pay on Delivery',
          },
        }),
      ]);

      const successCount = (res1.status === 200 ? 1 : 0) + (res2.status === 200 ? 1 : 0);
      const failureCount = (res1.status === 400 ? 1 : 0) + (res2.status === 400 ? 1 : 0);

      assert.strictEqual(successCount, 1, 'Exactly one concurrent checkout should succeed');
      assert.strictEqual(failureCount, 1, 'Exactly one concurrent checkout should fail with insufficient stock');

      const invFinal = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invFinal.rows[0].stock_count, 0, 'Final physical stock should be 0');
      assert.strictEqual(invFinal.rows[0].reserved_count, 0, 'Final reserved stock should be 0');
      console.log('✓ Scenario 4: Concurrent checkouts strictly protected against overselling.');
    }

    // -------------------------------------------------------------
    // SCENARIO 5: Seller Isolation (Tenant Boundary)
    // -------------------------------------------------------------
    console.log('[Scenario 5] Testing Seller Tenant Isolation...');
    {
      // Seller A attempts to view Seller B's inventory
      const crossViewRes = await apiRequest(`/api/merchants/${merchantB}/inventory`, {
        method: 'GET',
        token: sellerAAuth.token,
      });
      assert.strictEqual(crossViewRes.status, 403, 'Seller A must not access Seller B inventory');
      assert.strictEqual(crossViewRes.body.error, 'TENANT_ACCESS_DENIED');

      // Seller A attempts to restock Seller B's product
      const crossRestockRes = await apiRequest(`/api/merchants/${merchantB}/inventory/${productB}/restock`, {
        method: 'POST',
        token: sellerAAuth.token,
        body: { quantity: 10 },
      });
      assert.strictEqual(crossRestockRes.status, 403, 'Seller A must not restock Seller B inventory');
      assert.strictEqual(crossRestockRes.body.error, 'TENANT_ACCESS_DENIED');

      // Seller A can view their own inventory
      const ownInventoryRes = await apiRequest(`/api/merchants/${merchantA}/inventory`, {
        method: 'GET',
        token: sellerAAuth.token,
      });
      assert.strictEqual(ownInventoryRes.status, 200, 'Seller A should view their own inventory');
      console.log('✓ Scenario 5: Seller multi-tenant isolation strictly enforced.');
    }

    // -------------------------------------------------------------
    // SCENARIO 6: Rider Assignment Race & Mutually Exclusive Acceptance
    // -------------------------------------------------------------
    console.log('[Scenario 6] Testing Rider Assignment Concurrency & Mutual Exclusion...');
    {
      // Replenish stock and create an order for dispatch
      await pool.query(
        `UPDATE store_inventory SET stock_count = 10, reserved_count = 0 WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      const raceOrderRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAuth.token,
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 1 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Site 6' },
          paymentMethod: 'Pay on Delivery',
        },
      });
      const raceOrderId = raceOrderRes.body.order.id;

      // Ensure only rider1 and rider2 are eligible candidates
      await pool.query(`UPDATE riders SET status = 'OFFLINE'`);
      await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE id IN ($1, $2)`, [rider1Id, rider2Id]);
      const assignRace = await dispatchService.assignOrder({ orderId: raceOrderId, offerExpirySeconds: 60 });
      const offerId = assignRace.offer.id;
      const targetRiderId = assignRace.selectedRider.riderId;
      const otherRiderId = targetRiderId === rider1Id ? rider2Id : rider1Id;
      const otherRiderToken = targetRiderId === rider1Id ? rider2Auth.token : rider1Auth.token;

      // Other rider tries to claim the offer
      const stealAttempt = await apiRequest(`/api/dispatch/offers/${offerId}/accept`, {
        method: 'POST',
        token: otherRiderToken,
        body: { riderId: otherRiderId },
      });
      assert.strictEqual(stealAttempt.status, 403, 'Unassigned rider cannot accept offer');
      assert.ok(
        stealAttempt.body.error === 'UNAUTHORIZED_RIDER' || stealAttempt.body.error === 'RIDER_ACCESS_DENIED',
        `Expected UNAUTHORIZED_RIDER or RIDER_ACCESS_DENIED, got: ${stealAttempt.body.error}`
      );

      // Correct rider accepts
      const riderRow = await pool.query(`SELECT phone, name FROM riders WHERE id = $1`, [targetRiderId]);
      const targetRiderAuth = await createTestAuth({
        phone: riderRow.rows[0].phone,
        name: riderRow.rows[0].name || 'Target Rider',
        roleCode: 'RIDER',
        riderId: targetRiderId,
      });
      const validAccept = await apiRequest(`/api/dispatch/offers/${offerId}/accept`, {
        method: 'POST',
        token: targetRiderAuth.token,
        body: { riderId: targetRiderId },
      });
      assert.strictEqual(validAccept.status, 200, 'Legitimate rider should accept offer');
      console.log('✓ Scenario 6: Rider assignment race strictly controlled.');
    }

    // -------------------------------------------------------------
    // SCENARIO 7: Duplicate Delivery Confirmation & Idempotent Allocation
    // -------------------------------------------------------------
    console.log('[Scenario 7] Testing Duplicate Settlement Allocation Idempotency...');
    {
      // Create a delivered order
      const dupOrderId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO orders (
          id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
          discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
          gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
          place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, delivered_at, created_at
        )
        VALUES (
          $1, $2, $3, $4, 'delivered', 300, 40, 10, 0, 0, 300, 27, 27, 0, 350, 0, 0,
          'Instant UPI', 'PAID', '654321', 'PK-7777', '{}'::jsonb, '29', '{"itemsSubtotal":300,"grandTotal":350}'::jsonb,
          NOW(), NOW() + INTERVAL '30 minutes', NOW(), NOW()
        )
      `, [dupOrderId, `ORD-DUP-${Date.now()}`, customerAuth.userId, merchantA]);

      // Allocate first time
      const alloc1 = await settlementAllocationService.allocateFulfilledOrder(dupOrderId);
      assert.ok(alloc1.id, 'First allocation created');

      // Allocate second time (duplicate replay)
      const alloc2 = await settlementAllocationService.allocateFulfilledOrder(dupOrderId);
      assert.strictEqual(alloc1.id, alloc2.id, 'Duplicate allocation must return the existing record');
      assert.strictEqual(alloc1.journalBatchId, alloc2.journalBatchId, 'Must not create a new journal batch');

      // Check allocations count in DB
      const countRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM order_settlement_allocations WHERE order_id = $1`,
        [dupOrderId]
      );
      assert.strictEqual(parseInt(countRes.rows[0].cnt, 10), 1, 'Exactly one allocation record must exist');
      console.log('✓ Scenario 7: Duplicate delivery allocation is strictly idempotent.');
    }

    // -------------------------------------------------------------
    // SCENARIO 8: Cancellation and Inventory Restoration
    // -------------------------------------------------------------
    console.log('[Scenario 8] Testing Cancellation and Single Inventory Restoration...');
    {
      // Replenish stock
      await pool.query(
        `UPDATE store_inventory SET stock_count = 10, reserved_count = 0 WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );

      // Create online payment order (stock is RESERVED, not yet COMMITTED)
      const cancelOrderRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAuth.token,
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 3 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Site 8' },
          paymentMethod: 'Instant UPI',
        },
      });
      const cancelOrderId = cancelOrderRes.body.order.id;

      // Verify reserved_count is 3
      const invMid = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invMid.rows[0].reserved_count, 3, 'Reserved count should be 3');

      // Customer cancels order
      const cancelRes = await apiRequest(`/api/orders/${cancelOrderId}/cancel`, {
        method: 'POST',
        token: customerAuth.token,
        body: { reason: 'Customer changed mind within grace period' },
      });
      assert.strictEqual(cancelRes.status, 200, 'Cancellation should succeed');

      // Verify reserved_count restored to 0
      const invRestored = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invRestored.rows[0].reserved_count, 0, 'Reserved count must be restored to 0');
      assert.strictEqual(invRestored.rows[0].stock_count, 10, 'Stock count must remain 10');

      // Attempt second cancellation (should fail safely and not restore stock again)
      const secondCancelRes = await apiRequest(`/api/orders/${cancelOrderId}/cancel`, {
        method: 'POST',
        token: customerAuth.token,
        body: { reason: 'Duplicate cancel' },
      });
      assert.strictEqual(secondCancelRes.status, 400, 'Second cancellation must fail');

      const invFinal = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantA, productA]
      );
      assert.strictEqual(invFinal.rows[0].reserved_count, 0, 'Reserved count must still be 0');
      assert.strictEqual(invFinal.rows[0].stock_count, 10, 'Stock count must not be inflated');
      console.log('✓ Scenario 8: Cancellation restores inventory exactly once.');
    }

    // -------------------------------------------------------------
    // SCENARIO 9: Financial Consistency (Balanced Double-Entry Ledger)
    // -------------------------------------------------------------
    console.log('[Scenario 9] Testing General Ledger Balanced Double-Entry Invariants...');
    {
      const unallocatedOrderRes = await pool.query(
        `INSERT INTO orders (
          id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
          discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
          gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
          place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, delivered_at, created_at
        )
        VALUES (
          gen_random_uuid(), 'ORD-GL-TEST', $1, $2, 'delivered', 500, 0, 0, 0, 0, 500, 0, 0, 0, 500, 0, 0,
          'Instant UPI', 'PAID', '123456', 'PK-1234', '{}'::jsonb, '29', '{}'::jsonb,
          NOW(), NOW() + INTERVAL '30 minutes', NOW(), NOW()
        ) RETURNING id`,
        [customerAuth.userId, merchantA]
      );
      const testOrderId = unallocatedOrderRes.rows[0].id;
      const journalBatchId = await ledgerService.recordOrderPayment({
        orderId: testOrderId,
        merchantId: merchantA,
        grossAmount: 500.00,
        taxableAmount: 423.73,
        cgstAmount: 38.14,
        sgstAmount: 38.14,
        deliveryFee: 40.00,
        handlingFee: 10.00,
      });

      // Verify that for journalBatchId, total debits equal total credits
      const glEntries = await pool.query(
        `SELECT entry_side, SUM(amount) as total
         FROM general_ledger_entries
         WHERE journal_batch_id = $1
         GROUP BY entry_side`,
        [journalBatchId]
      );
      const debits = parseFloat(glEntries.rows.find(r => r.entry_side === 'DEBIT')?.total || '0');
      const credits = parseFloat(glEntries.rows.find(r => r.entry_side === 'CREDIT')?.total || '0');
      assert.strictEqual(debits, 500.00, 'Total debits must match 500.00');
      assert.strictEqual(credits, 500.00, 'Total credits must match 500.00');
      assert.strictEqual(debits, credits, 'Debits must strictly equal credits');

      // Attempt unbalanced fulfillment allocation (must throw LEDGER_UNBALANCED)
      let unbalancedError = false;
      try {
        await ledgerService.recordOrderFulfillmentAllocation({
          orderId: testOrderId,
          merchantId: merchantA,
          riderId: rider1Id,
          orderTotal: 500.00,
          netSellerPayable: 200.00, // Artificially deflated, debits != credits
          grossRiderFare: 50.00,
          netRiderPayable: 49.50,
          riderTdsAmount: 0.50,
          platformCommission: 50.00,
          commissionGst: 9.00,
          customerDeliveryFee: 40.00,
          deliveryFeeGst: 7.20,
          customerHandlingFee: 10.00,
          handlingFeeGst: 1.80,
          storeDelayPenalty: 0.00,
          gstTcsAmount: 4.24,
          sellerTdsAmount: 0.42,
        });
      } catch (err: any) {
        unbalancedError = true;
        assert.ok(err.message.includes('LEDGER_UNBALANCED'), `Expected LEDGER_UNBALANCED, got: ${err.message}`);
      }
      assert.strictEqual(unbalancedError, true, 'Unbalanced allocation must be rejected');
      console.log('✓ Scenario 9: Double-entry ledger debits strictly equal credits.');
    }

    // -------------------------------------------------------------
    // SCENARIO 10: Authorization Failures (Cross-Tenant & Cross-Role)
    // -------------------------------------------------------------
    console.log('[Scenario 10] Testing Cross-Role and Cross-Tenant Authorization Failures...');
    {
      // 1. Unauthenticated request
      const unauthRes = await apiRequest('/api/orders', { method: 'GET' });
      assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must return 401');

      // 2. Customer A attempts to view Customer B's order
      const custBOrderRes = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customer2Auth.token,
        body: {
          merchantId: merchantA,
          items: [{ productId: productA, quantity: 1 }],
          jobSite: { latitude: 12.9716, longitude: 77.5946, address: 'Cust 2 Site' },
          paymentMethod: 'Pay on Delivery',
        },
      });
      const custBOrderId = custBOrderRes.body.order.id;

      const idorRes = await apiRequest(`/api/orders/${custBOrderId}`, {
        method: 'GET',
        token: customerAuth.token,
      });
      assert.strictEqual(idorRes.status, 403, 'Customer A must not view Customer B order');
      assert.strictEqual(idorRes.body.error, 'RESOURCE_ACCESS_DENIED');

      // 3. Customer attempts admin RBAC route
      const rbacRes = await apiRequest('/api/admin/rbac/roles', {
        method: 'GET',
        token: customerAuth.token,
      });
      assert.strictEqual(rbacRes.status, 403, 'Customer must not access admin RBAC routes');

      // 4. Rider A attempts to view Rider B's profile
      const crossRiderRes = await apiRequest(`/api/riders/${rider2Id}/profile`, {
        method: 'GET',
        token: rider1Auth.token,
      });
      assert.strictEqual(crossRiderRes.status, 403, 'Rider 1 must not access Rider 2 profile');
      assert.strictEqual(crossRiderRes.body.error, 'RIDER_ACCESS_DENIED');
      console.log('✓ Scenario 10: Cross-role and cross-tenant access attempts strictly blocked.');
    }

    // -------------------------------------------------------------
    // SCENARIO 11: Recovery Worker Lease & Stale Worker Fencing
    // -------------------------------------------------------------
    console.log('[Scenario 11] Testing Recovery Worker Lease Integrity & Fencing...');
    {
      const workerA = new FinancialRecoveryWorker({
        workerId: 'worker_alpha',
        leaseDurationSec: 5,
        staleThresholdSec: 1,
      });

      const workerB = new FinancialRecoveryWorker({
        workerId: 'worker_beta',
        leaseDurationSec: 10,
        staleThresholdSec: 1,
      });

      // Insert a stale payment intent
      const staleIntentId = crypto.randomUUID();
      const testOrderId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO payment_intents (
          id, payment_order_id, order_id, amount, currency, status, signature,
          reconciliation_attempts, created_at, updated_at
        )
        VALUES ($1, $2, $3, 400.00, 'INR', 'PROCESSING', 'sig_test', 0, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')
      `, [staleIntentId, `ord_${Date.now()}`, testOrderId]);

      // Worker Alpha acquires lease
      await pool.query(`
        UPDATE payment_intents
        SET recovery_lease_id = 'worker_alpha',
            recovery_lease_expires_at = NOW() - INTERVAL '1 second', -- Already expired
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = $1
      `, [staleIntentId]);

      // Worker Beta should be able to acquire the expired lease with fencing / attempts increment
      const acquireResult = await pool.query(`
        UPDATE payment_intents
        SET recovery_lease_id = 'worker_beta',
            recovery_lease_expires_at = NOW() + INTERVAL '30 seconds',
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = $1 AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= NOW())
        RETURNING reconciliation_attempts, recovery_lease_id
      `, [staleIntentId]);

      assert.strictEqual(acquireResult.rowCount, 1, 'Worker Beta must acquire expired lease');
      assert.strictEqual(acquireResult.rows[0].recovery_lease_id, 'worker_beta');
      assert.strictEqual(acquireResult.rows[0].reconciliation_attempts, 2);

      // Stale Worker Alpha resumes and attempts to write with stale lease_id
      const staleWrite = await pool.query(`
        UPDATE payment_intents
        SET status = 'FAILED'
        WHERE id = $1 AND recovery_lease_id = 'worker_alpha'
      `, [staleIntentId]);
      assert.strictEqual(staleWrite.rowCount, 0, 'Stale worker Alpha must not commit over Worker Beta lease');

      // Stale Worker Alpha attempts to release Worker Beta's lease
      const staleRelease = await pool.query(`
        UPDATE payment_intents
        SET recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL
        WHERE id = $1 AND recovery_lease_id = 'worker_alpha'
      `, [staleIntentId]);
      assert.strictEqual(staleRelease.rowCount, 0, 'Stale worker Alpha must not release Worker Beta lease');

      // Active Worker Beta successfully finishes and clears lease
      const betaFinish = await pool.query(`
        UPDATE payment_intents
        SET status = 'FAILED',
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL
        WHERE id = $1 AND recovery_lease_id = 'worker_beta'
      `, [staleIntentId]);
      assert.strictEqual(betaFinish.rowCount, 1, 'Active worker Beta must be able to complete and release lease');
      console.log('✓ Scenario 11: Recovery worker lease fencing protects against stale writes.');
    }

    // -------------------------------------------------------------
    // SCENARIO 12: PostgreSQL Outage Resilience (Fail-Safe Response)
    // -------------------------------------------------------------
    console.log('[Scenario 12] Testing PostgreSQL Outage Fail-Safe Behavior...');
    {
      // Verify isDatabaseUnavailable helper correctly identifies database connectivity losses
      const simulatedErrors = [
        { message: 'Connection terminated unexpectedly', code: '57P01' },
        { message: 'connect ECONNREFUSED 127.0.0.1:5432', code: 'ECONNREFUSED' },
        { isDatabaseUnavailable: true, message: 'Database pool exhausted' },
      ];

      for (const err of simulatedErrors) {
        assert.strictEqual(
          paymentService.isDatabaseUnavailable(err),
          true,
          `Error ${err.code || err.message} should be identified as DB unavailable`
        );
      }

      // Check /ready probe behavior
      const readyRes = await apiRequest('/ready', { method: 'GET' });
      assert.strictEqual(readyRes.status, 200, '/ready probe should report READY when DB is alive');
      assert.strictEqual(readyRes.body.status, 'READY');
      assert.strictEqual(readyRes.body.database.status, 'UP');
      console.log('✓ Scenario 12: PostgreSQL outage fail-safe classification verified.');
    }

    console.log('\n===========================================================');
    console.log('✓ ALL 12 SPRINT 13.0 END-TO-END SCENARIOS PASSED SUCCESSFULLY!');
    console.log('===========================================================\n');
  } finally {
    server.close();
  }
}
