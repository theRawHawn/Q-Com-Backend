import { Router, Request, Response } from 'express';
import { customerService } from '../modules/customers/customerService.js';
import { authenticate } from '../middleware/auth.js';

export const customerRouter = Router();

/**
 * GET /api/profile & GET /api/v1/profile
 * Retrieves customer profile and saved GSTINs
 */
customerRouter.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await customerService.getProfile(req.auth!.userId);
    if (!profile) {
      res.status(404).json({ success: false, error: 'PROFILE_NOT_FOUND', message: 'Customer profile not found.' });
      return;
    }
    res.status(200).json({
      success: true,
      profile,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PROFILE_FETCH_FAILED',
      message: err.message || 'Failed to retrieve profile.',
    });
  }
});

/**
 * PUT /api/profile & PUT /api/v1/profile
 * Updates customer profile details
 */
customerRouter.put('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, accountType, defaultAddress, floorUnit, landmark, jobTag } = req.body;
    const updated = await customerService.updateProfile(req.auth!.userId, {
      name,
      email,
      accountType,
      defaultAddress,
      floorUnit,
      landmark,
      jobTag,
    });

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
      profile: updated,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: 'PROFILE_UPDATE_FAILED',
      message: err.message || 'Failed to update profile.',
    });
  }
});

/**
 * POST /api/profile/saved-gstin & POST /api/v1/profile/saved-gstin
 * Saves or updates a statutory business GSTIN for the customer
 */
customerRouter.post('/saved-gstin', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { gstin, legalBusinessName, tradeName, billingAddress, state, stateCode, pincode, isDefault } = req.body;

    if (!gstin || !legalBusinessName || !billingAddress || !state || !stateCode) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'gstin, legalBusinessName, billingAddress, state, and stateCode are mandatory statutory fields.',
      });
      return;
    }

    const result = await customerService.addSavedGstin(req.auth!.userId, {
      gstin,
      legalBusinessName,
      tradeName,
      billingAddress,
      state,
      stateCode,
      pincode,
      isDefault,
    });

    res.status(200).json({
      success: true,
      message: 'Business GSTIN registered successfully.',
      savedGstin: result.savedGstin,
      allSavedGstins: result.allSavedGstins,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: 'GSTIN_SAVE_FAILED',
      message: err.message || 'Failed to register business GSTIN.',
    });
  }
});
