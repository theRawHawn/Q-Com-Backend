import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { 
  requireAuth, 
  sanitizeString, 
  isValidGstin, 
  createRateLimiter 
} from '../security';
import { authoritativeUserStore } from '../store';
import { SavedGstinRecord } from '../../src/types';

const router = Router();

const profileLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: 'rl:prof'
});

// 1. Get Customer Profile
router.get('/', requireAuth, profileLimiter, (req: Request, res: Response) => {
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'USER_NOT_FOUND',
      message: 'User profile not found.'
    });
  }

  res.json({
    success: true,
    profile: user.profile
  });
});

// 2. Update Customer Profile
router.put('/', requireAuth, profileLimiter, (req: Request, res: Response) => {
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'USER_NOT_FOUND',
      message: 'User profile not found.'
    });
  }

  const { name, email, defaultAddress, floorUnit, landmark, accountType } = req.body;

  const updates: any = {};
  if (name !== undefined) updates.name = sanitizeString(name, 60);
  if (email !== undefined) {
    const cleanEmail = sanitizeString(email, 100);
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Invalid email address format.' });
    }
    updates.email = cleanEmail;
  }
  if (defaultAddress !== undefined) updates.defaultAddress = sanitizeString(defaultAddress, 300);
  if (floorUnit !== undefined) updates.floorUnit = sanitizeString(floorUnit, 100);
  if (landmark !== undefined) updates.landmark = sanitizeString(landmark, 150);
  if (accountType === 'business' || accountType === 'individual') updates.accountType = accountType;

  const updatedUser = authoritativeUserStore.updateUserProfile(userId, updates);

  res.json({
    success: true,
    message: 'Profile updated successfully.',
    profile: updatedUser?.profile
  });
});

// 3. Add or Update Saved GSTIN
router.post('/saved-gstin', requireAuth, profileLimiter, (req: Request, res: Response) => {
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!user) {
    return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found.' });
  }

  const { gstin, legalBusinessName, tradeName, billingAddress, state, stateCode, isDefault } = req.body;

  const cleanGstin = typeof gstin === 'string' ? gstin.trim().toUpperCase() : '';
  if (!isValidGstin(cleanGstin)) {
    return res.status(400).json({
      error: 'INVALID_GSTIN_FORMAT',
      message: 'GSTIN must be 15 alphanumeric characters (e.g. 29AABCP1429B1Z8).'
    });
  }

  const cleanBusinessName = sanitizeString(legalBusinessName || 'Apex Infra LLP', 120);
  const cleanTradeName = sanitizeString(tradeName || cleanBusinessName, 120);
  const cleanBillingAddress = sanitizeString(billingAddress || user.profile.defaultAddress || '', 300);
  const cleanState = sanitizeString(state || 'Karnataka', 50);
  const cleanStateCode = sanitizeString(stateCode || cleanGstin.substring(0, 2), 2);

  const gstProfile = user.profile.gstProfile || {
    isB2BEnabled: true,
    gstin: cleanGstin,
    legalBusinessName: cleanBusinessName,
    savedGstins: []
  };

  const existingList: SavedGstinRecord[] = gstProfile.savedGstins || [];
  const gstinId = `gstin_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

  const newGstinRecord: SavedGstinRecord = {
    id: gstinId,
    gstin: cleanGstin,
    legalBusinessName: cleanBusinessName,
    tradeName: cleanTradeName,
    billingAddress: cleanBillingAddress,
    state: cleanState,
    stateCode: cleanStateCode,
    isDefault: Boolean(isDefault),
    createdAt: new Date().toISOString().split('T')[0]
  };

  let updatedList: SavedGstinRecord[];
  if (isDefault) {
    updatedList = existingList.map(g => ({ ...g, isDefault: false }));
    updatedList.push(newGstinRecord);
  } else {
    updatedList = [...existingList, newGstinRecord];
  }

  const updatedGstProfile = {
    ...gstProfile,
    isB2BEnabled: true,
    gstin: isDefault ? cleanGstin : (gstProfile.gstin || cleanGstin),
    legalBusinessName: isDefault ? cleanBusinessName : (gstProfile.legalBusinessName || cleanBusinessName),
    billingAddress: cleanBillingAddress,
    state: cleanState,
    stateCode: cleanStateCode,
    savedGstins: updatedList
  };

  authoritativeUserStore.updateUserProfile(userId, { gstProfile: updatedGstProfile });

  res.json({
    success: true,
    message: 'Business GSTIN added successfully.',
    savedGstin: newGstinRecord,
    allSavedGstins: updatedList
  });
});

export default router;
