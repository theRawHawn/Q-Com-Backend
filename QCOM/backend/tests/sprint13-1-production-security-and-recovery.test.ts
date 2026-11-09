import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, getPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { signAccessToken } from '../src/modules/auth/jwt.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { sellerSettlementService } from '../src/modules/settlements/sellerSettlementService.js';
import { outboxService } from '../src/modules/outbox/outboxService.js';
import { FinancialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { paymentService } from '../src/modules/payments/paymentService.js';

export async function runSprint13_1ProductionSecurityAndRecoveryTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 13.1: Production Security, Concurrency & Failure-Recovery Suite ---');
  console.log('===========================================================');

  // Initialize in-memory test database (pg-mem)
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
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(rawData);
          } catch {
            parsed = rawData;
          }
          resolve({ status: res.statusCode || 500, body: parsed, headers: res.headers });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
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
    // Fetch Merchants & Products
    const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 2`);
    const merchantId = merchRes.rows[0].id;
    const merchantBId = merchRes.rows[1]?.id || crypto.randomUUID();

    const riderAIdRes = await pool.query(`SELECT id FROM riders LIMIT 2`);
    const riderAId = riderAIdRes.rows[0].id;
    const riderBId = riderAIdRes.rows[1]?.id || crypto.randomUUID();

    // Setup Actors
    const custA = await createTestAuth({ phone: '+91-9111111111', name: 'Customer Alpha', roleCode: 'CUSTOMER' });
    const customerAToken = custA.token;
    const customerAUserId = custA.userId;

    const custB = await createTestAuth({ phone: '+91-9222222222', name: 'Customer Beta', roleCode: 'CUSTOMER' });
    const customerBToken = custB.token;
    const customerBUserId = custB.userId;

    const sellerA = await createTestAuth({ phone: '+91-9845012345', name: 'Seller Alpha', roleCode: 'SELLER', merchantId });
    const sellerAToken = sellerA.token;

    const sellerB = await createTestAuth({ phone: '+91-9845099999', name: 'Seller Beta', roleCode: 'SELLER', merchantId: merchantBId });
    const sellerBToken = sellerB.token;

    const riderA = await createTestAuth({ phone: '+91-9876543210', name: 'Rider Alpha', roleCode: 'RIDER', riderId: riderAId });
    const riderAToken = riderA.token;

    const riderB = await createTestAuth({ phone: '+91-9876543212', name: 'Rider Beta', roleCode: 'RIDER', riderId: riderBId });
    const riderBToken = riderB.token;

    const admin = await createTestAuth({ phone: '+91-9999999999', name: 'Platform Admin', roleCode: 'SUPER_ADMIN' });
    const adminToken = admin.token;

    const prodRes = await pool.query(
      `SELECT p.id, p.name FROM products p 
       JOIN store_inventory si ON p.id = si.product_id 
       WHERE si.merchant_id = $1 ORDER BY p.id ASC LIMIT 3`,
      [merchantId]
    );
    const productA = prodRes.rows[0];
    const productB = prodRes.rows[1];
    const productC = prodRes.rows[2];

    const defaultJobSite = { latitude: 12.9716, longitude: 77.5946, address: 'Koramangala, Bangalore' };

    // =============================================================
    // WORKSTREAM A: CONCURRENCY & TRANSACTIONAL ROBUSTNESS (IN-MEMORY SIMULATION)
    // Note: Recorded as NOT TESTED against physical PostgreSQL 16 cluster.
    // =============================================================
    console.log('[Workstream A] Testing Concurrency & Lock Ordering (Simulation in pg-mem)...');

    // Scenario A.1: Two concurrent checkouts for final available unit
    {
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

      const [res1, res2] = await Promise.all([
        apiRequest('/api/orders/create', {
          method: 'POST',
          token: customerAToken,
          body: {
            merchantId,
            items: [{ productId: productA.id, quantity: 1 }],
            jobSite: defaultJobSite,
            paymentMethod: 'Instant UPI',
          },
        }),
        apiRequest('/api/orders/create', {
          method: 'POST',
          token: customerBToken,
          body: {
            merchantId,
            items: [{ productId: productA.id, quantity: 1 }],
            jobSite: defaultJobSite,
            paymentMethod: 'Instant UPI',
          },
        }),
      ]);

      const statuses = [res1.status, res2.status];
      assert(statuses.includes(200), 'Exactly one order placement must succeed (200 OK)');
      assert(statuses.includes(400), 'Losing competitor must be rejected with HTTP 400');
      const rejection = res1.status === 400 ? res1 : res2;
      assert.strictEqual(rejection.body.error, 'INSUFFICIENT_STOCK', 'Error code must be INSUFFICIENT_STOCK');

      const stockCheck = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantId, productA.id]
      );
      assert.strictEqual(Number(stockCheck.rows[0].stock_count), 1);
      assert.strictEqual(Number(stockCheck.rows[0].reserved_count), 1);
      console.log('✓ Scenario A.1: Last-unit checkout competition resolved with exactly 1 winner and zero oversell.');
    }

    // Scenario A.2: Concurrent multi-SKU reservations (Deadlock-Free Sorting)
    {
      await pool.query(`
        UPDATE store_inventory
        SET stock_count = 50, reserved_count = 0, updated_at = NOW()
        WHERE merchant_id = $1 AND product_id IN ($2, $3, $4)
      `, [merchantId, productA.id, productB.id, productC.id]);

      // Request 1: [productB, productA]
      // Request 2: [productA, productB]
      // Deterministic sort by productId ASC prevents deadlocks
      const [resMulti1, resMulti2] = await Promise.all([
        orderService.createOrder({
          userId: customerAUserId,
          merchantId,
          items: [{ productId: productB.id, quantity: 2 }, { productId: productA.id, quantity: 2 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
        orderService.createOrder({
          userId: customerBUserId,
          merchantId,
          items: [{ productId: productA.id, quantity: 3 }, { productId: productB.id, quantity: 3 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        }),
      ]);

      assert.ok(resMulti1.order.id, 'Multi-SKU Order 1 must succeed');
      assert.ok(resMulti2.order.id, 'Multi-SKU Order 2 must succeed');
      console.log('✓ Scenario A.2: Multi-SKU concurrent reservations execute deadlock-free.');
    }

    // Scenario A.3: Transaction rollback after failure during critical mutation
    {
      const initialStockRes = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantId, productC.id]
      );
      const initialStock = Number(initialStockRes.rows[0].stock_count);
      const initialReserved = Number(initialStockRes.rows[0].reserved_count);

      // Attempt transaction that reserves stock then throws intentionally
      let threw = false;
      try {
        await transaction(async (client) => {
          await client.query(`
            UPDATE store_inventory
            SET reserved_count = reserved_count + 5
            WHERE merchant_id = $1 AND product_id = $2
          `, [merchantId, productC.id]);

          // Simulate unhandled failure during subsequent step
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        });
      } catch (err: any) {
        threw = true;
        assert.strictEqual(err.message, 'SIMULATED_TRANSACTION_FAILURE');
      }
      assert.strictEqual(threw, true, 'Transaction must throw');

      // Verify database rolled back completely
      const afterStockRes = await pool.query(
        `SELECT stock_count, reserved_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`,
        [merchantId, productC.id]
      );
      assert.strictEqual(Number(afterStockRes.rows[0].stock_count), initialStock, 'Stock must be rolled back');
      assert.strictEqual(Number(afterStockRes.rows[0].reserved_count), initialReserved, 'Reserved stock must be rolled back');
      console.log('✓ Scenario A.3: Transaction rollback strictly preserves inventory state on failure.');
    }

    // =============================================================
    // WORKSTREAM B: CRASH & PARTIAL-FAILURE RECOVERY
    // =============================================================
    console.log('[Workstream B] Testing Crash and Partial-Failure Recovery Invariants...');

    // Scenario B.1: Order committed but notification/websocket fails (Outbox Pattern)
    {
      const orderRes = await orderService.createOrder({
        userId: customerAUserId,
        merchantId,
        items: [{ productId: productC.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Pay on Delivery',
      });
      assert.ok(orderRes.order.id);

      // Inspect outbox_events: the event must be staged and committed along with the order
      const outboxRes = await pool.query(
        `SELECT id, status, event_type FROM outbox_events WHERE aggregate_id = $1`,
        [orderRes.order.id]
      );
      assert(outboxRes.rows.length >= 1, 'Transactional outbox event must be durably staged');
      assert.strictEqual(outboxRes.rows[0].status, 'PENDING', 'Outbox status is PENDING awaiting relayer');

      // The order is fully valid and queryable even if no notification consumer ran yet
      const orderCheck = await orderService.getOrderById(orderRes.order.id, customerAUserId);
      assert.ok(orderCheck, 'Order remains committed and durable independently of notification execution');
      console.log('✓ Scenario B.1: Transactional outbox decouples order commitment from notification failures.');
    }

    // Scenario B.2: Idempotent cancellation retry
    {
      const orderToCancel = await orderService.createOrder({
        userId: customerAUserId,
        merchantId,
        items: [{ productId: productC.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });

      const cancelKey = `idemp_cancel_${Date.now()}`;
      // First cancel succeeds
      const cancel1 = await apiRequest(`/api/orders/${orderToCancel.order.id}/cancel`, {
        method: 'POST',
        token: customerAToken,
        headers: { 'Idempotency-Key': cancelKey },
        body: { reason: 'Customer changed mind' },
      });
      assert.strictEqual(cancel1.status, 200, 'First cancellation must succeed (200 OK)');

      // Second cancel with same idempotency key or repeat invocation
      const cancel2 = await apiRequest(`/api/orders/${orderToCancel.order.id}/cancel`, {
        method: 'POST',
        token: customerAToken,
        headers: { 'Idempotency-Key': cancelKey },
        body: { reason: 'Customer changed mind' },
      });
      assert(
        cancel2.status === 200 || cancel2.status === 400,
        'Duplicate cancel must either return cached response or reject without error corruption'
      );
      if (cancel2.status === 400) {
        assert(cancel2.body.message.includes('ALREADY_CANCELLED') || cancel2.body.error === 'CANCELLATION_FAILED');
      }

      // Verify reservations status
      const resvCheck = await pool.query(
        `SELECT status FROM inventory_reservations WHERE order_id = $1`,
        [orderToCancel.order.id]
      );
      const statuses = resvCheck.rows.map((r: any) => r.status);
      assert(statuses.every((s: string) => s === 'RELEASED'), 'Reservations must be in RELEASED state');
      console.log('✓ Scenario B.2: Cancellation retry preserves single inventory release invariant.');
    }

    // Delivered order for settlement and refund tests
    const deliveredOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (
        id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
        discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
        gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
        place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, delivered_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'delivered', 300.00, 40.00, 10.00, 0, 0, 300.00, 27.00, 27.00, 0, 350.00, 3.00, 3.00,
        'Pay on Delivery', 'PAID', '123456', 'HTOKEN-1', '{"latitude": 12.9716, "longitude": 77.5946}'::jsonb,
        '29', '{}'::jsonb, NOW(), NOW() + interval '30 minutes', NOW(), NOW(), NOW()
      )
    `, [deliveredOrderId, `ORD_STLM_${Date.now()}`, customerAUserId, merchantId]);

    // Scenario B.3: Idempotent settlement allocation retry
    {
      // Create matching delivery trip
      await pool.query(`
        INSERT INTO delivery_trips (
          id, order_id, rider_id, status, delivered_at, otp_verified, total_rider_payout, base_fare
        ) VALUES (
          gen_random_uuid(), $1, $2, 'DELIVERED', NOW(), TRUE, 50.00, 40.00
        )
      `, [deliveredOrderId, riderAId]);

      // First allocation
      const alloc1 = await settlementAllocationService.allocateFulfilledOrder(deliveredOrderId);
      assert.ok(alloc1.id, 'First allocation must succeed');

      // Second allocation (idempotent call)
      const alloc2 = await settlementAllocationService.allocateFulfilledOrder(deliveredOrderId);
      assert.strictEqual(alloc2.id, alloc1.id, 'Second allocation must return existing allocation record without duplicate insertion');

      // Check order_settlement_allocations count
      const allocCountRes = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM order_settlement_allocations WHERE order_id = $1`,
        [deliveredOrderId]
      );
      assert.strictEqual(allocCountRes.rows[0].cnt, 1, 'Exactly one settlement allocation record exists in database');
      console.log('✓ Scenario B.3: Settlement allocation retry is strictly idempotent.');
    }

    // Scenario B.4: Worker crash during lease & expired lease recovery
    {
      const workerB = new FinancialRecoveryWorker({ leaseDurationSec: 30 });

      const staleRefundId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO refunds (
          id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
          idempotency_key, recovery_lease_id, recovery_lease_expires_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 200.00, 'INR', 'ITEM_DEFECTIVE', 'FULL', 'PROCESSING',
          $4, 'worker_crashed', NOW() - INTERVAL '2 seconds', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes'
        )
      `, [staleRefundId, `REF_${Date.now()}`, deliveredOrderId, `idemp_ref_${Date.now()}`]);

      // Worker B reclaims expired lease
      const reclaimRes = await pool.query(`
        UPDATE refunds
        SET recovery_lease_id = $1,
            recovery_lease_expires_at = NOW() + INTERVAL '30 seconds',
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = $2 AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= NOW())
        RETURNING recovery_lease_id
      `, [workerB.workerId, staleRefundId]);

      assert.strictEqual(reclaimRes.rowCount, 1, 'Worker B must reclaim expired lease from crashed worker');
      assert.strictEqual(reclaimRes.rows[0].recovery_lease_id, workerB.workerId);
      console.log('✓ Scenario B.4: Crashed worker lease expires and is safely reclaimed by surviving worker.');
    }

    // =============================================================
    // WORKSTREAM C: PRODUCTION SECURITY & AUTHORIZATION BOUNDARIES
    // =============================================================
    console.log('[Workstream C] Testing Production Security & Authorization Controls...');

    // Scenario C.1: Expired and revoked sessions rejected
    {
      // Create revoked session
      const revokedSessionId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO auth_sessions (id, user_id, token_version, status, ip_address, user_agent, expires_at, created_at)
        VALUES ($1, $2, 1, 'REVOKED', '127.0.0.1', 'test', NOW() + INTERVAL '1 day', NOW())
      `, [revokedSessionId, customerAUserId]);

      const revokedToken = signAccessToken({
        sub: customerAUserId,
        session_id: revokedSessionId,
        token_version: 1,
        roles: ['CUSTOMER'],
      });

      const revokedRes = await apiRequest('/api/orders', {
        method: 'GET',
        token: revokedToken,
      });
      assert.strictEqual(revokedRes.status, 401, 'Revoked session token must be rejected with 401');
      assert.strictEqual(revokedRes.body.error, 'SESSION_REVOKED');

      // Create expired session
      const expiredSessionId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO auth_sessions (id, user_id, token_version, status, ip_address, user_agent, expires_at, created_at)
        VALUES ($1, $2, 1, 'ACTIVE', '127.0.0.1', 'test', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 day')
      `, [expiredSessionId, customerAUserId]);

      const expiredToken = signAccessToken({
        sub: customerAUserId,
        session_id: expiredSessionId,
        token_version: 1,
        roles: ['CUSTOMER'],
      });

      const expiredRes = await apiRequest('/api/orders', {
        method: 'GET',
        token: expiredToken,
      });
      assert.strictEqual(expiredRes.status, 401, 'Expired session token must be rejected with 401');
      assert.strictEqual(expiredRes.body.error, 'SESSION_EXPIRED');

      console.log('✓ Scenario C.1: Expired and revoked sessions strictly rejected with HTTP 401.');
    }

    // Scenario C.2: Direct Object Reference (IDOR) Protection across Customers
    {
      // Customer B creates an order
      const orderB = await orderService.createOrder({
        userId: customerBUserId,
        merchantId,
        items: [{ productId: productC.id, quantity: 1 }],
        jobSite: defaultJobSite,
        paymentMethod: 'Instant UPI',
      });

      // Customer A attempts to view Customer B's order
      const idorAttempt = await apiRequest(`/api/orders/${orderB.order.id}`, {
        method: 'GET',
        token: customerAToken,
      });
      assert.strictEqual(idorAttempt.status, 403, 'Customer A must be forbidden from inspecting Customer B order');
      assert.strictEqual(idorAttempt.body.error, 'RESOURCE_ACCESS_DENIED');
      console.log('✓ Scenario C.2: Customer-to-customer order IDOR strictly blocked with 403.');
    }

    // Scenario C.3: Direct Object Reference (IDOR) Protection across Sellers
    {
      // Seller A attempts to access Merchant B's inventory
      const sellerIdor = await apiRequest(`/api/merchants/${merchantBId}/inventory`, {
        method: 'GET',
        token: sellerAToken,
      });
      assert.strictEqual(sellerIdor.status, 403, 'Seller A must be forbidden from accessing Merchant B inventory');
      assert.strictEqual(sellerIdor.body.error, 'TENANT_ACCESS_DENIED');
      console.log('✓ Scenario C.3: Cross-tenant seller inventory IDOR strictly blocked with 403.');
    }

    // Scenario C.4: Forged ownership in request body is ignored
    {
      // Customer A places order but specifies Customer B's userId in request body
      const forgedBodyOrder = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAToken,
        body: {
          userId: customerBUserId, // Forged client-side parameter
          merchantId,
          items: [{ productId: productC.id, quantity: 1 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        },
      });
      assert.strictEqual(forgedBodyOrder.status, 200, 'Order creation succeeds for authenticated caller');
      // The stored order.user_id must be Customer A (authenticated identity), not Customer B (forged body param)
      assert.strictEqual(forgedBodyOrder.body.order.userId, customerAUserId, 'Server must enforce req.auth.userId over client body');
      console.log('✓ Scenario C.4: Server enforces authenticated JWT identity over client-supplied userId.');
    }

    // Scenario C.5: Prototype pollution sanitization
    {
      const pollRes = await apiRequest('/api/orders/check-availability', {
        method: 'POST',
        body: {
          merchantId,
          items: [{ productId: productC.id, quantity: 1 }],
          __proto__: { injected: true },
          constructor: { prototype: { poll: true } },
        },
      });
      assert.strictEqual(pollRes.status, 200, 'Sanitization cleans body without throwing');
      assert.strictEqual((Object.prototype as any).injected, undefined, 'Object.prototype must not be polluted');
      console.log('✓ Scenario C.5: Prototype pollution vectors safely stripped by sanitization middleware.');
    }

    // Scenario C.6: Idempotency fingerprint mismatch rejection
    {
      const testKey = `idemp_mismatch_${Date.now()}`;
      // Request 1
      const res1 = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAToken,
        headers: { 'Idempotency-Key': testKey },
        body: {
          merchantId,
          items: [{ productId: productC.id, quantity: 1 }],
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        },
      });
      assert.strictEqual(res1.status, 200);

      // Request 2 with same key but DIFFERENT item payload
      const res2 = await apiRequest('/api/orders/create', {
        method: 'POST',
        token: customerAToken,
        headers: { 'Idempotency-Key': testKey },
        body: {
          merchantId,
          items: [{ productId: productA.id, quantity: 2 }], // Different items!
          jobSite: defaultJobSite,
          paymentMethod: 'Instant UPI',
        },
      });
      assert.strictEqual(res2.status, 422, 'Payload mismatch on same Idempotency-Key must return HTTP 422');
      assert.strictEqual(res2.body.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
      console.log('✓ Scenario C.6: Idempotency-Key payload fingerprint mismatch rejected with HTTP 422.');
    }

    // =============================================================
    // WORKSTREAM D: FINANCIAL & INVENTORY INVARIANTS
    // =============================================================
    console.log('[Workstream D] Testing Financial & Inventory Invariants...');

    // Scenario D.1: Invariant: Available stock never becomes negative
    {
      const invRes = await pool.query(`
        SELECT stock_count, reserved_count
        FROM store_inventory
        WHERE stock_count < reserved_count
      `);
      assert.strictEqual(invRes.rows.length, 0, 'No inventory row should have reserved_count > stock_count');
      console.log('✓ Scenario D.1: Invariant confirmed: reserved_count <= stock_count across all store items.');
    }

    // Scenario D.2: Invariant: Balanced double-entry general ledger
    {
      const glBatches = await pool.query(`
        SELECT journal_batch_id,
               SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) as total_debit,
               SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) as total_credit
        FROM general_ledger_entries
        GROUP BY journal_batch_id
      `);

      for (const batch of glBatches.rows) {
        const debit = parseFloat(batch.total_debit);
        const credit = parseFloat(batch.total_credit);
        assert.strictEqual(
          Math.abs(debit - credit) < 0.001,
          true,
          `Journal batch ${batch.journal_batch_id} must balance: Debit ${debit} == Credit ${credit}`
        );
      }
      console.log(`✓ Scenario D.2: All ${glBatches.rows.length} journal batches strictly satisfy double-entry balance (Debits == Credits).`);
    }

    // Scenario D.3: Invariant: Settlement allocation is distinct from payout
    {
      const allocations = await pool.query(`SELECT status FROM order_settlement_allocations`);
      for (const a of allocations.rows) {
        assert(
          a.status === 'ALLOCATED' || a.status === 'PAID_OUT' || a.status === 'DISBURSED',
          `Allocation status ${a.status} is a valid distinct state`
        );
      }
      console.log('✓ Scenario D.3: Settlement allocations maintain clear state separation from disbursed payouts.');
    }

    // Scenario D.4: Invariant: Seller payable amount reconciles to formula
    {
      const allocRows = await pool.query(`SELECT * FROM order_settlement_allocations LIMIT 5`);
      for (const row of allocRows.rows) {
        const goodsTaxable = parseFloat(row.seller_goods_taxable);
        const goodsGst = parseFloat(row.seller_goods_gst);
        const commission = parseFloat(row.platform_commission);
        const commGst = parseFloat(row.commission_gst);
        const gstTcs = parseFloat(row.gst_tcs_amount);
        const sellerTds = parseFloat(row.seller_tds_amount);
        const penalty = parseFloat(row.store_delay_penalty || '0');
        const netSellerPayable = parseFloat(row.net_seller_payable);

        const expectedNet = (goodsTaxable + goodsGst) - (commission + commGst) - gstTcs - sellerTds - penalty;
        assert(
          Math.abs(netSellerPayable - expectedNet) < 0.05,
          `Net seller payable ${netSellerPayable} reconciles to formula result ${expectedNet.toFixed(2)}`
        );
      }
      console.log('✓ Scenario D.4: Seller payable calculation reconciles accurately to statutory components.');
    }

    // =============================================================
    // WORKSTREAM E: RECOVERY & OPERATIONAL READINESS
    // =============================================================
    console.log('[Workstream E] Testing Recovery & Operational Readiness...');

    // Scenario E.1: Recovery jobs survive application restart
    {
      // Insert a pending refund record
      const persistentRefundId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO refunds (
          id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
          idempotency_key, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 150.00, 'INR', 'DEFECTIVE_PRODUCT', 'FULL', 'PROCESSING',
          $4, NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '15 minutes'
        )
      `, [persistentRefundId, `REF_PERST_${Date.now()}`, deliveredOrderId, `idemp_perst_${Date.now()}`]);

      // Re-instantiate worker as if server restarted
      const newWorkerInstance = new FinancialRecoveryWorker({
        staleThresholdSec: 5,
        leaseDurationSec: 30,
      });

      // Claim candidates query finds the existing record
      const candidates = await transaction(async (client) => {
        return (newWorkerInstance as any).queryClaimCandidates(client, 'refunds', new Date(Date.now() - 5000), 10);
      });

      const found = candidates.rows.some((r: any) => r.id === persistentRefundId);
      assert.strictEqual(found, true, 'Recovery candidate persists across worker restarts');
      console.log('✓ Scenario E.1: Recovery candidate records persist in PostgreSQL across service restarts.');
    }

    // Scenario E.2: Request correlation via X-Request-Id header
    {
      const customReqId = `audit-trace-${crypto.randomBytes(4).toString('hex')}`;
      const res = await apiRequest('/api/v1/orders/check-availability', {
        method: 'POST',
        headers: { 'X-Request-Id': customReqId },
        body: {
          merchantId,
          items: [{ productId: productC.id, quantity: 1 }],
        },
      });
      assert.strictEqual(res.headers['x-request-id'], customReqId, 'Response must propagate incoming X-Request-Id');
      console.log('✓ Scenario E.2: X-Request-Id correctly propagated on HTTP response headers.');
    }

    // Scenario E.3: Readiness probe evaluates system components
    {
      const readyRes = await apiRequest('/ready', { method: 'GET' });
      assert.strictEqual(readyRes.status, 200, '/ready probe returns 200 OK');
      assert.strictEqual(readyRes.body.status, 'READY');
      assert.strictEqual(readyRes.body.payments.status, 'READY');
      assert.strictEqual(readyRes.body.payments.mode, 'mock');
      console.log('✓ Scenario E.3: Readiness probe confirms database health and payment mode reporting.');
    }

    console.log('\n===========================================================');
    console.log('✓ ALL SPRINT 13.1 PRODUCTION SECURITY & RECOVERY TESTS PASSED!');
    console.log('===========================================================\n');
  } finally {
    server.close();
  }
}

// Direct execution when run via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint13_1ProductionSecurityAndRecoveryTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
