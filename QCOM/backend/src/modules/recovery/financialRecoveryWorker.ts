import crypto from 'crypto';
import os from 'os';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { refundService } from '../payments/refundService.js';
import { paymentService } from '../payments/paymentService.js';
import { sellerSettlementService } from '../settlements/sellerSettlementService.js';
import { riderPayoutService } from '../settlements/riderPayoutService.js';

export interface RecoveryWorkerOptions {
  pollIntervalMs?: number;
  leaseDurationSec?: number;
  staleThresholdSec?: number;
  maxAttempts?: number;
  batchSize?: number;
  maxAgeHours?: number;
}

export interface RecoveryWorkerStats {
  runs: number;
  claimedRefunds: number;
  claimedSellerPayouts: number;
  claimedRiderPayouts: number;
  reconciledCompleted: number;
  reconciledFailed: number;
  stillPending: number;
  escalations: number;
  errors: number;
  lastRunAt?: string;
}

export interface RecoveryCycleSummary {
  cycleId: string;
  workerId: string;
  claimed: {
    refunds: number;
    sellerPayouts: number;
    riderPayouts: number;
  };
  reconciled: {
    completed: number;
    failed: number;
    stillPending: number;
    escalated: number;
  };
  errors: string[];
}

export class FinancialRecoveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private activeCyclePromise: Promise<RecoveryCycleSummary> | null = null;

  public readonly workerId: string;
  private pollIntervalMs: number;
  private leaseDurationSec: number;
  private staleThresholdSec: number;
  private maxAttempts: number;
  private batchSize: number;
  private maxAgeHours: number;

  private stats: RecoveryWorkerStats = {
    runs: 0,
    claimedRefunds: 0,
    claimedSellerPayouts: 0,
    claimedRiderPayouts: 0,
    reconciledCompleted: 0,
    reconciledFailed: 0,
    stillPending: 0,
    escalations: 0,
    errors: 0,
  };

  constructor(options?: RecoveryWorkerOptions) {
    this.workerId = `recovery_${os.hostname()}_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    this.pollIntervalMs = options?.pollIntervalMs ?? 10000; // 10s default
    this.leaseDurationSec = options?.leaseDurationSec ?? 60; // 60s lease
    this.staleThresholdSec = options?.staleThresholdSec ?? 5; // 5s min age before claiming
    this.maxAttempts = options?.maxAttempts ?? 10;
    this.batchSize = options?.batchSize ?? 10;
    this.maxAgeHours = options?.maxAgeHours ?? 24;
  }

  public getStats(): RecoveryWorkerStats {
    return { ...this.stats };
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public isWorkerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Starts periodic execution of the recovery cycle.
   */
  public start(options?: RecoveryWorkerOptions): void {
    if (this.isRunning) return;

    if (options) {
      if (options.pollIntervalMs !== undefined) this.pollIntervalMs = options.pollIntervalMs;
      if (options.leaseDurationSec !== undefined) this.leaseDurationSec = options.leaseDurationSec;
      if (options.staleThresholdSec !== undefined) this.staleThresholdSec = options.staleThresholdSec;
      if (options.maxAttempts !== undefined) this.maxAttempts = options.maxAttempts;
      if (options.batchSize !== undefined) this.batchSize = options.batchSize;
      if (options.maxAgeHours !== undefined) this.maxAgeHours = options.maxAgeHours;
    }

    this.isRunning = true;
    console.log(`[FinancialRecoveryWorker] Started on worker '${this.workerId}' (Poll: ${this.pollIntervalMs}ms, Lease: ${this.leaseDurationSec}s, MaxAttempts: ${this.maxAttempts})`);

    this.timer = setInterval(async () => {
      try {
        await this.runRecoveryCycle();
      } catch (err: any) {
        console.error('[FinancialRecoveryWorker Execution Error]', err.message || err);
      }
    }, this.pollIntervalMs);

    this.timer.unref();
  }

  /**
   * Gracefully stops the recovery worker, awaiting active cycle completion.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.activeCyclePromise) {
      try {
        await this.activeCyclePromise;
      } catch {
        // Suppress cycle completion errors during shutdown
      }
    }
    console.log(`[FinancialRecoveryWorker] Stopped worker '${this.workerId}'.`);
  }

  /**
   * Executes a single authoritative recovery cycle across all three financial rails.
   * Multi-instance safe via distributed row-level leasing with lease expiry.
   */
  public async runRecoveryCycle(): Promise<RecoveryCycleSummary> {
    const cycleId = `cycle_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.stats.runs++;
    this.stats.lastRunAt = new Date().toISOString();

    const summary: RecoveryCycleSummary = {
      cycleId,
      workerId: this.workerId,
      claimed: {
        refunds: 0,
        sellerPayouts: 0,
        riderPayouts: 0,
      },
      reconciled: {
        completed: 0,
        failed: 0,
        stillPending: 0,
        escalated: 0,
      },
      errors: [],
    };

    const runPromise = (async () => {
      // 1. Recover Refunds
      try {
        await this.recoverRefunds(summary);
      } catch (err: any) {
        this.stats.errors++;
        summary.errors.push(`Refund recovery error: ${err.message}`);
        console.error('[FinancialRecoveryWorker] Refund recovery cycle error:', err.message);
      }

      // 2. Recover Seller Payouts
      try {
        await this.recoverSellerPayouts(summary);
      } catch (err: any) {
        this.stats.errors++;
        summary.errors.push(`Seller payout recovery error: ${err.message}`);
        console.error('[FinancialRecoveryWorker] Seller payout recovery cycle error:', err.message);
      }

      // 3. Recover Rider Payouts
      try {
        await this.recoverRiderPayouts(summary);
      } catch (err: any) {
        this.stats.errors++;
        summary.errors.push(`Rider payout recovery error: ${err.message}`);
        console.error('[FinancialRecoveryWorker] Rider payout recovery cycle error:', err.message);
      }

      // 4. Recover Pending & Ambiguous Payments (Sprint 12.0)
      try {
        await this.recoverPendingPayments(summary);
      } catch (err: any) {
        this.stats.errors++;
        summary.errors.push(`Payment recovery error: ${err.message}`);
        console.error('[FinancialRecoveryWorker] Payment recovery cycle error:', err.message);
      }

      return summary;
    })();

    this.activeCyclePromise = runPromise;
    try {
      return await runPromise;
    } finally {
      this.activeCyclePromise = null;
    }
  }

  /**
   * Recovers stale or ambiguous payment intents (Sprint 12.0 / Sprint 12.5)
   */
  public async recoverPendingPayments(summary?: RecoveryCycleSummary): Promise<number> {
    const pool = getPool();
    const staleCutoffDate = new Date(Date.now() - this.staleThresholdSec * 1000);
    const leaseExpiryDate = new Date(Date.now() + this.leaseDurationSec * 1000);

    let claimedOrderIds: string[] = [];
    try {
      claimedOrderIds = await transaction(async (client) => {
        let candidatesRes;
        try {
          candidatesRes = await client.query(`
            SELECT id, order_id FROM payment_intents
            WHERE status IN ('PROCESSING', 'RECONCILIATION_REQUIRED')
              AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())
              AND created_at < $1
            ORDER BY created_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          `, [staleCutoffDate, this.batchSize]);
        } catch {
          // Graceful fallback if recovery_lease_expires_at not present or SKIP LOCKED unsupported
          try {
            candidatesRes = await client.query(`
              SELECT id, order_id FROM payment_intents
              WHERE status IN ('PROCESSING', 'RECONCILIATION_REQUIRED')
                AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())
                AND created_at < $1
              ORDER BY created_at ASC
              LIMIT $2
              FOR UPDATE
            `, [staleCutoffDate, this.batchSize]);
          } catch {
            candidatesRes = await client.query(`
              SELECT id, order_id FROM payment_intents
              WHERE status IN ('PROCESSING', 'RECONCILIATION_REQUIRED')
                AND created_at < $1
              ORDER BY created_at ASC
              LIMIT $2
            `, [staleCutoffDate, this.batchSize]);
          }
        }

        if (!candidatesRes || candidatesRes.rows.length === 0) return [];

        const orderIds: string[] = [];
        for (const row of candidatesRes.rows) {
          try {
            await client.query(`
              UPDATE payment_intents
              SET recovery_lease_id = $1,
                  recovery_lease_expires_at = $2,
                  reconciliation_attempts = reconciliation_attempts + 1,
                  last_reconciled_at = NOW(),
                  updated_at = NOW()
              WHERE id = $3
            `, [this.workerId, leaseExpiryDate, row.id]);
          } catch {
            // In case recovery_lease columns not yet in table schema
          }
          if (!orderIds.includes(row.order_id)) {
            orderIds.push(row.order_id);
          }
        }
        return orderIds;
      });
    } catch {
      return 0; // Return if table not yet migrated in test harness
    }

    if (claimedOrderIds.length === 0) return 0;

    let recovered = 0;
    for (const orderId of claimedOrderIds) {
      try {
        const res = await paymentService.reconcilePayment(orderId);
        if (res.reconciled) {
          recovered++;
          if (summary) summary.reconciled.completed++;
        }
        await pool.query(`
          UPDATE payment_intents
          SET recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE order_id = $1 AND recovery_lease_id = $2
        `, [orderId, this.workerId]).catch(() => {});
      } catch (err: any) {
        console.warn(`[FinancialRecoveryWorker] Payment reconciliation failed for order ${orderId}:`, err.message);
        await pool.query(`
          UPDATE payment_intents
          SET recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE order_id = $1 AND recovery_lease_id = $2
        `, [orderId, this.workerId]).catch(() => {});
      }
    }
    return recovered;
  }

  /**
   * Concurrently claims candidate rows using FOR UPDATE SKIP LOCKED
   * with fallback to FOR UPDATE if SKIP LOCKED is not supported by the test dialect / pg-mem.
   */
  private async queryClaimCandidates(
    client: pg.PoolClient,
    tableName: 'refunds' | 'seller_payouts' | 'rider_payouts',
    staleCutoffDate: Date,
    batchSize: number
  ): Promise<pg.QueryResult> {
    const skipLockedQuery = `
      SELECT id, reconciliation_attempts, created_at FROM ${tableName}
      WHERE status = 'PROCESSING'
        AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    `;
    const fallbackQuery = `
      SELECT id, reconciliation_attempts, created_at FROM ${tableName}
      WHERE status = 'PROCESSING'
        AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE
    `;
    try {
      return await client.query(skipLockedQuery, [staleCutoffDate, batchSize]);
    } catch {
      return await client.query(fallbackQuery, [staleCutoffDate, batchSize]);
    }
  }

  /**
   * Recovers stale PROCESSING refunds.
   */
  private async recoverRefunds(summary: RecoveryCycleSummary): Promise<void> {
    const pool = getPool();
    const leaseExpiryDate = new Date(Date.now() + this.leaseDurationSec * 1000);
    const staleCutoffDate = new Date(Date.now() - this.staleThresholdSec * 1000);
    const maxAgeCutoffDate = new Date(Date.now() - this.maxAgeHours * 3600 * 1000);

    // Step A: Atomic lease claim in short database transaction with SKIP LOCKED
    const claimedRefundIds = await transaction(async (client) => {
      const candidateRes = await this.queryClaimCandidates(client, 'refunds', staleCutoffDate, this.batchSize);

      if (candidateRes.rows.length === 0) return [];

      const ids: string[] = [];
      for (const row of candidateRes.rows) {
        const attempts = parseInt(row.reconciliation_attempts || '0', 10);
        const createdAt = new Date(row.created_at);

        // Check if exceeded max attempts or max age
        if (attempts >= this.maxAttempts || createdAt < maxAgeCutoffDate) {
          this.stats.escalations++;
          summary.reconciled.escalated++;
          console.warn(
            `[FinancialRecoveryWorker] ESCALATION REQUIRED: Refund '${row.id}' has exceeded recovery thresholds (Attempts: ${attempts}/${this.maxAttempts}, Created: ${createdAt.toISOString()}). Preserving PROCESSING for manual finance audit.`
          );
          // Update last_reconciled_at to prevent immediate tight-loop re-scanning
          await client.query(`
            UPDATE refunds
            SET last_reconciled_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `, [row.id]);
          continue;
        }

        // Claim lease atomically
        await client.query(`
          UPDATE refunds
          SET recovery_lease_id = $1,
              recovery_lease_expires_at = $2,
              reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciled_at = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `, [this.workerId, leaseExpiryDate, row.id]);

        ids.push(row.id);
      }
      return ids;
    });

    summary.claimed.refunds += claimedRefundIds.length;
    this.stats.claimedRefunds += claimedRefundIds.length;

    // Step B: External reconciliation performed strictly outside open database transactions
    for (const refundId of claimedRefundIds) {
      try {
        const reconciled = await refundService.reconcileRefund(refundId, this.workerId);
        if (reconciled.status === 'COMPLETED') {
          this.stats.reconciledCompleted++;
          summary.reconciled.completed++;
          console.log(`[FinancialRecoveryWorker] Successfully reconciled refund '${refundId}' to COMPLETED.`);
        } else if (reconciled.status === 'FAILED') {
          this.stats.reconciledFailed++;
          summary.reconciled.failed++;
          console.log(`[FinancialRecoveryWorker] Reconciled refund '${refundId}' to FAILED.`);
        } else {
          // Still PROCESSING / ambiguous
          this.stats.stillPending++;
          summary.reconciled.stillPending++;
          // Release lease early with bounded backoff; verify lease ownership
          await pool.query(`
            UPDATE refunds
            SET recovery_lease_id = NULL,
                recovery_lease_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1 AND status = 'PROCESSING'
              AND recovery_lease_id = $2
          `, [refundId, this.workerId]);
        }
      } catch (err: any) {
        this.stats.errors++;
        console.warn(`[FinancialRecoveryWorker] Transient error reconciling refund '${refundId}':`, err.message);
        // Release lease so subsequent cycles can re-evaluate after backoff; verify lease ownership
        await pool.query(`
          UPDATE refunds
          SET recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING'
            AND recovery_lease_id = $2
        `, [refundId, this.workerId]).catch(() => {});
      }
    }

    // Step C: Recover any orders stuck in REFUND_PENDING without an active/completed refund
    try {
      const pendingOrders = await transaction(async (client) => {
        try {
          const res = await client.query(`
            SELECT o.id, o.total_amount
            FROM orders o
            LEFT JOIN refunds r ON r.order_id = o.id
            WHERE o.payment_status = 'REFUND_PENDING'
              AND r.id IS NULL
            ORDER BY o.created_at ASC
            LIMIT 5
            FOR UPDATE OF o SKIP LOCKED
          `);
          return res.rows;
        } catch {
          const fallbackRes = await client.query(`
            SELECT o.id, o.total_amount
            FROM orders o
            LEFT JOIN refunds r ON r.order_id = o.id
            WHERE o.payment_status = 'REFUND_PENDING'
              AND r.id IS NULL
            ORDER BY o.created_at ASC
            LIMIT 5
          `);
          return fallbackRes.rows;
        }
      });

      for (const ord of pendingOrders) {
        try {
          await refundService.createRefund({
            orderId: ord.id,
            amount: parseFloat(ord.total_amount),
            reasonCode: 'ORDER_CANCELLED_LATE_PAYMENT_RECOVERY',
            reasonDescription: 'Recovery worker automated refund for REFUND_PENDING order',
            refundType: 'FULL',
            idempotencyKey: `ref_pending_recovery_${ord.id}`,
            createdBy: 'FINANCIAL_RECOVERY_WORKER',
          });
        } catch (rErr: any) {
          console.warn(`[FinancialRecoveryWorker] Error creating recovery refund for order ${ord.id}:`, rErr.message);
        }
      }
    } catch (pendingErr: any) {
      console.warn('[FinancialRecoveryWorker] Error scanning REFUND_PENDING orders:', pendingErr.message);
    }
  }

  /**
   * Recovers stale PROCESSING seller payouts.
   */
  private async recoverSellerPayouts(summary: RecoveryCycleSummary): Promise<void> {
    const pool = getPool();
    const leaseExpiryDate = new Date(Date.now() + this.leaseDurationSec * 1000);
    const staleCutoffDate = new Date(Date.now() - this.staleThresholdSec * 1000);
    const maxAgeCutoffDate = new Date(Date.now() - this.maxAgeHours * 3600 * 1000);

    const claimedPayoutIds = await transaction(async (client) => {
      const candidateRes = await this.queryClaimCandidates(client, 'seller_payouts', staleCutoffDate, this.batchSize);

      if (candidateRes.rows.length === 0) return [];

      const ids: string[] = [];
      for (const row of candidateRes.rows) {
        const attempts = parseInt(row.reconciliation_attempts || '0', 10);
        const createdAt = new Date(row.created_at);

        if (attempts >= this.maxAttempts || createdAt < maxAgeCutoffDate) {
          this.stats.escalations++;
          summary.reconciled.escalated++;
          console.warn(
            `[FinancialRecoveryWorker] ESCALATION REQUIRED: Seller payout '${row.id}' exceeded recovery thresholds (Attempts: ${attempts}/${this.maxAttempts}). Preserving PROCESSING for manual finance audit.`
          );
          await client.query(`
            UPDATE seller_payouts
            SET last_reconciled_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `, [row.id]);
          continue;
        }

        await client.query(`
          UPDATE seller_payouts
          SET recovery_lease_id = $1,
              recovery_lease_expires_at = $2,
              reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciled_at = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `, [this.workerId, leaseExpiryDate, row.id]);

        ids.push(row.id);
      }
      return ids;
    });

    summary.claimed.sellerPayouts += claimedPayoutIds.length;
    this.stats.claimedSellerPayouts += claimedPayoutIds.length;

    for (const payoutId of claimedPayoutIds) {
      try {
        const reconciled = await sellerSettlementService.reconcileSellerPayout(payoutId, this.workerId);
        if (reconciled.status === 'PAID') {
          this.stats.reconciledCompleted++;
          summary.reconciled.completed++;
          console.log(`[FinancialRecoveryWorker] Successfully reconciled seller payout '${payoutId}' to PAID.`);
        } else if (reconciled.status === 'FAILED') {
          this.stats.reconciledFailed++;
          summary.reconciled.failed++;
          console.log(`[FinancialRecoveryWorker] Reconciled seller payout '${payoutId}' to FAILED (balance restored).`);
        } else {
          this.stats.stillPending++;
          summary.reconciled.stillPending++;
          await pool.query(`
            UPDATE seller_payouts
            SET recovery_lease_id = NULL,
                recovery_lease_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1 AND status = 'PROCESSING'
              AND recovery_lease_id = $2
          `, [payoutId, this.workerId]);
        }
      } catch (err: any) {
        this.stats.errors++;
        console.warn(`[FinancialRecoveryWorker] Transient error reconciling seller payout '${payoutId}':`, err.message);
        await pool.query(`
          UPDATE seller_payouts
          SET recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING'
            AND recovery_lease_id = $2
        `, [payoutId, this.workerId]).catch(() => {});
      }
    }
  }

  /**
   * Recovers stale PROCESSING rider payouts.
   */
  private async recoverRiderPayouts(summary: RecoveryCycleSummary): Promise<void> {
    const pool = getPool();
    const leaseExpiryDate = new Date(Date.now() + this.leaseDurationSec * 1000);
    const staleCutoffDate = new Date(Date.now() - this.staleThresholdSec * 1000);
    const maxAgeCutoffDate = new Date(Date.now() - this.maxAgeHours * 3600 * 1000);

    const claimedPayoutIds = await transaction(async (client) => {
      const candidateRes = await this.queryClaimCandidates(client, 'rider_payouts', staleCutoffDate, this.batchSize);

      if (candidateRes.rows.length === 0) return [];

      const ids: string[] = [];
      for (const row of candidateRes.rows) {
        const attempts = parseInt(row.reconciliation_attempts || '0', 10);
        const createdAt = new Date(row.created_at);

        if (attempts >= this.maxAttempts || createdAt < maxAgeCutoffDate) {
          this.stats.escalations++;
          summary.reconciled.escalated++;
          console.warn(
            `[FinancialRecoveryWorker] ESCALATION REQUIRED: Rider payout '${row.id}' exceeded recovery thresholds (Attempts: ${attempts}/${this.maxAttempts}). Preserving PROCESSING for manual finance audit.`
          );
          await client.query(`
            UPDATE rider_payouts
            SET last_reconciled_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `, [row.id]);
          continue;
        }

        await client.query(`
          UPDATE rider_payouts
          SET recovery_lease_id = $1,
              recovery_lease_expires_at = $2,
              reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciled_at = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `, [this.workerId, leaseExpiryDate, row.id]);

        ids.push(row.id);
      }
      return ids;
    });

    summary.claimed.riderPayouts += claimedPayoutIds.length;
    this.stats.claimedRiderPayouts += claimedPayoutIds.length;

    for (const payoutId of claimedPayoutIds) {
      try {
        const reconciled = await riderPayoutService.reconcileRiderPayout(payoutId, this.workerId);
        if (reconciled.status === 'PAID') {
          this.stats.reconciledCompleted++;
          summary.reconciled.completed++;
          console.log(`[FinancialRecoveryWorker] Successfully reconciled rider payout '${payoutId}' to PAID.`);
        } else if (reconciled.status === 'FAILED') {
          this.stats.reconciledFailed++;
          summary.reconciled.failed++;
          console.log(`[FinancialRecoveryWorker] Reconciled rider payout '${payoutId}' to FAILED (wallet restored).`);
        } else {
          this.stats.stillPending++;
          summary.reconciled.stillPending++;
          await pool.query(`
            UPDATE rider_payouts
            SET recovery_lease_id = NULL,
                recovery_lease_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1 AND status = 'PROCESSING'
              AND recovery_lease_id = $2
          `, [payoutId, this.workerId]);
        }
      } catch (err: any) {
        this.stats.errors++;
        console.warn(`[FinancialRecoveryWorker] Transient error reconciling rider payout '${payoutId}':`, err.message);
        await pool.query(`
          UPDATE rider_payouts
          SET recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
            WHERE id = $1 AND status = 'PROCESSING'
            AND recovery_lease_id = $2
        `, [payoutId, this.workerId]).catch(() => {});
      }
    }
  }
}

export const financialRecoveryWorker = new FinancialRecoveryWorker();
