import { Router, Request, Response } from 'express';
import { routingService } from '../modules/routing/routingService.js';

export const routingRouter = Router();

/**
 * POST /api/routing/calculate & POST /api/v1/routing/calculate
 */
routingRouter.post('/calculate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sellerLocation, customerLocation, vehicleType } = req.body;
    if (!sellerLocation || !customerLocation) {
      res.status(400).json({
        success: false,
        error: 'MISSING_COORDINATES',
        message: 'sellerLocation and customerLocation with latitude/longitude are required.',
      });
      return;
    }

    const result = await routingService.calculateRoute(sellerLocation, customerLocation, vehicleType);
    res.status(200).json({
      success: true,
      selectedRoute: result.selectedRoute,
      alternativeRoutes: result.alternativeRoutes,
      sellerPickupEntrance: result.sellerPickupEntrance,
      customerDropoffEntrance: result.customerDropoffEntrance,
      summary: result.summary,
      cached: result.cached,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ROUTING_FAILED',
      message: err.message || 'Failed to calculate routing corridor.',
    });
  }
});

/**
 * POST /api/routing/reroute & POST /api/v1/routing/reroute
 */
routingRouter.post('/reroute', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, currentRiderLocation, destinationLocation } = req.body;
    if (!currentRiderLocation || !destinationLocation) {
      res.status(400).json({
        success: false,
        error: 'MISSING_COORDINATES',
        message: 'currentRiderLocation and destinationLocation are required.',
      });
      return;
    }

    const result = await routingService.rerouteCourier(orderId, currentRiderLocation, destinationLocation);
    res.status(200).json({
      success: true,
      message: 'Rider corridor dynamically recalculated on deviation.',
      recalculatedRoute: result.recalculatedRoute,
      summary: result.summary,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'REROUTE_FAILED',
      message: err.message || 'Failed to recalculate route.',
    });
  }
});

/**
 * POST /api/routing/entrance-correction & POST /api/v1/routing/entrance-correction
 */
routingRouter.post('/entrance-correction', async (req: Request, res: Response): Promise<void> => {
  try {
    const { locationType, originalCoords, accessibleEntranceCoords, notes } = req.body;
    if (!locationType || !originalCoords || !accessibleEntranceCoords) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'locationType, originalCoords, and accessibleEntranceCoords are required.',
      });
      return;
    }

    const locationKey = `${locationType}_${originalCoords.latitude.toFixed(5)}_${originalCoords.longitude.toFixed(5)}`;
    await routingService.saveEntranceCorrection({
      locationKey,
      locationType,
      originalCoords,
      accessibleEntranceCoords,
      notes,
    });

    res.status(200).json({
      success: true,
      message: 'Accessible loading entrance snapped and saved.',
      locationKey,
      accessibleEntranceCoords,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SAVE_FAILED',
      message: err.message || 'Failed to save entrance correction.',
    });
  }
});

/**
 * POST /api/routing/telemetry & POST /api/v1/routing/telemetry
 */
routingRouter.post('/telemetry', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, sellerId, riderId, originCoords, destinationCoords, plannedDistanceM, plannedDurationSec, actualDistanceM, actualDurationSec, deviationsCount } = req.body;

    if (!originCoords || !destinationCoords || !plannedDistanceM || !plannedDurationSec) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'originCoords, destinationCoords, plannedDistanceM, and plannedDurationSec are required.',
      });
      return;
    }

    const recordId = await routingService.recordTelemetry({
      orderId,
      sellerId,
      riderId,
      originCoords,
      destinationCoords,
      plannedDistanceM,
      plannedDurationSec,
      actualDistanceM,
      actualDurationSec,
      deviationsCount,
    });

    res.status(200).json({
      success: true,
      message: 'Telemetry trace logged successfully.',
      recordId,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'LOG_FAILED',
      message: err.message || 'Failed to record routing telemetry.',
    });
  }
});
