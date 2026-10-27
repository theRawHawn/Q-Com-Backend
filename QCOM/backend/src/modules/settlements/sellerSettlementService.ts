import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { getPayoutProvider, PayoutProvider, PayoutDisbursementResult } from './payoutProvider.js';
import { SellerSettlementStatement, PayoutResult, validateSellerSettlementTransition } from './settlementTypes.js';
import { settlementEventPublisher, SettlementDomainEvent } from './settlementEvents.js';
import { isTransientFailure } from '../resilience/retryPolicy.js';

export class AsyncKeyedMutex {
  private queues = new Map<string, Promise<void>>();

  public async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.queues.get(key) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, current.then(() => next));

    await current;
    try {
      return await fn();
    } finally {
      release!();
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }
}

export class SellerSettlementService {
  private payoutProvider: PayoutProvider;
  private mutex = new AsyncKeyedMutex();

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
  /**
   * Executes payout disbursement to merchant bank account.
   * Decoupled into 3 distinct phases:
   *   STEP A (Prepare): Short transaction locking merchant, verifying balance, reserving funds in seller_ledgers, inserting PROCESSING intent.
   *   STEP B (Execute): External banking rail disbursement completely outside of database transactions.
   *   STEP C (Reconcile): Short transaction posting General Ledger entries, setting status to PAID, and completing settlement.
   */
  public async executeSellerPayout(params: {
    merchantId: string;
    amount?: number;
    idempotencyKey?: string;
  }): Promise<PayoutResult> {
    const { merchantId, amount, idempotencyKey } = params;

    // -----------------------------------------------------------------
    // STEP 0: Fast Idempotency Check
    // -----------------------------------------------------------------
    if (idempotencyKey) {
      const pool = getPool();
      const existingPayoutRes = await pool.query(`
        SELECT * FROM seller_payouts
        WHERE idempotency_key = $1
        LIMIT 1
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

    // -----------------------------------------------------------------
    // STEP A: PREPARE INTENT (Short Database Transaction)
    // -----------------------------------------------------------------
    interface PreparedSellerPayout {
      payoutId: string;
      payoutReference: string;
      payoutAmount: number;
      merchant: any;
      isDuplicate: boolean;
      existingRow?: any;
    }

    const prepareResult = await this.mutex.runExclusive(merchantId, () => transaction(async (client): Promise<PreparedSellerPayout> => {
      // Re-verify idempotency under row lock
      if (idempotencyKey) {
        const existingPayoutRes = await client.query(`
          SELECT * FROM seller_payouts
          WHERE idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [idempotencyKey]);

        if (existingPayoutRes.rows.length > 0) {
          return {
            payoutId: existingPayoutRes.rows[0].id,
            payoutReference: existingPayoutRes.rows[0].payout_reference,
            payoutAmount: parseFloat(existingPayoutRes.rows[0].amount),
            merchant: null,
            isDuplicate: true,
            existingRow: existingPayoutRes.rows[0],
          };
        }
      }

      // Row-level lock on merchant
      const merchRes = await client.query(`
        SELECT * FROM merchants
        WHERE id = $1
        FOR UPDATE
      `, [merchantId]);

      if (merchRes.rows.length === 0) {
        throw new Error(`MERCHANT_NOT_FOUND: Merchant '${merchantId}' does not exist.`);
      }

      const merchant = merchRes.rows[0];

      // Verify bank details
      if (!merchant.bank_account_number || !merchant.bank_ifsc) {
        throw new Error('MISSING_BANK_DETAILS: Merchant does not have bank account details configured for payout.');
      }

      // Calculate available unsettled balance
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

      const payoutAmount = amount !== undefined ? amount : availableBalance;
      if (payoutAmount > availableBalance) {
        throw new Error(`INSUFFICIENT_BALANCE: Requested payout amount ₹${payoutAmount} exceeds available balance ₹${availableBalance}`);
      }
      if (payoutAmount <= 0) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }

      const payoutReference = `PAYOUT_SELLER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // Reserve funds in seller_ledgers immediately to block concurrent double-spend
      const updatedBalance = +(availableBalance - payoutAmount).toFixed(2);
      await client.query(`
        INSERT INTO seller_ledgers (
          merchant_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, 'PAYOUT_SETTLED', 'DEBIT', $2, $3, $4)
      `, [
        merchantId,
        payoutAmount,
        updatedBalance,
        `Bank payout disbursement reserved (Ref: ${payoutReference})`,
      ]);

      // Record payout in status 'PROCESSING'
      const insPayoutRes = await client.query(`
        INSERT INTO seller_payouts (
          payout_reference, merchant_id, amount, currency, status,
          bank_account_number, bank_ifsc, bank_account_holder, bank_name,
          idempotency_key
        )
        VALUES ($1, $2, $3, 'INR', 'PROCESSING', $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        payoutReference,
        merchantId,
        payoutAmount,
        merchant.bank_account_number,
        merchant.bank_ifsc,
        merchant.bank_account_holder || null,
        merchant.bank_name || null,
        idempotencyKey || null,
      ]);

      return {
        payoutId: insPayoutRes.rows[0].id,
        payoutReference,
        payoutAmount,
        merchant,
        isDuplicate: false,
      };
    }));

    if (prepareResult.isDuplicate && prepareResult.existingRow) {
      const row = prepareResult.existingRow;
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

    const { payoutId, payoutReference, payoutAmount, merchant } = prepareResult;

    // -----------------------------------------------------------------
    // STEP B: EXECUTE (External Payout Provider - OUTSIDE ANY TRANSACTION)
    // -----------------------------------------------------------------
    // No database connection or row locks are held during external banking API call.
    let providerRes: PayoutDisbursementResult;
    let outcomeUnknown = false;

    try {
      providerRes = await this.payoutProvider.disburseMerchantPayout({
        merchantId,
        amount: payoutAmount,
        accountNumber: merchant.bank_account_number,
        ifsc: merchant.bank_ifsc,
        accountHolder: merchant.bank_account_holder,
        reference: payoutReference,
        idempotencyKey,
      });
    } catch (err: any) {
      if (isTransientFailure(err) || (err.message && err.message.toLowerCase().includes('timeout'))) {
        outcomeUnknown = true;
        providerRes = {
          success: false,
          providerPayoutId: '',
          utrNumber: '',
          status: 'QUEUED',
          failureReason: 'PROVIDER_TIMEOUT_OR_NETWORK_ERROR',
        };
      } else {
        providerRes = {
          success: false,
          providerPayoutId: '',
          utrNumber: '',
          status: 'REJECTED',
          failureReason: err.message || 'Disbursement rejected by banking rail.',
        };
      }
    }

    // -----------------------------------------------------------------
    // STEP C: RECONCILE (Short Database Transaction)
    // -----------------------------------------------------------------
    const stagedEvents: SettlementDomainEvent[] = [];
    const finalResult = await transaction(async (client): Promise<PayoutResult> => {
      const lockRes = await client.query(`
        SELECT * FROM seller_payouts WHERE id = $1 FOR UPDATE
      `, [payoutId]);

      const payoutRow = lockRes.rows[0];
      if (payoutRow.status === 'PAID') {
        return {
          payoutId: payoutRow.id,
          payoutReference: payoutRow.payout_reference,
          actorId: payoutRow.merchant_id,
          amount: parseFloat(payoutRow.amount),
          status: payoutRow.status,
          utrNumber: payoutRow.utr_number || undefined,
          journalBatchId: payoutRow.journal_batch_id || undefined,
          isDuplicate: false,
        };
      }

      if (providerRes.success) {
        // 1. Post double-entry general ledger batch (Dr 2020 Merchant Payable, Cr 1020 Bank Account)
        const journalBatchId = await ledgerService.recordMerchantSettlementPayout({
          merchantId,
          amount: payoutAmount,
          payoutReference,
          utrNumber: providerRes.utrNumber,
          client,
        });

        // 2. Update seller_ledgers description with confirmed UTR
        await client.query(`
          UPDATE seller_ledgers
          SET utr_number = $1,
              description = $2
          WHERE merchant_id = $3 AND description = $4
        `, [
          providerRes.utrNumber,
          `Bank payout disbursement settled (Ref: ${payoutReference}, UTR: ${providerRes.utrNumber})`,
          merchantId,
          `Bank payout disbursement reserved (Ref: ${payoutReference})`,
        ]);

        // 3. Mark payout as PAID
        await client.query(`
          UPDATE seller_payouts
          SET status = 'PAID',
              utr_number = $1,
              provider_payout_id = $2,
              journal_batch_id = $3,
              processed_at = NOW(),
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $4
        `, [providerRes.utrNumber, providerRes.providerPayoutId, journalBatchId, payoutId]);

        // 4. Update allocated orders to SETTLED
        await client.query(`
          UPDATE order_settlement_allocations
          SET status = 'SETTLED'
          WHERE merchant_id = $1 AND status = 'ALLOCATED'
        `, [merchantId]);

        stagedEvents.push(
          settlementEventPublisher.createEvent('SellerPayoutCompleted', {
            payoutId,
            payoutReference,
            merchantId,
            amount: payoutAmount,
            utrNumber: providerRes.utrNumber,
            journalBatchId,
          })
        );

        return {
          payoutId,
          payoutReference,
          actorId: merchantId,
          amount: payoutAmount,
          status: 'PAID',
          utrNumber: providerRes.utrNumber,
          journalBatchId,
          isDuplicate: false,
        };
      } else if (outcomeUnknown) {
        // Critical Ambiguous Outcome Rule: Preserve PROCESSING, do not restore funds without verification
        await client.query(`
          UPDATE seller_payouts
          SET status = 'PROCESSING',
              failure_reason = 'PROVIDER_OUTCOME_UNKNOWN: Awaiting settlement reconciliation.',
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
        `, [payoutId]);

        return {
          payoutId,
          payoutReference,
          actorId: merchantId,
          amount: payoutAmount,
          status: 'PROCESSING',
          failureReason: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting banking rail reconciliation.',
          isDuplicate: false,
        };
      } else {
        // Conclusive failure: lock merchant first (F-10.1A-04 fix), mark FAILED, and restore merchant balance
        await client.query(`
          SELECT id FROM merchants WHERE id = $1 FOR UPDATE
        `, [merchantId]);

        await client.query(`
          UPDATE seller_payouts
          SET status = 'FAILED',
              failure_reason = $1,
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $2
        `, [providerRes.failureReason || 'Disbursement rejected by banking rail.', payoutId]);

        const curBalRes = await client.query(`
          SELECT running_balance FROM seller_ledgers
          WHERE merchant_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [merchantId]);

        const currentRunning = curBalRes.rows.length > 0 ? parseFloat(curBalRes.rows[0].running_balance) : 0;
        const restoredRunning = +(currentRunning + payoutAmount).toFixed(2);

        await client.query(`
          INSERT INTO seller_ledgers (
            merchant_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, 'ADJUSTMENT', 'CREDIT', $2, $3, $4)
        `, [
          merchantId,
          payoutAmount,
          restoredRunning,
          `Restoration of payable balance due to failed bank disbursement (Ref: ${payoutReference})`,
        ]);

        return {
          payoutId,
          payoutReference,
          actorId: merchantId,
          amount: payoutAmount,
          status: 'FAILED',
          failureReason: providerRes.failureReason || 'Disbursement rejected by banking rail.',
          isDuplicate: false,
        };
      }
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    if (finalResult.status === 'FAILED') {
      throw new Error(`PAYOUT_PROVIDER_REJECTED: ${finalResult.failureReason}`);
    }

    return finalResult;
  }

  /**
   * Reconciles a seller payout in PROCESSING state by querying the banking rail provider.
   * Protects against duplicate payouts or premature balance restorations.
   */
  public async reconcileSellerPayout(payoutId: string, expectedLeaseOwner?: string): Promise<PayoutResult> {
    const pool = getPool();
    const lockRes = await pool.query(`
      SELECT * FROM seller_payouts WHERE id = $1
    `, [payoutId]);

    if (lockRes.rows.length === 0) {
      throw new Error(`PAYOUT_NOT_FOUND: Seller payout '${payoutId}' does not exist.`);
    }

    const payout = lockRes.rows[0];
    if (payout.status === 'PAID' || payout.status === 'FAILED') {
      return {
        payoutId: payout.id,
        payoutReference: payout.payout_reference,
        actorId: payout.merchant_id,
        amount: parseFloat(payout.amount),
        status: payout.status,
        utrNumber: payout.utr_number || undefined,
        journalBatchId: payout.journal_batch_id || undefined,
        isDuplicate: false,
      };
    }

    // Provider check OUTSIDE database transaction
    let providerStatus: 'PROCESSED' | 'QUEUED' | 'REJECTED' = 'QUEUED';
    let utrNumber: string | undefined = payout.utr_number || undefined;
    let providerPayoutId: string | undefined = payout.provider_payout_id || undefined;
    let failureReason: string | undefined = payout.failure_reason || undefined;

    if (this.payoutProvider.getPayoutStatus) {
      try {
        const statusRes = await this.payoutProvider.getPayoutStatus({
          reference: payout.payout_reference,
          providerPayoutId: payout.provider_payout_id || undefined,
        });
        providerStatus = statusRes.status;
        if (statusRes.utrNumber) utrNumber = statusRes.utrNumber;
        if (statusRes.providerPayoutId) providerPayoutId = statusRes.providerPayoutId;
        if (statusRes.failureReason) failureReason = statusRes.failureReason;
      } catch {
        // Network timeout during status check -> retain PROCESSING
        providerStatus = 'QUEUED';
      }
    } else if (payout.idempotency_key && this.payoutProvider.getPayoutByIdempotencyKey) {
      const match = await this.payoutProvider.getPayoutByIdempotencyKey(payout.idempotency_key);
      if (match) {
        providerStatus = match.status;
        utrNumber = match.utrNumber;
        providerPayoutId = match.providerPayoutId;
      }
    }

    if (providerStatus === 'QUEUED') {
      // Ambiguous outcome safe policy: retain PROCESSING
      return {
        payoutId: payout.id,
        payoutReference: payout.payout_reference,
        actorId: payout.merchant_id,
        amount: parseFloat(payout.amount),
        status: 'PROCESSING',
        failureReason: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting settlement reconciliation.',
        isDuplicate: false,
      };
    }

    // Step C: Reconcile in short transaction
    const stagedEvents: SettlementDomainEvent[] = [];
    const finalResult = await transaction(async (client): Promise<PayoutResult> => {
      const rowCheck = await client.query(`
        SELECT * FROM seller_payouts WHERE id = $1 FOR UPDATE
      `, [payoutId]);

      if (rowCheck.rows.length === 0) {
        throw new Error(`PAYOUT_NOT_FOUND: Seller payout '${payoutId}' missing during reconciliation.`);
      }

      const curPayout = rowCheck.rows[0];
      if (curPayout.status === 'PAID' || curPayout.status === 'FAILED') {
        return {
          payoutId: curPayout.id,
          payoutReference: curPayout.payout_reference,
          actorId: curPayout.merchant_id,
          amount: parseFloat(curPayout.amount),
          status: curPayout.status,
          utrNumber: curPayout.utr_number || undefined,
          journalBatchId: curPayout.journal_batch_id || undefined,
          isDuplicate: false,
        };
      }

      // Stale-worker fencing check: If an expected lease owner was specified, verify that the lease
      // hasn't expired and been claimed by another active worker.
      if (expectedLeaseOwner && curPayout.recovery_lease_id && curPayout.recovery_lease_id !== expectedLeaseOwner) {
        const leaseExpiry = curPayout.recovery_lease_expires_at ? new Date(curPayout.recovery_lease_expires_at).getTime() : 0;
        if (leaseExpiry > Date.now()) {
          console.warn(`[sellerSettlementService.reconcileSellerPayout] Stale worker commit aborted: Worker '${expectedLeaseOwner}' lost lease to '${curPayout.recovery_lease_id}'.`);
          return {
            payoutId: curPayout.id,
            payoutReference: curPayout.payout_reference,
            actorId: curPayout.merchant_id,
            amount: parseFloat(curPayout.amount),
            status: curPayout.status,
            utrNumber: curPayout.utr_number || undefined,
            journalBatchId: curPayout.journal_batch_id || undefined,
            isDuplicate: true,
          };
        }
      }

      const payoutAmount = parseFloat(curPayout.amount);
      const merchantId = curPayout.merchant_id;
      const payoutReference = curPayout.payout_reference;

      if (providerStatus === 'PROCESSED') {
        const confirmedUtr = utrNumber || `UTR_MERCH_${Date.now()}`;
        const journalBatchId = await ledgerService.recordMerchantSettlementPayout({
          merchantId,
          amount: payoutAmount,
          payoutReference,
          utrNumber: confirmedUtr,
          client,
        });

        await client.query(`
          UPDATE seller_ledgers
          SET utr_number = $1,
              description = $2
          WHERE merchant_id = $3 AND description = $4
        `, [
          confirmedUtr,
          `Bank payout disbursement settled (Ref: ${payoutReference}, UTR: ${confirmedUtr})`,
          merchantId,
          `Bank payout disbursement reserved (Ref: ${payoutReference})`,
        ]);

        await client.query(`
          UPDATE seller_payouts
          SET status = 'PAID',
              utr_number = $1,
              provider_payout_id = COALESCE($2, provider_payout_id),
              journal_batch_id = $3,
              processed_at = NOW(),
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $4
        `, [confirmedUtr, providerPayoutId || null, journalBatchId, payoutId]);

        await client.query(`
          UPDATE order_settlement_allocations
          SET status = 'SETTLED'
          WHERE merchant_id = $1 AND status = 'ALLOCATED'
        `, [merchantId]);

        stagedEvents.push(
          settlementEventPublisher.createEvent('SellerPayoutCompleted', {
            payoutId,
            payoutReference,
            merchantId,
            amount: payoutAmount,
            utrNumber: confirmedUtr,
            journalBatchId,
          })
        );

        return {
          payoutId,
          payoutReference,
          actorId: merchantId,
          amount: payoutAmount,
          status: 'PAID',
          utrNumber: confirmedUtr,
          journalBatchId,
          isDuplicate: false,
        };
      } else {
        // Conclusive rejection: lock merchant, mark FAILED, and restore running balance
        await client.query(`
          SELECT id FROM merchants WHERE id = $1 FOR UPDATE
        `, [merchantId]);

        await client.query(`
          UPDATE seller_payouts
          SET status = 'FAILED',
              failure_reason = $1,
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $2
        `, [failureReason || 'Disbursement rejected by banking rail.', payoutId]);

        const curBalRes = await client.query(`
          SELECT running_balance FROM seller_ledgers
          WHERE merchant_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [merchantId]);

        const currentRunning = curBalRes.rows.length > 0 ? parseFloat(curBalRes.rows[0].running_balance) : 0;
        const restoredRunning = +(currentRunning + payoutAmount).toFixed(2);

        await client.query(`
          INSERT INTO seller_ledgers (
            merchant_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, 'ADJUSTMENT', 'CREDIT', $2, $3, $4)
        `, [
          merchantId,
          payoutAmount,
          restoredRunning,
          `Restoration of payable balance due to failed bank disbursement (Ref: ${payoutReference})`,
        ]);

        return {
          payoutId,
          payoutReference,
          actorId: merchantId,
          amount: payoutAmount,
          status: 'FAILED',
          failureReason: failureReason || 'Disbursement rejected by banking rail.',
          isDuplicate: false,
        };
      }
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return finalResult;
  }
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
