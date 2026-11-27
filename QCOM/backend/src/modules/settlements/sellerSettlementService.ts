import crypto from 'crypto';
import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService, isCodPaymentMethod } from '../ledger/ledgerService.js';
import { getPayoutProvider, PayoutProvider, PayoutDisbursementResult } from './payoutProvider.js';
import { SellerSettlementStatement, PayoutResult } from './settlementTypes.js';
import { settlementEventPublisher, SettlementDomainEvent } from './settlementEvents.js';
import { isTransientFailure } from '../resilience/retryPolicy.js';
import {
  add,
  divide,
  max,
  min,
  multiply,
  roundCurrency,
  subtract,
  toDecimal,
} from '../pricing/money.js';

export async function applyPayoutToAllocationsFIFO(
  client: pg.PoolClient,
  merchantId: string,
  payoutAmount: number
): Promise<void> {
  const openRes = await client.query(`
    SELECT id, net_seller_payable, COALESCE(settled_amount, 0) AS settled_amount, COALESCE(refunded_amount, 0) AS refunded_amount
    FROM order_settlement_allocations
    WHERE merchant_id = $1 AND status = 'ALLOCATED'
    ORDER BY allocated_at ASC, id ASC
    FOR UPDATE
  `, [merchantId]);

  let remainingBn = toDecimal(roundCurrency(payoutAmount));
  for (const row of openRes.rows) {
    if (remainingBn.lte('0.001')) break;
    const netPayableBn = toDecimal(row.net_seller_payable);
    const settledSoFarBn = toDecimal(row.settled_amount || '0');
    const refundedSoFarBn = toDecimal(row.refunded_amount || '0');
    const openPortionBn = BigNumber.max(0, netPayableBn.minus(settledSoFarBn).minus(refundedSoFarBn));
    if (openPortionBn.lte('0.001')) {
      await client.query(
        `UPDATE order_settlement_allocations SET status = 'SETTLED' WHERE id = $1`,
        [row.id]
      );
      continue;
    }
    const appliedBn = toDecimal(roundCurrency(min(remainingBn, openPortionBn)));
    const newSettledBn = toDecimal(roundCurrency(add(settledSoFarBn, appliedBn)));
    const fullySettled = newSettledBn.plus(refundedSoFarBn).gte(netPayableBn.minus('0.01'));
    await client.query(`
      UPDATE order_settlement_allocations
      SET settled_amount = $1,
          status = CASE WHEN $2 THEN 'SETTLED' ELSE status END
      WHERE id = $3
    `, [Number(roundCurrency(newSettledBn)), fullySettled, row.id]);
    remainingBn = remainingBn.minus(appliedBn);
  }
}

export async function revertAllocationsFIFOForReversal(
  client: pg.PoolClient,
  merchantId: string,
  reversedAmount: number
): Promise<void> {
  const settledRes = await client.query(`
    SELECT id, net_seller_payable, COALESCE(settled_amount, 0) AS settled_amount, status
    FROM order_settlement_allocations
    WHERE merchant_id = $1 AND (status = 'SETTLED' OR COALESCE(settled_amount, 0) > 0)
    ORDER BY allocated_at DESC, id DESC
    FOR UPDATE
  `, [merchantId]);

  let remainingBn = toDecimal(roundCurrency(reversedAmount));
  for (const row of settledRes.rows) {
    if (remainingBn.lte('0.001')) break;
    const settledSoFarBn = toDecimal(row.settled_amount || '0');
    const revertableBn = settledSoFarBn.gt(0) ? settledSoFarBn : toDecimal(row.net_seller_payable);
    if (revertableBn.lte(0)) continue;
    const revertedBn = toDecimal(roundCurrency(min(remainingBn, revertableBn)));
    const newSettledBn = BigNumber.max(0, revertableBn.minus(revertedBn));
    await client.query(`
      UPDATE order_settlement_allocations
      SET settled_amount = $1,
          status = CASE WHEN status = 'SETTLED' THEN 'ALLOCATED' ELSE status END
      WHERE id = $2
    `, [Number(roundCurrency(newSettledBn)), row.id]);
    remainingBn = remainingBn.minus(revertedBn);
  }
}

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

    let totalGrossGmvBn = new BigNumber(0);
    let totalCommissionBn = new BigNumber(0);
    let totalCommissionGstBn = new BigNumber(0);
    let totalGstTcsBn = new BigNumber(0);
    let totalSellerTdsBn = new BigNumber(0);
    let totalPenaltiesBn = new BigNumber(0);
    let totalNetPayableBn = new BigNumber(0);

    const orders = allocRes.rows.map((r) => {
      const gmvBn = toDecimal(r.gross_gmv);
      const commBn = toDecimal(r.platform_commission);
      const commGstBn = toDecimal(r.commission_gst);
      const tcsBn = toDecimal(r.gst_tcs_amount);
      const tdsBn = toDecimal(r.seller_tds_amount);
      const penBn = toDecimal(r.store_delay_penalty);
      const netBn = toDecimal(r.net_seller_payable);
      const refundedNetBn = toDecimal(r.refunded_amount || '0');

      if (r.status !== 'REVERSED') {
        const activeNetBn = BigNumber.max(0, netBn.minus(refundedNetBn));
        totalGrossGmvBn = totalGrossGmvBn.plus(gmvBn);
        totalCommissionBn = totalCommissionBn.plus(commBn);
        totalCommissionGstBn = totalCommissionGstBn.plus(commGstBn);
        totalGstTcsBn = totalGstTcsBn.plus(tcsBn);
        totalSellerTdsBn = totalSellerTdsBn.plus(tdsBn);
        totalPenaltiesBn = totalPenaltiesBn.plus(penBn);
        totalNetPayableBn = totalNetPayableBn.plus(activeNetBn);
      }

      return {
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderDate: r.order_created_at.toISOString(),
        grossGmv: Number(roundCurrency(gmvBn)),
        commission: Number(roundCurrency(add(commBn, commGstBn))),
        gstTcs: Number(roundCurrency(tcsBn)),
        tds: Number(roundCurrency(tdsBn)),
        netPayable: Number(roundCurrency(netBn)),
      };
    });

    // Fetch settled amounts from seller_payouts
    const payoutRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_settled
      FROM seller_payouts
      WHERE merchant_id = $1 AND status = 'PAID'
    `, [merchantId]);

    const settledAmountBn = toDecimal(payoutRes.rows[0].total_settled);

    // Authoritative withdrawable balance from seller_ledgers (incorporates reservations, reversals, and clawbacks)
    const ledgerBalRes = await pool.query(`
      SELECT running_balance FROM seller_ledgers
      WHERE merchant_id = $1
      ORDER BY created_at DESC, seq_no DESC
      LIMIT 1
    `, [merchantId]);
    const outstandingBalance = ledgerBalRes.rows.length > 0
      ? Number(roundCurrency(BigNumber.max(0, toDecimal(ledgerBalRes.rows[0].running_balance))))
      : Number(roundCurrency(BigNumber.max(0, totalNetPayableBn.minus(settledAmountBn))));

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
      totalGrossGmv: Number(roundCurrency(totalGrossGmvBn)),
      totalCommission: Number(roundCurrency(totalCommissionBn)),
      totalCommissionGst: Number(roundCurrency(totalCommissionGstBn)),
      totalGstTcs: Number(roundCurrency(totalGstTcsBn)),
      totalSellerTds: Number(roundCurrency(totalSellerTdsBn)),
      totalPenalties: Number(roundCurrency(totalPenaltiesBn)),
      totalNetPayable: Number(roundCurrency(totalNetPayableBn)),
      settledAmount: Number(roundCurrency(settledAmountBn)),
      outstandingBalance,
      orders,
    };
  }

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

    let validatedRequestedAmount: number | undefined;
    if (amount !== undefined) {
      let bn;
      try {
        bn = toDecimal(amount);
      } catch {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be a valid finite number.');
      }
      if (bn.lte(0)) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }
      validatedRequestedAmount = Number(roundCurrency(bn));
    }

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
        if (row.merchant_id !== merchantId) {
          throw new Error(
            `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' already belongs to a different merchant.`
          );
        }
        if (
          validatedRequestedAmount !== undefined &&
          !toDecimal(row.amount).eq(toDecimal(validatedRequestedAmount))
        ) {
          throw new Error(
            `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' was previously used for amount ₹${roundCurrency(row.amount)}, cannot reuse for ₹${roundCurrency(validatedRequestedAmount)}.`
          );
        }
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
          const existingRow = existingPayoutRes.rows[0];
          if (existingRow.merchant_id !== merchantId) {
            throw new Error(
              `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' already belongs to a different merchant.`
            );
          }
          if (
            validatedRequestedAmount !== undefined &&
            !toDecimal(existingRow.amount).eq(toDecimal(validatedRequestedAmount))
          ) {
            throw new Error(
              `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' was previously used for amount ₹${roundCurrency(existingRow.amount)}, cannot reuse for ₹${roundCurrency(validatedRequestedAmount)}.`
            );
          }
          return {
            payoutId: existingRow.id,
            payoutReference: existingRow.payout_reference,
            payoutAmount: parseFloat(existingRow.amount),
            merchant: null,
            isDuplicate: true,
            existingRow,
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

      // Calculate available unsettled balance deterministically
      const ledgerBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC, seq_no DESC
        LIMIT 1
      `, [merchantId]);

      const availableBalanceBn = ledgerBalRes.rows.length > 0
        ? toDecimal(ledgerBalRes.rows[0].running_balance)
        : new BigNumber(0);
      const availableBalance = Number(roundCurrency(availableBalanceBn));

      if (availableBalanceBn.lte(0)) {
        throw new Error('ZERO_PAYABLE_BALANCE: Merchant has zero unsettled payable balance.');
      }

      const payoutAmountBn = validatedRequestedAmount !== undefined
        ? toDecimal(validatedRequestedAmount)
        : availableBalanceBn;
      const payoutAmount = Number(roundCurrency(payoutAmountBn));
      if (payoutAmountBn.gt(availableBalanceBn)) {
        throw new Error(`INSUFFICIENT_BALANCE: Requested payout amount ₹${payoutAmount} exceeds available balance ₹${availableBalance}`);
      }
      if (payoutAmountBn.lte(0)) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }

      const payoutReference = `PAYOUT_SELLER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // Reserve funds in seller_ledgers immediately to block concurrent double-spend (append-only)
      const updatedBalance = Number(roundCurrency(availableBalanceBn.minus(payoutAmountBn)));
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
      if (payoutRow.status === 'PAID' || payoutRow.status === 'FAILED' || payoutRow.status === 'REVERSED') {
        return {
          payoutId: payoutRow.id,
          payoutReference: payoutRow.payout_reference,
          actorId: payoutRow.merchant_id,
          amount: parseFloat(payoutRow.amount),
          status: payoutRow.status,
          utrNumber: payoutRow.utr_number || undefined,
          journalBatchId: payoutRow.journal_batch_id || undefined,
          failureReason: payoutRow.failure_reason || undefined,
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

        // 2. Mark payout as PAID (UTR tracked on seller_payouts & GL; seller_ledgers remains strictly append-only)
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

        // 3. FIFO settle open allocations up to payoutAmount
        await applyPayoutToAllocationsFIFO(client, merchantId, payoutAmount);

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
        // Conclusive failure: lock merchant first, mark FAILED, and restore merchant balance via append-only CREDIT
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
          ORDER BY created_at DESC, seq_no DESC
          LIMIT 1
        `, [merchantId]);

        const currentRunningBn = curBalRes.rows.length > 0
          ? toDecimal(curBalRes.rows[0].running_balance)
          : new BigNumber(0);
        const restoredRunning = Number(roundCurrency(currentRunningBn.plus(toDecimal(payoutAmount))));

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
    if (payout.status === 'PAID' || payout.status === 'FAILED' || payout.status === 'REVERSED') {
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
      if (curPayout.status === 'PAID' || curPayout.status === 'FAILED' || curPayout.status === 'REVERSED') {
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

      // Stale-worker fencing check
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

        await applyPayoutToAllocationsFIFO(client, merchantId, payoutAmount);

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
        // Conclusive rejection: lock merchant, mark FAILED, and restore running balance via append-only CREDIT
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
          ORDER BY created_at DESC, seq_no DESC
          LIMIT 1
        `, [merchantId]);

        const currentRunningBn = curBalRes.rows.length > 0
          ? toDecimal(curBalRes.rows[0].running_balance)
          : new BigNumber(0);
        const restoredRunning = Number(roundCurrency(currentRunningBn.plus(toDecimal(payoutAmount))));

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
    returnId?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<{ isPostPayout: boolean; debitAmount: number; newBalance: number }> {
    const refundAmtBn = toDecimal(params.refundAmount);
    if (refundAmtBn.lte(0)) {
      throw new Error('INVALID_CLAWBACK_AMOUNT: Refund amount for seller clawback must be greater than zero.');
    }
    const refundAmount = Number(roundCurrency(refundAmtBn));

    const execute = async (client: pg.PoolClient) => {
      // 1. Lock merchant first, then allocation FOR UPDATE (consistent lock ordering with webhooks/payouts to prevent deadlocks)
      await client.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [params.merchantId]);

      const allocRes = await client.query(`
        SELECT * FROM order_settlement_allocations
        WHERE order_id = $1
        LIMIT 1
        FOR UPDATE
      `, [params.orderId]);

      if (allocRes.rows.length === 0) {
        // Pre-fulfillment order: no seller ledger entry existed
        return { isPostPayout: false, debitAmount: 0, newBalance: 0 };
      }

      const alloc = allocRes.rows[0];

      const ledgerBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC, seq_no DESC
        LIMIT 1
      `, [params.merchantId]);
      const currentBalanceBn = ledgerBalRes.rows.length > 0
        ? toDecimal(ledgerBalRes.rows[0].running_balance)
        : new BigNumber(0);
      const currentBalance = Number(roundCurrency(currentBalanceBn));

      const rawSettledBn = toDecimal(alloc.settled_amount || '0');
      const netSellerPayableBn = toDecimal(alloc.net_seller_payable || '0');
      const settledSoFarBn = alloc.status === 'SETTLED' && rawSettledBn.isZero()
        ? netSellerPayableBn
        : rawSettledBn;
      const alreadyRefundedNetBn = toDecimal(alloc.refunded_amount || '0');
      const remainingReversibleNetBn = BigNumber.max(0, netSellerPayableBn.minus(alreadyRefundedNetBn));

      // Guard against duplicate/excess clawbacks on already REVERSED allocations
      if (alloc.status === 'REVERSED' || remainingReversibleNetBn.lte(0)) {
        const hadPostPayout = alloc.status === 'SETTLED' || settledSoFarBn.gt(0);
        return { isPostPayout: hadPostPayout, debitAmount: 0, newBalance: currentBalance };
      }

      const refundAmountBn = toDecimal(refundAmount);
      const grossGmvBn = toDecimal(alloc.gross_gmv || '0');
      const allocSubsidyBn = toDecimal(alloc.platform_discount_subsidy || '0');
      const alreadyRevSubsidyBn = toDecimal(alloc.reversed_platform_subsidy || '0');
      const remainingSubsidyBn = BigNumber.max(0, allocSubsidyBn.minus(alreadyRevSubsidyBn));

      const allocCommBn = toDecimal(alloc.platform_commission || '0');
      const allocCommGstBn = toDecimal(alloc.commission_gst || '0');
      const allocTcsBn = toDecimal(alloc.gst_tcs_amount || '0');
      const allocTdsBn = toDecimal(alloc.seller_tds_amount || '0');
      const allocDelayPenaltyBn = toDecimal(alloc.store_delay_penalty || '0');

      const totalOrigFeesBn = add(allocCommBn, allocCommGstBn, allocTcsBn, allocTdsBn, allocDelayPenaltyBn);
      const refundedProportionBn = netSellerPayableBn.gt(0)
        ? divide(alreadyRefundedNetBn, netSellerPayableBn)
        : new BigNumber(0);
      const remainingGrossEstBn = subtract(grossGmvBn, multiply(refundedProportionBn, grossGmvBn)).minus('0.01');
      const isFullRemaining = grossGmvBn.gt(0)
        ? refundAmountBn.gte(remainingGrossEstBn)
        : refundAmountBn.gte(remainingReversibleNetBn);

      const ratioBn = grossGmvBn.gt(0) ? BigNumber.min(1, divide(refundAmountBn, grossGmvBn)) : new BigNumber(1);
      const revSubsidyBn = isFullRemaining
        ? remainingSubsidyBn
        : BigNumber.min(remainingSubsidyBn, toDecimal(roundCurrency(multiply(allocSubsidyBn, ratioBn))));
      const totalReversalValueBn = refundAmountBn.plus(revSubsidyBn);

      let revCommBn = toDecimal(roundCurrency(multiply(allocCommBn, ratioBn)));
      let revCommGstBn = toDecimal(roundCurrency(multiply(allocCommGstBn, ratioBn)));
      let revTcsBn = toDecimal(roundCurrency(multiply(allocTcsBn, ratioBn)));
      let revTdsBn = toDecimal(roundCurrency(multiply(allocTdsBn, ratioBn)));
      let revDelayPenaltyBn = toDecimal(roundCurrency(multiply(allocDelayPenaltyBn, ratioBn)));
      let revFeeTotalBn = add(revCommBn, revCommGstBn, revTcsBn, revTdsBn, revDelayPenaltyBn);

      // Ensure revFeeTotal never exceeds total return value (customer refund + subsidy unwind)
      if (revFeeTotalBn.gt(totalReversalValueBn) && revFeeTotalBn.gt(0)) {
        const capScaleBn = divide(totalReversalValueBn, revFeeTotalBn);
        revCommBn = toDecimal(roundCurrency(multiply(revCommBn, capScaleBn)));
        revCommGstBn = toDecimal(roundCurrency(multiply(revCommGstBn, capScaleBn)));
        revTcsBn = toDecimal(roundCurrency(multiply(revTcsBn, capScaleBn)));
        revTdsBn = toDecimal(roundCurrency(multiply(revTdsBn, capScaleBn)));
        revDelayPenaltyBn = toDecimal(roundCurrency(multiply(revDelayPenaltyBn, capScaleBn)));
        revFeeTotalBn = add(revCommBn, revCommGstBn, revTcsBn, revTdsBn, revDelayPenaltyBn);
      }

      let debitAmountBn: BigNumber;
      if (isFullRemaining && totalOrigFeesBn.plus(remainingReversibleNetBn).lte(totalReversalValueBn.plus('0.05'))) {
        debitAmountBn = remainingReversibleNetBn;
      } else {
        debitAmountBn = min(
          remainingReversibleNetBn,
          BigNumber.max(0, toDecimal(roundCurrency(totalReversalValueBn.minus(revFeeTotalBn))))
        );
      }
      const debitAmount = Number(roundCurrency(debitAmountBn));

      // Align proportional fee if rounding pushed debitAmount + revFeeTotal != totalReversalValueBn
      const remainderForFeesBn = BigNumber.max(0, totalReversalValueBn.minus(debitAmountBn));
      const feeGapBn = remainderForFeesBn.minus(revFeeTotalBn);
      if (!feeGapBn.isZero() && feeGapBn.abs().lte('0.05') && revCommBn.plus(feeGapBn).gte(0)) {
        revCommBn = toDecimal(roundCurrency(revCommBn.plus(feeGapBn)));
      }

      // Split partially settled order accurately between unsettled Payable (2020) and settled Clawback Receivable (1040)
      const unsettledRemainingBn = BigNumber.max(
        0,
        netSellerPayableBn.minus(alreadyRefundedNetBn).minus(settledSoFarBn)
      );
      const payableReductionBn = toDecimal(roundCurrency(min(debitAmountBn, unsettledRemainingBn)));
      const clawbackReceivableBn = toDecimal(roundCurrency(BigNumber.max(0, debitAmountBn.minus(payableReductionBn))));
      const payableReduction = Number(roundCurrency(payableReductionBn));
      const clawbackReceivable = Number(roundCurrency(clawbackReceivableBn));
      const isPostPayout = clawbackReceivableBn.gt(0);

      let runningAfterBn = currentBalanceBn;
      if (payableReductionBn.gt(0)) {
        runningAfterBn = runningAfterBn.minus(payableReductionBn);
        await client.query(`
          INSERT INTO seller_ledgers (
            merchant_id, order_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, $2, 'RETURN_DEBIT', 'DEBIT', $3, $4, $5)
        `, [
          params.merchantId,
          params.orderId,
          payableReduction,
          Number(roundCurrency(runningAfterBn)),
          `Return debit on pre-payout return portion for order ${params.orderId}`,
        ]);
      }

      if (clawbackReceivableBn.gt(0)) {
        runningAfterBn = runningAfterBn.minus(clawbackReceivableBn);
        await client.query(`
          INSERT INTO seller_ledgers (
            merchant_id, order_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, $2, 'CLAWBACK_DEBIT', 'DEBIT', $3, $4, $5)
        `, [
          params.merchantId,
          params.orderId,
          clawbackReceivable,
          Number(roundCurrency(runningAfterBn)),
          `Clawback debit on post-payout return portion for order ${params.orderId}`,
        ]);
      }

      const newBalance = Number(roundCurrency(runningAfterBn));

      const ordMethodRes = await client.query(`SELECT payment_method FROM orders WHERE id = $1 LIMIT 1`, [params.orderId]);
      const isCodOrder = isCodPaymentMethod(ordMethodRes.rows[0]?.payment_method);

      // Record balanced General Ledger Entry (Reversal of fees + delay penalty + 2020/1040 vs Cr 1010/1020 + 5040)
      await ledgerService.recordReturnRefund({
        orderId: params.orderId,
        merchantId: params.merchantId,
        refundAmount,
        platformSubsidyReversal: Number(roundCurrency(revSubsidyBn)),
        payableReductionAmount: payableReduction,
        clawbackReceivableAmount: clawbackReceivable,
        commissionAmount: Number(roundCurrency(revCommBn)),
        commissionGst: Number(roundCurrency(revCommGstBn)),
        gstTcsAmount: Number(roundCurrency(revTcsBn)),
        sellerTdsAmount: Number(roundCurrency(revTdsBn)),
        storeDelayPenalty: Number(roundCurrency(revDelayPenaltyBn)),
        isPostPayout,
        returnId: params.returnId,
        creditAccountCode: isCodOrder ? '1020' : '1010',
        client,
      });

      const updatedRefundedNetBn = toDecimal(roundCurrency(alreadyRefundedNetBn.plus(debitAmountBn)));
      const updatedRevSubsidyBn = toDecimal(roundCurrency(alreadyRevSubsidyBn.plus(revSubsidyBn)));
      const markFullyReversed = isFullRemaining || updatedRefundedNetBn.gte(netSellerPayableBn.minus('0.01'));

      await client.query(`
        UPDATE order_settlement_allocations
        SET refunded_amount = $1,
            reversed_platform_subsidy = $2,
            status = CASE WHEN $3 THEN 'REVERSED' ELSE status END
        WHERE order_id = $4
      `, [
        Number(roundCurrency(updatedRefundedNetBn)),
        Number(roundCurrency(updatedRevSubsidyBn)),
        markFullyReversed,
        params.orderId,
      ]);

      return { isPostPayout, debitAmount, newBalance };
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }
}

export const sellerSettlementService = new SellerSettlementService();
