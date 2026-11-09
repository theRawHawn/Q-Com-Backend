import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';

export async function testIdorAndResourceOwnership() {
  console.log('\n--- Running Resource Ownership & IDOR Protection Test Suite ---');
  const { pool } = createTestDatabase();
  setPool(pool);

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    const authService = new AuthService();

    // 1. Fetch Seeded Entities
    const merchARes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchBRes = await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-02'`);
    const merchantAId = merchARes.rows[0].id;
    const merchantBId = merchBRes.rows[0].id;

    const custARes = await pool.query(`SELECT id, phone FROM users WHERE phone = '+91-9876543210'`);
    const custBRes = await pool.query(`SELECT id, phone FROM users WHERE phone = '+91-9876543211'`);
    const customerA = custARes.rows[0];
    const customerB = custBRes.rows[0];

    const riderARes = await pool.query(`SELECT id, phone FROM riders WHERE rider_code = 'RIDER-77'`);
    const riderBRes = await pool.query(`SELECT id, phone FROM riders WHERE rider_code = 'RIDER-88'`);
    const riderA = riderARes.rows[0];
    const riderB = riderBRes.rows[0];

    // 2. Create Order A (Customer A @ Merchant A) and Order B (Customer B @ Merchant B)
    const orderARes = await pool.query(
      `INSERT INTO orders 
       (order_number, user_id, merchant_id, status, items_subtotal, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
       VALUES ('QC-BLR-ORD-001', $1, $2, 'placed', 500, 500, 590, 'Instant UPI', '1234', 'PK-9911', '{}', '{}', NOW() + interval '15 minutes')
       RETURNING id`,
      [customerA.id, merchantAId]
    );
    const orderAId = orderARes.rows[0].id;

    const orderBRes = await pool.query(
      `INSERT INTO orders 
       (order_number, user_id, merchant_id, status, items_subtotal, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
       VALUES ('QC-BLR-ORD-002', $1, $2, 'placed', 800, 800, 944, 'Instant UPI', '5678', 'PK-9922', '{}', '{}', NOW() + interval '15 minutes')
       RETURNING id`,
      [customerB.id, merchantBId]
    );
    const orderBId = orderBRes.rows[0].id;

    // Link Delivery Trip for Order A to Rider A
    await pool.query(
      `INSERT INTO delivery_trips (order_id, rider_id, status, total_rider_payout)
       VALUES ($1, $2, 'ACCEPTED', 65.00)`,
      [orderAId, riderA.id]
    );

    // Link Delivery Trip for Order B to Rider B
    await pool.query(
      `INSERT INTO delivery_trips (order_id, rider_id, status, total_rider_payout)
       VALUES ($1, $2, 'ACCEPTED', 85.00)`,
      [orderBId, riderB.id]
    );

    // 3. Authenticate Actors
    // (A) Seller A (Owner of Merchant A)
    const sellerAOtp = await authService.requestOtp('+91-9845012345', 'LOGIN', '127.0.0.1', pool);
    const sellerASession = await authService.verifyOtp('+91-9845012345', sellerAOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);

    // (B) Seller B (Owner of Merchant B)
    const sellerBOtp = await authService.requestOtp('+91-9845099999', 'LOGIN', '127.0.0.1', pool);
    const sellerBSession = await authService.verifyOtp('+91-9845099999', sellerBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);

    // (C) Customer A
    const custAOtp = await authService.requestOtp(customerA.phone, 'LOGIN', '127.0.0.1', pool);
    const custASession = await authService.verifyOtp(customerA.phone, custAOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', undefined, pool);

    // (D) Customer B
    const custBOtp = await authService.requestOtp(customerB.phone, 'LOGIN', '127.0.0.1', pool);
    const custBSession = await authService.verifyOtp(customerB.phone, custBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', undefined, pool);

    // (E) Rider A
    const riderAOtp = await authService.requestOtp('+91-9812345678', 'LOGIN', '127.0.0.1', pool);
    const riderASession = await authService.verifyOtp('+91-9812345678', riderAOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'DeliveryApp', undefined, pool);

    // (F) Super Admin
    const adminSession = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminPortal', pool);

    const app = createApp();

    // Helper for making authenticated requests against Express app
    async function makeRequest(path: string, token: string) {
      return new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = {
          method: 'GET',
          url: path,
          originalUrl: path,
          path: path.split('?')[0],
          headers: {
            authorization: `Bearer ${token}`,
            'user-agent': 'TestRunner',
          },
          params: {},
          query: {},
          body: {},
          ip: '127.0.0.1',
          socket: { remoteAddress: '127.0.0.1' },
          baseUrl: '',
        };

        const res: any = {
          statusCode: 200,
          _headers: {},
          setHeader(name: string, val: string) { this._headers[name] = val; },
          status(code: number) { this.statusCode = code; return this; },
          json(data: any) { resolve({ status: this.statusCode, body: data }); },
        };

        (app as any).handle(req, res, () => {
          resolve({ status: 404, body: { error: 'ROUTE_NOT_FOUND' } });
        });
      });
    }

    // =========================================================================
    // INVARIANT 1: SELLER LOGGED IN ≠ ACCESS TO OTHER SELLERS' INVENTORIES
    // =========================================================================
    console.log('[IDOR Test 1] Testing Merchant Inventory Tenant Isolation...');

    // Seller A accessing Merchant A inventory -> ALLOWED (200)
    const merchAResponse = await makeRequest(`/api/v1/merchants/${merchantAId}/inventory`, sellerASession.accessToken);
    assert.equal(merchAResponse.status, 200, 'Seller A must be able to view their own store inventory');
    assert.ok(merchAResponse.body.inventory.length >= 1);

    // Seller A attempting to access Merchant B inventory -> FORBIDDEN (403)
    const merchBResponse = await makeRequest(`/api/v1/merchants/${merchantBId}/inventory`, sellerASession.accessToken);
    assert.equal(merchBResponse.status, 403, 'Seller A MUST NOT access Merchant B store inventory');
    assert.equal(merchBResponse.body.error, 'TENANT_ACCESS_DENIED');
    console.log('✓ Cross-merchant inventory access correctly blocked (403 TENANT_ACCESS_DENIED)');

    // =========================================================================
    // INVARIANT 2: SELLER LOGGED IN ≠ ACCESS TO OTHER MERCHANTS' ORDERS
    // =========================================================================
    console.log('[IDOR Test 2] Testing Seller Order Scope Enforcement...');

    // Seller A accessing Order A (Merchant A order) -> ALLOWED (200)
    const sellerOrderARes = await makeRequest(`/api/v1/orders/${orderAId}`, sellerASession.accessToken);
    assert.equal(sellerOrderARes.status, 200, 'Seller A must be able to view orders for Merchant A');

    // Seller A attempting to access Order B (Merchant B order) -> FORBIDDEN (403)
    const sellerOrderBRes = await makeRequest(`/api/v1/orders/${orderBId}`, sellerASession.accessToken);
    assert.equal(sellerOrderBRes.status, 403, 'Seller A MUST NOT access orders belonging to Merchant B');
    assert.equal(sellerOrderBRes.body.error, 'RESOURCE_ACCESS_DENIED');
    console.log('✓ Cross-merchant order access correctly blocked (403 RESOURCE_ACCESS_DENIED)');

    // =========================================================================
    // INVARIANT 3: CUSTOMER A CANNOT ACCESS CUSTOMER B ORDERS
    // =========================================================================
    console.log('[IDOR Test 3] Testing Customer Order Ownership Enforcement...');

    // Customer A accessing Order A -> ALLOWED (200)
    const custOrderARes = await makeRequest(`/api/v1/orders/${orderAId}`, custASession.accessToken);
    assert.equal(custOrderARes.status, 200, 'Customer A can view their own order');

    // Customer A attempting to access Customer B Order B -> FORBIDDEN (403)
    const custOrderBRes = await makeRequest(`/api/v1/orders/${orderBId}`, custASession.accessToken);
    assert.equal(custOrderBRes.status, 403, 'Customer A MUST NOT access Customer B order');
    assert.equal(custOrderBRes.body.error, 'RESOURCE_ACCESS_DENIED');
    console.log('✓ Cross-customer order access correctly blocked (403 RESOURCE_ACCESS_DENIED)');

    // =========================================================================
    // INVARIANT 4: RIDER A CANNOT ACCESS RIDER B PROFILE / WALLET / TRIPS
    // =========================================================================
    console.log('[IDOR Test 4] Testing Delivery Partner Profile & Telemetry Isolation...');

    // Rider A accessing Rider A profile -> ALLOWED (200)
    const riderAProfileRes = await makeRequest(`/api/v1/riders/${riderA.id}/profile`, riderASession.accessToken);
    assert.equal(riderAProfileRes.status, 200, 'Rider A can view their own profile');

    // Rider A attempting to access Rider B profile -> FORBIDDEN (403)
    const riderBProfileRes = await makeRequest(`/api/v1/riders/${riderB.id}/profile`, riderASession.accessToken);
    assert.equal(riderBProfileRes.status, 403, 'Rider A MUST NOT access Rider B profile');
    assert.equal(riderBProfileRes.body.error, 'RIDER_ACCESS_DENIED');
    console.log('✓ Cross-rider profile access correctly blocked (403 RIDER_ACCESS_DENIED)');

    // =========================================================================
    // INVARIANT 5: ADMIN PRIVILEGED GLOBAL ACCESS
    // =========================================================================
    console.log('[IDOR Test 5] Testing Admin Privileged Cross-Tenant Visibility...');

    // Super Admin accessing Order A and Order B -> Both ALLOWED (200)
    const adminOrderARes = await makeRequest(`/api/v1/orders/${orderAId}`, adminSession.accessToken);
    assert.equal(adminOrderARes.status, 200, 'Admin can view Order A');

    const adminOrderBRes = await makeRequest(`/api/v1/orders/${orderBId}`, adminSession.accessToken);
    assert.equal(adminOrderBRes.status, 200, 'Admin can view Order B');

    // Super Admin accessing Merchant B Inventory -> ALLOWED (200)
    const adminMerchBRes = await makeRequest(`/api/v1/merchants/${merchantBId}/inventory`, adminSession.accessToken);
    assert.equal(adminMerchBRes.status, 200, 'Admin can view Merchant B inventory');
    console.log('✓ Administrative global oversight verified for privileged operations');

  } finally {
    setPool(null);
    await pool.end();
  }
}
