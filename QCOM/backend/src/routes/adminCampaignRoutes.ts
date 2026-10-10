import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.js';
import { campaignService } from '../modules/notifications/campaignService.js';

export const adminCampaignRouter = Router();

function requireCampaignAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
    return;
  }

  const isAuthorized =
    req.auth.isSuperAdmin ||
    req.auth.roles.includes('SUPER_ADMIN') ||
    req.auth.roles.includes('OPERATIONS') ||
    req.auth.roles.includes('MARKETING_ADMIN') ||
    req.auth.permissions.includes('notifications.manage');

  if (!isAuthorized) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN_ROLE',
      message: 'Access forbidden: Administrator privileges required to manage push campaigns.',
    });
    return;
  }

  next();
}

/**
 * POST /api/v1/admin/notifications/campaigns
 * Creates a new draft campaign.
 */
adminCampaignRouter.post('/campaigns', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name,
      title,
      body,
      imageUrl,
      deepLink,
      audienceType,
      audienceDefinition,
      scheduledAt,
      expiresAt,
      priority,
      frequencyPolicy,
      dedupeKey,
      campaignType,
      algorithmMetadata,
    } = req.body;

    if (!name || !title || !body || !audienceType) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'name, title, body, and audienceType are required.',
      });
      return;
    }

    const campaign = await campaignService.createCampaign(req.auth!.userId, {
      name,
      title,
      body,
      imageUrl,
      deepLink,
      audienceType,
      audienceDefinition,
      scheduledAt,
      expiresAt,
      priority,
      frequencyPolicy,
      dedupeKey,
      campaignType,
      algorithmMetadata,
    });

    res.status(201).json({
      success: true,
      message: 'Campaign created in DRAFT state.',
      campaign,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: 'CAMPAIGN_CREATE_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/admin/notifications/campaigns
 * Lists all campaigns.
 */
adminCampaignRouter.get('/campaigns', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query.status as any;
    const campaigns = await campaignService.listCampaigns(status);
    res.status(200).json({
      success: true,
      campaigns,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'LIST_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/admin/notifications/campaigns/:id
 * Retrieves a campaign by ID.
 */
adminCampaignRouter.get('/campaigns/:id', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const campaign = await campaignService.getCampaignById(req.params.id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });
      return;
    }
    res.status(200).json({ success: true, campaign });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * PATCH /api/v1/admin/notifications/campaigns/:id
 * Updates draft campaign.
 */
adminCampaignRouter.patch('/campaigns/:id', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const campaign = await campaignService.updateCampaign(req.params.id, req.body);
    res.status(200).json({ success: true, message: 'Campaign updated.', campaign });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'UPDATE_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/admin/notifications/campaigns/:id/test
 * Sends a controlled test push to authorized test devices.
 */
adminCampaignRouter.post('/campaigns/:id/test', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const testUserId = req.body?.testUserId || req.auth!.userId;
    const result = await campaignService.testSend(req.params.id, testUserId);
    res.status(200).json({
      success: true,
      message: 'Test notification dispatched.',
      testUserId,
      deliveryResult: result.deliveryResult,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'TEST_SEND_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/admin/notifications/campaigns/:id/schedule
 * Schedules campaign.
 */
adminCampaignRouter.post('/campaigns/:id/schedule', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : new Date(Date.now() + 3600000);
    const campaign = await campaignService.scheduleCampaign(req.params.id, scheduledAt);
    res.status(200).json({ success: true, message: 'Campaign scheduled.', campaign });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'SCHEDULE_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/admin/notifications/campaigns/:id/cancel
 * Cancels campaign.
 */
adminCampaignRouter.post('/campaigns/:id/cancel', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const campaign = await campaignService.cancelCampaign(req.params.id);
    res.status(200).json({ success: true, message: 'Campaign cancelled.', campaign });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'CANCEL_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/admin/notifications/campaigns/:id/execute
 * Triggers batch audience delivery execution.
 */
adminCampaignRouter.post('/campaigns/:id/execute', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const analytics = await campaignService.executeCampaign(req.params.id);
    res.status(200).json({
      success: true,
      message: 'Campaign execution completed.',
      analytics,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'EXECUTION_FAILED', message: err.message });
  }
});

/**
 * GET /api/v1/admin/notifications/campaigns/:id/analytics
 * Retrieves campaign performance and metrics.
 */
adminCampaignRouter.get('/campaigns/:id/analytics', authenticate, requireCampaignAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const analytics = await campaignService.getCampaignAnalytics(req.params.id);
    res.status(200).json({ success: true, analytics });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'ANALYTICS_FAILED', message: err.message });
  }
});
