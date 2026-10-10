import { env } from '../../config/env.js';

export interface OtpSendResult {
  success: boolean;
  provider: string;
  messageId?: string;
  debugOtp?: string; // Only populated in development/test
}

export interface IOtpProvider {
  sendOtp(phone: string, otp: string, purpose: string): Promise<OtpSendResult>;
}

/**
 * Development & Test Mock OTP Provider.
 * Safely retains generated OTPs in memory for automated test validation.
 */
export class MockOtpProvider implements IOtpProvider {
  private sentOtps: Map<string, { otp: string; purpose: string; timestamp: number }> = new Map();

  constructor() {
    if (env.NODE_ENV === 'production') {
      throw new Error('[Security Exception] MockOtpProvider cannot be initialized in production environment.');
    }
  }

  async sendOtp(phone: string, otp: string, purpose: string): Promise<OtpSendResult> {
    const key = `${phone.trim()}:${purpose.toUpperCase()}`;
    this.sentOtps.set(key, { otp, purpose, timestamp: Date.now() });

    // In non-production, log sanitized debug information
    if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
      console.log(`[MockOtpProvider] Generated mock OTP for ${phone.slice(0, 6)}**** (${purpose}): ${otp}`);
    }

    return {
      success: true,
      provider: 'mock-otp-gateway',
      messageId: `mock-msg-${Date.now()}`,
      debugOtp: env.NODE_ENV !== 'production' ? otp : undefined,
    };
  }

  getLastOtp(phone: string, purpose: string): string | undefined {
    return this.sentOtps.get(`${phone.trim()}:${purpose.toUpperCase()}`)?.otp;
  }

  clear(): void {
    this.sentOtps.clear();
  }
}

/**
 * Production SMS Provider for Telephony Gateway (Exotel/Twilio)
 * Fails closed if live provider integration is missing in production.
 */
export class ProductionSmsProvider implements IOtpProvider {
  constructor() {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Genuine live telephony SMS provider (Twilio / Exotel / AWS SNS) is not integrated. Mock OTP delivery is strictly prohibited in production.'
      );
    }
  }

  async sendOtp(phone: string, otp: string, purpose: string): Promise<OtpSendResult> {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Cannot dispatch SMS: Live telephony provider is not configured. Production launch remains blocked.'
      );
    }

    // In development / non-production sandbox mode
    return {
      success: true,
      provider: env.TELEPHONY_MODE,
      messageId: `telephony-${Date.now()}`,
    };
  }
}

export function createOtpProvider(): IOtpProvider {
  if (env.NODE_ENV === 'production' || env.TELEPHONY_MODE !== 'mock') {
    return new ProductionSmsProvider();
  }
  return new MockOtpProvider();
}

export const defaultOtpProvider = createOtpProvider();
