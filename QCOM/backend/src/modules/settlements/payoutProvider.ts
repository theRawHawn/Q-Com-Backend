import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface PayoutDisbursementResult {
  success: boolean;
  providerPayoutId: string;
  utrNumber: string;
  status: 'PROCESSED' | 'QUEUED' | 'REJECTED';
  failureReason?: string;
}

export interface PayoutProvider {
  name: string;
  disburseMerchantPayout(params: {
    merchantId: string;
    amount: number;
    accountNumber: string;
    ifsc: string;
    accountHolder?: string;
    reference: string;
  }): Promise<PayoutDisbursementResult>;

  disburseRiderPayout(params: {
    riderId: string;
    amount: number;
    method: 'UPI' | 'BANK';
    vpa?: string;
    accountNumber?: string;
    ifsc?: string;
    reference: string;
  }): Promise<PayoutDisbursementResult>;
}

export class MockPayoutProvider implements PayoutProvider {
  public readonly name = 'MOCK_PAYOUT_PROVIDER';

  constructor() {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] MockPayoutProvider cannot be initialized in production environment. Genuine banking payout rail (RazorpayX / Cashfree / IMPS) must be integrated.'
      );
    }
  }

  public async disburseMerchantPayout(params: {
    merchantId: string;
    amount: number;
    accountNumber: string;
    ifsc: string;
    accountHolder?: string;
    reference: string;
  }): Promise<PayoutDisbursementResult> {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Production merchant payout execution refused: Live banking payout rail is not configured.'
      );
    }

    // Validate basic bank details
    if (!params.accountNumber || !params.ifsc) {
      return {
        success: false,
        providerPayoutId: `pout_fail_${crypto.randomBytes(6).toString('hex')}`,
        utrNumber: '',
        status: 'REJECTED',
        failureReason: 'INVALID_BANK_CREDENTIALS',
      };
    }

    const utrNumber = `UTR_MERCH_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerPayoutId = `pout_merch_${crypto.randomBytes(8).toString('hex')}`;

    return {
      success: true,
      providerPayoutId,
      utrNumber,
      status: 'PROCESSED',
    };
  }

  public async disburseRiderPayout(params: {
    riderId: string;
    amount: number;
    method: 'UPI' | 'BANK';
    vpa?: string;
    accountNumber?: string;
    ifsc?: string;
    reference: string;
  }): Promise<PayoutDisbursementResult> {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Production delivery partner payout execution refused: Live banking payout rail is not configured.'
      );
    }

    if (params.method === 'UPI' && !params.vpa) {
      return {
        success: false,
        providerPayoutId: `pout_fail_${crypto.randomBytes(6).toString('hex')}`,
        utrNumber: '',
        status: 'REJECTED',
        failureReason: 'MISSING_UPI_VPA',
      };
    }

    const utrNumber = `UTR_RIDER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerPayoutId = `pout_rider_${crypto.randomBytes(8).toString('hex')}`;

    return {
      success: true,
      providerPayoutId,
      utrNumber,
      status: 'PROCESSED',
    };
  }
}

export function getPayoutProvider(): PayoutProvider {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[Provider Security Exception] No genuine production payout provider is configured. Production launch remains blocked for banking disbursements.'
    );
  }
  return new MockPayoutProvider();
}
