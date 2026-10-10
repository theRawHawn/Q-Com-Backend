import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { deviceTokenService } from '../modules/notifications/deviceTokenService.js';
import { preferenceService } from '../modules/notifications/preferenceService.js';
import { notificationService } from '../modules/notifications/notificationService.js';
import { liveLocationService } from '../modules/realtime/liveLocationService.js';
import { realtimeGateway } from '../modules/realtime/websocketServer.js';

export const notificationRouter = Router();

/**
 * POST /api/v1/notifications/tokens
 * Registers an active device token for push notifications.
 */
notificationRouter.post('/tokens', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rawToken, platform, appVersion, metadata } = req.body;

    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'MISSING_TOKEN',
        message: 'A valid rawToken is required.',
      });
      return;
    }

    if (!platform || !['ANDROID', 'IOS', 'WEB'].includes(platform)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_PLATFORM',
        message: "Platform must be one of 'ANDROID', 'IOS', or 'WEB'.",
      });
      return;
    }

    const result = await deviceTokenService.registerToken({
      userId: req.auth!.userId,
      rawToken,
      platform,
      appVersion,
      deviceMetadataMinimal: metadata,
    });

    res.status(200).json({
      success: true,
      message: 'Device token registered successfully.',
      tokenId: result.id,
      rawTokenPreview: result.rawTokenPreview,
      isNew: result.isNew,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'REGISTRATION_FAILED',
      message: err.message || 'Failed to register device token.',
    });
  }
});

/**
 * DELETE /api/v1/notifications/tokens/:id
 * Deactivates a registered device token.
 */
notificationRouter.delete('/tokens/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const deactivated = await deviceTokenService.deactivateToken(id, req.auth!.userId);

    if (!deactivated) {
      res.status(404).json({
        success: false,
        error: 'TOKEN_NOT_FOUND',
        message: 'Device token not found or already deactivated.',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Device token deactivated successfully.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'DEACTIVATION_FAILED',
      message: err.message || 'Failed to deactivate device token.',
    });
  }
});

/**
 * GET /api/v1/notifications/preferences
 * Retrieves notification preferences and consent status.
 */
notificationRouter.get('/preferences', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const preferences = await preferenceService.getPreferences(req.auth!.userId);
    res.status(200).json({
      success: true,
      preferences,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PREFERENCES_FETCH_FAILED',
      message: err.message || 'Failed to retrieve notification preferences.',
    });
  }
});

/**
 * PUT /api/v1/notifications/preferences
 * Updates notification preferences and consent status.
 */
notificationRouter.put('/preferences', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { pushEnabled, transactionalEnabled, deliveryUpdatesEnabled, promotionalEnabled } = req.body;

    const preferences = await preferenceService.updatePreferences(req.auth!.userId, {
      pushEnabled: typeof pushEnabled === 'boolean' ? pushEnabled : undefined,
      transactionalEnabled: typeof transactionalEnabled === 'boolean' ? transactionalEnabled : undefined,
      deliveryUpdatesEnabled: typeof deliveryUpdatesEnabled === 'boolean' ? deliveryUpdatesEnabled : undefined,
      promotionalEnabled: typeof promotionalEnabled === 'boolean' ? promotionalEnabled : undefined,
    });

    res.status(200).json({
      success: true,
      message: 'Notification preferences updated successfully.',
      preferences,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PREFERENCES_UPDATE_FAILED',
      message: err.message || 'Failed to update notification preferences.',
    });
  }
});

/**
 * POST /api/v1/notifications/events
 * Records client interaction metrics (OPENED, CLICKED, DISMISSED) for analytics & future algorithm training.
 */
notificationRouter.post('/events', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { notificationId, eventType, campaignId, metadata } = req.body;

    if (!notificationId) {
      res.status(400).json({ success: false, error: 'MISSING_NOTIFICATION_ID' });
      return;
    }

    if (!['OPENED', 'CLICKED', 'DISMISSED'].includes(eventType)) {
      res.status(400).json({ success: false, error: 'INVALID_EVENT_TYPE' });
      return;
    }

    const metricId = await notificationService.recordInteractionMetric(
      req.auth!.userId,
      notificationId,
      eventType,
      campaignId,
      metadata
    );

    res.status(200).json({
      success: true,
      message: 'Notification metric recorded.',
      metricId,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'METRIC_RECORD_FAILED',
      message: err.message,
    });
  }
});

/**
 * POST /api/v1/notifications/telemetry/location
 * HTTP ingest endpoint for rider live GPS updates with velocity anti-spoofing.
 */
notificationRouter.post('/telemetry/location', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth?.riderId) {
      res.status(403).json({
        success: false,
        error: 'RIDER_REQUIRED',
        message: 'Only registered delivery partners can upload live location telemetry.',
      });
      return;
    }

    const { latitude, longitude, heading, speed, timestamp } = req.body;

    const result = await liveLocationService.ingestRiderLocation(
      {
        riderId: req.auth.riderId,
        latitude,
        longitude,
        heading,
        speed,
        timestamp: timestamp || Date.now(),
      },
      (room, payload) => realtimeGateway.broadcastToRoom(room, payload)
    );

    if (!result.success) {
      const isSanityFailed = result.error?.includes('GPS_VELOCITY_CHECK_FAILED');
      const isStale = result.error?.includes('STALE_GPS_TIMESTAMP');
      res.status(isSanityFailed ? 422 : isStale ? 409 : 400).json({
        success: false,
        error: isSanityFailed ? 'GPS_VELOCITY_CHECK_FAILED' : isStale ? 'STALE_GPS_TIMESTAMP' : 'LOCATION_INGEST_FAILED',
        message: result.error,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Live location ingested successfully.',
      orderId: result.orderId,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'TELEMETRY_FAILED',
      message: err.message,
    });
  }
});
