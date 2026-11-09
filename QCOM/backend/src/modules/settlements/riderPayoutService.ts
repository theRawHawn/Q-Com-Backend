import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { getPayoutProvider, PayoutProvider, PayoutDisbursementResult } from './payoutProvider.js';
import { RiderEarningsStatement, PayoutResult } from './settlementTypes.js';
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

export class RiderPayoutService {
  private payoutProvider: PayoutProvider;
  private mutex = new AsyncKeyedMutex();

  constructor() {
    this.payoutProvider = getPayoutProvider();
  }

  /**
   * Generates comprehensive earnings and floating cash statement for a delivery partner
   */
  public async getRiderEarningsStatement(riderId: string): Promise<RiderEarningsStatement> {
    const pool = getPool();

    const riderRes = await pool.query(`
      SELECT id, name, phone, pan_number, pan_status, kyc_status,
             wallet_balance, floating_cash_balance, floating_cash_limit,
             status, is_payout_held, payout_hold_reason,
             upi_vpa, bank_account_number, bank_ifsc
      FROM riders
      WHERE id = $1
      LIMIT 1
    `, [riderId]);

    if (riderRes.rows.length === 0) {
      throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
    }

    const r = riderRes.rows[0];

    const tripsRes = await pool.query(`
      SELECT t.*, o.order_number
      FROM delivery_trips t
      JOIN orders o ON t.order_id = o.id
      WHERE t.rider_id = $1 AND t.status = 'DELIVERED'
      ORDER BY t.delivered_at DESC
    `, [riderId]);

    let totalGrossEarnings = 0;
    let totalTips = 0;
    let totalTdsWithheld = 0;
    let totalNetEarnings = 0;

    const trips = tripsRes.rows.map((t) => {
      const base = parseFloat(t.base_fare || '35.00');
      const dist = parseFloat(t.distance_fare || '0.00');
      const surge = parseFloat(t.surge_fare || '0.00');
      const wait = parseFloat(t.wait_time_compensation || '0.00');
      const tip = parseFloat(t.tip_amount || '0.00');
      const tds = parseFloat(t.rider_withholding_amount || '0.00');
      const net = +(base + dist + surge + wait + tip - tds).toFixed(2);

      totalGrossEarnings += +(base + dist + surge + wait).toFixed(2);
      totalTips += tip;
      totalTdsWithheld += tds;
      totalNetEarnings += net;

      return {
        tripId: t.id,
        orderId: t.order_id,
        deliveredAt: t.delivered_at ? t.delivered_at.toISOString() : new Date().toISOString(),
        baseFare: base,
        distanceFare: dist,
        surgeFare: surge,
        waitCompensation: wait,
        customerTip: tip,
        tdsWithheld: tds,
        netPayout: net,
      };
    });

    const payoutRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_paid_out
      FROM rider_payouts
      WHERE rider_id = $1 AND status = 'PAID'
    `, [riderId]);

    const totalPaidOut = parseFloat(payoutRes.rows[0].total_paid_out);
    const floatingCash = parseFloat(r.floating_cash_balance || '0.00');
    const floatingLimit = parseFloat(r.floating_cash_limit || '2500.00');
    const isDispatchBlocked = floatingCash >= floatingLimit || r.status === 'SUSPENDED';

    return {
      riderId: r.id,
      riderName: r.name,
      panNumber: r.pan_number || undefined,
      panStatus: r.pan_status || undefined,
      kycStatus: r.kyc_status,
      walletBalance: parseFloat(r.wallet_balance || '0.00'),
      floatingCashBalance: floatingCash,
      floatingCashLimit: floatingLimit,
      isDispatchBlocked,
      upiVpa: r.upi_vpa || undefined,
      bankDetails: {
        accountNumber: r.bank_account_number || undefined,
        ifsc: r.bank_ifsc || undefined,
      },
      totalGrossEarnings: +totalGrossEarnings.toFixed(2),
      totalTips: +totalTips.toFixed(2),
      totalTdsWithheld: +totalTdsWithheld.toFixed(2),
      totalNetEarnings: +totalNetEarnings.toFixed(2),
      totalPaidOut: +totalPaidOut.toFixed(2),
      trips,
    };
  }

  /**
   * Executes instant or scheduled rider wallet payout
   */
  /**
   * Executes instant or scheduled rider wallet payout withdrawal.
   * Decoupled into 3 distinct phases:
   *   STEP A (Prepare): Short transaction locking rider, verifying wallet, deducting balance, inserting PROCESSING intent.
   *   STEP B (Execute): External banking / UPI disbursement completely outside of database transactions.
   *   STEP C (Reconcile): Short transaction posting General Ledger entries, setting status to PAID, and completing payout.
   */
  public async executeRiderPayout(params: {
    riderId: string;
    amount?: number;
    method?: 'UPI' | 'BANK';
    idempotencyKey?: string;
  }): Promise<PayoutResult> {
    const { riderId, amount, method = 'UPI', idempotencyKey } = params;

    // -----------------------------------------------------------------
    // STEP 0: Fast Idempotency Check
    // -----------------------------------------------------------------
    if (idempotencyKey) {
      const pool = getPool();
      const existingPayoutRes = await pool.query(`
        SELECT * FROM rider_payouts
        WHERE idempotency_key = $1
        LIMIT 1
      `, [idempotencyKey]);

      if (existingPayoutRes.rows.length > 0) {
        const row = existingPayoutRes.rows[0];
        return {
          payoutId: row.id,
          payoutReference: row.payout_reference,
          actorId: row.rider_id,
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
    interface PreparedRiderPayout {
      payoutId: string;
      payoutReference: string;
      payoutAmount: number;
      rider: any;
      isDuplicate: boolean;
      existingRow?: any;
    }

    const prepareResult = await this.mutex.runExclusive(riderId, () => transaction(async (client): Promise<PreparedRiderPayout> => {
      // Re-verify idempotency with row lock
      if (idempotencyKey) {
        const existingPayoutRes = await client.query(`
          SELECT * FROM rider_payouts
          WHERE idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [idempotencyKey]);

        if (existingPayoutRes.rows.length > 0) {
          return {
            payoutId: existingPayoutRes.rows[0].id,
            payoutReference: existingPayoutRes.rows[0].payout_reference,
            payoutAmount: parseFloat(existingPayoutRes.rows[0].amount),
            rider: null,
            isDuplicate: true,
            existingRow: existingPayoutRes.rows[0],
          };
        }
      }

      // Row-level lock on rider
      const riderRes = await client.query(`
        SELECT * FROM riders
        WHERE id = $1
        FOR UPDATE
      `, [riderId]);

      if (riderRes.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
      }

      const rider = riderRes.rows[0];

      if (rider.is_payout_held) {
        throw new Error(`PAYOUT_HELD: Payouts for rider '${riderId}' are held: ${rider.payout_hold_reason || 'Compliance review'}`);
      }

      const currentWallet = parseFloat(rider.wallet_balance || '0.00');
      if (currentWallet <= 0) {
        throw new Error('ZERO_WALLET_BALANCE: Rider wallet balance is zero.');
      }

      const payoutAmount = amount !== undefined ? amount : currentWallet;
      if (payoutAmount > currentWallet) {
        throw new Error(`INSUFFICIENT_WALLET_BALANCE: Requested payout amount ₹${payoutAmount} exceeds wallet balance ₹${currentWallet}`);
      }
      if (payoutAmount <= 0) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }

      // Destination validation
      if (method === 'UPI' && !rider.upi_vpa) {
        throw new Error('MISSING_DESTINATION: Rider has no UPI VPA configured.');
      }
      if (method === 'BANK' && (!rider.bank_account_number || !rider.bank_ifsc)) {
        throw new Error('MISSING_DESTINATION: Rider has no bank account configured.');
      }

      const payoutReference = `PAYOUT_RIDER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // Deduct from wallet balance in DB immediately to prevent concurrent double-spend
      const updatedWallet = +(currentWallet - payoutAmount).toFixed(2);
      await client.query(`
        UPDATE riders
        SET wallet_balance = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [updatedWallet, riderId]);

      // Post subledger entry in rider_ledgers
      await client.query(`
        INSERT INTO rider_ledgers (
          rider_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, 'INSTANT_PAYOUT_DEBIT', 'DEBIT', $2, $3, $4)
      `, [
        riderId,
        payoutAmount,
        updatedWallet,
        `Disbursement to ${method === 'UPI' ? rider.upi_vpa : rider.bank_account_number} reserved (Ref: ${payoutReference})`,
      ]);

      // Insert into rider_payouts in status 'PROCESSING'
      const insRes = await client.query(`
        INSERT INTO rider_payouts (
          payout_reference, rider_id, amount, currency, payout_method,
          destination_vpa, destination_account, destination_ifsc,
          status, idempotency_key
        )
        VALUES ($1, $2, $3, 'INR', $4, $5, $6, $7, 'PROCESSING', $8)
        RETURNING *
      `, [
        payoutReference,
        riderId,
        payoutAmount,
        method,
        rider.upi_vpa || null,
        rider.bank_account_number || null,
        rider.bank_ifsc || null,
        idempotencyKey || null,
      ]);

      return {
        payoutId: insRes.rows[0].id,
        payoutReference,
        payoutAmount,
        rider,
        isDuplicate: false,
      };
    }));

    if (prepareResult.isDuplicate && prepareResult.existingRow) {
      const row = prepareResult.existingRow;
      return {
        payoutId: row.id,
        payoutReference: row.payout_reference,
        actorId: row.rider_id,
        amount: parseFloat(row.amount),
        status: row.status,
        utrNumber: row.utr_number || undefined,
        journalBatchId: row.journal_batch_id || undefined,
        isDuplicate: true,
      };
    }

    const { payoutId, payoutReference, payoutAmount, rider } = prepareResult;

    // -----------------------------------------------------------------
    // STEP B: EXECUTE (External Payout Provider - OUTSIDE ANY TRANSACTION)
    // -----------------------------------------------------------------
    // No database connection or row locks are held during external banking API call.
    let providerRes: PayoutDisbursementResult;
    let outcomeUnknown = false;

    try {
      providerRes = await this.payoutProvider.disburseRiderPayout({
        riderId,
        amount: payoutAmount,
        method,
        vpa: rider.upi_vpa,
        accountNumber: rider.bank_account_number,
        ifsc: rider.bank_ifsc,
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
        SELECT * FROM rider_payouts WHERE id = $1 FOR UPDATE
      `, [payoutId]);

      const payoutRow = lockRes.rows[0];
      if (payoutRow.status === 'PAID') {
        return {
          payoutId: payoutRow.id,
          payoutReference: payoutRow.payout_reference,
          actorId: payoutRow.rider_id,
          amount: parseFloat(payoutRow.amount),
          status: payoutRow.status,
          utrNumber: payoutRow.utr_number || undefined,
          journalBatchId: payoutRow.journal_batch_id || undefined,
          isDuplicate: false,
        };
      }

      if (providerRes.success) {
        // 1. Post double-entry general ledger batch (Dr 2030 Rider Wallet, Cr 1020 Bank Account)
        const journalBatchId = await ledgerService.recordRiderPayout({
          riderId,
          amount: payoutAmount,
          payoutReference,
          utrNumber: providerRes.utrNumber,
          client,
        });

        // 2. Update rider_ledgers with confirmed UTR
        await client.query(`
          UPDATE rider_ledgers
          SET utr_number = $1,
              description = $2
          WHERE rider_id = $3 AND description = $4
        `, [
          providerRes.utrNumber,
          `Disbursement to ${method === 'UPI' ? rider.upi_vpa : rider.bank_account_number} (Ref: ${payoutReference}, UTR: ${providerRes.utrNumber})`,
          riderId,
          `Disbursement to ${method === 'UPI' ? rider.upi_vpa : rider.bank_account_number} reserved (Ref: ${payoutReference})`,
        ]);

        // 3. Mark rider_payouts as PAID
        await client.query(`
          UPDATE rider_payouts
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

        stagedEvents.push(
          settlementEventPublisher.createEvent('RiderPayoutCompleted', {
            payoutId,
            payoutReference,
            riderId,
            amount: payoutAmount,
            method,
            utrNumber: providerRes.utrNumber,
            journalBatchId,
          })
        );

        return {
          payoutId,
          payoutReference,
          actorId: riderId,
          amount: payoutAmount,
          status: 'PAID',
          utrNumber: providerRes.utrNumber,
          journalBatchId,
          isDuplicate: false,
        };
      } else if (outcomeUnknown) {
        // Critical Ambiguous Outcome Rule: Preserve PROCESSING, do not restore funds without verification
        await client.query(`
          UPDATE rider_payouts
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
          actorId: riderId,
          amount: payoutAmount,
          status: 'PROCESSING',
          failureReason: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting banking rail reconciliation.',
          isDuplicate: false,
        };
      } else {
        // Conclusive failure: lock rider first (F-10.1A-04 fix), mark FAILED, and restore rider wallet balance
        await client.query(`
          SELECT id FROM riders WHERE id = $1 FOR UPDATE
        `, [riderId]);

        await client.query(`
          UPDATE rider_payouts
          SET status = 'FAILED',
              failure_reason = $1,
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $2
        `, [providerRes.failureReason || 'Disbursement rejected by banking rail.', payoutId]);

        await client.query(`
          UPDATE riders
          SET wallet_balance = wallet_balance + $1,
              updated_at = NOW()
          WHERE id = $2
        `, [payoutAmount, riderId]);

        const curBalRes = await client.query(`
          SELECT wallet_balance FROM riders WHERE id = $1
        `, [riderId]);
        const restoredBal = parseFloat(curBalRes.rows[0].wallet_balance);

        await client.query(`
          INSERT INTO rider_ledgers (
            rider_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, 'ADJUSTMENT', 'CREDIT', $2, $3, $4)
        `, [
          riderId,
          payoutAmount,
          restoredBal,
          `Restoration of rider wallet balance due to failed disbursement (Ref: ${payoutReference})`,
        ]);

        return {
          payoutId,
          payoutReference,
          actorId: riderId,
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
   * Reconciles a rider payout in PROCESSING state by querying the banking rail provider.
   * Protects against duplicate payouts or premature balance restorations.
   */
  public async reconcileRiderPayout(payoutId: string, expectedLeaseOwner?: string): Promise<PayoutResult> {
    const pool = getPool();
    const lockRes = await pool.query(`
      SELECT * FROM rider_payouts WHERE id = $1
    `, [payoutId]);

    if (lockRes.rows.length === 0) {
      throw new Error(`PAYOUT_NOT_FOUND: Rider payout '${payoutId}' does not exist.`);
    }

    const payout = lockRes.rows[0];
    if (payout.status === 'PAID' || payout.status === 'FAILED') {
      return {
        payoutId: payout.id,
        payoutReference: payout.payout_reference,
        actorId: payout.rider_id,
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
      return {
        payoutId: payout.id,
        payoutReference: payout.payout_reference,
        actorId: payout.rider_id,
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
        SELECT * FROM rider_payouts WHERE id = $1 FOR UPDATE
      `, [payoutId]);

      if (rowCheck.rows.length === 0) {
        throw new Error(`PAYOUT_NOT_FOUND: Rider payout '${payoutId}' missing during reconciliation.`);
      }

      const curPayout = rowCheck.rows[0];
      if (curPayout.status === 'PAID' || curPayout.status === 'FAILED') {
        return {
          payoutId: curPayout.id,
          payoutReference: curPayout.payout_reference,
          actorId: curPayout.rider_id,
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
          console.warn(`[riderPayoutService.reconcileRiderPayout] Stale worker commit aborted: Worker '${expectedLeaseOwner}' lost lease to '${curPayout.recovery_lease_id}'.`);
          return {
            payoutId: curPayout.id,
            payoutReference: curPayout.payout_reference,
            actorId: curPayout.rider_id,
            amount: parseFloat(curPayout.amount),
            status: curPayout.status,
            utrNumber: curPayout.utr_number || undefined,
            journalBatchId: curPayout.journal_batch_id || undefined,
            isDuplicate: true,
          };
        }
      }

      const payoutAmount = parseFloat(curPayout.amount);
      const riderId = curPayout.rider_id;
      const payoutReference = curPayout.payout_reference;
      const method = curPayout.payout_method || 'UPI';

      if (providerStatus === 'PROCESSED') {
        const confirmedUtr = utrNumber || `UTR_RIDER_${Date.now()}`;
        const journalBatchId = await ledgerService.recordRiderPayout({
          riderId,
          amount: payoutAmount,
          payoutReference,
          utrNumber: confirmedUtr,
          client,
        });

        await client.query(`
          UPDATE rider_ledgers
          SET utr_number = $1,
              description = $2
          WHERE rider_id = $3 AND description = $4
        `, [
          confirmedUtr,
          `Disbursement to rider (Ref: ${payoutReference}, UTR: ${confirmedUtr})`,
          riderId,
          `Disbursement to ${method === 'UPI' ? curPayout.destination_vpa : curPayout.destination_account} reserved (Ref: ${payoutReference})`,
        ]);

        await client.query(`
          UPDATE rider_payouts
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

        stagedEvents.push(
          settlementEventPublisher.createEvent('RiderPayoutCompleted', {
            payoutId,
            payoutReference,
            riderId,
            amount: payoutAmount,
            method,
            utrNumber: confirmedUtr,
            journalBatchId,
          })
        );

        return {
          payoutId,
          payoutReference,
          actorId: riderId,
          amount: payoutAmount,
          status: 'PAID',
          utrNumber: confirmedUtr,
          journalBatchId,
          isDuplicate: false,
        };
      } else {
        // Conclusive rejection: lock rider, mark FAILED, and restore wallet balance
        await client.query(`
          SELECT id FROM riders WHERE id = $1 FOR UPDATE
        `, [riderId]);

        await client.query(`
          UPDATE rider_payouts
          SET status = 'FAILED',
              failure_reason = $1,
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $2
        `, [failureReason || 'Disbursement rejected by banking rail.', payoutId]);

        await client.query(`
          UPDATE riders
          SET wallet_balance = wallet_balance + $1,
              updated_at = NOW()
          WHERE id = $2
        `, [payoutAmount, riderId]);

        const curBalRes = await client.query(`
          SELECT wallet_balance FROM riders WHERE id = $1
        `, [riderId]);
        const restoredBal = parseFloat(curBalRes.rows[0].wallet_balance);

        await client.query(`
          INSERT INTO rider_ledgers (
            rider_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, 'ADJUSTMENT', 'CREDIT', $2, $3, $4)
        `, [
          riderId,
          payoutAmount,
          restoredBal,
          `Restoration of rider wallet balance due to failed disbursement (Ref: ${payoutReference})`,
        ]);

        return {
          payoutId,
          payoutReference,
          actorId: riderId,
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

  /**
   * Deducts floating cash liability, records general ledger transfer, and unblocks suspended rider
   */
  public async remitCodCash(params: {
    riderId: string;
    amount: number;
    method?: 'UPI' | 'HUB';
    reference?: string;
  }): Promise<{ success: boolean; remittedAmount: number; remainingCash: number; unblocked: boolean }> {
    const { riderId, amount, method = 'UPI', reference } = params;
    const stagedEvents: SettlementDomainEvent[] = [];

    const result = await transaction(async (client) => {
      // 1. Lock rider
      const riderRes = await client.query(`
        SELECT * FROM riders
        WHERE id = $1
        FOR UPDATE
      `, [riderId]);

      if (riderRes.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
      }

      const rider = riderRes.rows[0];
      const floatingCash = parseFloat(rider.floating_cash_balance || '0.00');

      if (amount <= 0 || amount > floatingCash) {
        throw new Error(`INVALID_REMITTANCE_AMOUNT: Remittance amount ₹${amount} exceeds current floating cash ₹${floatingCash}.`);
      }

      const remittedAmount = +amount.toFixed(2);
      const remainingCash = +(floatingCash - remittedAmount).toFixed(2);
      const remitRef = reference || `REMIT_COD_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      // 2. Post double-entry general ledger batch (Dr 1020 Bank Account, Cr 1030 Floating Cash)
      await ledgerService.recordRiderCodRemittance({
        riderId,
        amount: remittedAmount,
        reference: remitRef,
        client,
      });

      // 3. Post Subledger entry in rider_ledgers
      const currentWallet = parseFloat(rider.wallet_balance || '0.00');
      await client.query(`
        INSERT INTO rider_ledgers (
          rider_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, 'COD_DEDUCTION', 'DEBIT', $2, $3, $4)
      `, [
        riderId,
        remittedAmount,
        currentWallet,
        `Remittance of physical COD cash via ${method} (Ref: ${remitRef})`,
      ]);

      // 4. Update rider floating cash and unblock if below ceiling
      const floatingLimit = parseFloat(rider.floating_cash_limit || '2500.00');
      const unblocked = remainingCash < floatingLimit && rider.status === 'SUSPENDED';

      await client.query(`
        UPDATE riders
        SET floating_cash_balance = $2,
            status = CASE WHEN $3 = TRUE THEN 'IDLE_AT_HUB' ELSE status END,
            updated_at = NOW()
        WHERE id = $1
      `, [riderId, remainingCash, unblocked]);

      // 5. Stage Post-Commit Event
      stagedEvents.push(
        settlementEventPublisher.createEvent('RiderCodRemitted', {
          riderId,
          remittedAmount,
          remainingCash,
          unblocked,
          method,
          reference: remitRef,
        })
      );

      return {
        success: true,
        remittedAmount,
        remainingCash,
        unblocked,
      };
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }
}

export const riderPayoutService = new RiderPayoutService();
