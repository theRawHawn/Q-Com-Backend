import { Router, Request, Response } from 'express';
import { aiService } from '../modules/ai/aiService.js';

export const aiRouter = Router();

/**
 * POST /api/part-finder & POST /api/v1/ai/part-finder
 */
aiRouter.post('/part-finder', async (req: Request, res: Response): Promise<void> => {
  try {
    const { prompt, tradeType } = req.body;
    const result = await aiService.findPart({ prompt, tradeType });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'AI_SEARCH_FAILED',
      message: err.message || 'Failed to match technical part.',
    });
  }
});

/**
 * POST /api/emergency-kit-planner & POST /api/v1/ai/emergency-kit-planner
 */
aiRouter.post('/emergency-kit-planner', async (req: Request, res: Response): Promise<void> => {
  try {
    const { emergencyDescription, trade } = req.body;
    const result = await aiService.planEmergencyKit(emergencyDescription, trade);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PLANNER_FAILED',
      message: err.message || 'Failed to formulate emergency kit.',
    });
  }
});
