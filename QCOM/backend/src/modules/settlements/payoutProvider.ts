import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface PayoutDisbursementResult {
  success: boolean;
  providerPayoutId: string;
  utrNumber: string;
  status: 'PROCESSED' | 'QUEUED' | 'REJECTED';
  failureReason?: string;
  reference?: string;
  amount?: number;
}

export interface PayoutStatusResult {
  success: boolean;
  status: 'PROCESSED' | 'QUEUED' | 'REJECTED';
  utrNumber?: string;
  providerPayoutId?: string;
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
    idempotencyKey?: string;
  }): Promise<PayoutDisbursementResult>;

  disburseRiderPayout(params: {
    riderId: string;
    amount: number;
    method: 'UPI' | 'BANK';
    vpa?: string;
    accountNumber?: string;
    ifsc?: string;
    reference: string;
    idempotencyKey?: string;
  }): Promise<PayoutDisbursementResult>;

  getPayoutStatus?(params: {
    reference?: string;
    providerPayoutId?: string;
  } | string): Promise<PayoutDisbursementResult | PayoutStatusResult>;

  getPayoutByIdempotencyKey?(idempotencyKey: string): Promise<PayoutDisbursementResult | null>;

  verifyWebhookSignature?(params: { rawBody: Buffer | string; signature: string }): boolean;
}

export class MockPayoutProvider implements PayoutProvider {
  public readonly name = 'MOCK_PAYOUT_PROVIDER';
  private payoutsByReference = new Map<string, PayoutDisbursementResult>();
  private payoutsById = new Map<string, PayoutDisbursementResult>();
  private payoutsByIdempotency = new Map<string, PayoutDisbursementResult>();

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
    idempotencyKey?: string;
  }): Promise<PayoutDisbursementResult> {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Production merchant payout execution refused: Live banking payout rail is not configured.'
      );
    }

    // Provider Idempotency check
    if (params.idempotencyKey && this.payoutsByIdempotency.has(params.idempotencyKey)) {
      return this.payoutsByIdempotency.get(params.idempotencyKey)!;
    }
    if (params.reference && this.payoutsByReference.has(params.reference)) {
      return this.payoutsByReference.get(params.reference)!;
    }

    // Validate basic bank details
    if (!params.accountNumber || !params.ifsc) {
      const failRes: PayoutDisbursementResult = {
        success: false,
        providerPayoutId: `pout_fail_${crypto.randomBytes(6).toString('hex')}`,
        utrNumber: '',
        status: 'REJECTED',
        failureReason: 'INVALID_BANK_CREDENTIALS',
        reference: params.reference,
        amount: params.amount,
      };
      if (params.idempotencyKey) this.payoutsByIdempotency.set(params.idempotencyKey, failRes);
      this.payoutsByReference.set(params.reference, failRes);
      return failRes;
    }

    const utrNumber = `UTR_MERCH_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerPayoutId = `pout_merch_${crypto.randomBytes(8).toString('hex')}`;

    const res: PayoutDisbursementResult = {
      success: true,
      providerPayoutId,
      utrNumber,
      status: 'PROCESSED',
      reference: params.reference,
      amount: params.amount,
    };

    if (params.idempotencyKey) {
      this.payoutsByIdempotency.set(params.idempotencyKey, res);
    }
    this.payoutsByReference.set(params.reference, res);
    this.payoutsById.set(providerPayoutId, res);

    return res;
  }

  public async disburseRiderPayout(params: {
    riderId: string;
    amount: number;
    method: 'UPI' | 'BANK';
    vpa?: string;
    accountNumber?: string;
    ifsc?: string;
    reference: string;
    idempotencyKey?: string;
  }): Promise<PayoutDisbursementResult> {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[Provider Security Exception] Production delivery partner payout execution refused: Live banking payout rail is not configured.'
      );
    }

    // Provider Idempotency check
    if (params.idempotencyKey && this.payoutsByIdempotency.has(params.idempotencyKey)) {
      return this.payoutsByIdempotency.get(params.idempotencyKey)!;
    }
    if (params.reference && this.payoutsByReference.has(params.reference)) {
      return this.payoutsByReference.get(params.reference)!;
    }

    if (params.method === 'UPI' && !params.vpa) {
      const failRes: PayoutDisbursementResult = {
        success: false,
        providerPayoutId: `pout_fail_${crypto.randomBytes(6).toString('hex')}`,
        utrNumber: '',
        status: 'REJECTED',
        failureReason: 'MISSING_UPI_VPA',
        reference: params.reference,
        amount: params.amount,
      };
      if (params.idempotencyKey) this.payoutsByIdempotency.set(params.idempotencyKey, failRes);
      this.payoutsByReference.set(params.reference, failRes);
      return failRes;
    }

    const utrNumber = `UTR_RIDER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerPayoutId = `pout_rider_${crypto.randomBytes(8).toString('hex')}`;

    const res: PayoutDisbursementResult = {
      success: true,
      providerPayoutId,
      utrNumber,
      status: 'PROCESSED',
      reference: params.reference,
      amount: params.amount,
    };

    if (params.idempotencyKey) {
      this.payoutsByIdempotency.set(params.idempotencyKey, res);
    }
    this.payoutsByReference.set(params.reference, res);
    this.payoutsById.set(providerPayoutId, res);

    return res;
  }

  public async getPayoutStatus(
    params: { reference?: string; providerPayoutId?: string } | string
  ): Promise<PayoutDisbursementResult> {
    const ref = typeof params === 'string' ? params : params.reference;
    const pid = typeof params === 'object' ? params.providerPayoutId : undefined;

    const existing =
      (pid && this.payoutsById.get(pid)) ||
      (ref && this.payoutsByReference.get(ref));

    if (existing) {
      return existing;
    }

    return {
      success: false,
      providerPayoutId: pid || '',
      utrNumber: '',
      status: 'QUEUED',
      failureReason: 'PAYOUT_STATUS_PENDING_AT_BANK',
    };
  }

  public async getPayoutByIdempotencyKey(idempotencyKey: string): Promise<PayoutDisbursementResult | null> {
    return this.payoutsByIdempotency.get(idempotencyKey) || null;
  }

  public verifyWebhookSignature(params: { rawBody: Buffer | string; signature: string }): boolean {
    const { rawBody, signature } = params;
    if (!signature || !rawBody) return false;
    try {
      const secret = env.RAZORPAY_WEBHOOK_SECRET;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }
}

let defaultPayoutProvider: PayoutProvider | null = null;

export function getPayoutProvider(): PayoutProvider {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[Provider Security Exception] No genuine production payout provider is configured. Production launch remains blocked for banking disbursements.'
    );
  }
  if (!defaultPayoutProvider) {
    defaultPayoutProvider = new MockPayoutProvider();
  }
  return defaultPayoutProvider;
}
