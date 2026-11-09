import { Router, Request, Response } from 'express';
import { fulfilmentSelectionService } from '../modules/delivery/fulfilmentSelectionService.js';

export const deliveryRouter = Router();

/**
 * POST /api/orders/delivery-economics/evaluate & POST /api/v1/delivery/economics/evaluate
 */
deliveryRouter.post('/economics/evaluate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { deliveryCoordinates, cartItems, cartTotal, platformCouponDiscount } = req.body;

    if (!deliveryCoordinates) {
      res.status(400).json({
        success: false,
        error: 'MISSING_COORDINATES',
        message: 'deliveryCoordinates with latitude and longitude are required.',
      });
      return;
    }

    const evaluation = await fulfilmentSelectionService.evaluateFulfilment({
      customerLocation: deliveryCoordinates,
      cartItems: cartItems || [],
      cartTotal: cartTotal || 500,
      platformCouponDiscount,
    });

    res.status(200).json({
      success: true,
      evaluation,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'EVALUATION_FAILED',
      message: err.message || 'Failed to evaluate delivery economics.',
    });
  }
});
