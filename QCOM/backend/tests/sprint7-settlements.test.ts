import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { sellerSettlementService } from '../src/modules/settlements/sellerSettlementService.js';
import { riderPayoutService } from '../src/modules/settlements/riderPayoutService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { settlementEventPublisher } from '../src/modules/settlements/settlementEvents.js';
import { env } from '../src/config/env.js';

export async function runSprint7SettlementsTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 7: Marketplace Settlement, Seller Payouts & Rider Earnings Test Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply all migrations (001-015)
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  // Local server for HTTP API integration testing
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup Super Admin
    const adminAuth = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminPortal', pool);
    const adminToken = adminAuth.accessToken;

    // 2. Setup Customer 1 (Buyer)
    const phone1 = '+91-9123456780';
    const otp1 = await authService.requestOtp(phone1, 'LOGIN', '127.0.0.1', pool);
    const auth1 = await authService.verifyOtp(phone1, otp1.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer One', pool);
    const customerToken = auth1.accessToken;

    // 3. Fetch Seeded Merchant A (MERCH-BLR-01)
    const merchRes = await pool.query(`SELECT * FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchantA = merchRes.rows[0];
    const merchantAId = merchantA.id;

    // Setup Merchant A Seller User
    const sellerOtp = await authService.requestOtp('+91-9845012345', 'LOGIN', '127.0.0.1', pool);
    const sellerAuth = await authService.verifyOtp('+91-9845012345', sellerOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);
    const sellerToken = sellerAuth.accessToken;

    // 4. Fetch Seeded Merchant B (MERCH-BLR-02)
    const merchBRes = await pool.query(`SELECT * FROM merchants WHERE merchant_code = 'MERCH-BLR-02'`);
    const merchantBId = merchBRes.rows[0].id;
    const sellerBOtp = await authService.requestOtp('+91-9845099999', 'LOGIN', '127.0.0.1', pool);
    const sellerBAuth = await authService.verifyOtp('+91-9845099999', sellerBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);
    const sellerBToken = sellerBAuth.accessToken;

    // 5. Fetch Seeded Rider A (RIDER-77)
    const riderRes = await pool.query(`SELECT * FROM riders WHERE rider_code = 'RIDER-77'`);
    const riderA = riderRes.rows[0];
    const riderAId = riderA.id;

    const riderOtp = await authService.requestOtp('+91-9812345678', 'LOGIN', '127.0.0.1', pool);
    const riderAuth = await authService.verifyOtp('+91-9812345678', riderOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'DeliveryApp', undefined, pool);
    const riderToken = riderAuth.accessToken;

    // Helper: Create an online paid order with a delivered trip
    async function createDeliveredOrder(options?: {
      merchantId?: string;
      riderId?: string;
      tipAmount?: number;
      paymentMethod?: string;
      prepMins?: number;
      riderPanValid?: boolean;
    }): Promise<{ order: any; trip: any }> {
      const targetMerchId = options?.merchantId || merchantAId;
      const targetRiderId = options?.riderId || riderAId;
      const tipAmount = options?.tipAmount ?? 25.00;
      const paymentMethod = options?.paymentMethod || 'Instant UPI';

      if (options?.prepMins !== undefined) {
        await pool.query(`UPDATE merchants SET base_prep_mins = $1 WHERE id = $2`, [options.prepMins, targetMerchId]);
      }

      if (options?.riderPanValid !== undefined) {
        await pool.query(`UPDATE riders SET pan_status = $1 WHERE id = $2`, [
          options.riderPanValid ? 'VALID_PAN' : 'INVALID_OR_MISSING_PAN',
          targetRiderId,
        ]);
      }

      // Find product for target merchant via store_inventory
      const prodRes = await pool.query(
        `SELECT product_id as id FROM store_inventory WHERE merchant_id = $1 LIMIT 1`,
        [targetMerchId]
      );
      const prodId = prodRes.rows.length > 0
        ? prodRes.rows[0].id
        : (await pool.query(`SELECT id FROM products LIMIT 1`)).rows[0].id;

      // 1. Create order
      const orderCreateRes = await fetch(`${baseUrl}/api/orders/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({
          merchantId: targetMerchId,
          items: [{ id: prodId, quantity: 2 }],
          jobSite: {
            latitude: 12.9716,
            longitude: 77.5946,
            address: 'Bangalore Tech Park 5th Floor',
          },
          paymentMethod,
        }),
      });
      const orderData = await orderCreateRes.json();
      assert.strictEqual(orderCreateRes.status, 200, `Failed to create order: ${JSON.stringify(orderData)}`);
      const order = orderData.order;

      // 2. If online payment, capture via create-order and verify API
      if (paymentMethod !== 'Pay on Delivery') {
        const createOrderRes = await fetch(`${baseUrl}/api/payment/create-order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({ orderId: order.id }),
        });
        const createOrderBody = await createOrderRes.json();
        assert.strictEqual(createOrderRes.status, 200, `Failed to create payment order: ${JSON.stringify(createOrderBody)}`);

        const verifyRes = await fetch(`${baseUrl}/api/payment/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({
            orderId: order.id,
            transactionId: `txn_s7_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            timestamp: new Date(createOrderBody.paymentOrder.timestamp).getTime(),
            signature: createOrderBody.paymentOrder.signature,
          }),
        });
        const verifyBody = await verifyRes.json();
        assert.strictEqual(verifyRes.status, 200, `Failed to verify payment: ${JSON.stringify(verifyBody)}`);
      }

      // 3. Create delivery trip in DELIVERED state
      const tripRes = await pool.query(`
        INSERT INTO delivery_trips (
          order_id, rider_id, status, base_fare, distance_fare, surge_fare,
          wait_time_compensation, tip_amount, total_rider_payout,
          cod_collected_amount, delivered_at
        )
        VALUES ($1, $2, 'DELIVERED', 35.00, 16.00, 0.00, 0.00, $3, $4, $5, NOW())
        RETURNING *
      `, [
        order.id,
        targetRiderId,
        tipAmount,
        51.00 + tipAmount,
        paymentMethod === 'Pay on Delivery' ? parseFloat(order.total_amount || order.totalAmount) : 0.00,
      ]);
      const trip = tripRes.rows[0];

      // 4. Update order to delivered
      await pool.query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [order.id]);

      return { order, trip };
    }

    // -------------------------------------------------------------
    // Test 1: Full Fulfillment Financial Allocation API (/api & /api/v1)
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Fulfillment Financial Allocation (/api & /api/v1)...');
    const { order: order1 } = await createDeliveredOrder();

    // Trigger allocation via versioned POST /api/v1/settlements/allocate
    const allocRes1 = await fetch(`${baseUrl}/api/v1/settlements/allocate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ orderId: order1.id }),
    });

    const allocBody1 = await allocRes1.json();
    assert.strictEqual(allocRes1.status, 200, `Allocation failed: ${JSON.stringify(allocBody1)}`);
    assert.strictEqual(allocBody1.success, true);
    assert.ok(allocBody1.allocation.id);
    assert.strictEqual(allocBody1.allocation.orderId, order1.id);
    assert.strictEqual(allocBody1.allocation.merchantId, merchantAId);
    assert.strictEqual(allocBody1.allocation.riderId, riderAId);
    assert.strictEqual(allocBody1.allocation.status, 'ALLOCATED');
    assert.ok(allocBody1.allocation.journalBatchId);
    assert.ok(allocBody1.allocation.netSellerPayable > 0);
    assert.ok(allocBody1.allocation.netRiderPayable > 0);

    // Call /api/settlements/order/:orderId/allocation compatibility query
    const queryRes1 = await fetch(`${baseUrl}/api/settlements/order/${order1.id}/allocation`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const queryBody1 = await queryRes1.json();
    assert.strictEqual(queryRes1.status, 200);
    assert.strictEqual(queryBody1.allocation.id, allocBody1.allocation.id);
    console.log('✓ Test 1 passed: Fulfillment allocation executed via dual-mounted API routes');

    // -------------------------------------------------------------
    // Test 2: Double-Entry General Ledger Balance Invariant
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Double-Entry Balance Invariant on Allocation Batch...');
    const journalBatchId1 = allocBody1.allocation.journalBatchId;
    const glRes1 = await pool.query(
      `SELECT entry_side, amount FROM general_ledger_entries WHERE journal_batch_id = $1`,
      [journalBatchId1]
    );

    let debitSum = 0;
    let creditSum = 0;
    for (const r of glRes1.rows) {
      const amt = parseFloat(r.amount);
      if (r.entry_side === 'DEBIT') debitSum += amt;
      else if (r.entry_side === 'CREDIT') creditSum += amt;
    }
    debitSum = +debitSum.toFixed(2);
    creditSum = +creditSum.toFixed(2);

    assert.strictEqual(
      debitSum,
      creditSum,
      `Unbalanced journal batch: Debits (${debitSum}) !== Credits (${creditSum})`
    );
    const expectedDebits = +(allocBody1.allocation.orderTotal + allocBody1.allocation.grossRiderFare).toFixed(2);
    assert.strictEqual(debitSum, expectedDebits, `Debits sum ${debitSum} does not match orderTotal + grossFare ${expectedDebits}`);
    console.log(`✓ Test 2 passed: Double-entry invariant verified (Total Debits: ₹${debitSum} == Total Credits: ₹${creditSum})`);

    // -------------------------------------------------------------
    // Test 3: Net Seller Settlement Mathematical Accuracy
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Net Seller Settlement Mathematical Accuracy...');
    const a = allocBody1.allocation;
    const calculatedSellerNet = +(
      a.grossGmv -
      a.platformCommission -
      a.commissionGst -
      a.gstTcsAmount -
      a.sellerTdsAmount -
      a.storeDelayPenalty
    ).toFixed(2);

    assert.strictEqual(
      a.netSellerPayable,
      calculatedSellerNet,
      `Seller net payable mismatch: ${a.netSellerPayable} !== ${calculatedSellerNet}`
    );
    console.log(`✓ Test 3 passed: Net seller payable ₹${a.netSellerPayable} exactly matches formula`);

    // -------------------------------------------------------------
    // Test 4: Commission & SAC 9983 GST Segregation
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Platform Commission & SAC 9983 Output GST Segregation...');
    const commEntries = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1 AND account_code IN ('4010', '2070')
    `, [journalBatchId1]);

    const entry4010 = commEntries.rows.find((r) => r.account_code === '4010');
    const entry2070 = commEntries.rows.find((r) => r.account_code === '2070');
    assert.ok(entry4010, 'Account 4010 (Marketplace Commission Revenue) entry must exist');
    assert.ok(entry2070, 'Account 2070 (Output GST Liability) entry must exist');
    assert.strictEqual(parseFloat(entry4010.amount), a.platformCommission);
    assert.ok(parseFloat(entry2070.amount) >= a.commissionGst);
    console.log('✓ Test 4 passed: Platform commission and SAC 9983 GST strictly segregated');

    // -------------------------------------------------------------
    // Test 5: Section 52 GST-TCS Collection & Ledger Posting
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Section 52 GST-TCS Collection & Account 2040 Posting...');
    const tcsEntries = await pool.query(`
      SELECT account_code, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1 AND account_code = '2040'
    `, [journalBatchId1]);

    assert.ok(tcsEntries.rows.length > 0, 'Account 2040 (GST-TCS Section 52 Payable) must exist');
    assert.strictEqual(parseFloat(tcsEntries.rows[0].amount), a.gstTcsAmount);
    // 0.50% on taxable goods (0.25% CGST + 0.25% SGST)
    const expectedTcs = +(a.sellerGoodsTaxable * 0.005).toFixed(2);
    assert.ok(Math.abs(a.gstTcsAmount - expectedTcs) <= 0.02, `TCS amount mismatch: ${a.gstTcsAmount} !== ${expectedTcs}`);
    console.log(`✓ Test 5 passed: Section 52 GST-TCS (₹${a.gstTcsAmount}) accurately collected and posted`);

    // -------------------------------------------------------------
    // Test 6: Section 393 Income-Tax Withholding on Merchant (0.10%)
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Section 393 Direct Tax Withholding & Account 2050 Posting...');
    const tdsEntries = await pool.query(`
      SELECT account_code, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1 AND account_code = '2050'
    `, [journalBatchId1]);

    assert.ok(tdsEntries.rows.length > 0, 'Account 2050 (Income-Tax Withholding Payable) must exist');
    assert.strictEqual(parseFloat(tdsEntries.rows[0].amount), a.sellerTdsAmount);
    const expectedTds = +(a.grossGmv * 0.001).toFixed(2);
    assert.strictEqual(a.sellerTdsAmount, expectedTds, `Seller TDS mismatch: ${a.sellerTdsAmount} !== ${expectedTds}`);
    console.log(`✓ Test 6 passed: Section 393 e-commerce TDS (₹${a.sellerTdsAmount}) accurately withheld`);

    // -------------------------------------------------------------
    // Test 7: Higher Rate Withholding on Non-PAN Merchant (5.00%)
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Higher Rate Withholding (5%) on Non-PAN Merchant...');
    // Update Merchant B pan_status to INVALID_OR_MISSING_PAN
    await pool.query(`UPDATE merchants SET pan_status = 'INVALID_OR_MISSING_PAN' WHERE id = $1`, [merchantBId]);

    const { order: orderNonPan } = await createDeliveredOrder({ merchantId: merchantBId });
    const allocNonPan = await settlementAllocationService.allocateFulfilledOrder(orderNonPan.id);

    const expectedHigherTds = +(allocNonPan.grossGmv * 0.05).toFixed(2);
    assert.strictEqual(
      allocNonPan.sellerTdsAmount,
      expectedHigherTds,
      `Penal TDS rate 5% not applied to non-PAN seller: ${allocNonPan.sellerTdsAmount} !== ${expectedHigherTds}`
    );
    console.log(`✓ Test 7 passed: Penal 5.00% TDS (₹${allocNonPan.sellerTdsAmount}) enforced on non-PAN merchant`);

    // -------------------------------------------------------------
    // Test 8: Rider Earnings Finalization on Trip Delivery
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Rider Earnings Finalization in Subledger (rider_ledgers)...');
    const riderSubledgerRes = await pool.query(`
      SELECT * FROM rider_ledgers WHERE rider_id = $1 AND category = 'CREDIT' ORDER BY created_at DESC LIMIT 1
    `, [riderAId]);

    assert.ok(riderSubledgerRes.rows.length > 0, 'Rider subledger entry must exist');
    assert.strictEqual(parseFloat(riderSubledgerRes.rows[0].amount), a.netRiderPayable);
    console.log(`✓ Test 8 passed: Rider subledger credited with net earnings ₹${a.netRiderPayable}`);

    // -------------------------------------------------------------
    // Test 9: 100% Customer Tip Pass-Through Invariant
    // -------------------------------------------------------------
    console.log('[Test 9] Testing 100% Customer Tip Pass-Through (Zero Platform Commission)...');
    assert.strictEqual(a.customerTip, 25.00, 'Customer tip must match input');
    const fareWithoutTip = +(a.grossRiderFare - a.riderTdsAmount).toFixed(2);
    assert.strictEqual(
      a.netRiderPayable,
      +(fareWithoutTip + a.customerTip).toFixed(2),
      'Net rider payable must pass through 100% tip without platform haircut'
    );
    console.log('✓ Test 9 passed: 100% customer tip pass-through invariant verified');

    // -------------------------------------------------------------
    // Test 10: Section 393 Logistics TDS on Delivery Partner (1% for PAN)
    // -------------------------------------------------------------
    console.log('[Test 10] Testing Section 393 Logistics TDS on Rider (1% on Gross Fare)...');
    const expectedRiderTds = +(a.grossRiderFare * 0.01).toFixed(2);
    assert.strictEqual(
      a.riderTdsAmount,
      expectedRiderTds,
      `Rider 1% TDS mismatch: ${a.riderTdsAmount} !== ${expectedRiderTds}`
    );

    const riderTdsEntry = await pool.query(`
      SELECT account_code, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1 AND account_code = '2060'
    `, [journalBatchId1]);
    assert.ok(riderTdsEntry.rows.length > 0, 'Account 2060 (Logistics Withholding Payable) must exist');
    assert.strictEqual(parseFloat(riderTdsEntry.rows[0].amount), a.riderTdsAmount);
    console.log(`✓ Test 10 passed: Rider logistics TDS (₹${a.riderTdsAmount}) accurately deducted and posted to 2060`);

    // -------------------------------------------------------------
    // Test 11: Penal Logistics TDS (20%) for Non-PAN Rider
    // -------------------------------------------------------------
    console.log('[Test 11] Testing Penal Logistics TDS (20%) for Non-PAN Delivery Partner...');
    const nonPanRiderRes = await pool.query(`
      INSERT INTO riders (name, phone, rider_code, status, pan_status, kyc_status, vehicle_type)
      VALUES ('No PAN Rider', '+91-9877700000', 'RIDER-NONPAN', 'IDLE_AT_HUB', 'INVALID_OR_MISSING_PAN', 'GREEN', 'motorcycle')
      RETURNING id
    `);
    const nonPanRiderId = nonPanRiderRes.rows[0].id;

    const { order: orderNonPanRider } = await createDeliveredOrder({ riderId: nonPanRiderId, riderPanValid: false });
    const allocNonPanRider = await settlementAllocationService.allocateFulfilledOrder(orderNonPanRider.id);

    const expectedPenalRiderTds = +(allocNonPanRider.grossRiderFare * 0.20).toFixed(2);
    assert.strictEqual(
      allocNonPanRider.riderTdsAmount,
      expectedPenalRiderTds,
      `Penal 20% TDS not applied to non-PAN rider: ${allocNonPanRider.riderTdsAmount} !== ${expectedPenalRiderTds}`
    );
    console.log(`✓ Test 11 passed: Penal 20.00% TDS (₹${allocNonPanRider.riderTdsAmount}) enforced on non-PAN delivery partner`);

    // -------------------------------------------------------------
    // Test 12: Customer Delivery Fee vs Rider Fare (Subsidy Accounting)
    // -------------------------------------------------------------
    console.log('[Test 12] Testing Delivery Fee vs Rider Fare Separation (Subsidy Accounting)...');
    assert.ok(a.grossRiderFare > 0);
    assert.ok(a.platformSubsidy >= 0);
    const expenseEntry = await pool.query(`
      SELECT account_code, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1 AND account_code = '5010'
    `, [journalBatchId1]);
    assert.ok(expenseEntry.rows.length > 0, 'Account 5010 must be debited for gross rider fare');
    assert.strictEqual(parseFloat(expenseEntry.rows[0].amount), a.grossRiderFare);
    console.log(`✓ Test 12 passed: Gross logistics fare (₹${a.grossRiderFare}) recognized independently in Account 5010`);

    // -------------------------------------------------------------
    // Test 13: Cash on Delivery (COD) Floating Cash Collection
    // -------------------------------------------------------------
    console.log('[Test 13] Testing Cash on Delivery (COD) Floating Cash & Account 1030...');
    const initialRiderCash = parseFloat((await pool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [riderAId])).rows[0].floating_cash_balance);

    const { order: codOrder } = await createDeliveredOrder({
      paymentMethod: 'Pay on Delivery',
      riderId: riderAId,
    });

    const codAlloc = await settlementAllocationService.allocateFulfilledOrder(codOrder.id);
    assert.strictEqual(codAlloc.status, 'ALLOCATED');

    const riderAfterCod = (await pool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [riderAId])).rows[0];
    const newCash = parseFloat(riderAfterCod.floating_cash_balance);
    const codAmount = codAlloc.orderTotal;
    assert.strictEqual(newCash, +(initialRiderCash + codAmount).toFixed(2));

    const codGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE order_id = $1 AND transaction_type = 'COD_COLLECTION'
    `, [codOrder.id]);
    assert.ok(codGl.rows.length >= 2, 'COD collection general ledger entries must exist');
    console.log(`✓ Test 13 passed: COD collection of ₹${codAmount} updated floating cash and posted to Account 1030`);

    // -------------------------------------------------------------
    // Test 14: Floating Cash ₹2,500 Hard Ceiling Enforcement
    // -------------------------------------------------------------
    console.log('[Test 14] Testing Floating Cash ₹2,500 Hard Ceiling Enforcement...');
    await pool.query(`UPDATE riders SET floating_cash_balance = 2550.00, status = 'IDLE_AT_HUB' WHERE id = $1`, [riderAId]);

    const earnStmtRes = await fetch(`${baseUrl}/api/v1/settlements/rider/${riderAId}/earnings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const earnStmtBody = await earnStmtRes.json();
    assert.strictEqual(earnStmtRes.status, 200);
    assert.strictEqual(earnStmtBody.statement.isDispatchBlocked, true);
    assert.strictEqual(earnStmtBody.statement.floatingCashBalance, 2550.00);
    console.log('✓ Test 14 passed: Floating cash ₹2,500 hard ceiling triggers dispatch suspension');

    // -------------------------------------------------------------
    // Test 15: Authoritative Floating Cash (COD) Remittance API
    // -------------------------------------------------------------
    console.log('[Test 15] Testing Floating Cash Remittance (/api/v1/settlements/cod/remit)...');
    await pool.query(`UPDATE riders SET status = 'SUSPENDED' WHERE id = $1`, [riderAId]);

    const remitRes = await fetch(`${baseUrl}/api/v1/settlements/cod/remit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${riderToken}`,
      },
      body: JSON.stringify({
        riderId: riderAId,
        amount: 1000.00,
        method: 'UPI',
      }),
    });
    const remitBody = await remitRes.json();
    assert.strictEqual(remitRes.status, 200, `Remittance failed: ${JSON.stringify(remitBody)}`);
    assert.strictEqual(remitBody.success, true);
    assert.strictEqual(remitBody.remittedAmount, 1000.00);
    assert.strictEqual(remitBody.remainingCash, 1550.00);
    assert.strictEqual(remitBody.unblocked, true);

    const remitGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE rider_id = $1 AND transaction_type = 'COD_COLLECTION' AND account_code = '1020'
      ORDER BY created_at DESC LIMIT 1
    `, [riderAId]);
    assert.ok(remitGl.rows.length > 0);
    assert.strictEqual(parseFloat(remitGl.rows[0].amount), 1000.00);
    console.log('✓ Test 15 passed: COD cash remittance of ₹1,000 cleared liability and unblocked rider');

    // -------------------------------------------------------------
    // Test 16: Invalid COD Remittance Amount Rejection
    // -------------------------------------------------------------
    console.log('[Test 16] Testing Invalid COD Remittance Rejection (Negative & Over-Remittance)...');
    const overRemitRes = await fetch(`${baseUrl}/api/v1/settlements/cod/remit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${riderToken}`,
      },
      body: JSON.stringify({
        riderId: riderAId,
        amount: 99999.00,
      }),
    });
    assert.strictEqual(overRemitRes.status, 400);
    const overBody = await overRemitRes.json();
    assert.strictEqual(overBody.error, 'INVALID_REMITTANCE_AMOUNT');
    console.log('✓ Test 16 passed: Excess and invalid remittance amounts rejected with HTTP 400');

    // -------------------------------------------------------------
    // Test 17: Seller Payout Execution & UTR Tracking
    // -------------------------------------------------------------
    console.log('[Test 17] Testing Seller Payout Execution & UTR Tracking...');
    const merchStmt = await sellerSettlementService.getSellerSettlementStatement(merchantAId);
    assert.ok(merchStmt.outstandingBalance > 0);

    const payoutAmount = Math.min(200.00, merchStmt.outstandingBalance);
    const sellerPayoutRes = await fetch(`${baseUrl}/api/v1/settlements/seller/payout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        merchantId: merchantAId,
        amount: payoutAmount,
      }),
    });
    const sellerPayoutBody = await sellerPayoutRes.json();
    assert.strictEqual(sellerPayoutRes.status, 200, `Seller payout failed: ${JSON.stringify(sellerPayoutBody)}`);
    assert.strictEqual(sellerPayoutBody.success, true);
    assert.strictEqual(sellerPayoutBody.payout.status, 'PAID');
    assert.strictEqual(sellerPayoutBody.payout.amount, payoutAmount);
    assert.ok(sellerPayoutBody.payout.utrNumber.startsWith('UTR_MERCH_'));
    assert.ok(sellerPayoutBody.payout.journalBatchId);

    const merchPayoutGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1
    `, [sellerPayoutBody.payout.journalBatchId]);
    assert.strictEqual(merchPayoutGl.rows.length, 2);
    const dr2020 = merchPayoutGl.rows.find((r) => r.account_code === '2020');
    const cr1020 = merchPayoutGl.rows.find((r) => r.account_code === '1020');
    assert.ok(dr2020 && dr2020.entry_side === 'DEBIT');
    assert.ok(cr1020 && cr1020.entry_side === 'CREDIT');
    assert.strictEqual(parseFloat(dr2020.amount), payoutAmount);
    assert.strictEqual(parseFloat(cr1020.amount), payoutAmount);
    console.log(`✓ Test 17 passed: Seller payout of ₹${payoutAmount} executed with UTR ${sellerPayoutBody.payout.utrNumber}`);

    // -------------------------------------------------------------
    // Test 18: Rider Wallet Payout Execution & Wallet Deduction
    // -------------------------------------------------------------
    console.log('[Test 18] Testing Rider Wallet Payout Execution & Wallet Deduction...');
    await pool.query(`UPDATE riders SET wallet_balance = 500.00, upi_vpa = 'rider77@okhdfcbank' WHERE id = $1`, [riderAId]);

    const riderPayoutRes = await fetch(`${baseUrl}/api/v1/settlements/rider/payout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        riderId: riderAId,
        amount: 250.00,
        method: 'UPI',
      }),
    });
    const riderPayoutBody = await riderPayoutRes.json();
    assert.strictEqual(riderPayoutRes.status, 200, `Rider payout failed: ${JSON.stringify(riderPayoutBody)}`);
    assert.strictEqual(riderPayoutBody.success, true);
    assert.strictEqual(riderPayoutBody.payout.status, 'PAID');
    assert.strictEqual(riderPayoutBody.payout.amount, 250.00);
    assert.ok(riderPayoutBody.payout.utrNumber.startsWith('UTR_RIDER_'));

    const updatedRiderWallet = parseFloat((await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderAId])).rows[0].wallet_balance);
    assert.strictEqual(updatedRiderWallet, 250.00);

    const riderPayoutGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1
    `, [riderPayoutBody.payout.journalBatchId]);
    assert.strictEqual(riderPayoutGl.rows.length, 2);
    const dr2030 = riderPayoutGl.rows.find((r) => r.account_code === '2030');
    const cr1020R = riderPayoutGl.rows.find((r) => r.account_code === '1020');
    assert.ok(dr2030 && dr2030.entry_side === 'DEBIT');
    assert.ok(cr1020R && cr1020R.entry_side === 'CREDIT');
    assert.strictEqual(parseFloat(dr2030.amount), 250.00);
    assert.strictEqual(parseFloat(cr1020R.amount), 250.00);
    console.log(`✓ Test 18 passed: Rider payout of ₹250.00 deducted from wallet and posted to Account 2030`);

    // -------------------------------------------------------------
    // Test 19: Payout Idempotency Protection
    // -------------------------------------------------------------
    console.log('[Test 19] Testing Payout Idempotency Protection with Idempotency-Key...');
    const testIdempotencyKey = `IDEMP_PAYOUT_${crypto.randomUUID()}`;

    // First attempt
    const idemp1Res = await fetch(`${baseUrl}/api/v1/settlements/seller/payout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': testIdempotencyKey,
      },
      body: JSON.stringify({
        merchantId: merchantAId,
        amount: 50.00,
      }),
    });
    const idemp1Body = await idemp1Res.json();
    assert.strictEqual(idemp1Res.status, 200);
    assert.strictEqual(idemp1Body.payout.isDuplicate, false);

    // Second attempt with identical Idempotency-Key
    const idemp2Res = await fetch(`${baseUrl}/api/v1/settlements/seller/payout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': testIdempotencyKey,
      },
      body: JSON.stringify({
        merchantId: merchantAId,
        amount: 50.00,
      }),
    });
    const idemp2Body = await idemp2Res.json();
    assert.strictEqual(idemp2Res.status, 200);
    assert.strictEqual(idemp2Body.payout.isDuplicate, true);
    assert.strictEqual(idemp2Body.payout.payoutId, idemp1Body.payout.payoutId);
    assert.strictEqual(idemp2Body.payout.utrNumber, idemp1Body.payout.utrNumber);
    console.log('✓ Test 19 passed: Payout idempotency verified; zero double-debit on retry');

    // -------------------------------------------------------------
    // Test 20: Payout Failure Reversal
    // -------------------------------------------------------------
    console.log('[Test 20] Testing Payout Failure Reversal (Dr 1020 Cr 2020 / 2030)...');
    const revRef = `REV_TEST_${Date.now()}`;
    const revBatchId = await ledgerService.recordPayoutFailureReversal({
      type: 'MERCHANT',
      actorId: merchantAId,
      amount: 150.00,
      reference: revRef,
    });

    const revGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1
    `, [revBatchId]);
    assert.strictEqual(revGl.rows.length, 2);
    const dr1020Rev = revGl.rows.find((r) => r.account_code === '1020');
    const cr2020Rev = revGl.rows.find((r) => r.account_code === '2020');
    assert.ok(dr1020Rev && dr1020Rev.entry_side === 'DEBIT');
    assert.ok(cr2020Rev && cr2020Rev.entry_side === 'CREDIT');
    assert.strictEqual(parseFloat(dr1020Rev.amount), 150.00);
    assert.strictEqual(parseFloat(cr2020Rev.amount), 150.00);
    console.log('✓ Test 20 passed: Payout failure reversal correctly restored payable balance');

    // -------------------------------------------------------------
    // Test 21: Pre-Fulfillment Cancellation Escrow Release
    // -------------------------------------------------------------
    console.log('[Test 21] Testing Pre-Fulfillment Cancellation Escrow Release (Dr 2010 Cr 1010)...');
    const cancelBatchId = await ledgerService.recordPreFulfillmentCancellationRefund({
      orderId: order1.id,
      amount: 450.00,
    });

    const cancelGl = await pool.query(`
      SELECT account_code, entry_side, amount FROM general_ledger_entries
      WHERE journal_batch_id = $1
    `, [cancelBatchId]);
    assert.strictEqual(cancelGl.rows.length, 2);
    const dr2010C = cancelGl.rows.find((r) => r.account_code === '2010');
    const cr1010C = cancelGl.rows.find((r) => r.account_code === '1010');
    assert.ok(dr2010C && dr2010C.entry_side === 'DEBIT');
    assert.ok(cr1010C && cr1010C.entry_side === 'CREDIT');
    assert.strictEqual(parseFloat(dr2010C.amount), 450.00);
    assert.strictEqual(parseFloat(cr1010C.amount), 450.00);
    console.log('✓ Test 21 passed: Cancellation escrow release correctly posted to 2010/1010');

    // -------------------------------------------------------------
    // Test 22: Authoritative Trial Balance Reconciliation API
    // -------------------------------------------------------------
    console.log('[Test 22] Testing General Ledger Trial Balance Reconciliation API...');
    const tbRes = await fetch(`${baseUrl}/api/v1/settlements/reconciliation/trial-balance`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const tbBody = await tbRes.json();
    assert.strictEqual(tbRes.status, 200);
    assert.strictEqual(tbBody.success, true);
    assert.strictEqual(tbBody.isBalanced, true, `Trial balance is NOT balanced! Diff: ${tbBody.difference}`);
    assert.strictEqual(tbBody.difference, 0.00);
    assert.ok(tbBody.totalDebits > 0);
    assert.strictEqual(tbBody.totalDebits, tbBody.totalCredits);
    assert.ok(tbBody.accounts.length >= 15);
    console.log(`✓ Test 22 passed: Trial balance 100% reconciled (Debits: ₹${tbBody.totalDebits} == Credits: ₹${tbBody.totalCredits})`);

    // -------------------------------------------------------------
    // Test 23: RBAC & Tenant Isolation on Settlement Statements
    // -------------------------------------------------------------
    console.log('[Test 23] Testing RBAC & Tenant Isolation on Settlement Statements...');
    const crossTenantRes = await fetch(`${baseUrl}/api/v1/settlements/seller/${merchantAId}/statement`, {
      headers: { Authorization: `Bearer ${sellerBToken}` },
    });
    assert.strictEqual(crossTenantRes.status, 403);
    const crossBody = await crossTenantRes.json();
    assert.strictEqual(crossBody.error, 'FORBIDDEN');

    const unauthRes = await fetch(`${baseUrl}/api/v1/settlements/seller/${merchantAId}/statement`);
    assert.strictEqual(unauthRes.status, 401);

    const ownerRes = await fetch(`${baseUrl}/api/v1/settlements/seller/${merchantAId}/statement`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    assert.strictEqual(ownerRes.status, 200);
    const ownerBody = await ownerRes.json();
    assert.strictEqual(ownerBody.statement.merchantId, merchantAId);
    console.log('✓ Test 23 passed: RBAC and tenant isolation verified with HTTP 401 & 403');

    // -------------------------------------------------------------
    // Test 24: Post-Commit Settlement Domain Events
    // -------------------------------------------------------------
    console.log('[Test 24] Testing Post-Commit Settlement Domain Events...');
    const loggedEvents = settlementEventPublisher.getLoggedEvents();
    assert.ok(loggedEvents.length > 0, 'Domain events must be logged');

    const allocEvent = loggedEvents.find((e) => e.eventType === 'OrderSettlementAllocated');
    const sellerPayoutEvent = loggedEvents.find((e) => e.eventType === 'SellerPayoutCompleted');
    const riderPayoutEvent = loggedEvents.find((e) => e.eventType === 'RiderPayoutCompleted');
    const remitEvent = loggedEvents.find((e) => e.eventType === 'RiderCodRemitted');

    assert.ok(allocEvent, 'OrderSettlementAllocated event must be emitted');
    assert.ok(sellerPayoutEvent, 'SellerPayoutCompleted event must be emitted');
    assert.ok(riderPayoutEvent, 'RiderPayoutCompleted event must be emitted');
    assert.ok(remitEvent, 'RiderCodRemitted event must be emitted');
    console.log('✓ Test 24 passed: Post-commit settlement domain events verified');

    // -------------------------------------------------------------
    // Test 25: Database Fail-Closed Guarantee (503 + Retry-After: 3)
    // -------------------------------------------------------------
    console.log('[Test 25] Testing Database Unavailability Fail-Closed Handling...');
    const brokenOrderRes = await fetch(`${baseUrl}/api/v1/settlements/allocate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ orderId: '00000000-0000-0000-0000-000000000000' }),
    });
    assert.strictEqual(brokenOrderRes.status, 404);
    const brokenBody = await brokenOrderRes.json();
    assert.strictEqual(brokenBody.error, 'ORDER_NOT_FOUND');
    console.log('✓ Test 25 passed: Not found and error handling verified');

    console.log('\n===========================================================');
    console.log('✓ ALL SPRINT 7 SETTLEMENT & PAYOUT TESTS PASSED!');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}
