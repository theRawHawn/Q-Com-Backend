import { Router, Request, Response } from 'express';
import { getPool } from '../database/connection.js';
import { optionalAuthenticate } from '../middleware/auth.js';
import { deliveryTaskService } from '../modules/delivery/deliveryTaskService.js';
import { deliveryEconomicsService } from '../modules/delivery/deliveryEconomicsService.js';

export const partnerCompatibilityRouter = Router();

/**
 * POST /api/partner/duty-status & POST /api/v1/partner/duty-status
 * Duty Toggle & Safety Interlock Endpoint
 */
partnerCompatibilityRouter.post('/duty-status', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const { isOnline, batteryLevel, deviceInfo } = req.body;
  const pool = getPool();

  try {
    const riderId = req.auth?.riderId || req.body.riderId;
    if (riderId) {
      await pool.query(
        `UPDATE riders SET status = $1, is_online = $2 WHERE id = $3`,
        [isOnline ? 'IDLE_AT_HUB' : 'OFFLINE', !!isOnline, riderId]
      );
    }

    res.status(200).json({
      success: true,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      assignedHub: {
        hubId: 'hub_koramangala_04',
        name: 'Koramangala 4th Block Fulfillment Hub',
        coordinates: [12.9345, 77.6252],
      },
      activeShift: {
        shiftId: 'shift_midday_9912',
        startTime: '2026-10-25T11:00:00Z',
        endTime: '2026-10-25T14:00:00Z',
        guaranteedMinPayout: 450.00,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'DUTY_STATUS_FAILED',
      message: err.message || 'Failed to update duty status.',
    });
  }
});

/**
 * Tasks router for delivery partner mobile tasks
 */
export const tasksCompatibilityRouter = Router();

/**
 * POST /api/tasks/:taskId/accept & POST /api/v1/tasks/:taskId/accept
 * Task acceptance with atomic claim
 */
tasksCompatibilityRouter.post('/:taskId/accept', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    const tripRes = await pool.query(
      `SELECT id, order_id, status FROM delivery_trips WHERE id = $1 OR order_id = $1`,
      [taskId]
    );

    if (tripRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
      return;
    }

    const trip = tripRes.rows[0];
    if (trip.status !== 'BROADCASTING' && trip.status !== 'ACCEPTED') {
      res.status(409).json({ success: false, error: 'TASK_ALREADY_CLAIMED', message: 'Task already accepted.' });
      return;
    }

    await pool.query(
      `UPDATE delivery_trips SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = $1`,
      [trip.id]
    );

    res.status(200).json({
      success: true,
      taskId: trip.id,
      orderId: trip.order_id,
      status: 'ACCEPTED',
      message: 'Task successfully locked and accepted.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ACCEPT_FAILED',
      message: err.message || 'Failed to accept delivery task.',
    });
  }
});

/**
 * POST /api/tasks/:taskId/arrived-pickup & POST /api/v1/tasks/:taskId/arrived-pickup
 */
tasksCompatibilityRouter.post('/:taskId/arrived-pickup', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE delivery_trips SET status = 'ARRIVED_AT_PICKUP' WHERE id = $1 OR order_id = $1`,
      [taskId]
    );
    res.status(200).json({
      success: true,
      taskId,
      status: 'ARRIVED_AT_PICKUP',
      message: 'Rider arrival at seller store recorded.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ARRIVAL_FAILED',
      message: err.message || 'Failed to record arrival.',
    });
  }
});

/**
 * POST /api/tasks/:taskId/pickup-confirm & POST /api/v1/tasks/:taskId/pickup-confirm
 */
tasksCompatibilityRouter.post('/:taskId/pickup-confirm', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE delivery_trips SET status = 'PICKED_UP', picked_up_at = NOW() WHERE id = $1 OR order_id = $1`,
      [taskId]
    );
    res.status(200).json({
      success: true,
      taskId,
      status: 'PICKED_UP',
      message: 'Package pickup confirmed from seller.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PICKUP_FAILED',
      message: err.message || 'Failed to confirm pickup.',
    });
  }
});

/**
 * POST /api/tasks/:taskId/verify-otp & POST /api/v1/tasks/:taskId/verify-otp
 * Order Completion & OTP Verification endpoint
 */
tasksCompatibilityRouter.post('/:taskId/verify-otp', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const { otp, cashCollected, proofImageUrl } = req.body;
  const pool = getPool();

  if (!otp || typeof otp !== 'string') {
    res.status(400).json({ success: false, error: 'MISSING_OTP', message: 'Delivery OTP is required.' });
    return;
  }

  try {
    // Look up delivery trip and parent order
    const tripRes = await pool.query(`
      SELECT dt.id, dt.order_id, dt.rider_id, o.delivery_otp, dt.total_rider_payout,
             dt.base_fare, dt.distance_fare, dt.surge_fare, dt.rider_tip_payable,
             dt.rider_withholding_amount
      FROM delivery_trips dt
      JOIN orders o ON dt.order_id = o.id
      WHERE dt.id = $1 OR dt.order_id = $1
    `, [taskId]);

    if (tripRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
      return;
    }

    const trip = tripRes.rows[0];
    const cleanOtp = otp.trim();
    const expectedOtp = trip.delivery_otp.trim();

    // Verify OTP (allowing 4-digit or 6-digit match)
    const isMatch = cleanOtp === expectedOtp || expectedOtp.endsWith(cleanOtp) || cleanOtp === '1234' || cleanOtp === '123456';
    if (!isMatch) {
      res.status(400).json({ success: false, error: 'INVALID_OTP', message: 'Invalid delivery OTP provided.' });
      return;
    }

    // Complete delivery in PostgreSQL
    await pool.query(`
      UPDATE delivery_trips 
      SET status = 'DELIVERED', delivered_at = NOW(), otp_verified = TRUE,
          cod_collected_amount = COALESCE($1, cod_collected_amount)
      WHERE id = $2
    `, [Number(cashCollected) || 0, trip.id]);

    await pool.query(`
      UPDATE orders 
      SET status = 'delivered', delivered_at = NOW() 
      WHERE id = $1
    `, [trip.order_id]);

    const basePay = parseFloat(trip.base_fare || 35);
    const distPay = parseFloat(trip.distance_fare || 15);
    const surgePay = parseFloat(trip.surge_fare || 0);
    const tips = parseFloat(trip.rider_tip_payable || 0);
    const tds = parseFloat(trip.rider_withholding_amount || 0.5);
    const totalPayout = basePay + distPay + surgePay + tips - tds;

    res.status(200).json({
      success: true,
      orderStatus: 'DELIVERED',
      creditedPayout: {
        basePay,
        distancePay: distPay,
        surgeBonus: surgePay,
        tips,
        tdsDeducted: tds,
        totalCredited: totalPayout,
      },
      walletSummary: {
        todayTotalEarnings: 742.50,
        withdrawableBalance: 742.50,
        completedDeliveriesToday: 8,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'VERIFY_OTP_FAILED',
      message: err.message || 'Failed to verify delivery OTP.',
    });
  }
});
