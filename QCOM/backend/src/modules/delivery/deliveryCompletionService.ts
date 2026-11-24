import { getPool, transaction } from '../../database/connection.js';
import { constantTimeCompare } from '../auth/crypto.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { settlementAllocationService } from '../settlements/settlementAllocationService.js';
import { liveLocationService } from '../realtime/liveLocationService.js';
import { add, subtract, toDecimal, roundCurrency } from '../pricing/money.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COD_PAYMENT_METHODS = new Set(['pay on delivery', 'cod', 'cash on delivery']);
const ACTIVE_TRIP_STATUSES = ['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP'] as const;
const MAX_OTP_FAILED_ATTEMPTS = 5;

export interface TripTaskActor {
  riderId?: string;
  isDispatchAdmin: boolean;
  actorUserId: string;
  ipAddress?: string;
}

export interface DeliveryCompletionResult {
  success: true;
  taskId: string;
  orderId: string;
  orderStatus: 'DELIVERED';
  codCollectedAmount: number;
  creditedPayout: {
    basePay: number;
    distancePay: number;
    surgeBonus: number;
    tips: number;
    tdsDeducted: number;
    totalCredited: number;
  };
  walletSummary: {
    todayTotalEarnings: number;
    withdrawableBalance: number;
    floatingCashBalance: number;
    completedDeliveriesToday: number;
  };
  riderStatus: string;
  allocationId: string;
  journalBatchId: string;
}

export class DeliveryTaskError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: Record<string, any>;

  constructor(statusCode: number, errorCode: string, message: string, details?: Record<string, any>) {
    super(`${errorCode}: ${message}`);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export class DeliveryCompletionService {
  private async resolveTripMeta(taskId: string): Promise<{ tripId: string; orderId: string; tripType: string } | null> {
    if (!taskId || !UUID_REGEX.test(taskId)) {
      return null;
    }
    const pool = getPool();
    const res = await pool.query(
      `SELECT id, order_id, trip_type
       FROM delivery_trips
       WHERE id = $1 OR (order_id = $1 AND trip_type = 'FORWARD')
       ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [taskId]
    );
    if (res.rows.length === 0) {
      return null;
    }
    return {
      tripId: res.rows[0].id,
      orderId: res.rows[0].order_id,
      tripType: res.rows[0].trip_type || 'FORWARD',
    };
  }

  public async acceptTask(params: {
    taskId: string;
    riderId: string;
  }): Promise<{
    alreadyAccepted?: boolean;
    taskId: string;
    orderId: string;
    riderId: string;
    status: 'ACCEPTED';
  }> {
    const meta = await this.resolveTripMeta(params.taskId);
    if (!meta) {
      throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
    }

    return transaction(async (client) => {
      // Canonical lock order: orders -> delivery_trips -> riders
      const orderRes = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [meta.orderId]);
      if (orderRes.rows.length === 0) {
        throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Parent order not found.');
      }
      if (orderRes.rows[0].status === 'cancelled') {
        throw new DeliveryTaskError(409, 'ORDER_CANCELLED', 'Cannot accept task for a cancelled order.');
      }

      const tripRes = await client.query(`SELECT * FROM delivery_trips WHERE id = $1 FOR UPDATE`, [meta.tripId]);
      if (tripRes.rows.length === 0) {
        throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
      }
      const trip = tripRes.rows[0];

      const riderRes = await client.query(`SELECT id, status FROM riders WHERE id = $1 FOR UPDATE`, [params.riderId]);
      if (riderRes.rows.length === 0) {
        throw new DeliveryTaskError(403, 'FORBIDDEN', 'Only registered and eligible delivery partners can claim delivery tasks.');
      }
      const rider = riderRes.rows[0];

      if (rider.status === 'SUSPENDED') {
        throw new DeliveryTaskError(403, 'RIDER_SUSPENDED', 'Delivery partner account is suspended and ineligible to accept tasks.');
      }

      if (trip.rider_id === params.riderId && trip.status === 'ACCEPTED') {
        return {
          alreadyAccepted: true,
          taskId: trip.id,
          orderId: trip.order_id,
          riderId: trip.rider_id,
          status: 'ACCEPTED' as const,
        };
      }

      if (trip.status !== 'BROADCASTING') {
        throw new DeliveryTaskError(409, 'TASK_ALREADY_CLAIMED', 'Task already claimed or accepted by another partner.', {
          currentStatus: trip.status,
        });
      }

      if (rider.status === 'OFFLINE') {
        throw new DeliveryTaskError(409, 'RIDER_OFFLINE', 'Rider must be online to accept delivery tasks.');
      }

      await client.query(
        `UPDATE delivery_trips
         SET status = 'ACCEPTED', accepted_at = COALESCE(accepted_at, NOW()), rider_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [params.riderId, trip.id]
      );

      await client.query(
        `UPDATE riders
         SET status = 'PICKING_UP', updated_at = NOW()
         WHERE id = $1 AND status != 'SUSPENDED'`,
        [params.riderId]
      );

      return {
        taskId: trip.id,
        orderId: trip.order_id,
        riderId: params.riderId,
        status: 'ACCEPTED' as const,
      };
    });
  }

  public async arrivedAtPickup(params: {
    taskId: string;
    actor: TripTaskActor;
  }): Promise<{ taskId: string; status: 'ARRIVED_AT_PICKUP' }> {
    const meta = await this.resolveTripMeta(params.taskId);
    if (!meta) {
      throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
    }

    let crossRiderAttempt: { assignedRiderId: string; callerRiderId: string; tripId: string } | null = null;

    try {
      return await transaction(async (client) => {
        await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [meta.orderId]);
        const tripRes = await client.query(`SELECT id, rider_id, status FROM delivery_trips WHERE id = $1 FOR UPDATE`, [meta.tripId]);
        if (tripRes.rows.length === 0) {
          throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
        }

        const trip = tripRes.rows[0];
        if (!params.actor.isDispatchAdmin && trip.rider_id !== params.actor.riderId) {
          crossRiderAttempt = {
            assignedRiderId: trip.rider_id,
            callerRiderId: params.actor.riderId || 'unknown',
            tripId: trip.id,
          };
          throw new DeliveryTaskError(
            403,
            'RIDER_ACCESS_DENIED',
            'Access forbidden: This delivery task is assigned to another delivery partner.'
          );
        }

        if (trip.status === 'ARRIVED_AT_PICKUP') {
          return { taskId: params.taskId, status: 'ARRIVED_AT_PICKUP' as const };
        }

        if (trip.status !== 'ACCEPTED') {
          throw new DeliveryTaskError(
            409,
            'INVALID_TRIP_STATE',
            `Cannot mark arrival at pickup when trip is in '${trip.status}' status.`,
            { currentStatus: trip.status }
          );
        }

        await client.query(
          `UPDATE delivery_trips SET status = 'ARRIVED_AT_PICKUP', updated_at = NOW() WHERE id = $1`,
          [trip.id]
        );

        return { taskId: params.taskId, status: 'ARRIVED_AT_PICKUP' as const };
      });
    } catch (err) {
      if (crossRiderAttempt) {
        await recordAuditEvent({
          actorId: params.actor.actorUserId,
          actorType: 'RIDER',
          action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
          entityType: 'DELIVERY_TRIP',
          entityId: (crossRiderAttempt as any).tripId,
          newState: {
            assignedRiderId: (crossRiderAttempt as any).assignedRiderId,
            callerRiderId: (crossRiderAttempt as any).callerRiderId,
            action: 'arrived-pickup',
          },
          ipAddress: params.actor.ipAddress,
        });
      }
      throw err;
    }
  }

  public async confirmPickup(params: {
    taskId: string;
    actor: TripTaskActor;
  }): Promise<{ taskId: string; status: 'PICKED_UP' }> {
    const meta = await this.resolveTripMeta(params.taskId);
    if (!meta) {
      throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
    }

    let crossRiderAttempt: { assignedRiderId: string; callerRiderId: string; tripId: string } | null = null;

    try {
      return await transaction(async (client) => {
        const orderRes = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [meta.orderId]);
        if (orderRes.rows.length === 0) {
          throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Parent order not found.');
        }
        const order = orderRes.rows[0];
        if (order.status === 'cancelled' || order.status === 'delivered') {
          throw new DeliveryTaskError(409, 'ORDER_NOT_ACTIVE', `Cannot confirm pickup for order in '${order.status}' status.`);
        }

        const tripRes = await client.query(`SELECT id, rider_id, status, trip_type FROM delivery_trips WHERE id = $1 FOR UPDATE`, [meta.tripId]);
        if (tripRes.rows.length === 0) {
          throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
        }

        const trip = tripRes.rows[0];
        if (!params.actor.isDispatchAdmin && trip.rider_id !== params.actor.riderId) {
          crossRiderAttempt = {
            assignedRiderId: trip.rider_id,
            callerRiderId: params.actor.riderId || 'unknown',
            tripId: trip.id,
          };
          throw new DeliveryTaskError(
            403,
            'RIDER_ACCESS_DENIED',
            'Access forbidden: This delivery task is assigned to another delivery partner.'
          );
        }

        if (trip.status === 'PICKED_UP') {
          return { taskId: params.taskId, status: 'PICKED_UP' as const };
        }

        if (!['ACCEPTED', 'ARRIVED_AT_PICKUP'].includes(trip.status)) {
          throw new DeliveryTaskError(
            409,
            'PICKUP_REQUIRES_ACCEPTANCE',
            `Cannot confirm pickup when trip is in '${trip.status}' status.`,
            { currentStatus: trip.status }
          );
        }

        await client.query(
          `UPDATE delivery_trips
           SET status = 'PICKED_UP', picked_up_at = COALESCE(picked_up_at, NOW()), updated_at = NOW()
           WHERE id = $1`,
          [trip.id]
        );

        if (trip.trip_type === 'FORWARD' && ['placed', 'accepted', 'picking', 'packed'].includes(order.status)) {
          await client.query(
            `UPDATE orders SET status = 'out_for_delivery', updated_at = NOW() WHERE id = $1`,
            [order.id]
          );
        }

        if (trip.rider_id) {
          await client.query(
            `UPDATE riders SET status = 'IN_TRANSIT', updated_at = NOW() WHERE id = $1 AND status != 'SUSPENDED'`,
            [trip.rider_id]
          );
        }

        return { taskId: params.taskId, status: 'PICKED_UP' as const };
      });
    } catch (err) {
      if (crossRiderAttempt) {
        await recordAuditEvent({
          actorId: params.actor.actorUserId,
          actorType: 'RIDER',
          action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
          entityType: 'DELIVERY_TRIP',
          entityId: (crossRiderAttempt as any).tripId,
          newState: {
            assignedRiderId: (crossRiderAttempt as any).assignedRiderId,
            callerRiderId: (crossRiderAttempt as any).callerRiderId,
            action: 'pickup-confirm',
          },
          ipAddress: params.actor.ipAddress,
        });
      }
      throw err;
    }
  }

  public async completeDeliveryWithOtp(params: {
    taskId: string;
    otp: string;
    cashCollected?: unknown;
    allowPartial?: boolean;
    actor: TripTaskActor;
  }): Promise<DeliveryCompletionResult> {
    if (params.allowPartial === true) {
      throw new DeliveryTaskError(
        400,
        'PARTIAL_COD_NOT_SUPPORTED',
        'Partial COD cash collection is not supported; full authoritative order total must be collected.'
      );
    }

    if (!params.otp || typeof params.otp !== 'string' || params.otp.trim().length === 0) {
      throw new DeliveryTaskError(400, 'MISSING_OTP', 'Delivery OTP is required.');
    }

    if (params.cashCollected !== undefined && params.cashCollected !== null) {
      const parsed = typeof params.cashCollected === 'number'
        ? params.cashCollected
        : typeof params.cashCollected === 'string' && params.cashCollected.trim() !== ''
          ? Number(params.cashCollected)
          : NaN;
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new DeliveryTaskError(400, 'INVALID_COD_AMOUNT', 'cashCollected must be a finite non-negative amount.');
      }
    }

    const meta = await this.resolveTripMeta(params.taskId);
    if (!meta) {
      throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
    }

    const pool = getPool();
    let crossRiderAudit: { tripId: string; assignedRiderId: string; callerRiderId: string } | null = null;
    let failedOtpAudit: { tripId: string; orderId: string; attempts: number } | null = null;
    let tamperedCodAudit: { tripId: string; orderId: string; clientAmount: number; authoritativeAmount: number } | null = null;
    let shouldClearRedisLocationRiderId: string | null = null;

    try {
      const completionResult = await transaction(async (client): Promise<DeliveryCompletionResult> => {
        // Strict canonical lock ordering: orders -> delivery_trips -> riders
        const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [meta.orderId]);
        if (orderRes.rows.length === 0) {
          throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Parent order not found.');
        }
        const order = orderRes.rows[0];

        const tripRes = await client.query(`SELECT * FROM delivery_trips WHERE id = $1 FOR UPDATE`, [meta.tripId]);
        if (tripRes.rows.length === 0) {
          throw new DeliveryTaskError(404, 'TASK_NOT_FOUND', 'Delivery task not found.');
        }
        const trip = tripRes.rows[0];

        if (trip.rider_id) {
          await client.query(`SELECT id, status FROM riders WHERE id = $1 FOR UPDATE`, [trip.rider_id]);
        }

        if (!params.actor.isDispatchAdmin && trip.rider_id !== params.actor.riderId) {
          crossRiderAudit = {
            tripId: trip.id,
            assignedRiderId: trip.rider_id,
            callerRiderId: params.actor.riderId || 'unknown',
          };
          throw new DeliveryTaskError(
            403,
            'RIDER_ACCESS_DENIED',
            'Access forbidden: This delivery task is assigned to another delivery partner.'
          );
        }

        if (trip.trip_type === 'REVERSE_PICKUP') {
          throw new DeliveryTaskError(
            409,
            'INVALID_TRIP_TYPE',
            'Reverse pickup trips cannot be completed through the forward delivery OTP endpoint.'
          );
        }

        if (order.status === 'cancelled' || trip.status === 'CANCELLED') {
          throw new DeliveryTaskError(409, 'ORDER_CANCELLED', 'Cancelled orders cannot be marked delivered.');
        }

        if (trip.status === 'DELIVERED' || trip.status === 'COMPLETED' || order.status === 'delivered') {
          throw new DeliveryTaskError(409, 'TASK_ALREADY_DELIVERED', 'Delivery task has already been completed.');
        }

        // Enforce pickup lifecycle precondition before OTP handover
        if (!['PICKED_UP', 'ARRIVED_AT_DROP', 'IN_TRANSIT'].includes(trip.status)) {
          throw new DeliveryTaskError(
            409,
            'PICKUP_NOT_COMPLETED',
            `Cannot verify delivery OTP while trip is in '${trip.status}' status. Pickup must be confirmed first.`,
            { currentStatus: trip.status }
          );
        }

        const pmLower = String(order.payment_method || '').trim().toLowerCase();
        const isCodOrder = COD_PAYMENT_METHODS.has(pmLower);
        if (!isCodOrder && order.payment_status !== 'PAID') {
          throw new DeliveryTaskError(
            409,
            'ORDER_NOT_PAID',
            `Online payment order cannot be completed while payment_status is '${order.payment_status}'.`,
            { paymentStatus: order.payment_status }
          );
        }

        const priorFailedAttempts = Number(trip.otp_failed_attempts || 0);
        if (priorFailedAttempts >= MAX_OTP_FAILED_ATTEMPTS) {
          throw new DeliveryTaskError(
            429,
            'OTP_ATTEMPTS_EXCEEDED',
            'Maximum failed delivery OTP attempts reached for this trip. Contact dispatch support.'
          );
        }

        const cleanOtp = params.otp.trim();
        const expectedOtp = String(order.delivery_otp || '').trim();
        const isMatch =
          expectedOtp.length > 0 &&
          cleanOtp.length === expectedOtp.length &&
          constantTimeCompare(cleanOtp, expectedOtp);

        if (!isMatch) {
          failedOtpAudit = {
            tripId: trip.id,
            orderId: order.id,
            attempts: priorFailedAttempts + 1,
          };
          throw new DeliveryTaskError(400, 'INVALID_OTP', 'Invalid delivery OTP provided.');
        }

        const authOrderTotalBn = toDecimal(roundCurrency(order.total_amount || '0'));
        const authoritativeOrderTotal = Number(roundCurrency(authOrderTotalBn));
        const authoritativeCodAmount = isCodOrder ? authoritativeOrderTotal : 0;

        if (params.cashCollected !== undefined && params.cashCollected !== null) {
          const clientCashBn = toDecimal(roundCurrency(params.cashCollected as any));
          if (subtract(clientCashBn, authoritativeCodAmount).abs().gt(0.01)) {
            tamperedCodAudit = {
              tripId: trip.id,
              orderId: order.id,
              clientAmount: Number(roundCurrency(clientCashBn)),
              authoritativeAmount: authoritativeCodAmount,
            };
          }
        }

        // Complete trip & order atomically inside the SAME transaction as settlement allocation.
        // Note: cod_reconciled remains FALSE upon doorstep collection; it flips to TRUE only upon verified COD remittance clearance.
        await client.query(
          `UPDATE delivery_trips
           SET status = 'DELIVERED',
               delivered_at = COALESCE(delivered_at, NOW()),
               otp_verified = TRUE,
               cod_due_amount = $1,
               cod_collected_amount = $1,
               cod_reconciled = FALSE,
               updated_at = NOW()
           WHERE id = $2`,
          [authoritativeCodAmount, trip.id]
        );

        await client.query(
          `UPDATE orders
           SET status = 'delivered',
               delivered_at = COALESCE(delivered_at, NOW()),
               payment_status = CASE WHEN $2 = TRUE THEN 'PAID' ELSE payment_status END,
               updated_at = NOW()
           WHERE id = $1`,
          [order.id, isCodOrder]
        );

        await client.query(
          `UPDATE dispatch_assignments
           SET status = 'COMPLETED', updated_at = NOW()
           WHERE order_id = $1 AND status IN ('CREATED', 'OFFERED', 'ACCEPTED')`,
          [order.id]
        );

        // Execute authoritative financial allocation atomically inside the SAME database transaction
        const allocation = await settlementAllocationService.allocateFulfilledOrder(order.id, client);

        // Sync withholding & total payout back onto delivery_trips to keep operational record aligned
        await client.query(
          `UPDATE delivery_trips
           SET rider_withholding_amount = $1,
               total_rider_payout = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [allocation.riderTdsAmount, allocation.netRiderPayable, trip.id]
        );

        // Conditional post-delivery rider state reset (never clears SUSPENDED; preserves busy status if active trips remain)
        let resultingRiderStatus = 'IDLE_AT_HUB';
        let authoritativeWalletBalance = allocation.netRiderPayable;
        let authoritativeFloatingCashBalance = 0;
        let completedDeliveriesToday = 1;

        if (trip.rider_id) {
          const riderStateRes = await client.query(
            `SELECT id, status, wallet_balance, floating_cash_balance
             FROM riders
             WHERE id = $1
             FOR UPDATE`,
            [trip.rider_id]
          );

          const riderRow = riderStateRes.rows[0];
          resultingRiderStatus = riderRow.status;
          authoritativeWalletBalance = Number(roundCurrency(riderRow.wallet_balance || '0'));
          authoritativeFloatingCashBalance = Number(roundCurrency(riderRow.floating_cash_balance || '0'));

          if (riderRow.status !== 'SUSPENDED') {
            const otherActiveTripsRes = await client.query(
              `SELECT id FROM delivery_trips
               WHERE rider_id = $1 AND id != $2 AND status IN ('ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP')
               LIMIT 1`,
              [trip.rider_id, trip.id]
            );
            const otherActiveAssignRes = await client.query(
              `SELECT id FROM dispatch_assignments
               WHERE rider_id = $1 AND order_id != $2 AND status IN ('ACCEPTED')
               LIMIT 1`,
              [trip.rider_id, order.id]
            );

            if (otherActiveTripsRes.rows.length === 0 && otherActiveAssignRes.rows.length === 0) {
              await client.query(
                `UPDATE riders SET status = 'IDLE_AT_HUB', updated_at = NOW() WHERE id = $1 AND status != 'SUSPENDED'`,
                [trip.rider_id]
              );
              resultingRiderStatus = 'IDLE_AT_HUB';
              shouldClearRedisLocationRiderId = trip.rider_id;
            }
          }

          const dCountRes = await client.query(
            `SELECT COUNT(*) AS cnt FROM delivery_trips WHERE rider_id = $1 AND status = 'DELIVERED'`,
            [trip.rider_id]
          );
          completedDeliveriesToday = Math.max(1, parseInt(dCountRes.rows[0]?.cnt || '1', 10));
        }

        const basePay = Number(roundCurrency(trip.base_fare ?? '0'));
        const distPay = Number(roundCurrency(trip.distance_fare ?? '0'));
        const surgePay = Number(roundCurrency(add(trip.surge_fare ?? '0', trip.wait_time_compensation ?? '0')));
        const tips = allocation.customerTip;
        const tds = allocation.riderTdsAmount;
        const totalCredited = allocation.netRiderPayable;

        return {
          success: true,
          taskId: trip.id,
          orderId: order.id,
          orderStatus: 'DELIVERED',
          codCollectedAmount: isCodOrder ? allocation.orderTotal : 0,
          creditedPayout: {
            basePay,
            distancePay: distPay,
            surgeBonus: surgePay,
            tips,
            tdsDeducted: tds,
            totalCredited,
          },
          walletSummary: {
            todayTotalEarnings: totalCredited,
            withdrawableBalance: authoritativeWalletBalance,
            floatingCashBalance: authoritativeFloatingCashBalance,
            completedDeliveriesToday,
          },
          riderStatus: resultingRiderStatus,
          allocationId: allocation.id,
          journalBatchId: allocation.journalBatchId,
        };
      });

      // Post-commit side effects
      if (shouldClearRedisLocationRiderId) {
        await liveLocationService.clearRiderLocation(shouldClearRedisLocationRiderId).catch(() => {});
      }

      if (tamperedCodAudit) {
        await recordAuditEvent({
          actorId: params.actor.actorUserId,
          actorType: 'RIDER',
          action: 'TAMPERED_CLIENT_COD_IGNORED',
          entityType: 'DELIVERY_TRIP',
          entityId: (tamperedCodAudit as any).tripId,
          newState: tamperedCodAudit,
          ipAddress: params.actor.ipAddress,
        });
      }

      await recordAuditEvent({
        actorId: params.actor.actorUserId,
        actorType: params.actor.isDispatchAdmin ? 'ADMIN' : 'RIDER',
        action: 'DELIVERY_OTP_VERIFIED',
        entityType: 'DELIVERY_TRIP',
        entityId: completionResult.taskId,
        newState: {
          orderId: completionResult.orderId,
          codCollectedAmount: completionResult.codCollectedAmount,
          allocationId: completionResult.allocationId,
          journalBatchId: completionResult.journalBatchId,
        },
        ipAddress: params.actor.ipAddress,
      });

      return completionResult;
    } catch (err) {
      if (crossRiderAudit) {
        await recordAuditEvent({
          actorId: params.actor.actorUserId,
          actorType: 'RIDER',
          action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
          entityType: 'DELIVERY_TRIP',
          entityId: (crossRiderAudit as any).tripId,
          newState: {
            assignedRiderId: (crossRiderAudit as any).assignedRiderId,
            callerRiderId: (crossRiderAudit as any).callerRiderId,
            action: 'verify-otp',
          },
          ipAddress: params.actor.ipAddress,
        });
      }
      if (failedOtpAudit) {
        // Persist OTP failed attempt increment outside the rolled-back transaction so retry limits stick
        await pool
          .query(
            `UPDATE delivery_trips SET otp_failed_attempts = COALESCE(otp_failed_attempts, 0) + 1, updated_at = NOW() WHERE id = $1`,
            [(failedOtpAudit as any).tripId]
          )
          .catch(() => {});
        await recordAuditEvent({
          actorId: params.actor.actorUserId,
          actorType: 'RIDER',
          action: 'DELIVERY_OTP_FAILED',
          entityType: 'DELIVERY_TRIP',
          entityId: (failedOtpAudit as any).tripId,
          newState: { orderId: (failedOtpAudit as any).orderId, attempts: (failedOtpAudit as any).attempts },
          ipAddress: params.actor.ipAddress,
        });
      }
      throw err;
    }
  }
}

export const deliveryCompletionService = new DeliveryCompletionService();
export { ACTIVE_TRIP_STATUSES };
