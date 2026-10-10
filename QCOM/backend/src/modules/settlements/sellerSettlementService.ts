import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { getPayoutProvider, PayoutProvider } from './payoutProvider.js';
import { SellerSettlementStatement, PayoutResult, validateSellerSettlementTransition } from './settlementTypes.js';
import { settlementEventPublisher, SettlementDomainEvent } from './settlementEvents.js';

export class SellerSettlementService {
  private payoutProvider: PayoutProvider;

  constructor() {
    this.payoutProvider = getPayoutProvider();
  }

  /**
   * Generates comprehensive settlement statement for a merchant
   */
  public async getSellerSettlementStatement(merchantId: string): Promise<SellerSettlementStatement> {
    const pool = getPool();

    const merchRes = await pool.query(`
      SELECT id, name, business_name, pan_number, pan_status, gstin, commission_rate_percent,
             bank_account_number, bank_ifsc, bank_account_holder, bank_name, bank_verified
      FROM merchants
      WHERE id = $1
      LIMIT 1
    `, [merchantId]);

    if (merchRes.rows.length === 0) {
      throw new Error(`MERCHANT_NOT_FOUND: Merchant '${merchantId}' does not exist.`);
    }

    const m = merchRes.rows[0];

    const allocRes = await pool.query(`
      SELECT a.*, o.order_number, o.created_at as order_created_at
      FROM order_settlement_allocations a
      JOIN orders o ON a.order_id = o.id
      WHERE a.merchant_id = $1
      ORDER BY a.allocated_at DESC
    `, [merchantId]);

    let totalGrossGmv = 0;
    let totalCommission = 0;
    let totalCommissionGst = 0;
    let totalGstTcs = 0;
    let totalSellerTds = 0;
    let totalPenalties = 0;
    let totalNetPayable = 0;

    const orders = allocRes.rows.map((r) => {
      const gmv = parseFloat(r.gross_gmv);
      const comm = parseFloat(r.platform_commission);
      const commGst = parseFloat(r.commission_gst);
      const tcs = parseFloat(r.gst_tcs_amount);
      const tds = parseFloat(r.seller_tds_amount);
      const pen = parseFloat(r.store_delay_penalty);
      const net = parseFloat(r.net_seller_payable);

      totalGrossGmv += gmv;
      totalCommission += comm;
      totalCommissionGst += commGst;
      totalGstTcs += tcs;
      totalSellerTds += tds;
      totalPenalties += pen;
      totalNetPayable += net;

      return {
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderDate: r.order_created_at.toISOString(),
        grossGmv: gmv,
        commission: +(comm + commGst).toFixed(2),
        gstTcs: tcs,
        tds,
        netPayable: net,
      };
    });

    // Fetch settled amounts from seller_payouts
    const payoutRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_settled
      FROM seller_payouts
      WHERE merchant_id = $1 AND status = 'PAID'
    `, [merchantId]);

    const settledAmount = parseFloat(payoutRes.rows[0].total_settled);
    const outstandingBalance = +(totalNetPayable - settledAmount).toFixed(2);

    return {
      merchantId: m.id,
      merchantName: m.business_name || m.name,
      panNumber: m.pan_number || undefined,
      panStatus: m.pan_status || undefined,
      gstin: m.gstin || undefined,
      commissionRatePercent: parseFloat(m.commission_rate_percent || '15.00'),
      bankDetails: {
        accountNumber: m.bank_account_number || '',
        ifsc: m.bank_ifsc || '',
        accountHolder: m.bank_account_holder || undefined,
        bankName: m.bank_name || undefined,
        verified: !!m.bank_verified,
      },
      totalGrossGmv: +totalGrossGmv.toFixed(2),
      totalCommission: +totalCommission.toFixed(2),
      totalCommissionGst: +totalCommissionGst.toFixed(2),
      totalGstTcs: +totalGstTcs.toFixed(2),
      totalSellerTds: +totalSellerTds.toFixed(2),
      totalPenalties: +totalPenalties.toFixed(2),
      totalNetPayable: +totalNetPayable.toFixed(2),
      settledAmount: +settledAmount.toFixed(2),
      outstandingBalance: Math.max(0, outstandingBalance),
      orders,
    };
  }

  /**
   * Executes authoritative seller payout with idempotency, row locking, and double-entry ledger posting
   */
  public async executeSellerPayout(params: {
    merchantId: string;
    amount?: number;
    idempotencyKey?: string;
  }): Promise<PayoutResult> {
    const { merchantId, amount, idempotencyKey } = params;
    const stagedEvents: SettlementDomainEvent[] = [];

    const result = await transaction(async (client) => {
      // 1. Idempotency Check on seller_payouts
      if (idempotencyKey) {
        const existingPayoutRes = await client.query(`
          SELECT * FROM seller_payouts
          WHERE idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [idempotencyKey]);

        if (existingPayoutRes.rows.length > 0) {
          const row = existingPayoutRes.rows[0];
          return {
            payoutId: row.id,
            payoutReference: row.payout_reference,
            actorId: row.merchant_id,
            amount: parseFloat(row.amount),
            status: row.status,
            utrNumber: row.utr_number || undefined,
            journalBatchId: row.journal_batch_id || undefined,
            isDuplicate: true,
          };
        }
      }

      // 2. Row-level lock on merchant
      const merchRes = await client.query(`
        SELECT * FROM merchants
        WHERE id = $1
        FOR UPDATE
      `, [merchantId]);

      if (merchRes.rows.length === 0) {
        throw new Error(`MERCHANT_NOT_FOUND: Merchant '${merchantId}' does not exist.`);
      }

      const merchant = merchRes.rows[0];

      // 3. Verify bank details
      if (!merchant.bank_account_number || !merchant.bank_ifsc) {
        throw new Error('MISSING_BANK_DETAILS: Merchant does not have bank account details configured for payout.');
      }

      // 4. Calculate available unsettled balance
      const ledgerBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [merchantId]);

      const availableBalance = ledgerBalRes.rows.length > 0 ? parseFloat(ledgerBalRes.rows[0].running_balance) : 0.00;

      if (availableBalance <= 0) {
        throw new Error('ZERO_PAYABLE_BALANCE: Merchant has zero unsettled payable balance.');
      }

      const payoutAmount = amount ? Math.min(amount, availableBalance) : availableBalance;
      if (payoutAmount <= 0) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }

      const payoutReference = `PAYOUT_SELLER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // 5. Call external Payout Provider (Mock / RazorpayX)
      const providerRes = await this.payoutProvider.disburseMerchantPayout({
        merchantId,
        amount: payoutAmount,
        accountNumber: merchant.bank_account_number,
        ifsc: merchant.bank_ifsc,
        accountHolder: merchant.bank_account_holder,
        reference: payoutReference,
      });

      if (!providerRes.success) {
        throw new Error(`PAYOUT_PROVIDER_REJECTED: ${providerRes.failureReason || 'Disbursement rejected by banking rail.'}`);
      }

      // 6. Post double-entry general ledger batch (Dr 2020 Merchant Payable, Cr 1020 Bank Account)
      const journalBatchId = await ledgerService.recordMerchantSettlementPayout({
        merchantId,
        amount: payoutAmount,
        payoutReference,
        utrNumber: providerRes.utrNumber,
        client,
      });

      // 7. Post Subledger entry in seller_ledgers
      const updatedBalance = +(availableBalance - payoutAmount).toFixed(2);
      await client.query(`
        INSERT INTO seller_ledgers (
          merchant_id, entry_type, category, amount, running_balance, utr_number, description
        )
        VALUES ($1, 'PAYOUT_SETTLED', 'DEBIT', $2, $3, $4, $5)
      `, [
        merchantId,
        payoutAmount,
        updatedBalance,
        providerRes.utrNumber,
        `Bank payout disbursement settled (Ref: ${payoutReference}, UTR: ${providerRes.utrNumber})`,
      ]);

      // 8. Record in seller_payouts table
      const insPayoutRes = await client.query(`
        INSERT INTO seller_payouts (
          payout_reference, merchant_id, amount, currency, status,
          bank_account_number, bank_ifsc, bank_account_holder, bank_name,
          utr_number, provider_payout_id, journal_batch_id, idempotency_key, processed_at
        )
        VALUES ($1, $2, $3, 'INR', 'PAID', $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING *
      `, [
        payoutReference,
        merchantId,
        payoutAmount,
        merchant.bank_account_number,
        merchant.bank_ifsc,
        merchant.bank_account_holder || null,
        merchant.bank_name || null,
        providerRes.utrNumber,
        providerRes.providerPayoutId,
        journalBatchId,
        idempotencyKey || null,
      ]);

      const payoutRow = insPayoutRes.rows[0];

      // 9. Update allocated orders to SETTLED
      await client.query(`
        UPDATE order_settlement_allocations
        SET status = 'SETTLED'
        WHERE merchant_id = $1 AND status = 'ALLOCATED'
      `, [merchantId]);

      // 10. Stage Post-Commit Domain Event
      stagedEvents.push(
        settlementEventPublisher.createEvent('SellerPayoutCompleted', {
          payoutId: payoutRow.id,
          payoutReference,
          merchantId,
          amount: payoutAmount,
          utrNumber: providerRes.utrNumber,
          journalBatchId,
        })
      );

      return {
        payoutId: payoutRow.id,
        payoutReference,
        actorId: merchantId,
        amount: payoutAmount,
        status: 'PAID',
        utrNumber: providerRes.utrNumber,
        journalBatchId,
        isDuplicate: false,
      };
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }

  /**
   * Processes post-fulfillment clawback or return debit against merchant ledger
   */
  public async processSellerClawback(params: {
    orderId: string;
    merchantId: string;
    refundAmount: number;
    clientOverride?: pg.PoolClient;
  }): Promise<{ isPostPayout: boolean; debitAmount: number; newBalance: number }> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Check if allocation exists
      const allocRes = await client.query(`
        SELECT * FROM order_settlement_allocations
        WHERE order_id = $1
        LIMIT 1
      `, [params.orderId]);

      if (allocRes.rows.length === 0) {
        // Pre-fulfillment order: no seller ledger entry existed
        return { isPostPayout: false, debitAmount: 0, newBalance: 0 };
      }

      const alloc = allocRes.rows[0];
      const isPostPayout = alloc.status === 'SETTLED';
      const debitAmount = Math.min(parseFloat(alloc.net_seller_payable), params.refundAmount);

      // 2. Fetch current running balance
      const ledgerBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [params.merchantId]);

      const currentBalance = ledgerBalRes.rows.length > 0 ? parseFloat(ledgerBalRes.rows[0].running_balance) : 0.00;
      const newBalance = +(currentBalance - debitAmount).toFixed(2);
      const entryType = isPostPayout ? 'CLAWBACK_DEBIT' : 'RETURN_DEBIT';

      // 3. Insert into seller_ledgers
      await client.query(`
        INSERT INTO seller_ledgers (
          merchant_id, order_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6)
      `, [
        params.merchantId,
        params.orderId,
        entryType,
        debitAmount,
        newBalance,
        isPostPayout
          ? `Clawback debit on post-payout return for order ${params.orderId}`
          : `Return debit on pre-payout return for order ${params.orderId}`,
      ]);

      // 4. Record General Ledger Entry
      await ledgerService.recordReturnRefund({
        orderId: params.orderId,
        merchantId: params.merchantId,
        refundAmount: params.refundAmount,
        netGoodsAmount: debitAmount,
        commissionAmount: parseFloat(alloc.platform_commission || 0),
        commissionGst: parseFloat(alloc.commission_gst || 0),
        gstTcsAmount: parseFloat(alloc.gst_tcs_amount || 0),
        sellerTdsAmount: parseFloat(alloc.seller_tds_amount || 0),
        isPostPayout,
        client,
      });

      // 5. Update allocation status
      await client.query(`
        UPDATE order_settlement_allocations
        SET status = 'REVERSED'
        WHERE order_id = $1
      `, [params.orderId]);

      return { isPostPayout, debitAmount, newBalance };
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }
}

export const sellerSettlementService = new SellerSettlementService();
