/**
 * Sprint 15.8: Gateway-Agnostic Internal Payment Reconciliation Engine
 * Audits internal consistency across orders, payment_intents, payment_attempts,
 * payment_receipts, payment_transactions, refunds, general_ledger_entries, and COD deliveries.
 * Operates strictly on internal PostgreSQL financial tables without external gateway calls.
 */

import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import {
  transitionPaymentIntentState,
  transitionPaymentAttemptState,
} from '../payments/paymentStateMachine.js';
import { paymentLogger } from '../payments/paymentLogger.js';
import { toDecimal, roundCurrency, subtract } from '../pricing/money.js';
import { codCashAccountabilityService } from '../settlements/codCashAccountabilityService.js';

export type ReconciliationRunType = 'SCHEDULED' | 'MANUAL' | 'ORDER_SCOPED' | 'TEST';
export type DiscrepancySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type DiscrepancyStatus = 'OPEN' | 'AUTO_REPAIRED' | 'REQUIRES_REVIEW' | 'RESOLVED';

export interface ReconciliationRunOptions {
  runType?: ReconciliationRunType;
  triggeredBy?: string;
  orderId?: string;
  autoRepair?: boolean;
  staleThresholdMinutes?: number;
  batchLimit?: number;
}

export interface DetectedDiscrepancy {
  discrepancyKey: string;
  category: string;
  severity: DiscrepancySeverity;
  status: DiscrepancyStatus;
  orderId?: string | null;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  refundId?: string | null;
  riderId?: string | null;
  remittanceId?: string | null;
  collectionId?: string | null;
  expectedAmount?: number | null;
  actualAmount?: number | null;
  currency?: string;
  repairAction?: string | null;
  details: Record<string, unknown>;
}

export interface ReconciliationRunReport {
  runId: string;
  runType: ReconciliationRunType;
  status: 'COMPLETED' | 'FAILED';
  scannedOrders: number;
  discrepanciesFound: number;
  autoRepairedCount: number;
  manualReviewCount: number;
  discrepancies: Array<DetectedDiscrepancy & { id?: string }>;
  startedAt: string;
  completedAt: string;
}

export class PaymentReconciliationService {
  private async upsertDiscrepancy(
    client: pg.PoolClient,
    runId: string,
    d: DetectedDiscrepancy
  ): Promise<string> {
    const res = await client.query(
      `INSERT INTO reconciliation_discrepancies (
         discrepancy_key, run_id, category, severity, status,
         order_id, payment_intent_id, payment_attempt_id, refund_id,
         rider_id, remittance_id, collection_id,
         expected_amount, actual_amount, currency, repair_action, details,
         occurrence_count, detected_at, last_seen_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15, $16, $17,
         1, NOW(), NOW()
       )
       ON CONFLICT (discrepancy_key) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         severity = EXCLUDED.severity,
         status = CASE
           WHEN EXCLUDED.status = 'AUTO_REPAIRED' THEN 'AUTO_REPAIRED'
           WHEN reconciliation_discrepancies.status = 'RESOLVED' THEN EXCLUDED.status
           ELSE reconciliation_discrepancies.status
         END,
         rider_id = COALESCE(EXCLUDED.rider_id, reconciliation_discrepancies.rider_id),
         remittance_id = COALESCE(EXCLUDED.remittance_id, reconciliation_discrepancies.remittance_id),
         collection_id = COALESCE(EXCLUDED.collection_id, reconciliation_discrepancies.collection_id),
         repair_action = COALESCE(EXCLUDED.repair_action, reconciliation_discrepancies.repair_action),
         expected_amount = COALESCE(EXCLUDED.expected_amount, reconciliation_discrepancies.expected_amount),
         actual_amount = COALESCE(EXCLUDED.actual_amount, reconciliation_discrepancies.actual_amount),
         details = EXCLUDED.details,
         occurrence_count = reconciliation_discrepancies.occurrence_count + 1,
         last_seen_at = NOW(),
         resolved_at = CASE WHEN reconciliation_discrepancies.status = 'RESOLVED' THEN NULL ELSE reconciliation_discrepancies.resolved_at END,
         resolved_by = CASE WHEN reconciliation_discrepancies.status = 'RESOLVED' THEN NULL ELSE reconciliation_discrepancies.resolved_by END
       RETURNING id`,
      [
        d.discrepancyKey,
        runId,
        d.category,
        d.severity,
        d.status,
        d.orderId || null,
        d.paymentIntentId || null,
        d.paymentAttemptId || null,
        d.refundId || null,
        d.riderId || null,
        d.remittanceId || null,
        d.collectionId || null,
        d.expectedAmount ?? null,
        d.actualAmount ?? null,
        d.currency || 'INR',
        d.repairAction || null,
        JSON.stringify(d.details || {}),
      ]
    );
    return res.rows[0].id;
  }

  /**
   * Records a standalone operational escalation (e.g., exhausted recovery retries or stale COD remittances)
   * into reconciliation_discrepancies so operators have unified exception tracking.
   */
  public async recordEscalationDiscrepancy(params: {
    discrepancyKey: string;
    category: string;
    severity?: DiscrepancySeverity;
    orderId?: string | null;
    paymentIntentId?: string | null;
    refundId?: string | null;
    riderId?: string | null;
    remittanceId?: string | null;
    collectionId?: string | null;
    expectedAmount?: number | null;
    actualAmount?: number | null;
    details: Record<string, unknown>;
    triggeredBy?: string;
  }): Promise<string | null> {
    try {
      return await transaction(async (client) => {
        const runRes = await client.query(
          `INSERT INTO reconciliation_runs (run_type, triggered_by, status, scanned_orders, discrepancies_found, manual_review_count, completed_at)
           VALUES ('SCHEDULED', $1, 'COMPLETED', 1, 1, 1, NOW())
           RETURNING id`,
          [params.triggeredBy || 'FINANCIAL_RECOVERY_WORKER']
        );
        const runId = runRes.rows[0].id;
        return await this.upsertDiscrepancy(client, runId, {
          discrepancyKey: params.discrepancyKey,
          category: params.category,
          severity: params.severity || 'HIGH',
          status: 'REQUIRES_REVIEW',
          orderId: params.orderId || null,
          paymentIntentId: params.paymentIntentId || null,
          refundId: params.refundId || null,
          riderId: params.riderId || null,
          remittanceId: params.remittanceId || null,
          collectionId: params.collectionId || null,
          expectedAmount: params.expectedAmount ?? null,
          actualAmount: params.actualAmount ?? null,
          details: params.details,
        });
      });
    } catch {
      return null;
    }
  }

  /**
   * Executes a comprehensive bounded internal reconciliation sweep across QCOM financial tables.
   */
  public async runReconciliation(options: ReconciliationRunOptions = {}): Promise<ReconciliationRunReport> {
    const runType: ReconciliationRunType = options.orderId ? 'ORDER_SCOPED' : (options.runType || 'MANUAL');
    const autoRepair = options.autoRepair !== false;
    const staleMinutes = options.staleThresholdMinutes ?? 30;
    const batchLimit = Math.min(Math.max(options.batchLimit ?? 500, 1), 2000);
    const pool = getPool();

    const runRes = await pool.query(
      `INSERT INTO reconciliation_runs (run_type, triggered_by, status, started_at)
       VALUES ($1, $2, 'RUNNING', NOW())
       RETURNING id, started_at`,
      [runType, options.triggeredBy || 'SYSTEM']
    );
    const runId = runRes.rows[0].id as string;
    const startedAt = new Date(runRes.rows[0].started_at).toISOString();

    const detected: DetectedDiscrepancy[] = [];
    let scannedOrders = 0;

    try {
      await transaction(async (client) => {
        const scopeClause = options.orderId ? `WHERE o.id = $1` : ``;
        const scopeParams: any[] = options.orderId ? [options.orderId] : [batchLimit];
        const limitClause = options.orderId ? `` : `ORDER BY o.created_at DESC LIMIT $1`;

        const ordersRes = await client.query(
          `SELECT o.id, o.user_id, o.total_amount, o.payment_status, o.payment_method, o.status, o.created_at
           FROM orders o
           ${scopeClause}
           ${limitClause}`,
          scopeParams
        );
        scannedOrders = ordersRes.rows.length;

        const orderFilterSql = options.orderId ? `AND order_id = $1` : ``;
        const orderFilterParams: any[] = options.orderId ? [options.orderId] : [];

        // Check 1: Paid online orders without captured intent or successful receipt
        const paidWithoutCapture = await client.query(
          `SELECT o.id AS order_id, o.total_amount, o.payment_status, o.payment_method
           FROM orders o
           LEFT JOIN payment_receipts pr ON pr.order_id = o.id AND pr.status = 'SUCCESS'
           LEFT JOIN payment_intents pi ON pi.order_id = o.id AND pi.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'REFUNDED')
           WHERE o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
             AND o.payment_method != 'Pay on Delivery'
             ${options.orderId ? 'AND o.id = $1' : ''}
             AND pr.id IS NULL
             AND pi.id IS NULL
           LIMIT 200`,
          orderFilterParams
        );
        for (const r of paidWithoutCapture.rows) {
          detected.push({
            discrepancyKey: `PAID_ORDER_WITHOUT_CAPTURE:${r.order_id}`,
            category: 'PAID_ORDER_WITHOUT_CAPTURE',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            expectedAmount: parseFloat(r.total_amount),
            currency: 'INR',
            details: { paymentStatus: r.payment_status, paymentMethod: r.payment_method },
          });
        }

        // Check 2: Captured payment intent / receipt while order payment_status is not paid/refunded
        const capturedOrderNotPaid = await client.query(
          `SELECT pi.id AS intent_id, pi.order_id, pi.amount, o.payment_status, o.status AS order_status
           FROM payment_intents pi
           JOIN orders o ON o.id = pi.order_id
           WHERE pi.status = 'CAPTURED'
             AND o.payment_status IN ('PENDING', 'FAILED', 'EXPIRED')
             ${options.orderId ? 'AND o.id = $1' : ''}
           LIMIT 200`,
          orderFilterParams
        );
        for (const r of capturedOrderNotPaid.rows) {
          detected.push({
            discrepancyKey: `CAPTURED_PAYMENT_ORDER_NOT_PAID:${r.order_id}`,
            category: 'CAPTURED_PAYMENT_ORDER_NOT_PAID',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            paymentIntentId: r.intent_id,
            expectedAmount: parseFloat(r.amount),
            currency: 'INR',
            details: { orderPaymentStatus: r.payment_status, orderStatus: r.order_status },
          });
        }

        // Check 3: Paid online orders missing General Ledger PAYMENT entries
        const missingGlRes = await client.query(
          `SELECT o.id AS order_id, o.total_amount, o.payment_status
           FROM orders o
           LEFT JOIN general_ledger_entries gle ON gle.order_id = o.id AND gle.transaction_type = 'PAYMENT'
           WHERE o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
             AND o.payment_method != 'Pay on Delivery'
             ${options.orderId ? 'AND o.id = $1' : ''}
             AND gle.id IS NULL
           LIMIT 200`,
          orderFilterParams
        );
        for (const r of missingGlRes.rows) {
          detected.push({
            discrepancyKey: `MISSING_PAYMENT_GL_ENTRY:${r.order_id}`,
            category: 'MISSING_PAYMENT_GL_ENTRY',
            severity: 'HIGH',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            expectedAmount: parseFloat(r.total_amount),
            currency: 'INR',
            details: { paymentStatus: r.payment_status },
          });
        }

        // Check 4: Duplicate succeeded payment attempts per order
        const dupAttemptsRes = await client.query(
          `SELECT order_id, COUNT(*) AS cnt
           FROM payment_attempts
           WHERE status = 'SUCCEEDED' ${orderFilterSql}
           GROUP BY order_id`,
          orderFilterParams
        );
        for (const r of dupAttemptsRes.rows) {
          const cnt = parseInt(r.cnt, 10);
          if (cnt <= 1) continue;
          detected.push({
            discrepancyKey: `DUPLICATE_SUCCESSFUL_ATTEMPTS:${r.order_id}`,
            category: 'DUPLICATE_SUCCESSFUL_ATTEMPTS',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            details: { succeededAttemptCount: cnt },
          });
        }

        // Check 5: Duplicate payment_transactions CAPTURE captures
        try {
          const dupTxRes = await client.query(
            `SELECT order_id, COUNT(*) AS cnt
             FROM payment_transactions
             WHERE transaction_type = 'CAPTURE' AND status = 'SUCCEEDED' ${orderFilterSql}
             GROUP BY order_id`,
            orderFilterParams
          );
          for (const r of dupTxRes.rows) {
            const cnt = parseInt(r.cnt, 10);
            if (cnt <= 1) continue;
            detected.push({
              discrepancyKey: `DUPLICATE_PAYMENT_CAPTURES:${r.order_id}`,
              category: 'DUPLICATE_PAYMENT_CAPTURES',
              severity: 'CRITICAL',
              status: 'REQUIRES_REVIEW',
              orderId: r.order_id,
              details: { captureCount: cnt },
            });
          }
        } catch {}

        // Check 6: Duplicate successful payment receipts
        const dupReceiptsRes = await client.query(
          `SELECT order_id, COUNT(*) AS cnt
           FROM payment_receipts
           WHERE status = 'SUCCESS' ${orderFilterSql}
           GROUP BY order_id`,
          orderFilterParams
        );
        for (const r of dupReceiptsRes.rows) {
          const cnt = parseInt(r.cnt, 10);
          if (cnt <= 1) continue;
          detected.push({
            discrepancyKey: `DUPLICATE_PAYMENT_RECEIPTS:${r.order_id}`,
            category: 'DUPLICATE_PAYMENT_RECEIPTS',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            details: { receiptCount: cnt },
          });
        }

        // Check 7: Payment amount mismatch between intent/receipt and authoritative order total
        const amtMismatchRes = await client.query(
          `SELECT pi.id AS intent_id, pi.order_id, pi.amount AS intent_amount, o.total_amount
           FROM payment_intents pi
           JOIN orders o ON o.id = pi.order_id
           WHERE pi.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_PENDING')
             AND (pi.amount - o.total_amount > 0.01 OR o.total_amount - pi.amount > 0.01)
             ${options.orderId ? 'AND o.id = $1' : ''}`,
          orderFilterParams
        );
        for (const r of amtMismatchRes.rows) {
          detected.push({
            discrepancyKey: `PAYMENT_AMOUNT_MISMATCH:${r.order_id}:${r.intent_id}`,
            category: 'PAYMENT_AMOUNT_MISMATCH',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            paymentIntentId: r.intent_id,
            expectedAmount: parseFloat(r.total_amount),
            actualAmount: parseFloat(r.intent_amount),
            currency: 'INR',
            details: { orderTotal: parseFloat(r.total_amount), intentAmount: parseFloat(r.intent_amount) },
          });
        }

        // Check 8: Currency mismatches
        const currMismatchRes = await client.query(
          `SELECT id AS intent_id, order_id, currency
           FROM payment_intents
           WHERE currency != 'INR' ${orderFilterSql}`,
          orderFilterParams
        );
        for (const r of currMismatchRes.rows) {
          detected.push({
            discrepancyKey: `PAYMENT_CURRENCY_MISMATCH:${r.intent_id}`,
            category: 'PAYMENT_CURRENCY_MISMATCH',
            severity: 'HIGH',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            paymentIntentId: r.intent_id,
            currency: r.currency,
            details: { expectedCurrency: 'INR', actualCurrency: r.currency },
          });
        }

        // Check 9 & 10: Refund ceiling exceeded or cumulative refund status mismatch
        const refundSumRes = await client.query(
          `SELECT o.id AS order_id, o.total_amount, o.payment_status,
                  COALESCE(SUM(CASE WHEN r.status = 'COMPLETED' THEN r.amount ELSE 0 END), 0) AS completed_sum,
                  COALESCE(SUM(CASE WHEN r.status IN ('REQUESTED','PENDING','PROCESSING','UNKNOWN','COMPLETED','REQUIRES_REVIEW') THEN r.amount ELSE 0 END), 0) AS active_sum
           FROM orders o
           JOIN refunds r ON r.order_id = o.id
           WHERE 1=1 ${options.orderId ? 'AND o.id = $1' : ''}
           GROUP BY o.id, o.total_amount, o.payment_status`,
          orderFilterParams
        );
        for (const r of refundSumRes.rows) {
          const orderTotal = parseFloat(r.total_amount);
          const completedSum = parseFloat(r.completed_sum);
          const activeSum = parseFloat(r.active_sum);
          if (activeSum > orderTotal + 0.01) {
            detected.push({
              discrepancyKey: `REFUND_EXCEEDS_CAPTURED:${r.order_id}`,
              category: 'REFUND_EXCEEDS_CAPTURED',
              severity: 'CRITICAL',
              status: 'REQUIRES_REVIEW',
              orderId: r.order_id,
              expectedAmount: orderTotal,
              actualAmount: activeSum,
              currency: 'INR',
              details: { orderTotal, activeRefundSum: activeSum },
            });
          } else if (completedSum >= orderTotal - 0.01 && r.payment_status !== 'REFUNDED') {
            detected.push({
              discrepancyKey: `REFUND_STATUS_MISMATCH:${r.order_id}`,
              category: 'REFUND_STATUS_MISMATCH',
              severity: 'HIGH',
              status: 'REQUIRES_REVIEW',
              orderId: r.order_id,
              expectedAmount: orderTotal,
              actualAmount: completedSum,
              currency: 'INR',
              details: { orderPaymentStatus: r.payment_status, completedRefundSum: completedSum },
            });
          }
        }

        // Check 11: Duplicate GL journal imbalance on orders
        const unbalancedGlRes = await client.query(
          `SELECT order_id,
                  SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS debits,
                  SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS credits
           FROM general_ledger_entries
           WHERE order_id IS NOT NULL ${orderFilterSql}
           GROUP BY order_id`,
          orderFilterParams
        );
        for (const r of unbalancedGlRes.rows) {
          const debits = parseFloat(r.debits || '0');
          const credits = parseFloat(r.credits || '0');
          if (Math.abs(debits - credits) <= 0.01) continue;
          detected.push({
            discrepancyKey: `LEDGER_IMBALANCE:${r.order_id}`,
            category: 'LEDGER_IMBALANCE',
            severity: 'CRITICAL',
            status: 'REQUIRES_REVIEW',
            orderId: r.order_id,
            expectedAmount: debits,
            actualAmount: credits,
            currency: 'INR',
            details: { debits, credits },
          });
        }

        // Check 12: Missing attempt history on terminal intents
        const missingAttemptsRes = await client.query(
          `SELECT pi.id AS intent_id, pi.order_id, pi.status
           FROM payment_intents pi
           LEFT JOIN payment_attempts pa ON pa.payment_intent_id = pi.id OR pa.order_id = pi.order_id
           WHERE pi.status IN ('CAPTURED', 'FAILED')
             ${options.orderId ? 'AND pi.order_id = $1' : ''}
             AND pa.id IS NULL
           LIMIT 200`,
          orderFilterParams
        );
        for (const r of missingAttemptsRes.rows) {
          detected.push({
            discrepancyKey: `MISSING_ATTEMPT_HISTORY:${r.intent_id}`,
            category: 'MISSING_ATTEMPT_HISTORY',
            severity: 'LOW',
            status: 'OPEN',
            orderId: r.order_id,
            paymentIntentId: r.intent_id,
            details: { intentStatus: r.status },
          });
        }

        const isMissingCodSchemaError = (err: any): boolean => {
          const code = String(err?.code || '');
          const msg = String(err?.message || '').toLowerCase();
          return (
            code === '42P01' ||
            code === '42703' ||
            msg.includes('cod_collections') && msg.includes('does not exist') ||
            msg.includes('cod_remittances') && msg.includes('does not exist') ||
            msg.includes('cod_cash_disputes') && msg.includes('does not exist') ||
            msg.includes('does not exist') && msg.includes('relation')
          );
        };

        // Check 13: Delivered COD orders missing collection records, GL COD_COLLECTION entries, or trip collection amounts
        try {
          const codUnreconciledRes = await client.query(
            `SELECT o.id AS order_id, o.total_amount, o.payment_status, o.payment_method,
                    dt.rider_id, dt.cod_collected_amount,
                    cc.id AS collection_id, cc.collected_amount AS cod_collection_amount
             FROM orders o
             LEFT JOIN delivery_trips dt ON dt.order_id = o.id AND dt.trip_type = 'FORWARD'
             LEFT JOIN cod_collections cc ON cc.order_id = o.id AND cc.status <> 'REVERSED'
             WHERE LOWER(COALESCE(o.payment_method, '')) IN ('pay on delivery', 'cod', 'cash', 'cash on delivery')
               AND o.status = 'delivered'
               ${options.orderId ? 'AND o.id = $1' : ''}`,
            orderFilterParams
          );

          const codGlRes = await client.query(
            `SELECT order_id, COUNT(*) AS cnt
             FROM general_ledger_entries
             WHERE transaction_type = 'COD_COLLECTION'
               AND order_id IS NOT NULL
               ${options.orderId ? 'AND order_id = $1' : ''}
             GROUP BY order_id`,
            orderFilterParams
          );
          const codGlMap = new Map<string, number>();
          for (const g of codGlRes.rows) {
            codGlMap.set(String(g.order_id), parseInt(String(g.cnt || '0'), 10) || 0);
          }

          for (const r of codUnreconciledRes.rows) {
            const totalNum = Number(roundCurrency(r.total_amount || 0));
            const tripCollectedNum = Number(roundCurrency(r.cod_collected_amount || 0));
            const glCnt = codGlMap.get(String(r.order_id)) || 0;

            if (!r.collection_id || glCnt === 0 || r.payment_status === 'PENDING' || tripCollectedNum < totalNum - 0.01) {
              detected.push({
                discrepancyKey: `UNRECONCILED_COD_COLLECTION:${r.order_id}`,
                category: 'UNRECONCILED_COD_COLLECTION',
                severity: !r.collection_id || glCnt === 0 ? 'CRITICAL' : 'HIGH',
                status: 'REQUIRES_REVIEW',
                orderId: r.order_id,
                riderId: r.rider_id || null,
                collectionId: r.collection_id || null,
                expectedAmount: totalNum,
                actualAmount: r.cod_collection_amount ? Number(roundCurrency(r.cod_collection_amount)) : tripCollectedNum,
                currency: 'INR',
                details: {
                  orderPaymentStatus: r.payment_status,
                  hasCodCollectionRow: Boolean(r.collection_id),
                  codCollectionGlEntries: glCnt,
                  tripCollectedAmount: tripCollectedNum,
                },
              });
            }
          }
        } catch (err: any) {
          if (!isMissingCodSchemaError(err)) throw err;
        }

        // Check 13B: Non-COD orders must NEVER carry non-reversed cod_collections
        try {
          const nonCodColsRes = await client.query(
            `SELECT cc.id AS collection_id, cc.order_id, cc.rider_id, cc.collected_amount, o.payment_method
             FROM cod_collections cc
             JOIN orders o ON o.id = cc.order_id
             WHERE cc.status <> 'REVERSED'
               AND LOWER(COALESCE(o.payment_method, '')) NOT IN ('pay on delivery', 'cod', 'cash', 'cash on delivery')
               ${options.orderId ? 'AND cc.order_id = $1' : ''}`,
            orderFilterParams
          );
          for (const r of nonCodColsRes.rows) {
            detected.push({
              discrepancyKey: `NON_COD_ORDER_WITH_COD_COLLECTION:${r.order_id}`,
              category: 'NON_COD_ORDER_WITH_COD_COLLECTION',
              severity: 'CRITICAL',
              status: 'REQUIRES_REVIEW',
              orderId: r.order_id,
              riderId: r.rider_id || null,
              collectionId: r.collection_id,
              expectedAmount: 0,
              actualAmount: Number(roundCurrency(r.collected_amount || 0)),
              currency: 'INR',
              details: { paymentMethod: r.payment_method },
            });
          }
        } catch (err: any) {
          if (!isMissingCodSchemaError(err)) throw err;
        }

        // Check 13C: Cleared COD collections whose forward trip still shows cod_reconciled = FALSE
        try {
          const tripSyncRes = await client.query(
            `SELECT cc.id AS collection_id, cc.order_id, cc.rider_id, cc.cleared_amount, dt.id AS trip_id
             FROM cod_collections cc
             JOIN delivery_trips dt ON dt.order_id = cc.order_id AND dt.trip_type = 'FORWARD'
             WHERE cc.status = 'CLEARED'
               AND dt.cod_reconciled = FALSE
               ${options.orderId ? 'AND cc.order_id = $1' : ''}`,
            orderFilterParams
          );
          for (const r of tripSyncRes.rows) {
            const verRemRes = await client.query(
              `SELECT cr.id
               FROM cod_remittance_allocations cra
               JOIN cod_remittances cr ON cr.id = cra.remittance_id
               WHERE cra.collection_id = $1
                 AND cr.status IN ('VERIFIED', 'LIABILITY_CLEARED', 'EXCESS')
                 AND cr.journal_batch_id IS NOT NULL
               LIMIT 1`,
              [r.collection_id]
            );
            const verifiedRemitId = verRemRes.rows[0]?.id || null;

            if (autoRepair && verifiedRemitId) {
              await client.query(`SELECT id FROM delivery_trips WHERE id = $1 FOR UPDATE`, [r.trip_id]);
              await client.query(
                `UPDATE delivery_trips SET cod_reconciled = TRUE, updated_at = NOW() WHERE id = $1`,
                [r.trip_id]
              );
              detected.push({
                discrepancyKey: `COD_TRIP_RECONCILED_FLAG_DRIFT:${r.order_id}`,
                category: 'COD_TRIP_RECONCILED_FLAG_DRIFT',
                severity: 'LOW',
                status: 'AUTO_REPAIRED',
                orderId: r.order_id,
                riderId: r.rider_id || null,
                collectionId: r.collection_id,
                remittanceId: verifiedRemitId,
                repairAction: 'SYNCED_DELIVERY_TRIP_COD_RECONCILED_TRUE',
                details: { tripId: r.trip_id, verifiedRemittanceId: verifiedRemitId },
              });
            } else {
              detected.push({
                discrepancyKey: `COD_TRIP_RECONCILED_FLAG_DRIFT:${r.order_id}`,
                category: 'COD_TRIP_RECONCILED_FLAG_DRIFT',
                severity: 'HIGH',
                status: 'REQUIRES_REVIEW',
                orderId: r.order_id,
                riderId: r.rider_id || null,
                collectionId: r.collection_id,
                expectedAmount: Number(roundCurrency(r.cleared_amount || 0)),
                details: { tripId: r.trip_id, hasVerifiedRemittance: Boolean(verifiedRemitId) },
              });
            }
          }
        } catch (err: any) {
          if (!isMissingCodSchemaError(err)) throw err;
        }

        // Check 13D..13F (Portfolio COD checks when not narrowly single-order scoped)
        if (!options.orderId) {
          // 13D: Negative rider floating_cash_balance OR GL 1030 / collection liability drift
          try {
            const riderAuditRes = await client.query(
              `SELECT id AS rider_id, floating_cash_balance, floating_cash_limit,
                      cod_restricted, active_cod_dispute_count,
                      cod_ceiling_override_limit, cod_ceiling_override_until
               FROM riders`
            );

            const gl1030Res = await client.query(
              `SELECT rider_id,
                      SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS debits,
                      SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS credits,
                      COUNT(*) AS cnt
               FROM general_ledger_entries
               WHERE account_code = '1030' AND rider_id IS NOT NULL
               GROUP BY rider_id`
            );
            const gl1030Map = new Map<string, { net: BigNumber; cnt: number }>();
            for (const g of gl1030Res.rows) {
              gl1030Map.set(String(g.rider_id), {
                net: subtract(toDecimal(g.debits || 0), toDecimal(g.credits || 0)),
                cnt: parseInt(String(g.cnt || '0'), 10) || 0,
              });
            }

            const colCntRes = await client.query(
              `SELECT rider_id, COUNT(*) AS cnt
               FROM cod_collections
               WHERE status <> 'REVERSED'
               GROUP BY rider_id`
            );
            const colCntMap = new Map<string, number>();
            for (const c of colCntRes.rows) {
              colCntMap.set(String(c.rider_id), parseInt(String(c.cnt || '0'), 10) || 0);
            }

            for (const rr of riderAuditRes.rows) {
              const floatBn = toDecimal(roundCurrency(rr.floating_cash_balance || 0));
              const glInfo = gl1030Map.get(String(rr.rider_id));
              const glNetBn = glInfo ? toDecimal(roundCurrency(glInfo.net)) : toDecimal(0);
              const glCnt = glInfo ? glInfo.cnt : 0;
              const colCnt = colCntMap.get(String(rr.rider_id)) || 0;

              if (floatBn.lt(0)) {
                detected.push({
                  discrepancyKey: `NEGATIVE_RIDER_CASH_LIABILITY:${rr.rider_id}`,
                  category: 'NEGATIVE_RIDER_CASH_LIABILITY',
                  severity: 'CRITICAL',
                  status: 'REQUIRES_REVIEW',
                  riderId: rr.rider_id,
                  expectedAmount: 0,
                  actualAmount: Number(roundCurrency(floatBn)),
                  currency: 'INR',
                  details: { floatingCashBalance: Number(roundCurrency(floatBn)) },
                });
              }

              if ((glCnt > 0 || colCnt > 0) && subtract(floatBn, glNetBn).abs().gt(0.01)) {
                detected.push({
                  discrepancyKey: `RIDER_CASH_LIABILITY_DRIFT:${rr.rider_id}`,
                  category: 'RIDER_CASH_LIABILITY_DRIFT',
                  severity: 'CRITICAL',
                  status: 'REQUIRES_REVIEW',
                  riderId: rr.rider_id,
                  expectedAmount: Number(roundCurrency(glNetBn)),
                  actualAmount: Number(roundCurrency(floatBn)),
                  currency: 'INR',
                  details: {
                    materializedFloatingCash: Number(roundCurrency(floatBn)),
                    glAccount1030Net: Number(roundCurrency(glNetBn)),
                    drift: Number(roundCurrency(subtract(floatBn, glNetBn))),
                  },
                });
              }

              // 13E: Restriction flag sync if over effective ceiling or open dispute exists without restriction flag
              const { effectiveLimit } = codCashAccountabilityService.resolveEffectiveCashCeiling(rr);
              const openDisputes = parseInt(String(rr.active_cod_dispute_count || '0'), 10) || 0;
              const shouldRestrict = floatBn.gte(effectiveLimit) || openDisputes > 0;
              if (shouldRestrict && !rr.cod_restricted) {
                if (autoRepair) {
                  await codCashAccountabilityService.syncRiderCodRestrictionInTx(client, rr.rider_id);
                  detected.push({
                    discrepancyKey: `COD_RESTRICTION_FLAG_DESYNC:${rr.rider_id}`,
                    category: 'COD_RESTRICTION_FLAG_DESYNC',
                    severity: 'MEDIUM',
                    status: 'AUTO_REPAIRED',
                    riderId: rr.rider_id,
                    repairAction: 'SYNCED_RIDER_COD_RESTRICTED_FLAG',
                    details: {
                      floatingCashBalance: Number(roundCurrency(floatBn)),
                      effectiveCeiling: effectiveLimit,
                      openDisputes,
                    },
                  });
                } else {
                  detected.push({
                    discrepancyKey: `COD_RESTRICTION_FLAG_DESYNC:${rr.rider_id}`,
                    category: 'COD_RESTRICTION_FLAG_DESYNC',
                    severity: 'HIGH',
                    status: 'REQUIRES_REVIEW',
                    riderId: rr.rider_id,
                    details: {
                      floatingCashBalance: Number(roundCurrency(floatBn)),
                      effectiveCeiling: effectiveLimit,
                      openDisputes,
                    },
                  });
                }
              }
            }
          } catch (err: any) {
            if (!isMissingCodSchemaError(err)) throw err;
          }

          // 13F: Remittance custody/two-person/GL/shortage-excess integrity audit
          try {
            const remAuditRes = await client.query(
              `SELECT id AS remittance_id, remittance_reference, rider_id, status,
                      submitted_by, received_by, verified_by,
                      submitted_amount, verified_amount, shortage_amount, excess_amount,
                      journal_batch_id, created_at, submitted_at
               FROM cod_remittances`
            );

            const dispCntRes = await client.query(
              `SELECT remittance_id, COUNT(*) AS cnt
               FROM cod_cash_disputes
               WHERE remittance_id IS NOT NULL
                 AND dispute_type IN ('SHORTAGE', 'EXCESS')
               GROUP BY remittance_id`
            );
            const dispCntMap = new Map<string, number>();
            for (const d of dispCntRes.rows) {
              dispCntMap.set(String(d.remittance_id), parseInt(String(d.cnt || '0'), 10) || 0);
            }

            const gl2080Res = await client.query(
              `SELECT rider_id, COUNT(*) AS cnt
               FROM general_ledger_entries
               WHERE account_code = '2080' AND rider_id IS NOT NULL
               GROUP BY rider_id`
            );
            const gl2080Map = new Map<string, number>();
            for (const g of gl2080Res.rows) {
              gl2080Map.set(String(g.rider_id), parseInt(String(g.cnt || '0'), 10) || 0);
            }

            const staleCutoffMs = Date.now() - staleMinutes * 60 * 1000;
            for (const rem of remAuditRes.rows) {
              const isVerifiedState = ['VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS'].includes(rem.status);
              if (isVerifiedState) {
                const sodBroken =
                  !rem.received_by ||
                  !rem.verified_by ||
                  (rem.submitted_by && rem.received_by === rem.submitted_by) ||
                  (rem.submitted_by && rem.verified_by === rem.submitted_by) ||
                  rem.received_by === rem.verified_by;

                if (sodBroken) {
                  detected.push({
                    discrepancyKey: `COD_SOD_INTEGRITY_VIOLATION:${rem.remittance_id}`,
                    category: 'COD_SOD_INTEGRITY_VIOLATION',
                    severity: 'CRITICAL',
                    status: 'REQUIRES_REVIEW',
                    riderId: rem.rider_id,
                    remittanceId: rem.remittance_id,
                    details: {
                      remittanceReference: rem.remittance_reference,
                      submittedBy: rem.submitted_by,
                      receivedBy: rem.received_by,
                      verifiedBy: rem.verified_by,
                    },
                  });
                }

                const verNum = Number(roundCurrency(rem.verified_amount || 0));
                if (verNum > 0 && !rem.journal_batch_id) {
                  detected.push({
                    discrepancyKey: `COD_VERIFIED_REMITTANCE_MISSING_GL:${rem.remittance_id}`,
                    category: 'COD_VERIFIED_REMITTANCE_MISSING_GL',
                    severity: 'CRITICAL',
                    status: 'REQUIRES_REVIEW',
                    riderId: rem.rider_id,
                    remittanceId: rem.remittance_id,
                    expectedAmount: verNum,
                    actualAmount: 0,
                    details: { remittanceReference: rem.remittance_reference, status: rem.status },
                  });
                }

                const shortNum = Number(roundCurrency(rem.shortage_amount || 0));
                const excessNum = Number(roundCurrency(rem.excess_amount || 0));
                const dispCnt = dispCntMap.get(String(rem.remittance_id)) || 0;
                const gl2080Cnt = gl2080Map.get(String(rem.rider_id)) || 0;

                if ((shortNum > 0 || excessNum > 0) && dispCnt === 0) {
                  detected.push({
                    discrepancyKey: `COD_VARIANCE_MISSING_DISPUTE:${rem.remittance_id}`,
                    category: 'COD_VARIANCE_MISSING_DISPUTE',
                    severity: 'HIGH',
                    status: 'REQUIRES_REVIEW',
                    riderId: rem.rider_id,
                    remittanceId: rem.remittance_id,
                    expectedAmount: shortNum > 0 ? shortNum : excessNum,
                    details: { remittanceReference: rem.remittance_reference, shortageAmount: shortNum, excessAmount: excessNum },
                  });
                }

                if (excessNum > 0 && gl2080Cnt === 0) {
                  detected.push({
                    discrepancyKey: `COD_EXCESS_MISSING_SUSPENSE_GL:${rem.remittance_id}`,
                    category: 'COD_EXCESS_MISSING_SUSPENSE_GL',
                    severity: 'HIGH',
                    status: 'REQUIRES_REVIEW',
                    riderId: rem.rider_id,
                    remittanceId: rem.remittance_id,
                    expectedAmount: excessNum,
                    details: { remittanceReference: rem.remittance_reference, excessAmount: excessNum },
                  });
                }
              }

              // Stale unverified remittance check
              if (['SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING'].includes(rem.status)) {
                const refTs = new Date(rem.submitted_at || rem.created_at).getTime();
                if (refTs < staleCutoffMs) {
                  detected.push({
                    discrepancyKey: `STALE_UNVERIFIED_COD_REMITTANCE:${rem.remittance_id}`,
                    category: 'STALE_UNVERIFIED_COD_REMITTANCE',
                    severity: 'MEDIUM',
                    status: 'REQUIRES_REVIEW',
                    riderId: rem.rider_id,
                    remittanceId: rem.remittance_id,
                    expectedAmount: Number(roundCurrency(rem.submitted_amount || 0)),
                    details: {
                      remittanceReference: rem.remittance_reference,
                      status: rem.status,
                      submittedAt: rem.submitted_at || rem.created_at,
                    },
                  });
                }
              }
            }
          } catch (err: any) {
            if (!isMissingCodSchemaError(err)) throw err;
          }
        }

        // Check 14 & 15: Expired uncaptured intents (safe auto-repair) & stuck ambiguous/processing intents (flag review)
        const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
        const problematicIntents = await client.query(
          `SELECT pi.id AS intent_id, pi.order_id, pi.status, pi.expires_at, pi.updated_at,
                  o.payment_status, o.status AS order_status
           FROM payment_intents pi
           JOIN orders o ON o.id = pi.order_id
           WHERE (
             (pi.status IN ('CREATED', 'INITIATED', 'PENDING') AND pi.expires_at <= NOW())
             OR
             (pi.status IN ('PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW') AND pi.updated_at < $1)
           )
           ${options.orderId ? 'AND pi.order_id = $2' : ''}
           FOR UPDATE`,
          options.orderId ? [staleCutoff, options.orderId] : [staleCutoff]
        );

        for (const row of problematicIntents.rows) {
          const isUnambiguousExpired =
            ['CREATED', 'INITIATED', 'PENDING'].includes(row.status) &&
            row.expires_at &&
            new Date(row.expires_at).getTime() <= Date.now() &&
            row.payment_status === 'PENDING';

          if (isUnambiguousExpired) {
            // Double check zero receipt & zero succeeded capture tx before repairing
            const receiptCheck = await client.query(
              `SELECT 1 FROM payment_receipts WHERE order_id = $1 AND status = 'SUCCESS' LIMIT 1`,
              [row.order_id]
            );
            let hasCaptureTx = false;
            try {
              const txCheck = await client.query(
                `SELECT 1 FROM payment_transactions WHERE order_id = $1 AND transaction_type = 'CAPTURE' AND status = 'SUCCEEDED' LIMIT 1`,
                [row.order_id]
              );
              hasCaptureTx = txCheck.rows.length > 0;
            } catch {}

            if (autoRepair && receiptCheck.rows.length === 0 && !hasCaptureTx) {
              await transitionPaymentIntentState(client, row.intent_id, 'EXPIRED', {
                errorCode: 'RECONCILIATION_AUTO_EXPIRED',
                errorDescription: 'Expired uncaptured payment intent lapsed without capture evidence.',
                failureClassification: 'POLICY',
              });
              try {
                const openAttRes = await client.query(
                  `SELECT id FROM payment_attempts
                   WHERE payment_intent_id = $1 AND status IN ('INITIATED', 'PENDING')
                   FOR UPDATE`,
                  [row.intent_id]
                );
                for (const att of openAttRes.rows) {
                  await transitionPaymentAttemptState(client, att.id, 'EXPIRED', {
                    errorCode: 'RECONCILIATION_AUTO_EXPIRED',
                    errorMessage: 'Parent intent auto-expired by internal reconciliation.',
                    failureClassification: 'POLICY',
                    retryEligible: true,
                  });
                }
              } catch {}

              detected.push({
                discrepancyKey: `EXPIRED_UNCAPTURED_INTENT:${row.intent_id}`,
                category: 'EXPIRED_UNCAPTURED_INTENT',
                severity: 'LOW',
                status: 'AUTO_REPAIRED',
                orderId: row.order_id,
                paymentIntentId: row.intent_id,
                repairAction: 'TRANSITIONED_INTENT_TO_EXPIRED',
                details: { previousStatus: row.status, expiresAt: row.expires_at },
              });
            } else {
              detected.push({
                discrepancyKey: `EXPIRED_UNCAPTURED_INTENT:${row.intent_id}`,
                category: 'EXPIRED_UNCAPTURED_INTENT',
                severity: 'MEDIUM',
                status: 'OPEN',
                orderId: row.order_id,
                paymentIntentId: row.intent_id,
                details: { previousStatus: row.status, hasCaptureTx },
              });
            }
          } else {
            detected.push({
              discrepancyKey: `STUCK_AMBIGUOUS_INTENT:${row.intent_id}`,
              category: 'STUCK_AMBIGUOUS_INTENT',
              severity: row.status === 'REQUIRES_REVIEW' ? 'HIGH' : 'MEDIUM',
              status: 'REQUIRES_REVIEW',
              orderId: row.order_id,
              paymentIntentId: row.intent_id,
              details: { status: row.status, updatedAt: row.updated_at },
            });
          }
        }

        // Persist all detected discrepancies inside this run
        for (const d of detected) {
          const id = await this.upsertDiscrepancy(client, runId, d);
          (d as any).id = id;
        }
      });

      const autoRepairedCount = detected.filter((d) => d.status === 'AUTO_REPAIRED').length;
      const manualReviewCount = detected.filter((d) => d.status === 'REQUIRES_REVIEW' || d.status === 'OPEN').length;
      const completedAt = new Date().toISOString();

      await pool.query(
        `UPDATE reconciliation_runs
         SET status = 'COMPLETED',
             scanned_orders = $1,
             discrepancies_found = $2,
             auto_repaired_count = $3,
             manual_review_count = $4,
             summary = $5,
             completed_at = NOW()
         WHERE id = $6`,
        [
          scannedOrders,
          detected.length,
          autoRepairedCount,
          manualReviewCount,
          JSON.stringify({
            categories: detected.reduce((acc: Record<string, number>, d) => {
              acc[d.category] = (acc[d.category] || 0) + 1;
              return acc;
            }, {}),
          }),
          runId,
        ]
      );

      if (detected.length > 0) {
        paymentLogger.increment('reconciliationDiscrepancies', detected.length);
        paymentLogger.log('warn', 'INTERNAL_RECONCILIATION_COMPLETED_WITH_FINDINGS', {}, {
          runId,
          scannedOrders,
          discrepanciesFound: detected.length,
          autoRepairedCount,
          manualReviewCount,
        });
      } else {
        paymentLogger.log('info', 'INTERNAL_RECONCILIATION_CLEAN', {}, { runId, scannedOrders });
      }

      return {
        runId,
        runType,
        status: 'COMPLETED',
        scannedOrders,
        discrepanciesFound: detected.length,
        autoRepairedCount,
        manualReviewCount,
        discrepancies: detected,
        startedAt,
        completedAt,
      };
    } catch (err: any) {
      await pool.query(
        `UPDATE reconciliation_runs SET status = 'FAILED', summary = $1, completed_at = NOW() WHERE id = $2`,
        [JSON.stringify({ error: err.message }), runId]
      ).catch(() => {});
      throw err;
    }
  }

  public async listDiscrepancies(filters: {
    status?: string;
    severity?: string;
    orderId?: string;
    riderId?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const pool = getPool();
    const clauses: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters.status) {
      clauses.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.severity) {
      clauses.push(`severity = $${idx++}`);
      params.push(filters.severity);
    }
    if (filters.orderId) {
      clauses.push(`order_id = $${idx++}`);
      params.push(filters.orderId);
    }
    if (filters.riderId) {
      clauses.push(`rider_id = $${idx++}`);
      params.push(filters.riderId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    params.push(limit);

    const res = await pool.query(
      `SELECT * FROM reconciliation_discrepancies
       ${whereClause}
       ORDER BY last_seen_at DESC
       LIMIT $${idx}`,
      params
    );
    return res.rows;
  }

  public async resolveDiscrepancy(params: {
    discrepancyId: string;
    resolvedBy: string;
    resolutionNote?: string;
  }): Promise<any> {
    const pool = getPool();
    const res = await pool.query(
      `UPDATE reconciliation_discrepancies
       SET status = 'RESOLVED',
           repair_action = COALESCE($1, repair_action),
           resolved_at = NOW(),
           resolved_by = $2
       WHERE id = $3
       RETURNING *`,
      [params.resolutionNote || 'MANUAL_ADMIN_RESOLUTION', params.resolvedBy, params.discrepancyId]
    );
    if (res.rows.length === 0) {
      throw new Error(`DISCREPANCY_NOT_FOUND: Discrepancy '${params.discrepancyId}' does not exist.`);
    }
    return res.rows[0];
  }
}

export const paymentReconciliationService = new PaymentReconciliationService();
