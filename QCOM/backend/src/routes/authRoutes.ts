import { Router, Request, Response } from 'express';
import { authService } from '../modules/auth/authService.js';
import { authenticate } from '../middleware/auth.js';
import { authRateLimiter, otpRateLimiter } from '../middleware/rateLimiter.js';

export const authRouter = Router();

/**
 * POST /auth/otp/request & POST /auth/request-otp
 * Dispatches an OTP to the given phone number with rate limiting
 */
const handleOtpRequest = async (req: Request, res: Response): Promise<void> => {
  const { phone, purpose } = req.body;
  if (!phone || typeof phone !== 'string') {
    res.status(400).json({ success: false, error: 'MISSING_PHONE', message: 'Valid phone number is required.' });
    return;
  }

  try {
    const result = await authService.requestOtp(
      phone,
      purpose || 'LOGIN',
      req.ip
    );
    res.status(200).json({
      success: true,
      message: 'OTP sent successfully.',
      resendAvailableAt: result.resendAvailableAt,
      ...(process.env.NODE_ENV !== 'production' && result.debugOtp ? { debugOtp: result.debugOtp } : {}),
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: 'OTP_REQUEST_FAILED',
      message: err.message || 'Failed to request OTP.',
    });
  }
};

authRouter.post('/otp/request', otpRateLimiter, handleOtpRequest);
authRouter.post('/request-otp', otpRateLimiter, handleOtpRequest);

/**
 * POST /auth/otp/verify & POST /auth/verify-otp
 * Verifies OTP and issues short-lived access JWT + rotating refresh token
 */
const handleOtpVerify = async (req: Request, res: Response): Promise<void> => {
  const { phone, otp, purpose, name } = req.body;
  if (!phone || !otp) {
    res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'Phone and OTP are required.' });
    return;
  }

  // Mass-assignment defense: Prevent client from injecting privilege escalation fields
  const safeName = typeof name === 'string' ? name.slice(0, 100) : undefined;

  try {
    const result = await authService.verifyOtp(
      phone,
      otp,
      purpose || 'LOGIN',
      req.ip,
      req.headers['user-agent'],
      safeName
    );

    res.status(200).json({
      success: true,
      message: 'Authentication successful.',
      token: result.accessToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: {
        ...result.user,
        accountType: (result.user as any).accountType || 'individual',
        profile: {
          name: result.user.name || '',
          email: result.user.email || '',
          phone: result.user.phone || '',
          accountType: (result.user as any).accountType || 'individual',
        },
      },
      session: result.session,
    });
  } catch (err: any) {
    const isSuspended = err.message.toLowerCase().includes('suspended');
    const isLockout = err.message.toLowerCase().includes('locked out') || err.message.toLowerCase().includes('exceeded');
    const status = isSuspended ? 403 : isLockout ? 429 : 400;

    res.status(status).json({
      success: false,
      error: isSuspended ? 'ACCOUNT_SUSPENDED' : isLockout ? 'RATE_LIMIT_EXCEEDED' : 'VERIFICATION_FAILED',
      message: err.message || 'OTP verification failed.',
    });
  }
};

authRouter.post('/otp/verify', authRateLimiter, handleOtpVerify);
authRouter.post('/verify-otp', authRateLimiter, handleOtpVerify);

/**
 * POST /auth/refresh
 * Rotates refresh token and issues a new access JWT
 */
authRouter.post('/refresh', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ success: false, error: 'MISSING_REFRESH_TOKEN', message: 'Refresh token is required.' });
    return;
  }

  try {
    const result = await authService.refreshTokens(
      refreshToken,
      req.ip,
      req.headers['user-agent']
    );

    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully.',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err: any) {
    res.status(401).json({
      success: false,
      error: 'REFRESH_FAILED',
      message: err.message || 'Failed to refresh token.',
    });
  }
});

/**
 * POST /auth/logout
 * Terminates active session and revokes token family
 */
authRouter.post('/logout', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    await authService.logout(
      req.auth!.sessionId,
      req.auth!.userId,
      req.ip,
      req.headers['user-agent']
    );

    res.status(200).json({
      success: true,
      message: 'Successfully logged out and session revoked.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'LOGOUT_FAILED',
      message: err.message || 'Failed to terminate session.',
    });
  }
});

/**
 * POST /auth/logout-all
 * Terminates all active sessions and revokes all refresh tokens for the authenticated user
 */
authRouter.post('/logout-all', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await authService.logoutAll(
      req.auth!.userId,
      req.ip,
      req.headers['user-agent']
    );

    res.status(200).json({
      success: true,
      message: 'Successfully logged out of all devices and all sessions revoked.',
      revokedSessionsCount: result.revokedSessionsCount,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'LOGOUT_ALL_FAILED',
      message: err.message || 'Failed to terminate all sessions.',
    });
  }
});

/**
 * GET /auth/me & GET /profile
 * Authoritative user profile, role, permissions, and tenant scope endpoint
 */
const handleGetMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const userContext = await authService.getMe(req.auth!.userId);
    if (!userContext) {
      res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'User profile not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      user: {
        id: userContext.userId,
        phone: userContext.phone,
        name: userContext.name,
        email: userContext.email,
        accountType: userContext.accountType,
        roles: userContext.roles,
        permissions: userContext.permissions,
        merchantIds: userContext.merchantIds,
        storeIds: userContext.storeIds,
        riderId: userContext.riderId,
        isSuperAdmin: userContext.isSuperAdmin,
      },
      session: {
        id: req.auth!.sessionId,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to retrieve profile.',
    });
  }
};

authRouter.get('/me', authenticate, handleGetMe);

/**
 * POST /admin/auth/login & POST /admin/auth/session
 * Authenticates admin operations staff and establishes secure admin session
 */
export const adminAuthRouter = Router();

const handleAdminLogin = async (req: Request, res: Response): Promise<void> => {
  const { employeeCode, pin, password } = req.body;
  if (!employeeCode) {
    res.status(400).json({ success: false, error: 'MISSING_CREDENTIALS', message: 'Employee code is required.' });
    return;
  }

  try {
    const result = await authService.adminLogin(
      employeeCode,
      pin || password,
      req.ip,
      req.headers['user-agent']
    );

    res.status(200).json({
      success: true,
      message: 'Admin session established.',
      sessionToken: result.accessToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      employee: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        roles: result.user.roles,
      },
      session: result.session,
    });
  } catch (err: any) {
    res.status(401).json({
      success: false,
      error: 'ADMIN_AUTH_FAILED',
      message: err.message || 'Admin authentication failed.',
    });
  }
};

adminAuthRouter.post('/login', authRateLimiter, handleAdminLogin);
adminAuthRouter.post('/session', authRateLimiter, handleAdminLogin);

/**
 * POST /auth/admin/set-password & POST /auth/admin/change-password
 * Sets or updates admin password, validates strength, and revokes active sessions.
 */
adminAuthRouter.post('/set-password', authenticate, authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { newPassword } = req.body;
  if (!newPassword) {
    res.status(400).json({ success: false, error: 'MISSING_PASSWORD', message: 'New password is required.' });
    return;
  }
  try {
    const result = await authService.adminSetPassword(req.auth!.userId, newPassword);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'PASSWORD_UPDATE_FAILED', message: err.message || 'Failed to update password.' });
  }
});
adminAuthRouter.post('/change-password', authenticate, authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { newPassword } = req.body;
  if (!newPassword) {
    res.status(400).json({ success: false, error: 'MISSING_PASSWORD', message: 'New password is required.' });
    return;
  }
  try {
    const result = await authService.adminSetPassword(req.auth!.userId, newPassword);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'PASSWORD_UPDATE_FAILED', message: err.message || 'Failed to update password.' });
  }
});

// Also mount adminAuthRouter on authRouter for /api/auth/admin/* compatibility
authRouter.use('/admin', adminAuthRouter);
