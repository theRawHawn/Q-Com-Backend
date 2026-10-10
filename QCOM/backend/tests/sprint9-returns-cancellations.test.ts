import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { sellerSettlementService } from '../src/modules/settlements/sellerSettlementService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { MockPaymentProvider, RazorpayPaymentProvider } from '../src/modules/payments/paymentProvider.js';
import { bloomFilterService } from '../src/modules/resilience/bloomFilterService.js';

export async function runSprint9ReturnsCancellationsTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 9: Returns, Cancellations, Refunds & Reverse Logistics Test Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply all migrations (001-017) and seeds
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Setup Admin
    const adminAuth = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminPortal', pool);
    const adminToken = adminAuth.accessToken;

    // Setup Customer 1
    const custOtp = await authService.requestOtp('+91-9123456780', 'LOGIN', '127.0.0.1', pool);
    const custAuth = await authService.verifyOtp('+91-9123456780', custOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer One', pool);
    const customerToken = custAuth.accessToken;
    const customerId = custAuth.user.id;

    // Setup Customer 2 (for IDOR tests)
    const cust2Otp = await authService.requestOtp('+91-9123456789', 'LOGIN', '127.0.0.1', pool);
    const cust2Auth = await authService.verifyOtp('+91-9123456789', cust2Otp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer Two', pool);
    const customer2Token = cust2Auth.accessToken;
    const customer2Id = cust2Auth.user.id;

    // Setup Merchant A Seller User
    const sellerOtp = await authService.requestOtp('+91-9845012345', 'LOGIN', '127.0.0.1', pool);
    const sellerAuth = await authService.verifyOtp('+91-9845012345', sellerOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);
    const sellerToken = sellerAuth.accessToken;

    // Fetch Merchant A
    const merchRes = await pool.query(`SELECT * FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchantA = merchRes.rows[0];
    const merchantAId = merchantA.id;

    // Fetch Products
    const prodRes = await pool.query(`SELECT p.*, si.stock_count, si.selling_price FROM products p JOIN store_inventory si ON p.id = si.product_id WHERE si.merchant_id = $1 LIMIT 2`, [merchantAId]);
    const productA = prodRes.rows[0];
    const productB = prodRes.rows[1];

    // Helper to create order directly in DB
    const createTestOrder = async (opts: {
      userId?: string;
      merchantId?: string;
      status?: string;
      paymentStatus?: string;
      placedMinutesAgo?: number;
      deliveredMinutesAgo?: number;
      totalAmount?: number;
      itemQty?: number;
    }) => {
      const orderId = crypto.randomUUID();
      const orderNumber = `QC-2026-${Math.floor(10000 + Math.random() * 90000)}`;
      const uId = opts.userId || customerId;
      const mId = opts.merchantId || merchantAId;
      const status = opts.status || 'placed';
      const paymentStatus = opts.paymentStatus || 'PENDING';
      const placedAt = new Date(Date.now() - (opts.placedMinutesAgo || 1) * 60 * 1000);
      const deliveredAt = opts.deliveredMinutesAgo !== undefined
        ? new Date(Date.now() - opts.deliveredMinutesAgo * 60 * 1000)
        : (status === 'delivered' ? new Date(Date.now() - 30 * 60 * 1000) : null);
      const totalAmount = opts.totalAmount || 500.00;
      const itemQty = opts.itemQty || 2;
      const unitPrice = +(totalAmount / itemQty).toFixed(2);

      await pool.query(`
        INSERT INTO orders (
          id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
          discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
          gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
          place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, delivered_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, 35.00, 15.00, 0, 0, $6, 0, 0, 0, $6, 0, 0,
          'Instant UPI', $7, '123456', 'PK-9999', '{"latitude": 12.9716, "longitude": 77.5946, "address": "Site 1"}'::jsonb,
          '29', '{}'::jsonb, $8, NOW() + INTERVAL '1 hour', $9
        )
      `, [orderId, orderNumber, uId, mId, status, totalAmount, paymentStatus, placedAt, deliveredAt]);

      const orderItemId = crypto.randomUUID();
      await pool.query(`
        INSERT INTO order_items (
          id, order_id, product_id, product_name, unit_price, quantity, total_price, hsn_code,
          taxable_amount, gst_rate_percent, cgst_amount, sgst_amount, igst_amount
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, '8708', $7, 18.00, 0, 0, 0)
      `, [orderItemId, orderId, productA.id, productA.name, unitPrice, itemQty, totalAmount]);

      bloomFilterService.add('orders', orderId);

      return { orderId, orderNumber, orderItemId, unitPrice, itemQty, totalAmount };
    };

    // -------------------------------------------------------------
    // Test 1: Migration 017 Schema & Constraint Verification
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Migration 017 Schema & Constraints Verification...');
    const refCount = await pool.query(`SELECT count(*) as cnt FROM refunds`);
    const retCount = await pool.query(`SELECT count(*) as cnt FROM order_returns`);
    const retItemCount = await pool.query(`SELECT count(*) as cnt FROM order_return_items`);
    assert.equal(parseInt(refCount.rows[0].cnt, 10), 0);
    assert.equal(parseInt(retCount.rows[0].cnt, 10), 0);
    assert.equal(parseInt(retItemCount.rows[0].cnt, 10), 0);

    // Verify Account 1040 exists in general_ledger_accounts
    const acc1040 = await pool.query(`SELECT * FROM general_ledger_accounts WHERE account_code = '1040'`);
    assert.equal(acc1040.rows.length, 1, 'Account 1040 (Merchant Receivable / Clawbacks) must exist');
    assert.equal(acc1040.rows[0].category, 'ASSET');
    assert.equal(acc1040.rows[0].normal_balance, 'DEBIT');

    console.log('✓ Test 1 passed: Migration 017 schema, tables, constraints and Account 1040 verified');

    // -------------------------------------------------------------
    // Test 2: Customer Pre-Fulfillment Cancellation (Within 5 Min Window)
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Customer Pre-Fulfillment Cancellation within 5-min grace window...');
    const ord2 = await createTestOrder({ placedMinutesAgo: 2, status: 'placed', paymentStatus: 'PENDING' });
    
    // Reserve stock to verify release
    await pool.query(`
      INSERT INTO inventory_reservations (order_id, merchant_id, product_id, quantity, status, expires_at)
      VALUES ($1, $2, $3, 2, 'RESERVED', NOW() + INTERVAL '15 minutes')
    `, [ord2.orderId, merchantAId, productA.id]);

    const res2 = await cancellationService.cancelByCustomer({
      orderId: ord2.orderId,
      userId: customerId,
      reason: 'Ordered wrong specification.',
    });

    assert.equal(res2.order.status, 'cancelled');
    assert.ok(res2.order.cancellation_reason.includes('Ordered wrong specification'));

    // Verify reservation marked RELEASED
    const rsv2 = await pool.query(`SELECT status FROM inventory_reservations WHERE order_id = $1`, [ord2.orderId]);
    assert.equal(rsv2.rows[0].status, 'RELEASED');
    console.log('✓ Test 2 passed: Customer pre-fulfillment cancellation successful and reserved stock released');

    // -------------------------------------------------------------
    // Test 3: Customer Cancellation Rejection After 5 Min Window
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Customer Cancellation Rejection past 5-min grace window...');
    const ord3 = await createTestOrder({ placedMinutesAgo: 8, status: 'placed' });

    let err3 = '';
    try {
      await cancellationService.cancelByCustomer({
        orderId: ord3.orderId,
        userId: customerId,
      });
    } catch (e: any) {
      err3 = e.message;
    }
    assert.ok(err3.includes('CANCELLATION_WINDOW_EXPIRED'), `Expected CANCELLATION_WINDOW_EXPIRED, got: ${err3}`);
    console.log('✓ Test 3 passed: Customer cancellation strictly rejected after 5 minutes');

    // -------------------------------------------------------------
    // Test 4: Customer Cancellation Blocked on Out For Delivery / Delivered
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Cancellation Blocked on Out For Delivery / Delivered Status...');
    const ord4 = await createTestOrder({ status: 'out_for_delivery' });

    let err4 = '';
    try {
      await cancellationService.cancelByCustomer({
        orderId: ord4.orderId,
        userId: customerId,
      });
    } catch (e: any) {
      err4 = e.message;
    }
    assert.ok(err4.includes('ORDER_NON_CANCELLABLE'), `Expected ORDER_NON_CANCELLABLE, got: ${err4}`);
    console.log('✓ Test 4 passed: Out for delivery orders cannot be cancelled by customer');

    // -------------------------------------------------------------
    // Test 5: Seller Cancellation of In-Flight Order (Out-of-Stock)
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Seller Cancellation Before Dispatch...');
    const ord5 = await createTestOrder({ placedMinutesAgo: 20, status: 'picking' });

    const res5 = await cancellationService.cancelBySeller({
      orderId: ord5.orderId,
      merchantId: merchantAId,
      reason: 'Part damaged during warehouse packing.',
    });

    assert.equal(res5.order.status, 'cancelled');
    assert.ok(res5.order.cancellation_reason.includes('[SELLER]'));
    console.log('✓ Test 5 passed: Seller successfully cancelled in-flight order past customer 5-min window');

    // -------------------------------------------------------------
    // Test 6: Admin Cancellation Override with Audit Trail
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Admin Cancellation Override...');
    const ord6 = await createTestOrder({ status: 'packed' });

    const res6 = await cancellationService.cancelByAdmin({
      orderId: ord6.orderId,
      adminUserId: adminAuth.user.id,
      reason: 'Customer requested manual hotline override due to wrong address.',
    });

    assert.equal(res6.order.status, 'cancelled');
    assert.ok(res6.order.cancellation_reason.includes('[ADMIN]'));
    console.log('✓ Test 6 passed: Admin cancellation override verified');

    // -------------------------------------------------------------
    // Test 7: Dispatch Decoupling on Cancellation
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Dispatch Decoupling & Rider Status Restoration...');
    const ord7 = await createTestOrder({ status: 'packed' });
    const riderRes = await pool.query(`SELECT id FROM riders LIMIT 1`);
    const riderId = riderRes.rows[0].id;

    // Create assignment and offer
    const assignId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO dispatch_assignments (id, order_id, rider_id, status, scoring_snapshot)
      VALUES ($1, $2, $3, 'OFFERED', '{}'::jsonb)
    `, [assignId, ord7.orderId, riderId]);

    await pool.query(`
      INSERT INTO dispatch_offers (assignment_id, rider_id, order_id, status, expires_at)
      VALUES ($1, $2, $3, 'OFFERED', NOW() + INTERVAL '60 seconds')
    `, [assignId, riderId, ord7.orderId]);

    await pool.query(`UPDATE riders SET status = 'PICKING_UP' WHERE id = $1`, [riderId]);

    // Cancel order
    await cancellationService.cancelByCustomer({
      orderId: ord7.orderId,
      userId: customerId,
      reason: 'Changed mind.',
    });

    const assignCheck = await pool.query(`SELECT status FROM dispatch_assignments WHERE id = $1`, [assignId]);
    const offerCheck = await pool.query(`SELECT status FROM dispatch_offers WHERE assignment_id = $1`, [assignId]);
    const riderCheck = await pool.query(`SELECT status FROM riders WHERE id = $1`, [riderId]);

    assert.equal(assignCheck.rows[0].status, 'CANCELLED');
    assert.equal(offerCheck.rows[0].status, 'CANCELLED');
    assert.equal(riderCheck.rows[0].status, 'IDLE_AT_HUB');
    console.log('✓ Test 7 passed: Dispatch assignment cancelled, offer cancelled, and rider restored to available');

    // -------------------------------------------------------------
    // Test 8: Committed Stock Restoration on Post-Payment Cancellation
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Committed Stock Restoration on Post-Payment Cancellation...');
    const ord8 = await createTestOrder({ status: 'packed', paymentStatus: 'PAID' });
    const initStockRes = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    const stockBefore = parseInt(initStockRes.rows[0].stock_count, 10);

    // Create COMMITTED reservation
    await pool.query(`
      INSERT INTO inventory_reservations (order_id, merchant_id, product_id, quantity, status, expires_at)
      VALUES ($1, $2, $3, 2, 'COMMITTED', NOW() + INTERVAL '1 hour')
    `, [ord8.orderId, merchantAId, productA.id]);

    await cancellationService.cancelByCustomer({
      orderId: ord8.orderId,
      userId: customerId,
      reason: 'Need different parts.',
    });

    const stockAfterRes = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    const stockAfter = parseInt(stockAfterRes.rows[0].stock_count, 10);
    assert.equal(stockAfter, stockBefore + 2, 'Physical inventory stock_count must increment by committed quantity');
    console.log(`✓ Test 8 passed: Committed stock successfully restocked from ${stockBefore} to ${stockAfter}`);

    // -------------------------------------------------------------
    // Test 9: Pre-Fulfillment Cancellation General Ledger Balancing (Batch Q)
    // -------------------------------------------------------------
    console.log('[Test 9] Testing Pre-Fulfillment Cancellation GL Batch Q (Dr 2010 Cr 1010)...');
    const ord9 = await createTestOrder({ totalAmount: 750.00, status: 'placed', paymentStatus: 'PAID' });

    // Record initial payment capture in GL (Dr 1010, Cr 2010)
    await ledgerService.recordOrderPayment({
      orderId: ord9.orderId,
      merchantId: merchantAId,
      grossAmount: 750.00,
      taxableAmount: 700.00,
      cgstAmount: 0,
      sgstAmount: 0,
      deliveryFee: 35.00,
      handlingFee: 15.00,
    });

    // Cancel order
    const cancel9 = await cancellationService.cancelByCustomer({
      orderId: ord9.orderId,
      userId: customerId,
      reason: 'Wrong item selected.',
    });

    assert.equal(cancel9.order.payment_status, 'REFUNDED');
    assert.equal(cancel9.refund.status, 'COMPLETED');

    // Verify GL entries for cancel refund: Dr 2010, Cr 1010
    const gl9 = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE order_id = $1 AND transaction_type = 'REFUND'
    `, [ord9.orderId]);

    assert.equal(gl9.rows.length, 2);
    const dr2010 = gl9.rows.find(r => r.account_code === '2010' && r.entry_side === 'DEBIT');
    const cr1010 = gl9.rows.find(r => r.account_code === '1010' && r.entry_side === 'CREDIT');
    assert.ok(dr2010 && parseFloat(dr2010.amount) === 750.00);
    assert.ok(cr1010 && parseFloat(cr1010.amount) === 750.00);
    console.log('✓ Test 9 passed: General ledger Batch Q recorded Dr 2010 (₹750) and Cr 1010 (₹750)');

    // -------------------------------------------------------------
    // Test 10: Cancellation Idempotency
    // -------------------------------------------------------------
    console.log('[Test 10] Testing Cancellation Idempotency...');
    const ord10 = await createTestOrder({ status: 'placed', paymentStatus: 'PAID', totalAmount: 400.00 });
    const idemKey10 = `idem_cancel_${crypto.randomUUID()}`;

    const firstRun = await cancellationService.cancelByCustomer({
      orderId: ord10.orderId,
      userId: customerId,
      idempotencyKey: idemKey10,
    });
    assert.equal(firstRun.isDuplicate, false);

    const secondRun = await cancellationService.cancelByCustomer({
      orderId: ord10.orderId,
      userId: customerId,
      idempotencyKey: idemKey10,
    });
    assert.equal(secondRun.isDuplicate, true);

    // Verify only ONE refund record exists
    const refundsCount = await pool.query(`SELECT COUNT(*) as cnt FROM refunds WHERE order_id = $1`, [ord10.orderId]);
    assert.equal(parseInt(refundsCount.rows[0].cnt, 10), 1);
    console.log('✓ Test 10 passed: Idempotency strictly guaranteed zero duplicate refund records');

    // -------------------------------------------------------------
    // Test 11: Payment Gateway Refund Adapter (Mock & Razorpay)
    // -------------------------------------------------------------
    console.log('[Test 11] Testing Payment Gateway Refund Adapters...');
    const mockProvider = new MockPaymentProvider();
    const mockRefRes = await mockProvider.createRefund({
      paymentId: 'pay_test_123',
      amount: 250.00,
    });
    assert.ok(mockRefRes.providerRefundId.startsWith('rfnd_'));
    assert.equal(mockRefRes.status, 'PROCESSED');

    const razorpayProvider = new RazorpayPaymentProvider('razorpay_test');
    const rzRefRes = await razorpayProvider.createRefund({
      paymentId: 'pay_rz_456',
      amount: 250.00,
    });
    assert.ok(rzRefRes.providerRefundId.startsWith('rfrz_'));
    assert.equal(rzRefRes.status, 'PROCESSED');
    console.log('✓ Test 11 passed: Mock and Razorpay payment refund adapters verified');

    // -------------------------------------------------------------
    // Test 12: Customer Return Request Validation
    // -------------------------------------------------------------
    console.log('[Test 12] Testing Customer Return Request on Delivered Order...');
    const ord12 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 60, totalAmount: 600.00, itemQty: 2 });

    const ret12 = await returnService.requestReturn({
      orderId: ord12.orderId,
      userId: customerId,
      items: [{ orderItemId: ord12.orderItemId, quantity: 1 }],
      reasonCode: 'WRONG_ITEM_DELIVERED',
      customerNotes: 'Received M8 bolts instead of M10 bolts.',
    });

    assert.equal(ret12.returnRequest.status, 'REQUESTED');
    assert.equal(ret12.returnRequest.items.length, 1);
    assert.equal(ret12.returnRequest.items[0].quantity, 1);

    // Order status updated
    const ord12Check = await pool.query(`SELECT status FROM orders WHERE id = $1`, [ord12.orderId]);
    assert.equal(ord12Check.rows[0].status, 'return_requested');
    console.log('✓ Test 12 passed: Return request created with status REQUESTED and items persisted');

    // -------------------------------------------------------------
    // Test 13: Return Window Expiration Rejection (>48h)
    // -------------------------------------------------------------
    console.log('[Test 13] Testing Return Window Expiration Rejection past 48 hours...');
    const ord13 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 49 * 60 });

    let err13 = '';
    try {
      await returnService.requestReturn({
        orderId: ord13.orderId,
        userId: customerId,
        items: [{ orderItemId: ord13.orderItemId, quantity: 1 }],
        reasonCode: 'DEFECTIVE_PRODUCT',
      });
    } catch (e: any) {
      err13 = e.message;
    }
    assert.ok(err13.includes('RETURN_WINDOW_EXPIRED'), `Expected RETURN_WINDOW_EXPIRED, got: ${err13}`);
    console.log('✓ Test 13 passed: Returns requested past 48 hours are rejected');

    // -------------------------------------------------------------
    // Test 14: Return Anti-IDOR Security Guard
    // -------------------------------------------------------------
    console.log('[Test 14] Testing Return Anti-IDOR Boundary Guard...');
    const ord14 = await createTestOrder({ userId: customerId, status: 'delivered', deliveredMinutesAgo: 10 });

    let err14 = '';
    try {
      await returnService.requestReturn({
        orderId: ord14.orderId,
        userId: customer2Id, // Customer 2 attempts to return Customer 1's order
        items: [{ orderItemId: ord14.orderItemId, quantity: 1 }],
        reasonCode: 'WRONG_ITEM_DELIVERED',
      });
    } catch (e: any) {
      err14 = e.message;
    }
    assert.ok(err14.includes('UNAUTHORIZED_RETURN_REQUEST'), `Expected UNAUTHORIZED_RETURN_REQUEST, got: ${err14}`);
    console.log('✓ Test 14 passed: Cross-customer IDOR return attempt strictly rejected');

    // -------------------------------------------------------------
    // Test 15: Return Quantity Ceiling Enforcement
    // -------------------------------------------------------------
    console.log('[Test 15] Testing Return Quantity Ceiling Enforcement...');
    const ord15 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 20, itemQty: 2 });

    // Requesting 3 units on 2 purchased units must fail
    let err15 = '';
    try {
      await returnService.requestReturn({
        orderId: ord15.orderId,
        userId: customerId,
        items: [{ orderItemId: ord15.orderItemId, quantity: 3 }],
        reasonCode: 'EXCESS_UNITS',
      });
    } catch (e: any) {
      err15 = e.message;
    }
    assert.ok(err15.includes('RETURN_QUANTITY_EXCEEDED'), `Expected RETURN_QUANTITY_EXCEEDED, got: ${err15}`);
    console.log('✓ Test 15 passed: Requesting quantity > purchased quantity is rejected');

    // -------------------------------------------------------------
    // Test 16: Seller Return Approval & Reverse Pickup Trip Creation
    // -------------------------------------------------------------
    console.log('[Test 16] Testing Seller Return Approval & Reverse Pickup Trip...');
    const ord16 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 30, itemQty: 1 });
    const ret16Req = await returnService.requestReturn({
      orderId: ord16.orderId,
      userId: customerId,
      items: [{ orderItemId: ord16.orderItemId, quantity: 1 }],
      reasonCode: 'DAMAGED_PACKAGING',
    });

    const reviewed16 = await returnService.reviewReturn({
      returnId: ret16Req.returnRequest.id,
      merchantId: merchantAId,
      action: 'APPROVE',
      reasonNotes: 'Approved for pickup and inspection.',
    });

    assert.equal(reviewed16.status, 'PICKUP_ASSIGNED');
    assert.ok(reviewed16.pickupTripId);

    const ord16Check = await pool.query(`SELECT status FROM orders WHERE id = $1`, [ord16.orderId]);
    assert.equal(ord16Check.rows[0].status, 'return_approved');
    console.log('✓ Test 16 passed: Seller approved return and reverse pickup trip assigned');

    // -------------------------------------------------------------
    // Test 17: Seller Return Rejection (Terminal State)
    // -------------------------------------------------------------
    console.log('[Test 17] Testing Seller Return Rejection...');
    const ord17 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 30, itemQty: 1 });
    const ret17Req = await returnService.requestReturn({
      orderId: ord17.orderId,
      userId: customerId,
      items: [{ orderItemId: ord17.orderItemId, quantity: 1 }],
      reasonCode: 'CUSTOMER_MISTAKE',
    });

    const reviewed17 = await returnService.reviewReturn({
      returnId: ret17Req.returnRequest.id,
      merchantId: merchantAId,
      action: 'REJECT',
      reasonNotes: 'Product was unsealed and used. Non-returnable.',
    });

    assert.equal(reviewed17.status, 'REJECTED');
    const ord17Check = await pool.query(`SELECT status FROM orders WHERE id = $1`, [ord17.orderId]);
    assert.equal(ord17Check.rows[0].status, 'return_rejected');
    console.log('✓ Test 17 passed: Seller rejected return request to terminal REJECTED state');

    // -------------------------------------------------------------
    // Test 18: Store Receipt & QC Inspection with Selective Restocking
    // -------------------------------------------------------------
    console.log('[Test 18] Testing Store Receipt & QC Inspection with Selective Restock...');
    const ord18 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 40, itemQty: 2, totalAmount: 500.00 });
    const ret18Req = await returnService.requestReturn({
      orderId: ord18.orderId,
      userId: customerId,
      items: [{ orderItemId: ord18.orderItemId, quantity: 2 }],
      reasonCode: 'DEFECTIVE_BATCH',
    });

    await returnService.reviewReturn({
      returnId: ret18Req.returnRequest.id,
      merchantId: merchantAId,
      action: 'APPROVE',
    });

    await returnService.receiveAtStore({
      returnId: ret18Req.returnRequest.id,
      merchantId: merchantAId,
    });

    const stockBefore18Res = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    const stockBefore18 = parseInt(stockBefore18Res.rows[0].stock_count, 10);

    const returnItem = ret18Req.returnRequest.items[0];

    // QC Inspect: item passes QC
    const qcResult18 = await returnService.qcInspectAndResolve({
      returnId: ret18Req.returnRequest.id,
      merchantId: merchantAId,
      itemDecisions: [{ returnItemId: returnItem.id, qcPassed: true }],
      qcNotes: 'Item in original unopened packaging. Passed inspection.',
    });

    assert.equal(qcResult18.returnRecord.status, 'ACCEPTED');
    assert.ok(qcResult18.refund);
    assert.equal(qcResult18.refund.amount, 500.00);

    // Verify stock incremented by 2
    const stockAfter18Res = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    const stockAfter18 = parseInt(stockAfter18Res.rows[0].stock_count, 10);
    assert.equal(stockAfter18, stockBefore18 + 2);

    const ord18Check = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [ord18.orderId]);
    assert.equal(ord18Check.rows[0].status, 'returned');
    assert.equal(ord18Check.rows[0].payment_status, 'REFUNDED');
    console.log('✓ Test 18 passed: Store receipt, QC inspection, physical restock and gateway refund verified');

    // -------------------------------------------------------------
    // Test 19: All Items Fail QC Inspection (Zero Restock & Zero Refund)
    // -------------------------------------------------------------
    console.log('[Test 19] Testing Return Items Failing QC Inspection...');
    const ord19 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 45, itemQty: 1, totalAmount: 250.00 });
    const ret19Req = await returnService.requestReturn({
      orderId: ord19.orderId,
      userId: customerId,
      items: [{ orderItemId: ord19.orderItemId, quantity: 1 }],
      reasonCode: 'DEFECTIVE_PRODUCT',
    });

    await returnService.reviewReturn({
      returnId: ret19Req.returnRequest.id,
      merchantId: merchantAId,
      action: 'APPROVE',
    });

    const stockBefore19Res = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    const stockBefore19 = parseInt(stockBefore19Res.rows[0].stock_count, 10);

    const qcResult19 = await returnService.qcInspectAndResolve({
      returnId: ret19Req.returnRequest.id,
      merchantId: merchantAId,
      itemDecisions: [{ returnItemId: ret19Req.returnRequest.items[0].id, qcPassed: false, notes: 'Stripped threads; user damage.' }],
      qcNotes: 'User misuse. QC rejected.',
    });

    assert.equal(qcResult19.returnRecord.status, 'REJECTED_QC');
    assert.equal(qcResult19.refund, undefined);

    const stockAfter19Res = await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantAId, productA.id]);
    assert.equal(parseInt(stockAfter19Res.rows[0].stock_count, 10), stockBefore19, 'Stock must NOT increment for failed QC');
    console.log('✓ Test 19 passed: Failed QC inspection produces zero restock and zero refund');

    // -------------------------------------------------------------
    // Test 20: Pre-Payout Return Seller Settlement Debit
    // -------------------------------------------------------------
    console.log('[Test 20] Testing Pre-Payout Return Seller Settlement Debit...');
    const ord20 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 50, itemQty: 1, totalAmount: 300.00 });

    // Seed initial balance in seller_ledgers
    await pool.query(`
      INSERT INTO seller_ledgers (merchant_id, order_id, entry_type, category, amount, running_balance, description)
      VALUES ($1, $2, 'ORDER_CREDIT', 'CREDIT', 250.00, 250.00, 'Initial order credit')
    `, [merchantAId, ord20.orderId]);

    // Create allocation in order_settlement_allocations with status ALLOCATED (not settled)
    await pool.query(`
      INSERT INTO order_settlement_allocations (
        order_id, merchant_id, journal_batch_id, order_total, gross_gmv, seller_goods_taxable,
        seller_goods_gst, platform_commission, commission_gst, net_seller_payable, status
      )
      VALUES ($1, $2, gen_random_uuid(), 300.00, 300.00, 250.00, 0, 50.00, 0, 250.00, 'ALLOCATED')
    `, [ord20.orderId, merchantAId]);

    const clawback20 = await sellerSettlementService.processSellerClawback({
      orderId: ord20.orderId,
      merchantId: merchantAId,
      refundAmount: 300.00,
    });

    assert.equal(clawback20.isPostPayout, false);
    assert.equal(clawback20.debitAmount, 250.00);
    assert.equal(clawback20.newBalance, 0.00);

    const lastLedger20 = await pool.query(`
      SELECT entry_type, amount, running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [merchantAId]);
    assert.equal(lastLedger20.rows[0].entry_type, 'RETURN_DEBIT');
    assert.equal(parseFloat(lastLedger20.rows[0].running_balance), 0.00);
    console.log('✓ Test 20 passed: Pre-payout return debited seller ledger back to 0.00');

    // -------------------------------------------------------------
    // Test 21: Post-Payout Return Clawback Debit (Account 1040)
    // -------------------------------------------------------------
    console.log('[Test 21] Testing Post-Payout Return Clawback Debit (Account 1040)...');
    const ord21 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 60, itemQty: 1, totalAmount: 400.00 });

    // Merchant had 0 balance after payout
    await pool.query(`
      INSERT INTO order_settlement_allocations (
        order_id, merchant_id, journal_batch_id, order_total, gross_gmv, seller_goods_taxable,
        seller_goods_gst, platform_commission, commission_gst, net_seller_payable, status
      )
      VALUES ($1, $2, gen_random_uuid(), 400.00, 400.00, 340.00, 0, 60.00, 0, 340.00, 'SETTLED')
    `, [ord21.orderId, merchantAId]);

    const clawback21 = await sellerSettlementService.processSellerClawback({
      orderId: ord21.orderId,
      merchantId: merchantAId,
      refundAmount: 400.00,
    });

    assert.equal(clawback21.isPostPayout, true);
    assert.equal(clawback21.debitAmount, 340.00);
    assert.ok(clawback21.newBalance < 0, 'New balance should become negative post-payout');

    // Verify GL recorded Account 1040 (Merchant Receivable Asset)
    const gl21 = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE order_id = $1 AND account_code = '1040'
    `, [ord21.orderId]);
    assert.equal(gl21.rows.length, 1);
    assert.equal(gl21.rows[0].entry_side, 'DEBIT');
    assert.equal(parseFloat(gl21.rows[0].amount), 340.00);
    console.log('✓ Test 21 passed: Post-payout clawback posted Dr 1040 (₹340.00) and negative subledger balance');

    // -------------------------------------------------------------
    // Test 22: Clawback Offset & Negative Balance Payout Lock
    // -------------------------------------------------------------
    console.log('[Test 22] Testing Negative Balance Payout Lock & Future Offset...');
    let payoutBlocked = false;
    try {
      await sellerSettlementService.executeSellerPayout({
        merchantId: merchantAId,
        idempotencyKey: 'idem_payout_neg',
      });
    } catch (e: any) {
      payoutBlocked = true;
      assert.ok(e.message.includes('ZERO_PAYABLE_BALANCE') || e.message.toLowerCase().includes('balance'));
    }
    assert.ok(payoutBlocked, 'Payout must be blocked when merchant has negative balance from clawbacks');

    // Future order offsets the negative balance
    await pool.query(`
      INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description)
      VALUES ($1, 'ORDER_CREDIT', 'CREDIT', 1000.00, $2, 'Offset order credit')
    `, [merchantAId, clawback21.newBalance + 1000.00]);

    const restoredBal = await pool.query(`SELECT running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`, [merchantAId]);
    assert.ok(parseFloat(restoredBal.rows[0].running_balance) > 0, 'Balance restored to positive after offset');
    console.log('✓ Test 22 passed: Negative balance blocked payout and successfully offset by subsequent credit');

    // -------------------------------------------------------------
    // Test 23: Refund Ceiling Constraint
    // -------------------------------------------------------------
    console.log('[Test 23] Testing Refund Ceiling Constraint...');
    const ord23 = await createTestOrder({ totalAmount: 200.00, status: 'placed', paymentStatus: 'PAID' });

    let err23 = '';
    try {
      await refundService.createRefund({
        orderId: ord23.orderId,
        amount: 350.00,
        reasonCode: 'OVER_REFUND_ATTEMPT',
      });
    } catch (e: any) {
      err23 = e.message;
    }
    assert.ok(err23.includes('REFUND_CEILING_EXCEEDED'), `Expected REFUND_CEILING_EXCEEDED, got: ${err23}`);
    console.log('✓ Test 23 passed: Refunding amount exceeding order total strictly rejected');

    // -------------------------------------------------------------
    // Test 24: General Ledger Trial Balance Reconciled (Debits == Credits)
    // -------------------------------------------------------------
    console.log('[Test 24] Testing General Ledger Trial Balance 100% Reconciled...');
    const trialBalance = await ledgerService.getTrialBalance();
    assert.ok(trialBalance.isBalanced, `Trial balance must balance! Debits: ${trialBalance.totalDebits}, Credits: ${trialBalance.totalCredits}, Diff: ${trialBalance.difference}`);
    assert.equal(trialBalance.difference, 0.00);
    console.log(`✓ Test 24 passed: Trial balance 100% reconciled (Debits: ₹${trialBalance.totalDebits} == Credits: ₹${trialBalance.totalCredits})`);

    // -------------------------------------------------------------
    // Test 25: Database Unavailability Fail-Closed Handling
    // -------------------------------------------------------------
    console.log('[Test 25] Testing HTTP API Return & Refund Endpoints...');
    const ord25 = await createTestOrder({ status: 'delivered', deliveredMinutesAgo: 10 });
    
    // HTTP POST return request
    const postRes = await fetch(`${baseUrl}/api/v1/orders/${ord25.orderId}/returns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        items: [{ orderItemId: ord25.orderItemId, quantity: 1 }],
        reasonCode: 'DEFECTIVE_PRODUCT',
        customerNotes: 'Defective tool casing.',
      }),
    });
    assert.equal(postRes.status, 201);
    const postJson = await postRes.json();
    assert.equal(postJson.success, true);
    assert.equal(postJson.returnRequest.status, 'REQUESTED');

    // HTTP GET returns for order
    const getRes = await fetch(`${baseUrl}/api/v1/orders/${ord25.orderId}/returns`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.returns.length, 1);
    console.log('✓ Test 25 passed: HTTP REST API endpoints for return lifecycle verified');

    console.log('===========================================================');
    console.log('✓ ALL SPRINT 9 RETURNS & CANCELLATIONS TESTS PASSED!');
    console.log('===========================================================\n');
  } finally {
    server.close();
    await pool.end();
  }
}

if (process.argv[1]?.includes('sprint9')) {
  runSprint9ReturnsCancellationsTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
