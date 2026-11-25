import crypto from 'crypto';
import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { toDecimal, roundCurrency, add, subtract } from '../pricing/money.js';
import { ledgerService, isCodPaymentMethod } from '../ledger/ledgerService.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { paymentLogger } from '../payments/paymentLogger.js';
import { settlementEventPublisher } from './settlementEvents.js';

export type RemittanceMethod = 'CASH_HUB' | 'UPI' | 'BANK' | 'KIOSK' | 'DEPOSIT_SLIP';

export type RemittanceStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'RECEIVED'
  | 'VERIFICATION_PENDING'
  | 'VERIFIED'
  | 'LIABILITY_CLEARED'
  | 'SHORTAGE'
  | 'EXCESS'
  | 'DISPUTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REVERSED';

export type DisputeResolutionType =
  | 'RECOVERED_CASH'
  | 'RECOVERED_FROM_WALLET'
  | 'ESCALATED_TO_RECEIVABLE'
  | 'RECEIVABLE_COLLECTED'
  | 'WRITTEN_OFF'
  | 'EXCESS_RETURNED'
  | 'EXCESS_ALLOCATED_TO_COLLECTION'
  | 'CONFIRMED_NO_VARIANCE';

export class CodAccountabilityError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(`${errorCode}: ${message}`);
    this.name = 'CodAccountabilityError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new CodAccountabilityError(400, 'INVALID_UUID', `${fieldName} must be a valid UUID.`);
  }
  return value.trim();
}

export interface RiderCashSummary {
  riderId: string;
  riderCode: string;
  riderName: string;
  riderStatus: string;
  currency: 'INR';
  totalCodCollected: number;
  totalRemittanceSubmitted: number;
  totalRemittanceReceived: number;
  totalVerifiedRemittance: number;
  totalRiderCashLiability: number;
  totalDisputedAmount: number;
  totalUnverifiedRemittance: number;
  totalOutstandingAmount: number;
  unallocatedLiability: number;
  materializedFloatingCashBalance: number;
  ledger1030NetBalance: number;
  ledgerDriftAmount: number;
  floatingCashLimit: number;
  effectiveCashCeiling: number;
  ceilingOverrideActive: boolean;
  ceilingOverrideUntil: string | null;
  isOverCeiling: boolean;
  isCodRestricted: boolean;
  codRestrictionReason: string | null;
  activeCodDisputeCount: number;
  isDispatchBlocked: boolean;
  collections: Array<{
    collectionId: string;
    collectionReference: string;
    orderId: string;
    tripId: string | null;
    expectedAmount: number;
    collectedAmount: number;
    allocatedAmount: number;
    clearedAmount: number;
    disputedAmount: number;
    outstandingAmount: number;
    status: string;
    collectedAt: string;
    clearedAt: string | null;
  }>;
  remittances: Array<{
    remittanceId: string;
    remittanceReference: string;
    submittedAmount: number;
    receivedAmount: number | null;
    verifiedAmount: number | null;
    clearedAmount: number;
    shortageAmount: number;
    excessAmount: number;
    status: string;
    method: string;
    collectionLocation: string | null;
    submittedAt: string | null;
    receivedAt: string | null;
    verifiedAt: string | null;
    clearedAt: string | null;
  }>;
  disputes: Array<{
    disputeId: string;
    disputeNumber: string;
    remittanceId: string | null;
    disputeType: string;
    status: string;
    resolutionType: string | null;
    expectedAmount: number;
    submittedAmount: number;
    verifiedAmount: number;
    disputedAmount: number;
    reason: string;
    openedAt: string;
    resolvedAt: string | null;
  }>;
}

const VALID_METHODS = new Set<RemittanceMethod>(['CASH_HUB', 'UPI', 'BANK', 'KIOSK', 'DEPOSIT_SLIP']);

/**
 * Authoritative PostgreSQL Lock Hierarchy for COD operations (prevents deadlocks):
 * 1. orders
 * 2. delivery_trips
 * 3. riders
 * 4. cod_collections
 * 5. cod_remittances
 * 6. cod_remittance_allocations
 * 7. cod_cash_disputes
 * 8. ledger_journal_batches / general_ledger_entries
 */
export class CodCashAccountabilityService {
  /**
   * Computes the rider's active COD ceiling considering non-expired authorized temporary overrides.
   */
  public resolveEffectiveCashCeiling(riderRow: any): {
    baseLimit: number;
    effectiveLimit: number;
    overrideActive: boolean;
  } {
    const baseLimit = Number(roundCurrency(toDecimal(riderRow.floating_cash_limit ?? 2500)));
    const overrideLimit = riderRow.cod_ceiling_override_limit
      ? Number(roundCurrency(toDecimal(riderRow.cod_ceiling_override_limit)))
      : null;
    const overrideUntil = riderRow.cod_ceiling_override_until
      ? new Date(riderRow.cod_ceiling_override_until)
      : null;

    const overrideActive = Boolean(
      overrideLimit && overrideLimit > 0 && overrideUntil && overrideUntil.getTime() > Date.now()
    );

    return {
      baseLimit,
      effectiveLimit: overrideActive && overrideLimit ? overrideLimit : baseLimit,
      overrideActive,
    };
  }

  /**
   * Synchronizes rider COD ceiling restriction and legacy status safely under an already held riders row lock.
   */
  public async syncRiderCodRestrictionInTx(
    client: pg.PoolClient,
    riderId: string,
    opts?: { liftSuspensionIfClear?: boolean }
  ): Promise<{
    floatingCashBalance: number;
    effectiveCeiling: number;
    isCodRestricted: boolean;
    riderStatus: string;
    unblocked: boolean;
  }> {
    const res = await client.query(
      `SELECT id, status, floating_cash_balance, floating_cash_limit,
              cod_restricted, cod_restriction_reason, active_cod_dispute_count,
              cod_ceiling_override_limit, cod_ceiling_override_until
       FROM riders
       WHERE id = $1
       FOR UPDATE`,
      [riderId]
    );
    if (res.rows.length === 0) {
      throw new CodAccountabilityError(404, 'RIDER_NOT_FOUND', `Rider '${riderId}' not found.`);
    }

    const r = res.rows[0];
    const cashBn = toDecimal(roundCurrency(r.floating_cash_balance || '0'));
    const { effectiveLimit } = this.resolveEffectiveCashCeiling(r);
    const overCeiling = cashBn.gte(effectiveLimit);
    const openDisputes = parseInt(String(r.active_cod_dispute_count || '0'), 10) || 0;

    let nextCodRestricted = Boolean(r.cod_restricted);
    let nextReason: string | null = r.cod_restriction_reason || null;
    let nextStatus = String(r.status);
    let unblocked = false;

    if (openDisputes > 0) {
      nextCodRestricted = true;
      nextReason = nextReason && nextReason.includes('SHORTAGE') ? nextReason : 'UNRESOLVED_COD_DISPUTE';
    } else if (overCeiling) {
      nextCodRestricted = true;
      nextReason = 'CASH_CEILING_EXCEEDED';
      nextStatus = 'SUSPENDED';
    } else {
      // Under ceiling & zero open COD disputes: clear ceiling/dispute COD restriction unless manually locked for admin investigation
      const manualAdminHold = nextReason === 'ADMIN_COD_INVESTIGATION';
      if (!manualAdminHold) {
        nextCodRestricted = false;
        nextReason = null;
        if (opts?.liftSuspensionIfClear && nextStatus === 'SUSPENDED') {
          nextStatus = 'IDLE_AT_HUB';
          unblocked = true;
        }
      }
    }

    await client.query(
      `UPDATE riders
       SET cod_restricted = $1,
           cod_restriction_reason = $2,
           cod_restricted_at = CASE WHEN $1 = TRUE THEN COALESCE(cod_restricted_at, NOW()) ELSE NULL END,
           status = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [nextCodRestricted, nextReason, nextStatus, riderId]
    );

    return {
      floatingCashBalance: Number(roundCurrency(cashBn)),
      effectiveCeiling: effectiveLimit,
      isCodRestricted: nextCodRestricted,
      riderStatus: nextStatus,
      unblocked,
    };
  }

  /**
   * Records an authoritative order-level COD collection atomically inside the caller's transaction
   * (or opens a transaction if no client is provided).
   */
  public async recordCodCollection(params: {
    orderId: string;
    tripId?: string | null;
    riderId: string;
    collectedByUserId?: string | null;
    collectorSource?: string;
    clientSuppliedAmount?: unknown;
    allowPartial?: boolean;
    idempotencyKey?: string;
    client?: pg.PoolClient;
  }): Promise<{
    collectionId: string;
    collectionReference: string;
    orderId: string;
    riderId: string;
    collectedAmount: number;
    journalBatchId: string;
    alreadyExisted: boolean;
  }> {
    if (params.allowPartial === true) {
      throw new CodAccountabilityError(
        400,
        'PARTIAL_COD_NOT_SUPPORTED',
        'Partial COD cash collection is not supported; full authoritative order total must be collected.'
      );
    }

    const execute = async (client: pg.PoolClient) => {
      // 1. Lock order first (hierarchy level 1)
      const orderRes = await client.query(
        `SELECT id, order_number, merchant_id, status, payment_method, payment_status, total_amount
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [params.orderId]
      );
      if (orderRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'ORDER_NOT_FOUND', `Order '${params.orderId}' not found.`);
      }
      const order = orderRes.rows[0];

      if (!isCodPaymentMethod(order.payment_method)) {
        throw new CodAccountabilityError(
          400,
          'NON_COD_ORDER',
          `Order '${params.orderId}' uses '${order.payment_method}' and cannot record COD cash collection.`
        );
      }

      if (order.status === 'cancelled' || order.status === 'returned') {
        throw new CodAccountabilityError(
          409,
          'ORDER_NOT_ELIGIBLE_FOR_COD',
          `Cannot collect COD for order in status '${order.status}'.`
        );
      }
      if (
        ['REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'FAILED', 'EXPIRED'].includes(
          String(order.payment_status)
        )
      ) {
        throw new CodAccountabilityError(
          409,
          'ORDER_FINANCIAL_STATE_INVALID',
          `Cannot collect COD when payment_status is '${order.payment_status}'.`
        );
      }

      const authTotalBn = toDecimal(roundCurrency(order.total_amount));
      if (authTotalBn.lte(0)) {
        throw new CodAccountabilityError(
          400,
          'INVALID_COD_ORDER_TOTAL',
          `Order '${params.orderId}' has non-positive total amount '${order.total_amount}'.`
        );
      }
      const authoritativeAmount = Number(roundCurrency(authTotalBn));

      // Lock trip if present (hierarchy level 2)
      let verifiedTripId: string | null = params.tripId || null;
      if (verifiedTripId) {
        const tripRes = await client.query(
          `SELECT id, rider_id, order_id, trip_type, status
           FROM delivery_trips
           WHERE id = $1
           FOR UPDATE`,
          [verifiedTripId]
        );
        if (tripRes.rows.length === 0) {
          throw new CodAccountabilityError(404, 'TRIP_NOT_FOUND', `Trip '${verifiedTripId}' not found.`);
        }
        const trip = tripRes.rows[0];
        if (trip.order_id !== params.orderId) {
          throw new CodAccountabilityError(409, 'TRIP_ORDER_MISMATCH', 'Delivery trip does not belong to order.');
        }
        if (trip.rider_id && trip.rider_id !== params.riderId) {
          throw new CodAccountabilityError(
            403,
            'COD_RIDER_MISMATCH',
            `Delivery trip is assigned to rider '${trip.rider_id}', not '${params.riderId}'.`
          );
        }
      }

      // Lock rider (hierarchy level 3)
      const riderRes = await client.query(
        `SELECT id, status FROM riders WHERE id = $1 FOR UPDATE`,
        [params.riderId]
      );
      if (riderRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'RIDER_NOT_FOUND', `Rider '${params.riderId}' not found.`);
      }

      // 4. Check existing collection (hierarchy level 4)
      const existingColRes = await client.query(
        `SELECT * FROM cod_collections WHERE order_id = $1 FOR UPDATE`,
        [params.orderId]
      );
      if (existingColRes.rows.length > 0) {
        const ex = existingColRes.rows[0];
        if (ex.rider_id !== params.riderId) {
          throw new CodAccountabilityError(
            409,
            'COD_ALREADY_COLLECTED_OTHER_RIDER',
            `Order '${params.orderId}' COD was already collected by rider '${ex.rider_id}'.`
          );
        }
        return {
          collectionId: ex.id,
          collectionReference: ex.collection_reference,
          orderId: ex.order_id,
          riderId: ex.rider_id,
          collectedAmount: Number(roundCurrency(ex.collected_amount)),
          journalBatchId: ex.journal_batch_id,
          alreadyExisted: true,
        };
      }

      const collectionRef = `COD_COL_${params.orderId}`;
      const ledgerRef = `TX_COD_COLLECT_${params.orderId}`;
      const journalBatchId = await ledgerService.recordCodCollection({
        orderId: params.orderId,
        merchantId: order.merchant_id,
        riderId: params.riderId,
        amount: authoritativeAmount,
        client,
      });

      const insertRes = await client.query(
        `INSERT INTO cod_collections (
           collection_reference, order_id, trip_id, rider_id, currency,
           expected_amount, collected_amount, allocated_amount, cleared_amount, disputed_amount,
           status, journal_batch_id, ledger_transaction_reference,
           collected_by_user_id, collector_source, idempotency_key, collected_at, metadata
         ) VALUES (
           $1, $2, $3, $4, 'INR',
           $5, $5, 0.00, 0.00, 0.00,
           'COLLECTED', $6, $7,
           $8, $9, $10, NOW(), $11
         )
         ON CONFLICT (order_id) DO UPDATE SET updated_at = NOW()
         RETURNING id, collection_reference`,
        [
          collectionRef,
          params.orderId,
          verifiedTripId,
          params.riderId,
          authoritativeAmount.toFixed(2),
          journalBatchId,
          ledgerRef,
          params.collectedByUserId || null,
          params.collectorSource || 'DELIVERY_OTP_COMPLETION',
          params.idempotencyKey || null,
          JSON.stringify({
            orderNumber: order.order_number,
            clientSuppliedIgnored: params.clientSuppliedAmount !== undefined,
          }),
        ]
      );

      // Ensure delivery_trips marks collection amount accurately while keeping cod_reconciled = FALSE until remittance cleared!
      if (verifiedTripId) {
        await client.query(
          `UPDATE delivery_trips
           SET cod_due_amount = $1,
               cod_collected_amount = $1,
               cod_reconciled = FALSE,
               updated_at = NOW()
           WHERE id = $2`,
          [authoritativeAmount.toFixed(2), verifiedTripId]
        );
      }

      paymentLogger.increment('codCollectionsRecorded');
      paymentLogger.log('info', 'COD_COLLECTION_RECORDED', {
        orderId: params.orderId,
        internalReference: collectionRef,
      }, {
        riderId: params.riderId,
        amount: authoritativeAmount,
      });

      return {
        collectionId: insertRes.rows[0].id,
        collectionReference: insertRes.rows[0].collection_reference,
        orderId: params.orderId,
        riderId: params.riderId,
        collectedAmount: authoritativeAmount,
        journalBatchId,
        alreadyExisted: false,
      };
    };

    if (params.client) {
      return execute(params.client);
    }
    return transaction(execute);
  }

  /**
   * Computes metrics A-H and full auditable breakdown for a rider.
   */
  public async getRiderCashSummary(riderId: string, client?: pg.PoolClient): Promise<RiderCashSummary> {
    const db = client || getPool();
    const riderRes = await db.query(
      `SELECT id, rider_code, name, status, floating_cash_balance, floating_cash_limit,
              cod_restricted, cod_restriction_reason, active_cod_dispute_count,
              cod_ceiling_override_limit, cod_ceiling_override_until
       FROM riders
       WHERE id = $1`,
      [riderId]
    );
    if (riderRes.rows.length === 0) {
      throw new CodAccountabilityError(404, 'RIDER_NOT_FOUND', `Rider '${riderId}' not found.`);
    }
    const r = riderRes.rows[0];
    const { baseLimit, effectiveLimit, overrideActive } = this.resolveEffectiveCashCeiling(r);

    const [colRes, remRes, dispRes, gl1030Res] = await Promise.all([
      db.query(
        `SELECT id, collection_reference, order_id, trip_id, expected_amount, collected_amount,
                allocated_amount, cleared_amount, disputed_amount, status, collected_at, cleared_at
         FROM cod_collections
         WHERE rider_id = $1
         ORDER BY collected_at ASC, id ASC`,
        [riderId]
      ),
      db.query(
        `SELECT id, remittance_reference, submitted_amount, received_amount, verified_amount,
                cleared_amount, shortage_amount, excess_amount, status, remittance_method,
                collection_location, submitted_at, received_at, verified_at, cleared_at
         FROM cod_remittances
         WHERE rider_id = $1
         ORDER BY created_at DESC`,
        [riderId]
      ),
      db.query(
        `SELECT id, dispute_number, remittance_id, dispute_type, status, resolution_type,
                expected_amount, submitted_amount, verified_amount, disputed_amount, reason,
                opened_at, resolved_at
         FROM cod_cash_disputes
         WHERE rider_id = $1
         ORDER BY opened_at DESC`,
        [riderId]
      ),
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END), 0) AS dr,
           COALESCE(SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END), 0) AS cr
         FROM general_ledger_entries
         WHERE rider_id = $1 AND account_code = '1030'`,
        [riderId]
      ),
    ]);

    let collectedBn = new BigNumber(0);
    let clearedFromCollectionsBn = new BigNumber(0);
    let allocatedInPendingBn = new BigNumber(0);
    for (const c of colRes.rows) {
      if (c.status === 'REVERSED') continue;
      collectedBn = collectedBn.plus(toDecimal(c.collected_amount));
      clearedFromCollectionsBn = clearedFromCollectionsBn.plus(toDecimal(c.cleared_amount));
      allocatedInPendingBn = allocatedInPendingBn.plus(toDecimal(c.allocated_amount));
    }

    let submittedBn = new BigNumber(0);
    let receivedBn = new BigNumber(0);
    let verifiedBn = new BigNumber(0);
    let clearedRemitBn = new BigNumber(0);
    let unverifiedRemitBn = new BigNumber(0);

    for (const rem of remRes.rows) {
      if (rem.status === 'DRAFT' || rem.status === 'CANCELLED' || rem.status === 'REJECTED' || rem.status === 'REVERSED') {
        continue;
      }
      submittedBn = submittedBn.plus(toDecimal(rem.submitted_amount));
      if (['RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS', 'DISPUTED'].includes(rem.status)) {
        receivedBn = receivedBn.plus(toDecimal(rem.received_amount ?? rem.submitted_amount));
      }
      if (['VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS', 'DISPUTED'].includes(rem.status)) {
        verifiedBn = verifiedBn.plus(toDecimal(rem.verified_amount ?? 0));
      }
      clearedRemitBn = clearedRemitBn.plus(toDecimal(rem.cleared_amount || 0));
      if (['SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING'].includes(rem.status)) {
        unverifiedRemitBn = unverifiedRemitBn.plus(toDecimal(rem.submitted_amount));
      }
    }

    let disputedBn = new BigNumber(0);
    let openDisputeCount = 0;
    for (const d of dispRes.rows) {
      if (['OPEN', 'UNDER_INVESTIGATION', 'ESCALATED'].includes(d.status)) {
        disputedBn = disputedBn.plus(toDecimal(d.disputed_amount));
        openDisputeCount++;
      }
    }

    const materializedBn = toDecimal(roundCurrency(r.floating_cash_balance || 0));
    const ledger1030Bn = subtract(gl1030Res.rows[0]?.dr || 0, gl1030Res.rows[0]?.cr || 0);
    // Authoritative liability is GL 1030 balance when collections exist, or max consistent custody figure
    const collectionLiabilityBn = BigNumber.max(0, subtract(collectedBn, clearedFromCollectionsBn));
    const authoritativeLiabilityBn =
      colRes.rows.length > 0 && ledger1030Bn.gte(0)
        ? ledger1030Bn
        : materializedBn.gt(0) && colRes.rows.length === 0
        ? materializedBn
        : BigNumber.max(collectionLiabilityBn, ledger1030Bn);

    const outstandingBn = BigNumber.max(0, subtract(authoritativeLiabilityBn, 0));
    const unallocatedBn = BigNumber.max(0, subtract(authoritativeLiabilityBn, unverifiedRemitBn));
    const driftBn = subtract(materializedBn, ledger1030Bn);
    const isOverCeiling = materializedBn.gte(effectiveLimit);
    const isCodRestricted = Boolean(r.cod_restricted) || isOverCeiling || openDisputeCount > 0;
    const isDispatchBlocked = r.status === 'SUSPENDED' || isOverCeiling;

    return {
      riderId: r.id,
      riderCode: r.rider_code,
      riderName: r.name,
      riderStatus: r.status,
      currency: 'INR',
      totalCodCollected: Number(roundCurrency(collectedBn)),
      totalRemittanceSubmitted: Number(roundCurrency(submittedBn)),
      totalRemittanceReceived: Number(roundCurrency(receivedBn)),
      totalVerifiedRemittance: Number(roundCurrency(verifiedBn)),
      totalRiderCashLiability: Number(roundCurrency(authoritativeLiabilityBn)),
      totalDisputedAmount: Number(roundCurrency(disputedBn)),
      totalUnverifiedRemittance: Number(roundCurrency(unverifiedRemitBn)),
      totalOutstandingAmount: Number(roundCurrency(outstandingBn)),
      unallocatedLiability: Number(roundCurrency(unallocatedBn)),
      materializedFloatingCashBalance: Number(roundCurrency(materializedBn)),
      ledger1030NetBalance: Number(roundCurrency(ledger1030Bn)),
      ledgerDriftAmount: Number(roundCurrency(driftBn)),
      floatingCashLimit: baseLimit,
      effectiveCashCeiling: effectiveLimit,
      ceilingOverrideActive: overrideActive,
      ceilingOverrideUntil: r.cod_ceiling_override_until
        ? new Date(r.cod_ceiling_override_until).toISOString()
        : null,
      isOverCeiling,
      isCodRestricted,
      codRestrictionReason:
        r.cod_restriction_reason ||
        (openDisputeCount > 0 ? 'UNRESOLVED_COD_DISPUTE' : isOverCeiling ? 'CASH_CEILING_EXCEEDED' : null),
      activeCodDisputeCount: Math.max(openDisputeCount, parseInt(String(r.active_cod_dispute_count || '0'), 10) || 0),
      isDispatchBlocked,
      collections: colRes.rows.map((c) => {
        const colAmt = toDecimal(c.collected_amount);
        const clrAmt = toDecimal(c.cleared_amount);
        return {
          collectionId: c.id,
          collectionReference: c.collection_reference,
          orderId: c.order_id,
          tripId: c.trip_id || null,
          expectedAmount: Number(roundCurrency(c.expected_amount)),
          collectedAmount: Number(roundCurrency(colAmt)),
          allocatedAmount: Number(roundCurrency(c.allocated_amount)),
          clearedAmount: Number(roundCurrency(clrAmt)),
          disputedAmount: Number(roundCurrency(c.disputed_amount)),
          outstandingAmount: Number(roundCurrency(BigNumber.max(0, subtract(colAmt, clrAmt)))),
          status: c.status,
          collectedAt: new Date(c.collected_at).toISOString(),
          clearedAt: c.cleared_at ? new Date(c.cleared_at).toISOString() : null,
        };
      }),
      remittances: remRes.rows.map((rem) => ({
        remittanceId: rem.id,
        remittanceReference: rem.remittance_reference,
        submittedAmount: Number(roundCurrency(rem.submitted_amount)),
        receivedAmount: rem.received_amount !== null ? Number(roundCurrency(rem.received_amount)) : null,
        verifiedAmount: rem.verified_amount !== null ? Number(roundCurrency(rem.verified_amount)) : null,
        clearedAmount: Number(roundCurrency(rem.cleared_amount)),
        shortageAmount: Number(roundCurrency(rem.shortage_amount)),
        excessAmount: Number(roundCurrency(rem.excess_amount)),
        status: rem.status,
        method: rem.remittance_method,
        collectionLocation: rem.collection_location || null,
        submittedAt: rem.submitted_at ? new Date(rem.submitted_at).toISOString() : null,
        receivedAt: rem.received_at ? new Date(rem.received_at).toISOString() : null,
        verifiedAt: rem.verified_at ? new Date(rem.verified_at).toISOString() : null,
        clearedAt: rem.cleared_at ? new Date(rem.cleared_at).toISOString() : null,
      })),
      disputes: dispRes.rows.map((d) => ({
        disputeId: d.id,
        disputeNumber: d.dispute_number,
        remittanceId: d.remittance_id || null,
        disputeType: d.dispute_type,
        status: d.status,
        resolutionType: d.resolution_type || null,
        expectedAmount: Number(roundCurrency(d.expected_amount)),
        submittedAmount: Number(roundCurrency(d.submitted_amount)),
        verifiedAmount: Number(roundCurrency(d.verified_amount)),
        disputedAmount: Number(roundCurrency(d.disputed_amount)),
        reason: d.reason,
        openedAt: new Date(d.opened_at).toISOString(),
        resolvedAt: d.resolved_at ? new Date(d.resolved_at).toISOString() : null,
      })),
    };
  }

  /**
   * Step 1: Rider initiates/submits a COD remittance (DRAFT or SUBMITTED).
   * NEVER clears floating_cash_balance or posts GL clearance!
   * Reserves open order-level cod_collections atomically so two concurrent remittances cannot claim the same collections.
   */
  public async submitRemittance(params: {
    riderId: string;
    amount: number | string;
    method?: string;
    reference?: string;
    idempotencyKey?: string;
    collectionLocation?: string;
    evidenceReference?: string;
    collectionIds?: string[];
    orderIds?: string[];
    asDraft?: boolean;
    submittedByUserId?: string | null;
  }): Promise<{
    success: true;
    idempotentReplay: boolean;
    remittanceId: string;
    remittanceReference: string;
    status: RemittanceStatus;
    submittedAmount: number;
    liabilityCleared: boolean;
    remainingCash: number;
    unblocked: boolean;
    allocatedCollections: Array<{ collectionId: string; orderId: string; allocatedAmount: number }>;
  }> {
    let amountBn: BigNumber;
    try {
      amountBn = toDecimal(params.amount);
    } catch {
      throw new CodAccountabilityError(400, 'INVALID_REMITTANCE_AMOUNT', 'Remittance amount must be a valid finite number.');
    }
    if (amountBn.lte(0)) {
      throw new CodAccountabilityError(400, 'INVALID_REMITTANCE_AMOUNT', 'Remittance amount must be greater than zero.');
    }
    const submittedAmount = Number(roundCurrency(amountBn));

    const method = (String(params.method || 'CASH_HUB').toUpperCase() as RemittanceMethod);
    if (!VALID_METHODS.has(method)) {
      throw new CodAccountabilityError(400, 'INVALID_REMITTANCE_METHOD', `Unsupported remittance method '${params.method}'.`);
    }

    const reference = params.reference
      ? String(params.reference).trim()
      : `REM_${params.riderId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const idemKey = params.idempotencyKey ? String(params.idempotencyKey).trim() : null;
    const initialStatus: RemittanceStatus = params.asDraft ? 'DRAFT' : 'SUBMITTED';

    const txOut = await transaction(async (client) => {
      // 1. Lock rider row first (Lock hierarchy level 3)
      const riderRes = await client.query(
        `SELECT id, user_id, floating_cash_balance, floating_cash_limit, status
         FROM riders
         WHERE id = $1
         FOR UPDATE`,
        [params.riderId]
      );
      if (riderRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'RIDER_NOT_FOUND', `Rider '${params.riderId}' not found.`);
      }
      const rider = riderRes.rows[0];
      const floatingBn = toDecimal(roundCurrency(rider.floating_cash_balance || 0));

      // 2. Check idempotency by reference or idempotencyKey
      const existingByRef = await client.query(
        `SELECT * FROM cod_remittances WHERE remittance_reference = $1 FOR UPDATE`,
        [reference]
      );
      if (existingByRef.rows.length > 0) {
        const ex = existingByRef.rows[0];
        if (ex.rider_id !== params.riderId) {
          throw new CodAccountabilityError(
            409,
            'COD_REFERENCE_CONFLICT',
            `Remittance reference '${reference}' already belongs to another rider.`
          );
        }
        if (!toDecimal(ex.submitted_amount).eq(submittedAmount)) {
          throw new CodAccountabilityError(
            409,
            'COD_REFERENCE_AMOUNT_MISMATCH',
            `Remittance reference '${reference}' was previously submitted for ₹${ex.submitted_amount}, cannot reuse for ₹${submittedAmount}.`
          );
        }
        const allocs = await client.query(
          `SELECT collection_id, order_id, allocated_amount FROM cod_remittance_allocations WHERE remittance_id = $1`,
          [ex.id]
        );
        return {
          success: true as const,
          idempotentReplay: true,
          remittanceId: ex.id as string,
          remittanceReference: ex.remittance_reference as string,
          status: ex.status as RemittanceStatus,
          submittedAmount: Number(roundCurrency(ex.submitted_amount)),
          liabilityCleared: ex.status === 'LIABILITY_CLEARED' || ex.status === 'VERIFIED',
          remainingCash: Number(roundCurrency(floatingBn)),
          unblocked: false,
          allocatedCollections: allocs.rows.map((a) => ({
            collectionId: a.collection_id,
            orderId: a.order_id,
            allocatedAmount: Number(roundCurrency(a.allocated_amount)),
          })),
        };
      }

      if (idemKey) {
        const existingByKey = await client.query(
          `SELECT * FROM cod_remittances WHERE rider_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [params.riderId, idemKey]
        );
        if (existingByKey.rows.length > 0) {
          const ex = existingByKey.rows[0];
          if (
            !toDecimal(ex.submitted_amount).eq(submittedAmount) ||
            ex.remittance_method !== method
          ) {
            throw new CodAccountabilityError(
              409,
              'IDEMPOTENCY_KEY_CONFLICT',
              `Idempotency key '${idemKey}' already bound to a different COD remittance payload.`
            );
          }
          const allocs = await client.query(
            `SELECT collection_id, order_id, allocated_amount FROM cod_remittance_allocations WHERE remittance_id = $1`,
            [ex.id]
          );
          return {
            success: true as const,
            idempotentReplay: true,
            remittanceId: ex.id as string,
            remittanceReference: ex.remittance_reference as string,
            status: ex.status as RemittanceStatus,
            submittedAmount: Number(roundCurrency(ex.submitted_amount)),
            liabilityCleared: ex.status === 'LIABILITY_CLEARED' || ex.status === 'VERIFIED',
            remainingCash: Number(roundCurrency(floatingBn)),
            unblocked: false,
            allocatedCollections: allocs.rows.map((a) => ({
              collectionId: a.collection_id,
              orderId: a.order_id,
              allocatedAmount: Number(roundCurrency(a.allocated_amount)),
            })),
          };
        }
      }

      // 3. Check available unreserved cash liability across existing unverified remittances
      const pendingRemRes = await client.query(
        `SELECT COALESCE(SUM(submitted_amount), 0) AS pending_total
         FROM cod_remittances
         WHERE rider_id = $1
           AND status IN ('DRAFT', 'SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING')`,
        [params.riderId]
      );
      const pendingTotalBn = toDecimal(roundCurrency(pendingRemRes.rows[0]?.pending_total || 0));
      const availableLiabilityBn = subtract(floatingBn, pendingTotalBn);

      if (amountBn.gt(availableLiabilityBn)) {
        throw new CodAccountabilityError(
          400,
          'INVALID_REMITTANCE_AMOUNT',
          `Remittance amount ₹${submittedAmount.toFixed(2)} exceeds available unreserved COD cash liability ₹${roundCurrency(BigNumber.max(0, availableLiabilityBn))}.`,
          {
            floatingCashBalance: Number(roundCurrency(floatingBn)),
            pendingUnverifiedRemittances: Number(roundCurrency(pendingTotalBn)),
            availableLiability: Number(roundCurrency(BigNumber.max(0, availableLiabilityBn))),
          }
        );
      }

      // 4. Lock & reserve order-level cod_collections (either explicit list or FIFO)
      let candidateCols: any[];
      if (params.collectionIds && params.collectionIds.length > 0) {
        const uniqueIds = Array.from(new Set(params.collectionIds));
        uniqueIds.forEach((cid) => assertUuid(cid, 'collectionId'));
        const placeholders = uniqueIds.map((_, i) => `$${i + 2}`).join(', ');
        const res = await client.query(
          `SELECT * FROM cod_collections
           WHERE rider_id = $1 AND id IN (${placeholders})
           ORDER BY collected_at ASC, id ASC
           FOR UPDATE`,
          [params.riderId, ...uniqueIds]
        );
        if (res.rows.length !== uniqueIds.length) {
          throw new CodAccountabilityError(
            403,
            'COLLECTION_OWNERSHIP_OR_NOT_FOUND',
            'One or more requested COD collection records do not exist or belong to another rider.'
          );
        }
        candidateCols = res.rows;
      } else if (params.orderIds && params.orderIds.length > 0) {
        const uniqueIds = Array.from(new Set(params.orderIds));
        uniqueIds.forEach((oid) => assertUuid(oid, 'orderId'));
        const placeholders = uniqueIds.map((_, i) => `$${i + 2}`).join(', ');
        const res = await client.query(
          `SELECT * FROM cod_collections
           WHERE rider_id = $1 AND order_id IN (${placeholders})
           ORDER BY collected_at ASC, id ASC
           FOR UPDATE`,
          [params.riderId, ...uniqueIds]
        );
        if (res.rows.length !== uniqueIds.length) {
          throw new CodAccountabilityError(
            403,
            'COLLECTION_OWNERSHIP_OR_NOT_FOUND',
            'One or more requested COD order collection records do not exist or belong to another rider.'
          );
        }
        candidateCols = res.rows;
      } else {
        const res = await client.query(
          `SELECT * FROM cod_collections
           WHERE rider_id = $1
             AND status IN ('COLLECTED', 'PARTIALLY_ALLOCATED', 'PARTIALLY_CLEARED', 'SHORTAGE_DISPUTED')
           ORDER BY collected_at ASC, id ASC
           FOR UPDATE`,
          [params.riderId]
        );
        candidateCols = res.rows;
      }

      const toAllocate: Array<{ col: any; allocBn: BigNumber }> = [];
      let remainingToAllocateBn = amountBn;

      for (const col of candidateCols) {
        if (remainingToAllocateBn.lte(0)) break;
        const freeOnColBn = subtract(
          toDecimal(col.collected_amount),
          toDecimal(col.allocated_amount),
          toDecimal(col.cleared_amount)
        );
        if (freeOnColBn.lte(0)) continue;
        const takeBn = BigNumber.min(remainingToAllocateBn, freeOnColBn);
        toAllocate.push({ col, allocBn: takeBn });
        remainingToAllocateBn = subtract(remainingToAllocateBn, takeBn);
      }

      if ((params.collectionIds?.length || params.orderIds?.length) && remainingToAllocateBn.gt(0)) {
        throw new CodAccountabilityError(
          409,
          'COLLECTION_ALREADY_ALLOCATED_OR_INSUFFICIENT',
          'Selected COD collections do not have sufficient unallocated cash balance (possible double allocation).'
        );
      }

      // 5. Insert durable cod_remittances row
      const submittedAtTs = initialStatus === 'SUBMITTED' ? new Date() : null;
      const insRemRes = await client.query(
        `INSERT INTO cod_remittances (
           remittance_reference, idempotency_key, rider_id, currency,
           submitted_amount, remittance_method, collection_location, evidence_reference,
           status, submitted_by, submitted_at, metadata
         ) VALUES (
           $1, $2, $3, 'INR',
           $4, $5, $6, $7,
           $8, $9, $10, $11
         )
         RETURNING id`,
        [
          reference,
          idemKey,
          params.riderId,
          submittedAmount.toFixed(2),
          method,
          params.collectionLocation || null,
          params.evidenceReference || null,
          initialStatus,
          params.submittedByUserId || rider.user_id || null,
          submittedAtTs,
          JSON.stringify({
            unbackedResidualAmount: Number(roundCurrency(remainingToAllocateBn)),
          }),
        ]
      );
      const remittanceId = insRemRes.rows[0].id as string;

      const allocatedCollections: Array<{ collectionId: string; orderId: string; allocatedAmount: number }> = [];
      for (const item of toAllocate) {
        const allocAmtNum = Number(roundCurrency(item.allocBn));
        await client.query(
          `INSERT INTO cod_remittance_allocations (
             remittance_id, collection_id, order_id, allocated_amount, cleared_amount, status
           ) VALUES ($1, $2, $3, $4, 0.00, 'RESERVED')`,
          [remittanceId, item.col.id, item.col.order_id, allocAmtNum.toFixed(2)]
        );

        const newAllocBn = add(item.col.allocated_amount, item.allocBn);
        const totalCoveredBn = add(newAllocBn, item.col.cleared_amount);
        const newColStatus = totalCoveredBn.gte(item.col.collected_amount)
          ? 'ALLOCATED'
          : 'PARTIALLY_ALLOCATED';

        await client.query(
          `UPDATE cod_collections
           SET allocated_amount = $1,
               status = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [roundCurrency(newAllocBn), newColStatus, item.col.id]
        );

        allocatedCollections.push({
          collectionId: item.col.id,
          orderId: item.col.order_id,
          allocatedAmount: allocAmtNum,
        });
      }

      return {
        success: true as const,
        idempotentReplay: false,
        remittanceId,
        remittanceReference: reference,
        status: initialStatus,
        submittedAmount,
        liabilityCleared: false,
        remainingCash: Number(roundCurrency(floatingBn)),
        unblocked: false,
        allocatedCollections,
      };
    });

    if (!txOut.idempotentReplay) {
      await recordAuditEvent({
        actorId: params.submittedByUserId || params.riderId,
        actorType: 'USER',
        action: params.asDraft ? 'COD_REMITTANCE_DRAFTED' : 'COD_REMITTANCE_SUBMITTED',
        entityType: 'COD_REMITTANCE',
        entityId: txOut.remittanceId,
        newState: {
          riderId: params.riderId,
          submittedAmount: txOut.submittedAmount,
          method,
          reference: txOut.remittanceReference,
          status: txOut.status,
          allocatedCollections: txOut.allocatedCollections,
        },
      }).catch(() => {});

      paymentLogger.increment('codRemittancesSubmitted');
      paymentLogger.log('info', 'COD_REMITTANCE_SUBMITTED', {
        internalReference: txOut.remittanceReference,
        userId: params.submittedByUserId || undefined,
      }, {
        riderId: params.riderId,
        submittedAmount: txOut.submittedAmount,
        status: txOut.status,
      });
    }

    return txOut;
  }

  /**
   * Optional explicit DRAFT -> SUBMITTED transition if remittance was initiated as DRAFT.
   */
  public async finalizeDraftSubmission(params: {
    remittanceId: string;
    actorUserId: string;
    riderId?: string;
  }): Promise<{ remittanceId: string; status: RemittanceStatus }> {
    const out = await transaction(async (client) => {
      const res = await client.query(
        `SELECT * FROM cod_remittances WHERE id = $1 FOR UPDATE`,
        [params.remittanceId]
      );
      if (res.rows.length === 0) {
        throw new CodAccountabilityError(404, 'REMITTANCE_NOT_FOUND', `Remittance '${params.remittanceId}' not found.`);
      }
      const rem = res.rows[0];
      if (params.riderId && rem.rider_id !== params.riderId) {
        throw new CodAccountabilityError(403, 'IDOR_FORBIDDEN', 'Remittance belongs to another rider.');
      }
      if (rem.status === 'SUBMITTED') {
        return { remittanceId: rem.id as string, status: 'SUBMITTED' as RemittanceStatus };
      }
      if (rem.status !== 'DRAFT') {
        throw new CodAccountabilityError(409, 'INVALID_REMITTANCE_STATE', `Cannot submit remittance in status '${rem.status}'.`);
      }

      await client.query(
        `UPDATE cod_remittances
         SET status = 'SUBMITTED',
             submitted_by = COALESCE(submitted_by, $1),
             submitted_at = COALESCE(submitted_at, NOW()),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [params.actorUserId, rem.id]
      );
      return { remittanceId: rem.id as string, status: 'SUBMITTED' as RemittanceStatus };
    });

    await recordAuditEvent({
      actorId: params.actorUserId,
      actorType: 'USER',
      action: 'COD_REMITTANCE_SUBMITTED',
      entityType: 'COD_REMITTANCE',
      entityId: out.remittanceId,
      newState: { status: out.status },
    }).catch(() => {});

    return out;
  }

  /**
   * Step 2: Authorized Receiver acknowledges physical/bank receipt of remittance.
   * Enforces separation of duties: receiver CANNOT be the submitter!
   */
  public async acknowledgeReceipt(params: {
    remittanceId: string;
    receiverUserId: string;
    receivedAmount?: number | string;
    collectionLocation?: string;
    evidenceReference?: string;
    moveToVerificationPending?: boolean;
    idempotencyKey?: string;
  }): Promise<{
    success: true;
    idempotentReplay: boolean;
    remittanceId: string;
    remittanceReference: string;
    status: RemittanceStatus;
    receivedAmount: number;
    receivedBy: string;
  }> {
    const out = await transaction(async (client) => {
      const remRes = await client.query(
        `SELECT * FROM cod_remittances WHERE id = $1 FOR UPDATE`,
        [params.remittanceId]
      );
      if (remRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'REMITTANCE_NOT_FOUND', `Remittance '${params.remittanceId}' not found.`);
      }
      const rem = remRes.rows[0];

      // Separation of duties: receiver must not be the rider/submitter
      if (rem.submitted_by && rem.submitted_by === params.receiverUserId) {
        throw new CodAccountabilityError(
          403,
          'SELF_RECEIPT_FORBIDDEN',
          'The rider/submitter cannot acknowledge receipt of their own cash remittance.'
        );
      }

      const riderRes = await client.query(`SELECT user_id FROM riders WHERE id = $1`, [rem.rider_id]);
      if (riderRes.rows[0]?.user_id && riderRes.rows[0].user_id === params.receiverUserId) {
        throw new CodAccountabilityError(
          403,
          'SELF_RECEIPT_FORBIDDEN',
          'A rider cannot acknowledge receipt of their own COD remittance.'
        );
      }

      const expectedRecAmt =
        params.receivedAmount !== undefined
          ? Number(roundCurrency(toDecimal(params.receivedAmount)))
          : Number(roundCurrency(rem.submitted_amount));

      if (toDecimal(expectedRecAmt).lt(0)) {
        throw new CodAccountabilityError(400, 'INVALID_RECEIVED_AMOUNT', 'Received amount cannot be negative.');
      }

      if (['RECEIVED', 'VERIFICATION_PENDING'].includes(rem.status)) {
        // Idempotent replay only if same receiver & matching amount; reject duplicate conflicting receiver confirmation
        const sameActor = rem.received_by === params.receiverUserId;
        const sameAmt =
          rem.received_amount === null || toDecimal(rem.received_amount).eq(expectedRecAmt);
        if (sameActor && sameAmt) {
          return {
            success: true as const,
            idempotentReplay: true,
            remittanceId: rem.id as string,
            remittanceReference: rem.remittance_reference as string,
            status: rem.status as RemittanceStatus,
            receivedAmount: Number(roundCurrency(rem.received_amount ?? rem.submitted_amount)),
            receivedBy: rem.received_by as string,
          };
        }
        throw new CodAccountabilityError(
          409,
          'REMITTANCE_ALREADY_RECEIVED',
          `Remittance '${rem.remittance_reference}' was already received in state '${rem.status}'.`
        );
      }

      if (rem.status !== 'SUBMITTED') {
        throw new CodAccountabilityError(
          409,
          'INVALID_REMITTANCE_STATE',
          `Cannot receive remittance in status '${rem.status}'; expected 'SUBMITTED'.`
        );
      }

      const nextStatus: RemittanceStatus = params.moveToVerificationPending ? 'VERIFICATION_PENDING' : 'RECEIVED';
      const verificationStartedAtTs = params.moveToVerificationPending ? new Date() : null;
      await client.query(
        `UPDATE cod_remittances
         SET status = $1,
             received_amount = $2,
             received_by = $3,
             received_at = NOW(),
             verification_started_at = COALESCE($6, verification_started_at),
             collection_location = COALESCE($4, collection_location),
             evidence_reference = COALESCE($5, evidence_reference),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $7`,
        [
          nextStatus,
          expectedRecAmt.toFixed(2),
          params.receiverUserId,
          params.collectionLocation || null,
          params.evidenceReference || null,
          verificationStartedAtTs,
          rem.id,
        ]
      );

      return {
        success: true as const,
        idempotentReplay: false,
        remittanceId: rem.id as string,
        remittanceReference: rem.remittance_reference as string,
        status: nextStatus,
        receivedAmount: expectedRecAmt,
        receivedBy: params.receiverUserId,
      };
    });

    if (!out.idempotentReplay) {
      await recordAuditEvent({
        actorId: params.receiverUserId,
        actorType: 'ADMIN',
        action: 'COD_REMITTANCE_RECEIVED',
        entityType: 'COD_REMITTANCE',
        entityId: out.remittanceId,
        newState: {
          status: out.status,
          receivedAmount: out.receivedAmount,
        },
      }).catch(() => {});
    }

    return out;
  }

  /**
   * Step 3: Independent verifier counts/confirms deposited cash and clears rider liability.
   * Enforces:
   *  - Receipt acknowledgment must precede verification (never skips SUBMITTED -> VERIFIED).
   *  - Verifier != Submitter AND Verifier != Receiver (two-person integrity).
   *  - Shortage (< submitted): clears ONLY verifiedAmount, leaves remaining liability + opens durable dispute + keeps restriction.
   *  - Excess (> submitted): clears submittedAmount, holds excess in 2080 Suspense + opens durable dispute.
   *  - Exact match: transitions VERIFIED -> LIABILITY_CLEARED, posts balanced GL (Dr 1020 / Cr 1030), updates collections & trips.cod_reconciled.
   */
  public async verifyRemittance(params: {
    remittanceId: string;
    verifierUserId: string;
    verifiedAmount?: number | string;
    discrepancyNotes?: string;
    evidenceReference?: string;
    idempotencyKey?: string;
  }): Promise<{
    success: true;
    idempotentReplay: boolean;
    remittanceId: string;
    remittanceReference: string;
    riderId: string;
    status: RemittanceStatus;
    submittedAmount: number;
    verifiedAmount: number;
    clearedAmount: number;
    shortageAmount: number;
    excessAmount: number;
    remainingCash: number;
    unblocked: boolean;
    journalBatchId: string | null;
    disputeId: string | null;
    disputeNumber: string | null;
  }> {
    const out = await transaction(async (client) => {
      // Lock in deterministic hierarchy: read remittance first to discover rider_id, then lock rider -> collections -> remittance
      const peekRes = await client.query(
        `SELECT rider_id FROM cod_remittances WHERE id = $1`,
        [params.remittanceId]
      );
      if (peekRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'REMITTANCE_NOT_FOUND', `Remittance '${params.remittanceId}' not found.`);
      }
      const riderId = peekRes.rows[0].rider_id as string;

      // 1. Lock rider (hierarchy level 3)
      const riderRes = await client.query(
        `SELECT id, user_id, floating_cash_balance, floating_cash_limit, status,
                cod_restricted, cod_restriction_reason, active_cod_dispute_count,
                cod_ceiling_override_limit, cod_ceiling_override_until
         FROM riders
         WHERE id = $1
         FOR UPDATE`,
        [riderId]
      );
      const rider = riderRes.rows[0];

      // 2. Lock allocated collections (hierarchy level 4)
      const allocColsRes = await client.query(
        `SELECT a.id AS alloc_id, a.collection_id, a.order_id, a.allocated_amount, a.status AS alloc_status,
                c.collected_amount, c.allocated_amount AS col_allocated_amount, c.cleared_amount AS col_cleared_amount,
                c.disputed_amount AS col_disputed_amount, c.status AS col_status
         FROM cod_remittance_allocations a
         JOIN cod_collections c ON c.id = a.collection_id
         WHERE a.remittance_id = $1
         ORDER BY c.collected_at ASC, c.id ASC
         FOR UPDATE`,
        [params.remittanceId]
      );

      // 3. Lock remittance (hierarchy level 5)
      const remRes = await client.query(
        `SELECT * FROM cod_remittances WHERE id = $1 FOR UPDATE`,
        [params.remittanceId]
      );
      const rem = remRes.rows[0];

      // Separation of duties checks BEFORE checking terminal state conflicts
      if (
        (rem.submitted_by && rem.submitted_by === params.verifierUserId) ||
        (rider.user_id && rider.user_id === params.verifierUserId)
      ) {
        throw new CodAccountabilityError(
          403,
          'SELF_VERIFICATION_FORBIDDEN',
          'A rider/submitter cannot verify or clear their own COD remittance.'
        );
      }
      if (rem.received_by && rem.received_by === params.verifierUserId) {
        throw new CodAccountabilityError(
          403,
          'RECEIVER_VERIFICATION_CONFLICT',
          'Separation of duties: the receiver who acknowledged physical cash handover cannot verify the same remittance.'
        );
      }

      const submittedBn = toDecimal(roundCurrency(rem.submitted_amount));
      const defaultVerified = rem.received_amount !== null ? rem.received_amount : rem.submitted_amount;
      let verifiedBn: BigNumber;
      try {
        verifiedBn =
          params.verifiedAmount !== undefined
            ? toDecimal(params.verifiedAmount)
            : toDecimal(roundCurrency(defaultVerified));
      } catch {
        throw new CodAccountabilityError(400, 'INVALID_VERIFIED_AMOUNT', 'Verified amount must be a valid finite number.');
      }
      if (verifiedBn.lt(0)) {
        throw new CodAccountabilityError(400, 'INVALID_VERIFIED_AMOUNT', 'Verified amount cannot be negative.');
      }
      const verifiedAmtNum = Number(roundCurrency(verifiedBn));

      // Idempotent retry / duplicate verification handling
      if (['VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS'].includes(rem.status)) {
        const sameVerifier = rem.verified_by === params.verifierUserId;
        const sameAmt = rem.verified_amount !== null && toDecimal(rem.verified_amount).eq(verifiedBn);
        const sameKey = params.idempotencyKey && rem.metadata?.verifyIdempotencyKey === params.idempotencyKey;
        if ((sameKey || sameVerifier) && sameAmt) {
          const dispLookup = await client.query(
            `SELECT id, dispute_number FROM cod_cash_disputes WHERE remittance_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [rem.id]
          );
          return {
            success: true as const,
            idempotentReplay: true,
            remittanceId: rem.id as string,
            remittanceReference: rem.remittance_reference as string,
            riderId,
            status: rem.status as RemittanceStatus,
            submittedAmount: Number(roundCurrency(submittedBn)),
            verifiedAmount: verifiedAmtNum,
            clearedAmount: Number(roundCurrency(rem.cleared_amount || 0)),
            shortageAmount: Number(roundCurrency(rem.shortage_amount || 0)),
            excessAmount: Number(roundCurrency(rem.excess_amount || 0)),
            remainingCash: Number(roundCurrency(rider.floating_cash_balance || 0)),
            unblocked: false,
            journalBatchId: rem.journal_batch_id || null,
            disputeId: dispLookup.rows[0]?.id || null,
            disputeNumber: dispLookup.rows[0]?.dispute_number || null,
          };
        }
        throw new CodAccountabilityError(
          409,
          'REMITTANCE_ALREADY_VERIFIED',
          `Remittance '${rem.remittance_reference}' has already been verified in terminal state '${rem.status}'.`
        );
      }

      if (!['RECEIVED', 'VERIFICATION_PENDING'].includes(rem.status)) {
        throw new CodAccountabilityError(
          409,
          'REMITTANCE_RECEIPT_REQUIRED',
          `Remittance in state '${rem.status}' cannot be verified; physical receiver acknowledgment is required first.`
        );
      }

      const riderFloatBn = toDecimal(roundCurrency(rider.floating_cash_balance || 0));
      let shortageBn = new BigNumber(0);
      let excessBn = new BigNumber(0);
      let clearedBn: BigNumber;
      let finalStatus: RemittanceStatus;

      if (verifiedBn.eq(submittedBn)) {
        clearedBn = BigNumber.min(verifiedBn, riderFloatBn);
        excessBn = BigNumber.max(0, subtract(verifiedBn, clearedBn));
        finalStatus = excessBn.gt(0) ? 'EXCESS' : 'LIABILITY_CLEARED';
      } else if (verifiedBn.lt(submittedBn)) {
        shortageBn = subtract(submittedBn, verifiedBn);
        clearedBn = BigNumber.min(verifiedBn, riderFloatBn);
        finalStatus = 'SHORTAGE';
      } else {
        // Excess cash physically received above submitted amount
        clearedBn = BigNumber.min(submittedBn, riderFloatBn);
        excessBn = subtract(verifiedBn, clearedBn);
        finalStatus = 'EXCESS';
      }

      const clearedNum = Number(roundCurrency(clearedBn));
      const shortageNum = Number(roundCurrency(shortageBn));
      const excessNum = Number(roundCurrency(excessBn));

      // Post balanced GL batch only when verified cash > 0
      let journalBatchId: string | null = null;
      const ledgerRef = `TX_COD_REMIT_${rem.remittance_reference}`;
      if (verifiedBn.gt(0)) {
        journalBatchId = await ledgerService.recordRiderCodRemittance({
          riderId,
          amount: verifiedAmtNum,
          clearedLiabilityAmount: clearedNum,
          excessAmount: excessNum,
          reference: rem.remittance_reference,
          orderId: allocColsRes.rows.length === 1 ? allocColsRes.rows[0].order_id : null,
          client,
        });
      }

      // Reduce materialized floating_cash_balance strictly by clearedBn (NEVER negative, NEVER clears shortage)
      const newFloatBn = subtract(riderFloatBn, clearedBn);
      if (newFloatBn.lt(0)) {
        throw new CodAccountabilityError(
          409,
          'NEGATIVE_RIDER_CASH_PREVENTED',
          'Attempted clearance would make rider floating_cash_balance negative.'
        );
      }
      await client.query(
        `UPDATE riders
         SET floating_cash_balance = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [roundCurrency(newFloatBn), riderId]
      );

      // Update order-level allocations & cod_collections -> set delivery_trips.cod_reconciled = TRUE only on full CLEARED
      let remainingToClearOnColsBn = clearedBn;
      for (const row of allocColsRes.rows) {
        const allocAmtBn = toDecimal(row.allocated_amount);
        const applyClearBn = BigNumber.min(remainingToClearOnColsBn, allocAmtBn);
        remainingToClearOnColsBn = subtract(remainingToClearOnColsBn, applyClearBn);

        const releaseUnusedBn = subtract(allocAmtBn, applyClearBn);
        const newColAllocatedBn = BigNumber.max(0, subtract(toDecimal(row.col_allocated_amount), allocAmtBn));
        const newColClearedBn = add(toDecimal(row.col_cleared_amount), applyClearBn);
        const collectedBn = toDecimal(row.collected_amount);

        const isFullyCleared = newColClearedBn.gte(collectedBn);
        let newColStatus = row.col_status as string;
        if (isFullyCleared) {
          newColStatus = 'CLEARED';
        } else if (finalStatus === 'SHORTAGE' && releaseUnusedBn.gt(0)) {
          newColStatus = 'SHORTAGE_DISPUTED';
        } else if (newColClearedBn.gt(0) && newColAllocatedBn.gt(0)) {
          newColStatus = 'PARTIALLY_ALLOCATED';
        } else if (newColClearedBn.gt(0)) {
          newColStatus = 'PARTIALLY_CLEARED';
        } else if (newColAllocatedBn.gt(0)) {
          newColStatus = 'ALLOCATED';
        } else {
          newColStatus = 'COLLECTED';
        }

        const extraDisputedBn = finalStatus === 'SHORTAGE' ? releaseUnusedBn : new BigNumber(0);
        const colClearedAtTs = newColStatus === 'CLEARED' ? new Date() : null;
        await client.query(
          `UPDATE cod_collections
           SET allocated_amount = $1,
               cleared_amount = $2,
               disputed_amount = disputed_amount + $3,
               status = $4,
               cleared_at = COALESCE(cleared_at, $5),
               updated_at = NOW()
           WHERE id = $6`,
          [
            roundCurrency(newColAllocatedBn),
            roundCurrency(newColClearedBn),
            roundCurrency(extraDisputedBn),
            newColStatus,
            colClearedAtTs,
            row.collection_id,
          ]
        );

        await client.query(
          `UPDATE cod_remittance_allocations
           SET cleared_amount = $1,
               status = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [
            roundCurrency(applyClearBn),
            finalStatus === 'SHORTAGE' && applyClearBn.lt(allocAmtBn) ? 'SHORTAGE_PARTIAL' : 'CLEARED',
            row.alloc_id,
          ]
        );

        if (isFullyCleared) {
          await client.query(
            `UPDATE delivery_trips
             SET cod_reconciled = TRUE,
                 updated_at = NOW()
             WHERE order_id = $1 AND trip_type = 'FORWARD'`,
            [row.order_id]
          );
        }
      }

      // Open durable dispute if SHORTAGE or EXCESS
      let disputeId: string | null = null;
      let disputeNumber: string | null = null;
      if (shortageBn.gt(0) || excessBn.gt(0)) {
        const dType = shortageBn.gt(0) ? 'SHORTAGE' : 'EXCESS';
        const dAmt = shortageBn.gt(0) ? shortageNum : excessNum;
        disputeNumber = `CODDISP_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const dispRes = await client.query(
          `INSERT INTO cod_cash_disputes (
             dispute_number, remittance_id, order_id, rider_id, dispute_type, status,
             expected_amount, submitted_amount, verified_amount, disputed_amount,
             reason, evidence, opened_by, verified_by
           ) VALUES (
             $1, $2, $3, $4, $5, 'OPEN',
             $6, $7, $8, $9,
             $10, $11, $12, $12
           )
           RETURNING id`,
          [
            disputeNumber,
            rem.id,
            allocColsRes.rows.length === 1 ? allocColsRes.rows[0].order_id : null,
            riderId,
            dType,
            Number(roundCurrency(submittedBn)).toFixed(2),
            Number(roundCurrency(submittedBn)).toFixed(2),
            verifiedAmtNum.toFixed(2),
            dAmt.toFixed(2),
            params.discrepancyNotes ||
              (dType === 'SHORTAGE'
                ? `Physical count verified ₹${verifiedAmtNum.toFixed(2)} against submitted ₹${Number(roundCurrency(submittedBn)).toFixed(2)} (Shortage ₹${dAmt.toFixed(2)}).`
                : `Physical count verified ₹${verifiedAmtNum.toFixed(2)} exceeding expected ₹${Number(roundCurrency(clearedBn)).toFixed(2)} (Excess ₹${dAmt.toFixed(2)} held in Account 2080).`),
            JSON.stringify({
              evidenceReference: params.evidenceReference || rem.evidence_reference || null,
              remittanceReference: rem.remittance_reference,
            }),
            params.verifierUserId,
          ]
        );
        disputeId = dispRes.rows[0].id as string;

        await client.query(
          `UPDATE riders
           SET active_cod_dispute_count = active_cod_dispute_count + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [riderId]
        );
      }

      // Append COD_DEDUCTION historical note only on exact/cleared verification if clearedNum > 0
      // (Keeps rider_ledgers running_balance anchored strictly to wallet_balance without distorting earnings!)
      if (clearedNum > 0) {
        const walletRow = await client.query(
          `SELECT wallet_balance FROM riders WHERE id = $1`,
          [riderId]
        );
        const currentWallet = Number(roundCurrency(walletRow.rows[0]?.wallet_balance || 0));
        await client.query(
          `INSERT INTO rider_ledgers (rider_id, entry_type, category, amount, running_balance, utr_number, description)
           VALUES ($1, 'COD_DEDUCTION', 'DEBIT', $2, $3, $4, $5)`,
          [
            riderId,
            clearedNum.toFixed(2),
            currentWallet.toFixed(2),
            rem.remittance_reference,
            `Verified COD cash remittance clearance (${rem.remittance_reference}, method ${rem.remittance_method})`,
          ]
        );
      }

      const prevMeta = (rem.metadata && typeof rem.metadata === 'object' ? rem.metadata : {}) as Record<string, unknown>;
      const remClearedAtTs = ['LIABILITY_CLEARED', 'EXCESS'].includes(finalStatus) ? new Date() : null;
      await client.query(
        `UPDATE cod_remittances
         SET status = $1,
             verified_amount = $2,
             cleared_amount = $3,
             shortage_amount = $4,
             excess_amount = $5,
             verified_by = $6,
             verified_at = NOW(),
             cleared_at = $12,
             journal_batch_id = $7,
             ledger_transaction_reference = $8,
             discrepancy_notes = COALESCE($9, discrepancy_notes),
             evidence_reference = COALESCE($10, evidence_reference),
             metadata = $11,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $13`,
        [
          finalStatus,
          verifiedAmtNum.toFixed(2),
          clearedNum.toFixed(2),
          shortageNum.toFixed(2),
          excessNum.toFixed(2),
          params.verifierUserId,
          journalBatchId,
          journalBatchId ? ledgerRef : null,
          params.discrepancyNotes || null,
          params.evidenceReference || null,
          JSON.stringify({ ...prevMeta, verifyIdempotencyKey: params.idempotencyKey || null }),
          remClearedAtTs,
          rem.id,
        ]
      );

      // Evaluate whether rider ceiling & dispute restrictions lift now
      const syncResult = await this.syncRiderCodRestrictionInTx(client, riderId, {
        liftSuspensionIfClear: finalStatus === 'LIABILITY_CLEARED',
      });

      return {
        success: true as const,
        idempotentReplay: false,
        remittanceId: rem.id as string,
        remittanceReference: rem.remittance_reference as string,
        riderId,
        status: finalStatus,
        submittedAmount: Number(roundCurrency(submittedBn)),
        verifiedAmount: verifiedAmtNum,
        clearedAmount: clearedNum,
        shortageAmount: shortageNum,
        excessAmount: excessNum,
        remainingCash: syncResult.floatingCashBalance,
        unblocked: syncResult.unblocked,
        journalBatchId,
        disputeId,
        disputeNumber,
      };
    });

    if (!out.idempotentReplay) {
      if (out.clearedAmount > 0) {
        settlementEventPublisher.emit('RiderCodRemitted', {
          remittanceId: out.remittanceId,
          remittanceReference: out.remittanceReference,
          riderId: out.riderId,
          amount: out.clearedAmount,
          verifiedAmount: out.verifiedAmount,
          journalBatchId: out.journalBatchId,
          remainingCash: out.remainingCash,
          unblocked: out.unblocked,
        });
      }
      await recordAuditEvent({
        actorId: params.verifierUserId,
        actorType: 'ADMIN',
        action:
          out.status === 'SHORTAGE'
            ? 'COD_REMITTANCE_VERIFIED_WITH_SHORTAGE'
            : out.status === 'EXCESS'
            ? 'COD_REMITTANCE_VERIFIED_WITH_EXCESS'
            : 'COD_REMITTANCE_VERIFIED_AND_CLEARED',
        entityType: 'COD_REMITTANCE',
        entityId: out.remittanceId,
        newState: {
          status: out.status,
          verifiedAmount: out.verifiedAmount,
          clearedAmount: out.clearedAmount,
          shortageAmount: out.shortageAmount,
          excessAmount: out.excessAmount,
          journalBatchId: out.journalBatchId,
          disputeNumber: out.disputeNumber,
          unblocked: out.unblocked,
        },
      }).catch(() => {});

      paymentLogger.increment('codRemittancesVerified');
      if (out.shortageAmount > 0) {
        paymentLogger.increment('codShortagesDetected');
        paymentLogger.increment('codDisputesOpened');
      }
      if (out.excessAmount > 0) {
        paymentLogger.increment('codExcessDetected');
        paymentLogger.increment('codDisputesOpened');
      }
      paymentLogger.log(
        out.status === 'LIABILITY_CLEARED' ? 'info' : 'warn',
        `COD_REMITTANCE_${out.status}`,
        { internalReference: out.remittanceReference, userId: params.verifierUserId },
        {
          verifiedAmount: out.verifiedAmount,
          shortageAmount: out.shortageAmount,
          excessAmount: out.excessAmount,
        }
      );
    }

    return out;
  }

  /**
   * Cancels (by rider while DRAFT/SUBMITTED) or Rejects (by Finance/Ops prior to VERIFIED) a remittance,
   * safely releasing allocated_amount on cod_collections while preserving row history.
   */
  public async rejectOrCancelRemittance(params: {
    remittanceId: string;
    actorUserId: string;
    mode: 'CANCEL' | 'REJECT';
    reason: string;
    riderIdScope?: string;
  }): Promise<{ remittanceId: string; status: 'CANCELLED' | 'REJECTED' }> {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new CodAccountabilityError(400, 'REASON_REQUIRED', 'A clear reason is required to reject or cancel a remittance.');
    }

    const out = await transaction(async (client) => {
      const remRes = await client.query(
        `SELECT * FROM cod_remittances WHERE id = $1 FOR UPDATE`,
        [params.remittanceId]
      );
      if (remRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'REMITTANCE_NOT_FOUND', `Remittance '${params.remittanceId}' not found.`);
      }
      const rem = remRes.rows[0];
      if (params.riderIdScope && rem.rider_id !== params.riderIdScope) {
        throw new CodAccountabilityError(403, 'IDOR_FORBIDDEN', 'Remittance belongs to another rider.');
      }

      const targetStatus: 'CANCELLED' | 'REJECTED' = params.mode === 'CANCEL' ? 'CANCELLED' : 'REJECTED';
      if (rem.status === targetStatus) {
        return { remittanceId: rem.id as string, status: targetStatus };
      }

      if (params.mode === 'CANCEL' && !['DRAFT', 'SUBMITTED'].includes(rem.status)) {
        throw new CodAccountabilityError(
          409,
          'CANNOT_CANCEL_AFTER_RECEIPT',
          `Cannot cancel remittance after it has reached '${rem.status}'.`
        );
      }
      if (params.mode === 'REJECT' && !['DRAFT', 'SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING'].includes(rem.status)) {
        throw new CodAccountabilityError(
          409,
          'CANNOT_REJECT_TERMINAL_REMITTANCE',
          `Cannot reject remittance in state '${rem.status}'; use authorized reversal for verified remittances.`
        );
      }

      const allocs = await client.query(
        `SELECT a.id AS alloc_id, a.collection_id, a.allocated_amount, c.allocated_amount AS col_allocated, c.cleared_amount, c.collected_amount
         FROM cod_remittance_allocations a
         JOIN cod_collections c ON c.id = a.collection_id
         WHERE a.remittance_id = $1 AND a.status = 'RESERVED'
         FOR UPDATE`,
        [rem.id]
      );

      for (const a of allocs.rows) {
        const nextColAlloc = BigNumber.max(0, subtract(a.col_allocated, a.allocated_amount));
        const nextColStatus =
          toDecimal(a.cleared_amount).gt(0)
            ? toDecimal(a.cleared_amount).gte(a.collected_amount)
              ? 'CLEARED'
              : 'PARTIALLY_CLEARED'
            : nextColAlloc.gt(0)
            ? 'PARTIALLY_ALLOCATED'
            : 'COLLECTED';

        await client.query(
          `UPDATE cod_collections
           SET allocated_amount = $1,
               status = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [roundCurrency(nextColAlloc), nextColStatus, a.collection_id]
        );
        await client.query(
          `UPDATE cod_remittance_allocations SET status = 'RELEASED', updated_at = NOW() WHERE id = $1`,
          [a.alloc_id]
        );
      }

      const rejectedByVal = targetStatus === 'REJECTED' ? params.actorUserId : null;
      const rejectedAtTs = targetStatus === 'REJECTED' ? new Date() : null;
      const cancelledAtTs = targetStatus === 'CANCELLED' ? new Date() : null;
      await client.query(
        `UPDATE cod_remittances
         SET status = $1,
             rejected_by = COALESCE($2, rejected_by),
             rejected_at = COALESCE($3, rejected_at),
             cancelled_at = COALESCE($4, cancelled_at),
             rejection_reason = $5,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $6`,
        [targetStatus, rejectedByVal, rejectedAtTs, cancelledAtTs, params.reason.trim(), rem.id]
      );

      return { remittanceId: rem.id as string, status: targetStatus };
    });

    await recordAuditEvent({
      actorId: params.actorUserId,
      actorType: params.mode === 'CANCEL' ? 'USER' : 'ADMIN',
      action: `COD_REMITTANCE_${out.status}`,
      entityType: 'COD_REMITTANCE',
      entityId: out.remittanceId,
      newState: { reason: params.reason.trim(), status: out.status },
    }).catch(() => {});

    return out;
  }

  /**
   * Opens a manual COD cash dispute (missing collection, customer dispute, overdue liability).
   */
  public async openDispute(params: {
    riderId: string;
    remittanceId?: string;
    collectionId?: string;
    orderId?: string;
    disputeType: 'SHORTAGE' | 'EXCESS' | 'MISSING_COLLECTION' | 'CUSTOMER_DISPUTE' | 'VERIFICATION_DISPUTE' | 'OVERDUE_LIABILITY';
    disputedAmount: number | string;
    reason: string;
    openedByUserId: string;
    evidence?: Record<string, unknown>;
  }): Promise<{ disputeId: string; disputeNumber: string; status: string }> {
    const amtBn = toDecimal(params.disputedAmount);
    if (amtBn.lte(0)) {
      throw new CodAccountabilityError(400, 'INVALID_DISPUTE_AMOUNT', 'Disputed amount must be positive.');
    }
    if (!params.reason || params.reason.trim().length < 3) {
      throw new CodAccountabilityError(400, 'REASON_REQUIRED', 'Dispute reason is required.');
    }

    const res = await transaction(async (client) => {
      const riderRes = await client.query(`SELECT id, floating_cash_balance FROM riders WHERE id = $1 FOR UPDATE`, [params.riderId]);
      if (riderRes.rows.length === 0) {
        throw new CodAccountabilityError(404, 'RIDER_NOT_FOUND', `Rider '${params.riderId}' not found.`);
      }

      const disputeNumber = `CODDISP_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const ins = await client.query(
        `INSERT INTO cod_cash_disputes (
           dispute_number, remittance_id, collection_id, order_id, rider_id,
           dispute_type, status, expected_amount, disputed_amount, reason, evidence, opened_by
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, 'OPEN', $7, $7, $8, $9, $10
         )
         RETURNING id, dispute_number, status`,
        [
          disputeNumber,
          params.remittanceId || null,
          params.collectionId || null,
          params.orderId || null,
          params.riderId,
          params.disputeType,
          roundCurrency(amtBn),
          params.reason.trim(),
          JSON.stringify(params.evidence || {}),
          params.openedByUserId,
        ]
      );

      await client.query(
        `UPDATE riders
         SET active_cod_dispute_count = active_cod_dispute_count + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [params.riderId]
      );
      await this.syncRiderCodRestrictionInTx(client, params.riderId);

      return ins.rows[0];
    });

    await recordAuditEvent({
      actorId: params.openedByUserId,
      actorType: 'ADMIN',
      action: 'COD_DISPUTE_OPENED',
      entityType: 'COD_DISPUTE',
      entityId: res.id,
      newState: {
        disputeNumber: res.dispute_number,
        riderId: params.riderId,
        disputeType: params.disputeType,
        disputedAmount: Number(roundCurrency(amtBn)),
      },
    }).catch(() => {});

    paymentLogger.increment('codDisputesOpened');
    return {
      disputeId: res.id,
      disputeNumber: res.dispute_number,
      status: res.status,
    };
  }

  /**
   * Authorized Finance Resolution for COD Shortage, Excess, or Investigation Disputes.
   */
  public async resolveDispute(params: {
    disputeId: string;
    resolverUserId: string;
    resolutionType: DisputeResolutionType;
    notes: string;
    idempotencyKey?: string;
  }): Promise<{
    success: true;
    idempotentReplay: boolean;
    disputeId: string;
    disputeNumber: string;
    status: string;
    resolutionType: DisputeResolutionType;
    journalBatchId: string | null;
    remainingCash: number;
    unblocked: boolean;
  }> {
    if (!params.notes || params.notes.trim().length < 3) {
      throw new CodAccountabilityError(400, 'RESOLUTION_NOTES_REQUIRED', 'Resolution notes are required.');
    }

    const out = await transaction(async (client) => {
      const peek = await client.query(`SELECT rider_id FROM cod_cash_disputes WHERE id = $1`, [params.disputeId]);
      if (peek.rows.length === 0) {
        throw new CodAccountabilityError(404, 'DISPUTE_NOT_FOUND', `Dispute '${params.disputeId}' not found.`);
      }
      const riderId = peek.rows[0].rider_id as string;

      // Hierarchy: rider -> collections -> dispute
      const riderRes = await client.query(
        `SELECT id, user_id, floating_cash_balance, wallet_balance, active_cod_dispute_count
         FROM riders WHERE id = $1 FOR UPDATE`,
        [riderId]
      );
      const rider = riderRes.rows[0];

      if (rider.user_id && rider.user_id === params.resolverUserId) {
        throw new CodAccountabilityError(
          403,
          'SELF_DISPUTE_RESOLUTION_FORBIDDEN',
          'A rider cannot resolve their own COD cash dispute.'
        );
      }

      const dispRes = await client.query(
        `SELECT * FROM cod_cash_disputes WHERE id = $1 FOR UPDATE`,
        [params.disputeId]
      );
      const dispute = dispRes.rows[0];

      if (dispute.status === 'REJECTED') {
        throw new CodAccountabilityError(
          409,
          'INVALID_DISPUTE_STATE_TRANSITION',
          `Rejected/reversed dispute '${dispute.dispute_number}' cannot be resolved.`
        );
      }

      const prevEvidence = (dispute.evidence && typeof dispute.evidence === 'object' ? dispute.evidence : {}) as Record<string, unknown>;
      const sameIdempKey = Boolean(params.idempotencyKey && prevEvidence.resolveIdempotencyKey === params.idempotencyKey);

      if (dispute.status === 'RESOLVED') {
        if (sameIdempKey || (dispute.resolution_type === params.resolutionType && dispute.resolved_by === params.resolverUserId)) {
          return {
            success: true as const,
            idempotentReplay: true,
            disputeId: dispute.id as string,
            disputeNumber: dispute.dispute_number as string,
            status: 'RESOLVED',
            resolutionType: dispute.resolution_type as DisputeResolutionType,
            journalBatchId: dispute.journal_batch_id || null,
            remainingCash: Number(roundCurrency(rider.floating_cash_balance || 0)),
            unblocked: false,
          };
        }
        throw new CodAccountabilityError(409, 'DISPUTE_ALREADY_RESOLVED', `Dispute '${dispute.dispute_number}' is already resolved.`);
      }

      const isFromEscalated = dispute.status === 'ESCALATED';
      if (isFromEscalated && params.resolutionType === 'ESCALATED_TO_RECEIVABLE') {
        if (sameIdempKey || dispute.resolved_by === params.resolverUserId) {
          return {
            success: true as const,
            idempotentReplay: true,
            disputeId: dispute.id as string,
            disputeNumber: dispute.dispute_number as string,
            status: 'ESCALATED',
            resolutionType: 'ESCALATED_TO_RECEIVABLE' as DisputeResolutionType,
            journalBatchId: dispute.journal_batch_id || null,
            remainingCash: Number(roundCurrency(rider.floating_cash_balance || 0)),
            unblocked: false,
          };
        }
        throw new CodAccountabilityError(409, 'DISPUTE_ALREADY_ESCALATED', `Dispute '${dispute.dispute_number}' is already escalated to receivable.`);
      }

      const amountBn = toDecimal(roundCurrency(dispute.disputed_amount));
      const amountNum = Number(roundCurrency(amountBn));
      const riderFloatBn = toDecimal(roundCurrency(rider.floating_cash_balance || 0));
      const riderWalletBn = toDecimal(roundCurrency(rider.wallet_balance || 0));

      // Validate semantic compatibility between dispute type, current state, and resolution type
      if (dispute.dispute_type === 'EXCESS') {
        if (!['EXCESS_RETURNED', 'EXCESS_ALLOCATED_TO_COLLECTION', 'CONFIRMED_NO_VARIANCE'].includes(params.resolutionType)) {
          throw new CodAccountabilityError(
            400,
            'INVALID_EXCESS_RESOLUTION',
            `Excess cash disputes cannot be resolved via '${params.resolutionType}'.`
          );
        }
      } else if (['EXCESS_RETURNED', 'EXCESS_ALLOCATED_TO_COLLECTION'].includes(params.resolutionType)) {
        throw new CodAccountabilityError(
          400,
          'INVALID_RESOLUTION_FOR_DISPUTE_TYPE',
          `Resolution '${params.resolutionType}' is valid only for EXCESS disputes, not '${dispute.dispute_type}'.`
        );
      }

      if (params.resolutionType === 'RECEIVABLE_COLLECTED' && !isFromEscalated) {
        throw new CodAccountabilityError(
          409,
          'RECEIVABLE_NOT_ESCALATED',
          `Dispute '${dispute.dispute_number}' must be escalated to receivable (1050) before calling RECEIVABLE_COLLECTED.`
        );
      }

      if (isFromEscalated && params.resolutionType === 'CONFIRMED_NO_VARIANCE') {
        throw new CodAccountabilityError(
          409,
          'INVALID_DISPUTE_STATE_TRANSITION',
          `Escalated receivable '${dispute.dispute_number}' must be settled via RECEIVABLE_COLLECTED, RECOVERED_CASH, RECOVERED_FROM_WALLET, or WRITTEN_OFF.`
        );
      }

      let journalBatchId: string | null = null;
      let ledgerRef: string | null = null;

      if (params.resolutionType !== 'CONFIRMED_NO_VARIANCE') {
        if (params.resolutionType === 'RECOVERED_FROM_WALLET' && riderWalletBn.lt(amountBn)) {
          throw new CodAccountabilityError(
            409,
            'INSUFFICIENT_WALLET_FOR_RECOVERY',
            `Rider wallet balance ₹${roundCurrency(riderWalletBn)} is insufficient to cover shortage ₹${amountNum.toFixed(2)}.`
          );
        }

        if (
          !isFromEscalated &&
          ['RECOVERED_CASH', 'RECOVERED_FROM_WALLET', 'ESCALATED_TO_RECEIVABLE', 'WRITTEN_OFF'].includes(params.resolutionType) &&
          riderFloatBn.lt(amountBn)
        ) {
          throw new CodAccountabilityError(
            409,
            'INSUFFICIENT_FLOAT_FOR_DISPUTE_SETTLEMENT',
            `Rider floating cash ₹${roundCurrency(riderFloatBn)} is less than disputed shortage ₹${amountNum.toFixed(2)}.`
          );
        }

        let fifoCollectionsForExcess: any[] = [];
        if (params.resolutionType === 'EXCESS_ALLOCATED_TO_COLLECTION') {
          if (riderFloatBn.lt(amountBn)) {
            throw new CodAccountabilityError(
              409,
              'INSUFFICIENT_FLOAT_FOR_EXCESS_ALLOCATION',
              `Rider floating cash ₹${roundCurrency(riderFloatBn)} is less than excess ₹${amountNum.toFixed(2)} to allocate.`
            );
          }
          const openColRes = await client.query(
            `SELECT id, order_id, collected_amount, allocated_amount, cleared_amount, disputed_amount, status
             FROM cod_collections
             WHERE rider_id = $1
               AND status IN ('COLLECTED', 'PARTIALLY_ALLOCATED', 'PARTIALLY_CLEARED', 'SHORTAGE_DISPUTED')
             ORDER BY collected_at ASC, id ASC
             FOR UPDATE`,
            [riderId]
          );
          let freeTotalBn = new BigNumber(0);
          for (const c of openColRes.rows) {
            const freeBn = BigNumber.max(0, subtract(toDecimal(c.collected_amount), toDecimal(c.allocated_amount), toDecimal(c.cleared_amount)));
            freeTotalBn = add(freeTotalBn, freeBn);
          }
          if (freeTotalBn.lt(amountBn)) {
            throw new CodAccountabilityError(
              409,
              'INSUFFICIENT_UNALLOCATED_FLOAT_FOR_EXCESS_ALLOCATION',
              `Unallocated COD collection balance ₹${roundCurrency(freeTotalBn)} is insufficient to absorb excess ₹${amountNum.toFixed(2)}.`
            );
          }
          fifoCollectionsForExcess = openColRes.rows;
        }

        ledgerRef = `TX_COD_DISP_${dispute.dispute_number}_${params.resolutionType}`;
        journalBatchId = await ledgerService.recordCodDisputeResolution({
          riderId,
          disputeNumber: dispute.dispute_number,
          resolutionType: params.resolutionType,
          amount: amountNum,
          fromReceivable: isFromEscalated,
          orderId: dispute.order_id || null,
          reason: params.notes.trim(),
          client,
        });

        if (
          (!isFromEscalated && ['RECOVERED_CASH', 'ESCALATED_TO_RECEIVABLE', 'WRITTEN_OFF'].includes(params.resolutionType)) ||
          params.resolutionType === 'EXCESS_ALLOCATED_TO_COLLECTION'
        ) {
          const nextFloat = subtract(riderFloatBn, amountBn);
          await client.query(`UPDATE riders SET floating_cash_balance = $1, updated_at = NOW() WHERE id = $2`, [
            roundCurrency(nextFloat),
            riderId,
          ]);
        } else if (params.resolutionType === 'RECOVERED_FROM_WALLET') {
          const nextFloat = isFromEscalated ? riderFloatBn : subtract(riderFloatBn, amountBn);
          const nextWallet = subtract(riderWalletBn, amountBn);
          await client.query(
            `UPDATE riders SET floating_cash_balance = $1, wallet_balance = $2, updated_at = NOW() WHERE id = $3`,
            [roundCurrency(nextFloat), roundCurrency(nextWallet), riderId]
          );
          await client.query(
            `INSERT INTO rider_ledgers (rider_id, entry_type, category, amount, running_balance, utr_number, description)
             VALUES ($1, 'ADJUSTMENT', 'DEBIT', $2, $3, $4, $5)`,
            [
              riderId,
              amountNum.toFixed(2),
              roundCurrency(nextWallet),
              dispute.dispute_number,
              `Authorized recovery of COD shortage (${dispute.dispute_number}) from rider wallet: ${params.notes.trim()}`,
            ]
          );
        }

        if (params.resolutionType === 'EXCESS_ALLOCATED_TO_COLLECTION' && fifoCollectionsForExcess.length > 0) {
          let excessRemainingBn = amountBn;
          for (const col of fifoCollectionsForExcess) {
            if (excessRemainingBn.lte(0)) break;
            const freeBn = BigNumber.max(0, subtract(toDecimal(col.collected_amount), toDecimal(col.allocated_amount), toDecimal(col.cleared_amount)));
            if (freeBn.lte(0)) continue;
            const applyBn = BigNumber.min(excessRemainingBn, freeBn);
            excessRemainingBn = subtract(excessRemainingBn, applyBn);
            const newCleared = add(col.cleared_amount, applyBn);
            const isFullyCleared = newCleared.gte(col.collected_amount);
            const finalColStatus = isFullyCleared
              ? 'CLEARED'
              : toDecimal(col.allocated_amount).gt(0)
              ? 'PARTIALLY_ALLOCATED'
              : 'PARTIALLY_CLEARED';
            const colClearedAtTs = isFullyCleared ? new Date() : null;
            await client.query(
              `UPDATE cod_collections
               SET disputed_amount = GREATEST(0, disputed_amount - $1),
                   cleared_amount = $2,
                   status = $3,
                   cleared_at = COALESCE(cleared_at, $4),
                   updated_at = NOW()
               WHERE id = $5`,
              [roundCurrency(applyBn), roundCurrency(newCleared), finalColStatus, colClearedAtTs, col.id]
            );
            if (isFullyCleared) {
              await client.query(
                `UPDATE delivery_trips SET cod_reconciled = TRUE, updated_at = NOW() WHERE order_id = $1 AND trip_type = 'FORWARD'`,
                [col.order_id]
              );
            }
          }
        }
      }

      // Clear shortage disputed_amount / collection states on linked remittance or collection (only on first GL move out of 1030)
      if (
        !isFromEscalated &&
        ['RECOVERED_CASH', 'RECOVERED_FROM_WALLET', 'ESCALATED_TO_RECEIVABLE', 'WRITTEN_OFF'].includes(params.resolutionType)
      ) {
        if (dispute.remittance_id) {
          const linkedCols = await client.query(
            `SELECT a.collection_id, a.order_id, c.collected_amount, c.cleared_amount, c.disputed_amount
             FROM cod_remittance_allocations a
             JOIN cod_collections c ON c.id = a.collection_id
             WHERE a.remittance_id = $1 AND c.disputed_amount > 0
             FOR UPDATE`,
            [dispute.remittance_id]
          );
          let remDispToClear = amountBn;
          for (const col of linkedCols.rows) {
            if (remDispToClear.lte(0)) break;
            const colDisp = toDecimal(col.disputed_amount);
            const take = BigNumber.min(remDispToClear, colDisp);
            remDispToClear = subtract(remDispToClear, take);
            const newCleared = add(col.cleared_amount, take);
            const isFull = newCleared.gte(col.collected_amount);
            const finalColStatus =
              params.resolutionType === 'WRITTEN_OFF'
                ? 'WRITTEN_OFF'
                : isFull
                ? 'CLEARED'
                : 'PARTIALLY_CLEARED';

            const colClearedAtTs = finalColStatus === 'CLEARED' ? new Date() : null;
            await client.query(
              `UPDATE cod_collections
               SET disputed_amount = GREATEST(0, disputed_amount - $1),
                   cleared_amount = $2,
                   status = $3,
                   cleared_at = COALESCE(cleared_at, $4),
                   updated_at = NOW()
               WHERE id = $5`,
              [roundCurrency(take), roundCurrency(newCleared), finalColStatus, colClearedAtTs, col.collection_id]
            );

            if (finalColStatus === 'CLEARED') {
              await client.query(
                `UPDATE delivery_trips SET cod_reconciled = TRUE, updated_at = NOW() WHERE order_id = $1 AND trip_type = 'FORWARD'`,
                [col.order_id]
              );
            }
          }
        } else if (dispute.collection_id || dispute.order_id) {
          const targetColRes = dispute.collection_id
            ? await client.query(
                `SELECT id AS collection_id, order_id, collected_amount, allocated_amount, cleared_amount, disputed_amount
                 FROM cod_collections
                 WHERE id = $1 AND rider_id = $2 AND status <> 'REVERSED'
                 FOR UPDATE`,
                [dispute.collection_id, riderId]
              )
            : await client.query(
                `SELECT id AS collection_id, order_id, collected_amount, allocated_amount, cleared_amount, disputed_amount
                 FROM cod_collections
                 WHERE order_id = $1 AND rider_id = $2 AND status <> 'REVERSED'
                 FOR UPDATE`,
                [dispute.order_id, riderId]
              );
          if (targetColRes.rows.length > 0) {
            const col = targetColRes.rows[0];
            const availableOnCol = BigNumber.max(
              0,
              subtract(toDecimal(col.collected_amount), toDecimal(col.allocated_amount), toDecimal(col.cleared_amount))
            );
            const take = BigNumber.min(amountBn, availableOnCol);
            if (take.gt(0)) {
              const newCleared = add(col.cleared_amount, take);
              const isFull = newCleared.gte(col.collected_amount);
              const finalColStatus =
                params.resolutionType === 'WRITTEN_OFF'
                  ? 'WRITTEN_OFF'
                  : isFull
                  ? 'CLEARED'
                  : 'PARTIALLY_CLEARED';
              const colClearedAtTs = finalColStatus === 'CLEARED' ? new Date() : null;
              await client.query(
                `UPDATE cod_collections
                 SET disputed_amount = GREATEST(0, disputed_amount - $1),
                     cleared_amount = $2,
                     status = $3,
                     cleared_at = COALESCE(cleared_at, $4),
                     updated_at = NOW()
                 WHERE id = $5`,
                [roundCurrency(take), roundCurrency(newCleared), finalColStatus, colClearedAtTs, col.collection_id]
              );
              if (finalColStatus === 'CLEARED') {
                await client.query(
                  `UPDATE delivery_trips SET cod_reconciled = TRUE, updated_at = NOW() WHERE order_id = $1 AND trip_type = 'FORWARD'`,
                  [col.order_id]
                );
              }
            }
          }
        }
      }

      // If ESCALATED_TO_RECEIVABLE keep status 'ESCALATED' until settled, otherwise 'RESOLVED'
      const nextDisputeStatus = params.resolutionType === 'ESCALATED_TO_RECEIVABLE' ? 'ESCALATED' : 'RESOLVED';
      const resolvedAtTs = nextDisputeStatus === 'RESOLVED' ? new Date() : null;
      const nextEvidence = {
        ...prevEvidence,
        ...(params.idempotencyKey ? { resolveIdempotencyKey: params.idempotencyKey } : {}),
        ...(isFromEscalated ? { escalatedSettlementCompleted: true } : {}),
      };
      await client.query(
        `UPDATE cod_cash_disputes
         SET status = $1,
             resolution_type = $2,
             resolved_by = $3,
             resolution_notes = $4,
             journal_batch_id = COALESCE($5, journal_batch_id),
             ledger_transaction_reference = COALESCE($6, ledger_transaction_reference),
             resolved_at = COALESCE($7, resolved_at),
             evidence = $8,
             updated_at = NOW()
         WHERE id = $9`,
        [
          nextDisputeStatus,
          params.resolutionType,
          params.resolverUserId,
          params.notes.trim(),
          journalBatchId,
          ledgerRef,
          resolvedAtTs,
          JSON.stringify(nextEvidence),
          dispute.id,
        ]
      );

      if (nextDisputeStatus === 'RESOLVED') {
        await client.query(
          `UPDATE riders
           SET active_cod_dispute_count = GREATEST(0, active_cod_dispute_count - 1),
               updated_at = NOW()
           WHERE id = $1`,
          [riderId]
        );
      }

      const syncRes = await this.syncRiderCodRestrictionInTx(client, riderId, { liftSuspensionIfClear: true });

      return {
        success: true as const,
        idempotentReplay: false,
        disputeId: dispute.id as string,
        disputeNumber: dispute.dispute_number as string,
        status: nextDisputeStatus,
        resolutionType: params.resolutionType,
        journalBatchId,
        remainingCash: syncRes.floatingCashBalance,
        unblocked: syncRes.unblocked,
      };
    });

    if (!out.idempotentReplay) {
      if (out.status === 'RESOLVED') {
        paymentLogger.increment('codDisputesResolved');
      }
      await recordAuditEvent({
        actorId: params.resolverUserId,
        actorType: 'ADMIN',
        action: 'COD_DISPUTE_RESOLVED',
        entityType: 'COD_DISPUTE',
        entityId: out.disputeId,
        newState: {
          resolutionType: out.resolutionType,
          status: out.status,
          journalBatchId: out.journalBatchId,
          notes: params.notes.trim(),
        },
      }).catch(() => {});
    }

    return out;
  }

  /**
   * Authorized reversal of an already-verified COD remittance.
   * Never modifies or deletes original GL entries — appends offsetting reversal journal,
   * restores rider liability and collection allocation state, and clears cod_reconciled.
   */
  public async reverseVerifiedRemittance(params: {
    remittanceId: string;
    actorUserId: string;
    reason: string;
  }): Promise<{
    success: true;
    idempotentReplay: boolean;
    remittanceId: string;
    remittanceReference: string;
    reversalJournalBatchId: string | null;
    restoredLiability: number;
    remainingCash: number;
  }> {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new CodAccountabilityError(400, 'REVERSAL_REASON_REQUIRED', 'A detailed reason (>= 5 chars) is required to reverse a verified remittance.');
    }

    const out = await transaction(async (client) => {
      const peek = await client.query(`SELECT rider_id FROM cod_remittances WHERE id = $1`, [params.remittanceId]);
      if (peek.rows.length === 0) {
        throw new CodAccountabilityError(404, 'REMITTANCE_NOT_FOUND', `Remittance '${params.remittanceId}' not found.`);
      }
      const riderId = peek.rows[0].rider_id as string;

      const riderRes = await client.query(`SELECT id, floating_cash_balance FROM riders WHERE id = $1 FOR UPDATE`, [riderId]);
      const remRes = await client.query(`SELECT * FROM cod_remittances WHERE id = $1 FOR UPDATE`, [params.remittanceId]);
      const rem = remRes.rows[0];

      if (rem.status === 'REVERSED') {
        return {
          success: true as const,
          idempotentReplay: true,
          remittanceId: rem.id as string,
          remittanceReference: rem.remittance_reference as string,
          reversalJournalBatchId: rem.reversal_journal_batch_id || null,
          restoredLiability: Number(roundCurrency(rem.cleared_amount || 0)),
          remainingCash: Number(roundCurrency(riderRes.rows[0].floating_cash_balance || 0)),
        };
      }

      if (!['VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS'].includes(rem.status)) {
        throw new CodAccountabilityError(
          409,
          'REMITTANCE_NOT_REVERSIBLE',
          `Only verified/cleared remittances can be financially reversed (current status: '${rem.status}').`
        );
      }

      const linkedDisputes = await client.query(
        `SELECT id, dispute_number, status, resolution_type
         FROM cod_cash_disputes
         WHERE remittance_id = $1
         FOR UPDATE`,
        [rem.id]
      );
      for (const ld of linkedDisputes.rows) {
        if (ld.status === 'ESCALATED' || (ld.status === 'RESOLVED' && ld.resolution_type !== 'CONFIRMED_NO_VARIANCE')) {
          throw new CodAccountabilityError(
            409,
            'REMITTANCE_DISPUTE_ALREADY_PROCESSED',
            `Cannot reverse remittance '${rem.remittance_reference}' because linked dispute '${ld.dispute_number}' already posted financial resolution '${ld.resolution_type || ld.status}'.`
          );
        }
      }

      const verifiedBn = toDecimal(roundCurrency(rem.verified_amount || 0));
      const clearedBn = toDecimal(roundCurrency(rem.cleared_amount || 0));
      const excessBn = toDecimal(roundCurrency(rem.excess_amount || 0));

      let revBatchId: string | null = null;
      const revRef = `TX_COD_REV_${rem.remittance_reference}`;
      if (verifiedBn.gt(0)) {
        revBatchId = await ledgerService.recordCodRemittanceReversal({
          riderId,
          verifiedAmount: Number(roundCurrency(verifiedBn)),
          clearedLiabilityAmount: Number(roundCurrency(clearedBn)),
          excessAmount: Number(roundCurrency(excessBn)),
          reference: rem.remittance_reference,
          reason: params.reason.trim(),
          client,
        });
      }

      const newFloatBn = add(riderRes.rows[0].floating_cash_balance || 0, clearedBn);
      await client.query(`UPDATE riders SET floating_cash_balance = $1, updated_at = NOW() WHERE id = $2`, [
        roundCurrency(newFloatBn),
        riderId,
      ]);

      const allocs = await client.query(
        `SELECT a.id AS alloc_id, a.collection_id, a.order_id, a.allocated_amount, a.cleared_amount,
                c.cleared_amount AS col_cleared, c.allocated_amount AS col_allocated, c.disputed_amount AS col_disputed
         FROM cod_remittance_allocations a
         JOIN cod_collections c ON c.id = a.collection_id
         WHERE a.remittance_id = $1
         FOR UPDATE`,
        [rem.id]
      );
      for (const a of allocs.rows) {
        const nextColCleared = BigNumber.max(0, subtract(a.col_cleared, a.cleared_amount));
        const shortageDelta =
          rem.status === 'SHORTAGE' ? BigNumber.max(0, subtract(a.allocated_amount, a.cleared_amount)) : new BigNumber(0);
        const nextColDisputed = BigNumber.max(0, subtract(a.col_disputed, shortageDelta));
        const nextStatus = nextColDisputed.gt(0)
          ? 'SHORTAGE_DISPUTED'
          : nextColCleared.gt(0)
          ? 'PARTIALLY_CLEARED'
          : toDecimal(a.col_allocated).gt(0)
          ? 'PARTIALLY_ALLOCATED'
          : 'COLLECTED';

        await client.query(
          `UPDATE cod_collections
           SET cleared_amount = $1,
               disputed_amount = $2,
               status = $3,
               cleared_at = NULL,
               updated_at = NOW()
           WHERE id = $4`,
          [roundCurrency(nextColCleared), roundCurrency(nextColDisputed), nextStatus, a.collection_id]
        );
        await client.query(
          `UPDATE cod_remittance_allocations SET status = 'REVERSED', updated_at = NOW() WHERE id = $1`,
          [a.alloc_id]
        );
        await client.query(
          `UPDATE delivery_trips SET cod_reconciled = FALSE, updated_at = NOW() WHERE order_id = $1 AND trip_type = 'FORWARD'`,
          [a.order_id]
        );
      }

      let closedOpenDisputes = 0;
      for (const ld of linkedDisputes.rows) {
        if (['OPEN', 'UNDER_INVESTIGATION'].includes(ld.status)) {
          await client.query(
            `UPDATE cod_cash_disputes
             SET status = 'REJECTED',
                 resolution_type = 'REVERSED',
                 resolved_by = $1,
                 resolved_at = NOW(),
                 resolution_notes = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [params.actorUserId, `Closed on remittance reversal: ${params.reason.trim()}`, ld.id]
          );
          closedOpenDisputes++;
        }
      }
      if (closedOpenDisputes > 0) {
        await client.query(
          `UPDATE riders
           SET active_cod_dispute_count = GREATEST(0, active_cod_dispute_count - $1),
               updated_at = NOW()
           WHERE id = $2`,
          [closedOpenDisputes, riderId]
        );
      }

      await client.query(
        `UPDATE cod_remittances
         SET status = 'REVERSED',
             reversed_by = $1,
             reversed_at = NOW(),
             reversal_reason = $2,
             reversal_journal_batch_id = $3,
             reversal_transaction_reference = $4,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $5`,
        [params.actorUserId, params.reason.trim(), revBatchId, revBatchId ? revRef : null, rem.id]
      );

      const syncRes = await this.syncRiderCodRestrictionInTx(client, riderId, { liftSuspensionIfClear: true });

      return {
        success: true as const,
        idempotentReplay: false,
        remittanceId: rem.id as string,
        remittanceReference: rem.remittance_reference as string,
        reversalJournalBatchId: revBatchId,
        restoredLiability: Number(roundCurrency(clearedBn)),
        remainingCash: syncRes.floatingCashBalance,
      };
    });

    if (!out.idempotentReplay) {
      await recordAuditEvent({
        actorId: params.actorUserId,
        actorType: 'ADMIN',
        action: 'COD_REMITTANCE_REVERSED',
        entityType: 'COD_REMITTANCE',
        entityId: out.remittanceId,
        newState: {
          reason: params.reason.trim(),
          reversalJournalBatchId: out.reversalJournalBatchId,
          restoredLiability: out.restoredLiability,
        },
      }).catch(() => {});
    }

    return out;
  }

  /**
   * Authorized temporary COD cash ceiling override (never clears liability, only adjusts active dispatch threshold temporarily).
   */
  public async grantTemporaryCeilingOverride(params: {
    riderId: string;
    overrideLimit: number | string;
    durationMinutes: number;
    reason: string;
    adminUserId: string;
  }): Promise<{
    riderId: string;
    overrideLimit: number;
    validUntil: string;
    isCodRestricted: boolean;
    riderStatus: string;
  }> {
    const limitBn = toDecimal(params.overrideLimit);
    if (limitBn.lte(0) || limitBn.gt(50000)) {
      throw new CodAccountabilityError(400, 'INVALID_OVERRIDE_LIMIT', 'Override limit must be between 0 and 50000.');
    }
    const mins = Math.min(Math.max(Number(params.durationMinutes) || 0, 5), 1440);
    if (!params.reason || params.reason.trim().length < 5) {
      throw new CodAccountabilityError(400, 'REASON_REQUIRED', 'Audit reason is required for COD ceiling override.');
    }

    const validUntil = new Date(Date.now() + mins * 60 * 1000);
    const out = await transaction(async (client) => {
      await client.query(
        `UPDATE riders
         SET cod_ceiling_override_limit = $1,
             cod_ceiling_override_by = $2,
             cod_ceiling_override_reason = $3,
             cod_ceiling_override_until = $4,
             updated_at = NOW()
         WHERE id = $5`,
        [roundCurrency(limitBn), params.adminUserId, params.reason.trim(), validUntil, params.riderId]
      );

      const sync = await this.syncRiderCodRestrictionInTx(client, params.riderId, { liftSuspensionIfClear: true });
      return {
        riderId: params.riderId,
        overrideLimit: Number(roundCurrency(limitBn)),
        validUntil: validUntil.toISOString(),
        isCodRestricted: sync.isCodRestricted,
        riderStatus: sync.riderStatus,
      };
    });

    await recordAuditEvent({
      actorId: params.adminUserId,
      actorType: 'ADMIN',
      action: 'COD_CEILING_OVERRIDE_GRANTED',
      entityType: 'RIDER',
      entityId: params.riderId,
      newState: out,
    }).catch(() => {});

    return out;
  }

  /**
   * Portfolio-wide COD Accountability Metrics for Observability (Section 23).
   */
  public async getPortfolioCodObservability(): Promise<{
    totalCodCollected: number;
    totalRiderCashLiability: number;
    totalRemittanceSubmitted: number;
    totalRemittanceReceived: number;
    totalRemittanceVerified: number;
    totalOutstandingLiability: number;
    totalShortages: number;
    totalExcess: number;
    openDisputeCount: number;
    unverifiedRemittancesCount: number;
    unverifiedRemittancesAmount: number;
    ridersAboveCashCeilingCount: number;
    codRestrictedRidersCount: number;
    stuckRemittancesCount: number;
    openCodReconciliationDiscrepancies: number;
  }> {
    const pool = getPool();
    const [colSum, remSum, dispSum, riderCounts, stuckCnt, reconCnt] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status <> 'REVERSED' THEN collected_amount ELSE 0 END), 0) AS total_collected,
           COALESCE(SUM(CASE WHEN status <> 'REVERSED' THEN cleared_amount ELSE 0 END), 0) AS total_cleared
         FROM cod_collections`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS', 'DISPUTED') THEN submitted_amount ELSE 0 END), 0) AS total_submitted,
           COALESCE(SUM(CASE WHEN status IN ('RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS', 'DISPUTED') THEN COALESCE(received_amount, submitted_amount) ELSE 0 END), 0) AS total_received,
           COALESCE(SUM(CASE WHEN status IN ('VERIFIED', 'LIABILITY_CLEARED', 'SHORTAGE', 'EXCESS', 'DISPUTED') THEN COALESCE(verified_amount, 0) ELSE 0 END), 0) AS total_verified,
           COALESCE(SUM(CASE WHEN status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING') THEN submitted_amount ELSE 0 END), 0) AS unverified_amt,
           COUNT(CASE WHEN status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING') THEN 1 END) AS unverified_cnt
         FROM cod_remittances`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN dispute_type = 'SHORTAGE' AND status IN ('OPEN', 'UNDER_INVESTIGATION', 'ESCALATED') THEN disputed_amount ELSE 0 END), 0) AS shortages,
           COALESCE(SUM(CASE WHEN dispute_type = 'EXCESS' AND status IN ('OPEN', 'UNDER_INVESTIGATION', 'ESCALATED') THEN disputed_amount ELSE 0 END), 0) AS excess,
           COUNT(CASE WHEN status IN ('OPEN', 'UNDER_INVESTIGATION', 'ESCALATED') THEN 1 END) AS open_cnt
         FROM cod_cash_disputes`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(floating_cash_balance), 0) AS total_rider_liability,
           COUNT(CASE WHEN floating_cash_balance >= COALESCE(floating_cash_limit, 2500.00) THEN 1 END) AS above_ceiling_cnt,
           COUNT(CASE WHEN cod_restricted = TRUE THEN 1 END) AS restricted_cnt
         FROM riders`
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt
         FROM cod_remittances
         WHERE status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING')
           AND created_at < NOW() - INTERVAL '4 hours'`
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt
         FROM reconciliation_discrepancies
         WHERE status IN ('OPEN', 'REQUIRES_REVIEW')
           AND (category LIKE 'COD_%' OR category LIKE '%COD%' OR category LIKE 'RIDER_CASH%')`
      ),
    ]);

    const totalCollected = Number(roundCurrency(colSum.rows[0]?.total_collected || 0));
    const totalCleared = Number(roundCurrency(colSum.rows[0]?.total_cleared || 0));
    const outstandingFromCols = Number(roundCurrency(BigNumber.max(0, subtract(totalCollected, totalCleared))));
    const riderLiability = Number(roundCurrency(riderCounts.rows[0]?.total_rider_liability || 0));

    return {
      totalCodCollected: totalCollected,
      totalRiderCashLiability: riderLiability,
      totalRemittanceSubmitted: Number(roundCurrency(remSum.rows[0]?.total_submitted || 0)),
      totalRemittanceReceived: Number(roundCurrency(remSum.rows[0]?.total_received || 0)),
      totalRemittanceVerified: Number(roundCurrency(remSum.rows[0]?.total_verified || 0)),
      totalOutstandingLiability: Math.max(outstandingFromCols, riderLiability),
      totalShortages: Number(roundCurrency(dispSum.rows[0]?.shortages || 0)),
      totalExcess: Number(roundCurrency(dispSum.rows[0]?.excess || 0)),
      openDisputeCount: parseInt(String(dispSum.rows[0]?.open_cnt || '0'), 10) || 0,
      unverifiedRemittancesCount: parseInt(String(remSum.rows[0]?.unverified_cnt || '0'), 10) || 0,
      unverifiedRemittancesAmount: Number(roundCurrency(remSum.rows[0]?.unverified_amt || 0)),
      ridersAboveCashCeilingCount: parseInt(String(riderCounts.rows[0]?.above_ceiling_cnt || '0'), 10) || 0,
      codRestrictedRidersCount: parseInt(String(riderCounts.rows[0]?.restricted_cnt || '0'), 10) || 0,
      stuckRemittancesCount: parseInt(String(stuckCnt.rows[0]?.cnt || '0'), 10) || 0,
      openCodReconciliationDiscrepancies: parseInt(String(reconCnt.rows[0]?.cnt || '0'), 10) || 0,
    };
  }
}

export const codCashAccountabilityService = new CodCashAccountabilityService();
