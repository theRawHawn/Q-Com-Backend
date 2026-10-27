import pg from 'pg';
import crypto from 'crypto';
import { getPool } from '../../database/connection.js';

export interface LedgerPaymentEntry {
  orderId: string;
  merchantId: string;
  grossAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  deliveryFee: number;
  handlingFee: number;
  client?: pg.PoolClient;
}

export interface FulfillmentAllocationLedgerParams {
  orderId: string;
  merchantId: string;
  riderId?: string;
  orderTotal: number;
  netSellerPayable: number;
  grossRiderFare: number;
  netRiderPayable: number;
  riderTdsAmount: number;
  platformCommission: number;
  commissionGst: number;
  customerDeliveryFee: number;
  deliveryFeeGst: number;
  customerHandlingFee: number;
  handlingFeeGst: number;
  storeDelayPenalty: number;
  gstTcsAmount: number;
  sellerTdsAmount: number;
  client?: pg.PoolClient;
}

export class LedgerService {
  /**
   * Batch A: Customer Online Payment Capture
   * Dr 1010 Cash at Gateway (Escrow), Cr 2010 Customer Funds Held in Escrow
   */
  public async recordOrderPayment(entry: LedgerPaymentEntry): Promise<string> {
    const runner = entry.client || getPool();
    const txRef = `TX_PAY_${entry.orderId}`;

    // Idempotency guard: Return existing batch if already posted
    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    // 1. Debit: Cash at Payment Gateway (Escrow) - Account 1010
    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        order_id, merchant_id, narration
      )
      VALUES ($1, $2, 'CUSTOMER_PAYMENT', '1010', 'DEBIT', $3, 'INR', $4, $5, $6)
      ON CONFLICT (transaction_reference, account_code, entry_side) DO NOTHING
    `, [
      journalBatchId,
      txRef,
      entry.grossAmount,
      entry.orderId,
      entry.merchantId,
      `Customer payment escrow for order ${entry.orderId}`,
    ]);

    // 2. Credit: Customer Funds Held in Escrow - Account 2010
    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        order_id, merchant_id, narration
      )
      VALUES ($1, $2, 'CUSTOMER_PAYMENT', '2010', 'CREDIT', $3, 'INR', $4, $5, $6)
      ON CONFLICT (transaction_reference, account_code, entry_side) DO NOTHING
    `, [
      journalBatchId,
      txRef,
      entry.grossAmount,
      entry.orderId,
      entry.merchantId,
      `Escrow liability for order ${entry.orderId}`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch B: Cash on Delivery Collection
   * Dr 1030 Floating Cash in Hands of Riders (COD), Cr 2010 Customer Funds Held in Escrow
   */
  public async recordCodCollection(params: {
    orderId: string;
    merchantId: string;
    riderId: string;
    amount: number;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const txRef = `TX_COD_COLLECT_${params.orderId}`;

    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        order_id, merchant_id, rider_id, narration
      )
      VALUES 
      ($1, $2, 'COD_COLLECTION', '1030', 'DEBIT', $3, 'INR', $4, $5, $6, $7),
      ($1, $2, 'COD_COLLECTION', '2010', 'CREDIT', $3, 'INR', $4, $5, $6, $8)
    `, [
      journalBatchId,
      txRef,
      params.amount,
      params.orderId,
      params.merchantId,
      params.riderId,
      `COD physical collection by rider for order ${params.orderId}`,
      `Customer liability satisfied via COD for order ${params.orderId}`,
    ]);

    return journalBatchId;
  }

  /**
   * Batches C through I: Order Fulfillment Financial Allocation (Atomic Double-Entry Batch)
   * Dr 2010 Customer Escrow (Order Total), Dr 5010 Rider Logistics Expense (Gross Rider Fare)
   * Cr 2020 Merchant Payable, Cr 2030 Rider Wallet, Cr 2060 Rider TDS, Cr 4010 Commission,
   * Cr 4020 Delivery Fee, Cr 4030 Handling Fee & Penalty, Cr 2070 Output GST, Cr 2040 GST-TCS, Cr 2050 Seller TDS
   * Total Debits == Total Credits == Order Total + Gross Rider Fare
   */
  public async recordOrderFulfillmentAllocation(params: FulfillmentAllocationLedgerParams): Promise<string> {
    const runner = params.client || getPool();
    const txRef = `TX_FULFILL_${params.orderId}`;

    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    const totalFeeGst = +(params.commissionGst + params.deliveryFeeGst + params.handlingFeeGst).toFixed(2);
    const totalPlatformCharges = +(params.customerHandlingFee + params.storeDelayPenalty).toFixed(2);

    const entries: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      merchantId?: string;
      riderId?: string;
    }[] = [];

    // 1. Debit Customer Escrow Liability
    entries.push({
      account: '2010',
      side: 'DEBIT',
      amount: params.orderTotal,
      narration: `Release customer escrow liability upon order fulfillment for ${params.orderId}`,
      merchantId: params.merchantId,
      riderId: params.riderId,
    });

    // 2. Debit Rider Logistics Expense
    if (params.grossRiderFare > 0) {
      entries.push({
        account: '5010',
        side: 'DEBIT',
        amount: params.grossRiderFare,
        narration: `Logistics expense recognized for delivery of order ${params.orderId}`,
        merchantId: params.merchantId,
        riderId: params.riderId,
      });
    }

    // 3. Credit Merchant Accounts Payable
    if (params.netSellerPayable > 0) {
      entries.push({
        account: '2020',
        side: 'CREDIT',
        amount: params.netSellerPayable,
        narration: `Net payable allocated to merchant for order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }

    // 4. Credit Delivery Partner Wallet Payable
    if (params.netRiderPayable > 0) {
      entries.push({
        account: '2030',
        side: 'CREDIT',
        amount: params.netRiderPayable,
        narration: `Net fare and tips payable to delivery partner for order ${params.orderId}`,
        riderId: params.riderId,
      });
    }

    // 5. Credit Logistics Withholding Payable (Sec 393 / 194-C)
    if (params.riderTdsAmount > 0) {
      entries.push({
        account: '2060',
        side: 'CREDIT',
        amount: params.riderTdsAmount,
        narration: `TDS withheld on rider logistics fare under Section 393 for order ${params.orderId}`,
        riderId: params.riderId,
      });
    }

    // 6. Credit Marketplace Commission Revenue (SAC 9983)
    if (params.platformCommission > 0) {
      entries.push({
        account: '4010',
        side: 'CREDIT',
        amount: params.platformCommission,
        narration: `Marketplace commission earned under SAC 9983 on order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }

    // 7. Credit Customer Delivery Fee Revenue (SAC 9968)
    if (params.customerDeliveryFee > 0) {
      entries.push({
        account: '4020',
        side: 'CREDIT',
        amount: params.customerDeliveryFee,
        narration: `Customer logistics fee revenue recognized under SAC 9968 for order ${params.orderId}`,
      });
    }

    // 8. Credit Convenience, Handling & Store Delay Fees (SAC 9985)
    if (totalPlatformCharges > 0) {
      entries.push({
        account: '4030',
        side: 'CREDIT',
        amount: totalPlatformCharges,
        narration: `Platform handling fee and merchant delay compensation for order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }

    // 9. Credit Output GST Liability on Platform Fees
    if (totalFeeGst > 0) {
      entries.push({
        account: '2070',
        side: 'CREDIT',
        amount: totalFeeGst,
        narration: `Output GST liability on platform fees (commission, delivery, handling) for order ${params.orderId}`,
      });
    }

    // 10. Credit GST-TCS Section 52 Payable
    if (params.gstTcsAmount > 0) {
      entries.push({
        account: '2040',
        side: 'CREDIT',
        amount: params.gstTcsAmount,
        narration: `Section 52 GST-TCS collected for order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }

    // 11. Credit Income-Tax Withholding Payable (Sec 393 / 194-O)
    if (params.sellerTdsAmount > 0) {
      entries.push({
        account: '2050',
        side: 'CREDIT',
        amount: params.sellerTdsAmount,
        narration: `Section 393 e-commerce TDS withheld from merchant for order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }

    // Enforce exact mathematical Debit == Credit equality
    const totalDebits = +entries
      .filter((e) => e.side === 'DEBIT')
      .reduce((sum, e) => sum + e.amount, 0)
      .toFixed(2);
    const totalCredits = +entries
      .filter((e) => e.side === 'CREDIT')
      .reduce((sum, e) => sum + e.amount, 0)
      .toFixed(2);

    const diff = +(totalDebits - totalCredits).toFixed(2);
    if (Math.abs(diff) > 0.05) {
      throw new Error(`LEDGER_UNBALANCED: Fulfillment journal batch is unbalanced. Debits: ${totalDebits}, Credits: ${totalCredits}, Diff: ${diff}`);
    } else if (diff !== 0) {
      // Absorb fractional rounding difference (< ₹0.05) into convenience/handling revenue (4030) or merchant payable
      const adjEntry = entries.find((e) => e.account === '4030') || entries.find((e) => e.account === '2020');
      if (adjEntry) {
        adjEntry.amount = +(adjEntry.amount + diff).toFixed(2);
      }
    }

    // Insert all entries in batch
    for (const e of entries) {
      await runner.query(`
        INSERT INTO general_ledger_entries (
          journal_batch_id, transaction_reference, transaction_type,
          account_code, entry_side, amount, currency,
          order_id, merchant_id, rider_id, narration
        )
        VALUES ($1, $2, 'ORDER_FULFILLMENT', $3, $4, $5, 'INR', $6, $7, $8, $9)
      `, [
        journalBatchId,
        txRef,
        e.account,
        e.side,
        e.amount,
        params.orderId,
        e.merchantId || null,
        e.riderId || null,
        e.narration,
      ]);
    }

    return journalBatchId;
  }

  /**
   * Batch J: Merchant Settlement Payout Disbursed
   * Dr 2020 Merchant Accounts Payable, Cr 1020 Bank Operating Account
   */
  public async recordMerchantSettlementPayout(params: {
    merchantId: string;
    amount: number;
    payoutReference: string;
    utrNumber?: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const txRef = `TX_MERCH_PAYOUT_${params.payoutReference}`;

    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        merchant_id, narration
      )
      VALUES 
      ($1, $2, 'MERCHANT_SETTLEMENT', '2020', 'DEBIT', $3, 'INR', $4, $5),
      ($1, $2, 'MERCHANT_SETTLEMENT', '1020', 'CREDIT', $3, 'INR', $4, $6)
      ON CONFLICT (transaction_reference, account_code, entry_side) DO NOTHING
    `, [
      journalBatchId,
      txRef,
      params.amount,
      params.merchantId,
      `Disbursement of merchant payable via bank transfer (Ref: ${params.payoutReference}, UTR: ${params.utrNumber || 'PENDING'})`,
      `Bank operating account debit for merchant settlement ${params.payoutReference}`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch L: Rider Payout Disbursed
   * Dr 2030 Delivery Partner Wallet Payable, Cr 1020 Bank Operating Account
   */
  public async recordRiderPayout(params: {
    riderId: string;
    amount: number;
    payoutReference: string;
    utrNumber?: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const txRef = `TX_RIDER_PAYOUT_${params.payoutReference}`;

    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        rider_id, narration
      )
      VALUES 
      ($1, $2, 'RIDER_PAYOUT', '2030', 'DEBIT', $3, 'INR', $4, $5),
      ($1, $2, 'RIDER_PAYOUT', '1020', 'CREDIT', $3, 'INR', $4, $6)
      ON CONFLICT (transaction_reference, account_code, entry_side) DO NOTHING
    `, [
      journalBatchId,
      txRef,
      params.amount,
      params.riderId,
      `Disbursement of rider wallet earnings via UPI/IMPS (Ref: ${params.payoutReference}, UTR: ${params.utrNumber || 'PENDING'})`,
      `Bank operating account disbursement for rider payout ${params.payoutReference}`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch N: Rider Floating Cash (COD) Remittance
   * Dr 1020 Bank Operating Account, Cr 1030 Floating Cash in Hands of Riders
   */
  public async recordRiderCodRemittance(params: {
    riderId: string;
    amount: number;
    reference: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const journalBatchId = crypto.randomUUID();
    const txRef = `TX_COD_REMIT_${params.reference}`;

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        rider_id, narration
      )
      VALUES 
      ($1, $2, 'COD_COLLECTION', '1020', 'DEBIT', $3, 'INR', $4, $5),
      ($1, $2, 'COD_COLLECTION', '1030', 'CREDIT', $3, 'INR', $4, $6)
    `, [
      journalBatchId,
      txRef,
      params.amount,
      params.riderId,
      `Bank operating account receipt for COD remittance (Ref: ${params.reference})`,
      `Clearance of rider floating cash liability (Rider: ${params.riderId})`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch K / M: Payout Failure Reversal
   * Dr 1020 Bank Operating Account, Cr 2020 Merchant Payable / Cr 2030 Rider Wallet
   */
  public async recordPayoutFailureReversal(params: {
    type: 'MERCHANT' | 'RIDER';
    actorId: string;
    amount: number;
    reference: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const journalBatchId = crypto.randomUUID();
    const txRef = `TX_PAYOUT_REV_${params.reference}`;

    const targetAccount = params.type === 'MERCHANT' ? '2020' : '2030';
    const merchantId = params.type === 'MERCHANT' ? params.actorId : null;
    const riderId = params.type === 'RIDER' ? params.actorId : null;

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        merchant_id, rider_id, narration
      )
      VALUES 
      ($1, $2, 'ADJUSTMENT', '1020', 'DEBIT', $3, 'INR', $4, $5, $6),
      ($1, $2, 'ADJUSTMENT', $7, 'CREDIT', $3, 'INR', $4, $5, $8)
    `, [
      journalBatchId,
      txRef,
      params.amount,
      merchantId,
      riderId,
      `Reversal of failed payout funds back to bank operating account (Ref: ${params.reference})`,
      targetAccount,
      `Restoration of payable balance due to failed transfer (Ref: ${params.reference})`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch Q: Pre-Fulfillment Cancellation Escrow Release
   * Dr 2010 Customer Funds Held in Escrow, Cr 1010 Cash at Gateway / Escrow
   */
  public async recordPreFulfillmentCancellationRefund(params: {
    orderId: string;
    refundId?: string;
    refundNumber?: string;
    amount: number;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const refundKey = params.refundNumber || params.refundId || 'FULL';
    const txRef = `TX_CANCEL_REFUND_${params.orderId}_${refundKey}`;

    const existing = await runner.query(`
      SELECT journal_batch_id, amount FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();

    await runner.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency,
        order_id, narration
      )
      VALUES 
      ($1, $2, 'REFUND', '2010', 'DEBIT', $3, 'INR', $4, $5),
      ($1, $2, 'REFUND', '1010', 'CREDIT', $3, 'INR', $4, $6)
      ON CONFLICT (transaction_reference, account_code, entry_side) DO NOTHING
    `, [
      journalBatchId,
      txRef,
      params.amount,
      params.orderId,
      `Cancellation refund: release customer escrow liability for order ${params.orderId} (Ref: ${refundKey})`,
      `Cancellation refund: gateway escrow cash returned for order ${params.orderId} (Ref: ${refundKey})`,
    ]);

    return journalBatchId;
  }

  /**
   * Batch R: Post-Fulfillment Return & Refund General Ledger Entry
   * Pre-Payout: Dr 2020 Merchant Payable (or Dr 2020 + Dr 4010 + Dr 2070 + Dr 2040 + Dr 2050), Cr 1010 Cash at Gateway
   * Post-Payout: Dr 1040 Merchant Receivable (or Dr 1040 + Dr 4010 + Dr 2070 + Dr 2040 + Dr 2050), Cr 1010 Cash at Gateway
   * Guarantees sum(Debits) == sum(Credits) == refundAmount
   */
  public async recordReturnRefund(params: {
    orderId: string;
    merchantId: string;
    refundAmount: number;
    isPostPayout?: boolean;
    netGoodsAmount?: number;
    commissionAmount?: number;
    commissionGst?: number;
    gstTcsAmount?: number;
    sellerTdsAmount?: number;
    returnId?: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const runner = params.client || getPool();
    const txRef = `TX_RETURN_REFUND_${params.returnId || params.orderId}`;

    const existing = await runner.query(`
      SELECT journal_batch_id FROM general_ledger_entries
      WHERE transaction_reference = $1
      LIMIT 1
    `, [txRef]);
    if (existing.rows.length > 0) {
      return existing.rows[0].journal_batch_id;
    }

    const journalBatchId = crypto.randomUUID();
    const refundTotal = +(params.refundAmount).toFixed(2);
    const targetAccount = params.isPostPayout ? '1040' : '2020';

    const comm = +(params.commissionAmount || 0).toFixed(2);
    const commGst = +(params.commissionGst || 0).toFixed(2);
    const tcs = +(params.gstTcsAmount || 0).toFixed(2);
    const tds = +(params.sellerTdsAmount || 0).toFixed(2);
    const feeTotal = +(comm + commGst + tcs + tds).toFixed(2);
    const netGoods = params.netGoodsAmount !== undefined
      ? +params.netGoodsAmount.toFixed(2)
      : +(refundTotal - feeTotal).toFixed(2);

    const entries: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      merchantId?: string;
    }[] = [];

    // 1. Debit Merchant Payable (2020) or Merchant Receivable / Clawback (1040)
    entries.push({
      account: targetAccount,
      side: 'DEBIT',
      amount: netGoods,
      narration: params.isPostPayout
        ? `Post-payout return clawback debit against merchant ${params.merchantId} for order ${params.orderId}`
        : `Pre-payout return debit reducing merchant payable for order ${params.orderId}`,
      merchantId: params.merchantId,
    });

    // 2. Proportional Fee Reversals if applicable
    if (comm > 0) {
      entries.push({
        account: '4010',
        side: 'DEBIT',
        amount: comm,
        narration: `Reversal of commission on returned goods for order ${params.orderId}`,
        merchantId: params.merchantId,
      });
    }
    if (commGst > 0) {
      entries.push({
        account: '2070',
        side: 'DEBIT',
        amount: commGst,
        narration: `Reversal of output GST on platform commission for order ${params.orderId}`,
      });
    }
    if (tcs > 0) {
      entries.push({
        account: '2040',
        side: 'DEBIT',
        amount: tcs,
        narration: `Adjustment of Section 52 GST-TCS on return for order ${params.orderId}`,
      });
    }
    if (tds > 0) {
      entries.push({
        account: '2050',
        side: 'DEBIT',
        amount: tds,
        narration: `Adjustment of Section 393/194-O TDS on return for order ${params.orderId}`,
      });
    }

    // 3. Credit Cash at Gateway / Escrow Account 1010 (Total Refund Amount)
    entries.push({
      account: '1010',
      side: 'CREDIT',
      amount: refundTotal,
      narration: `Gateway refund disbursed to customer for order ${params.orderId}`,
    });

    for (const e of entries) {
      await runner.query(`
        INSERT INTO general_ledger_entries (
          journal_batch_id, transaction_reference, transaction_type,
          account_code, entry_side, amount, currency,
          order_id, merchant_id, narration
        )
        VALUES ($1, $2, 'REFUND', $3, $4, $5, 'INR', $6, $7, $8)
      `, [
        journalBatchId,
        txRef,
        e.account,
        e.side,
        e.amount,
        params.orderId,
        e.merchantId || null,
        e.narration,
      ]);
    }

    return journalBatchId;
  }

  /**
   * Reconciles trial balance across all Chart of Accounts entries
   * Validates sum(Debits) == sum(Credits)
   */
  public async getTrialBalance(client?: pg.PoolClient): Promise<{
    totalDebits: number;
    totalCredits: number;
    isBalanced: boolean;
    difference: number;
    accounts: {
      accountCode: string;
      accountName: string;
      category: string;
      normalBalance: string;
      debitTotal: number;
      creditTotal: number;
      netBalance: number;
    }[];
  }> {
    const runner = client || getPool();

    const res = await runner.query(`
      SELECT 
        a.account_code,
        a.account_name,
        a.category,
        a.normal_balance,
        COALESCE(SUM(CASE WHEN e.entry_side = 'DEBIT' THEN e.amount ELSE 0 END), 0) AS debit_total,
        COALESCE(SUM(CASE WHEN e.entry_side = 'CREDIT' THEN e.amount ELSE 0 END), 0) AS credit_total
      FROM general_ledger_accounts a
      LEFT JOIN general_ledger_entries e ON a.account_code = e.account_code
      GROUP BY a.account_code, a.account_name, a.category, a.normal_balance
      ORDER BY a.account_code ASC
    `);

    let totalDebits = 0;
    let totalCredits = 0;

    const accounts = res.rows.map((r) => {
      const d = parseFloat(r.debit_total);
      const c = parseFloat(r.credit_total);
      totalDebits += d;
      totalCredits += c;
      const net = r.normal_balance === 'DEBIT' ? +(d - c).toFixed(2) : +(c - d).toFixed(2);

      return {
        accountCode: r.account_code,
        accountName: r.account_name,
        category: r.category,
        normalBalance: r.normal_balance,
        debitTotal: +d.toFixed(2),
        creditTotal: +c.toFixed(2),
        netBalance: net,
      };
    });

    totalDebits = +totalDebits.toFixed(2);
    totalCredits = +totalCredits.toFixed(2);
    const difference = +(totalDebits - totalCredits).toFixed(2);
    const isBalanced = Math.abs(difference) === 0;

    return {
      totalDebits,
      totalCredits,
      isBalanced,
      difference,
      accounts,
    };
  }
}

export const ledgerService = new LedgerService();
