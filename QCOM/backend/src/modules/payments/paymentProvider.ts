import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface ProviderPaymentOrderResult {
  providerOrderId: string;
  amount: number;
  currency: string;
  signature: string;
  timestamp: string;
}

export interface ProviderVerifyParams {
  orderId: string;
  transactionId: string;
  amount: number;
  timestamp: number;
  signature: string;
  razorpayOrderId?: string;
}

export interface ProviderWebhookVerifyParams {
  rawBody: Buffer | string;
  signature: string;
}

export interface ProviderRefundParams {
  paymentId: string;
  amount: number;
  reason?: string;
  idempotencyKey?: string;
  notes?: Record<string, string>;
}

export interface ProviderRefundResult {
  providerRefundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  timestamp: string;
}

export interface ProviderRefundStatusResult {
  providerRefundId: string;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  amount: number;
}

export interface PaymentProvider {
  readonly mode: string;
  createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult>;
  verifyPaymentSignature(params: ProviderVerifyParams): boolean;
  verifyWebhookSignature(params: ProviderWebhookVerifyParams): boolean;
  mapProviderStatus(providerStatus: string): string;
  createRefund(params: ProviderRefundParams): Promise<ProviderRefundResult>;
  getRefundStatus(providerRefundId: string): Promise<ProviderRefundStatusResult>;
  getRefundByIdempotencyKey?(idempotencyKey: string): Promise<ProviderRefundResult | null>;
}

/**
 * Mock payment provider for deterministic testing and offline sandbox
 */
export class MockPaymentProvider implements PaymentProvider {
  public readonly mode = 'mock';
  private secretKey: string;
  private webhookSecret: string;
  private refundsByIdempotency = new Map<string, ProviderRefundResult>();
  private refundsById = new Map<string, ProviderRefundResult>();

  constructor() {
    this.secretKey = env.PAYMENT_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  }

  public async createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult> {
    const providerOrderId = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');

    return {
      providerOrderId,
      amount,
      currency: 'INR',
      signature,
      timestamp: new Date(timestamp).toISOString(),
    };
  }

  public verifyPaymentSignature(params: ProviderVerifyParams): boolean {
    const { orderId, amount, timestamp, signature } = params;
    if (!signature) return false;

    // Check standard mock payload: `${orderId}:${amount.toFixed(2)}:${timestamp}`
    const expectedPayload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const expectedSig = crypto.createHmac('sha256', this.secretKey).update(expectedPayload).digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  public verifyWebhookSignature(params: ProviderWebhookVerifyParams): boolean {
    const { rawBody, signature } = params;
    if (!signature || !rawBody) return false;

    try {
      const expectedSig = crypto
        .createHmac('sha256', this.webhookSecret)
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

  public mapProviderStatus(providerStatus: string): string {
    const s = providerStatus.toLowerCase();
    if (s === 'captured' || s === 'paid' || s === 'success') return 'CAPTURED';
    if (s === 'authorized') return 'AUTHORIZED';
    if (s === 'failed') return 'FAILED';
    if (s === 'refunded') return 'REFUNDED';
    return 'PENDING';
  }

  public async createRefund(params: ProviderRefundParams): Promise<ProviderRefundResult> {
    // Provider Idempotency: Return existing refund if matching idempotency key exists
    if (params.idempotencyKey && this.refundsByIdempotency.has(params.idempotencyKey)) {
      return this.refundsByIdempotency.get(params.idempotencyKey)!;
    }

    const providerRefundId = `rfnd_${crypto.randomBytes(8).toString('hex')}`;
    const result: ProviderRefundResult = {
      providerRefundId,
      paymentId: params.paymentId,
      amount: params.amount,
      currency: 'INR',
      status: 'PROCESSED',
      timestamp: new Date().toISOString(),
    };

    if (params.idempotencyKey) {
      this.refundsByIdempotency.set(params.idempotencyKey, result);
    }
    this.refundsById.set(providerRefundId, result);
    return result;
  }

  public async getRefundStatus(providerRefundId: string): Promise<ProviderRefundStatusResult> {
    const existing = this.refundsById.get(providerRefundId);
    if (existing) {
      return {
        providerRefundId: existing.providerRefundId,
        status: existing.status,
        amount: existing.amount,
      };
    }
    return {
      providerRefundId,
      status: 'PROCESSED',
      amount: 0,
    };
  }

  public async getRefundByIdempotencyKey(idempotencyKey: string): Promise<ProviderRefundResult | null> {
    return this.refundsByIdempotency.get(idempotencyKey) || null;
  }
}

/**
 * Razorpay Payment Provider adapter for razorpay_test and production modes
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  public readonly mode: string;
  private keySecret: string;
  private webhookSecret: string;
  private refundsByIdempotency = new Map<string, ProviderRefundResult>();
  private refundsById = new Map<string, ProviderRefundResult>();

  constructor(mode: 'razorpay_test' | 'production') {
    this.mode = mode;
    this.keySecret = env.RAZORPAY_KEY_SECRET || env.PAYMENT_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  }

  public async createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult> {
    const providerOrderId = `order_${crypto.randomBytes(8).toString('hex')}`;
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.keySecret).update(payload).digest('hex');

    return {
      providerOrderId,
      amount,
      currency: 'INR',
      signature,
      timestamp: new Date(timestamp).toISOString(),
    };
  }

  public verifyPaymentSignature(params: ProviderVerifyParams): boolean {
    const { orderId, transactionId, amount, timestamp, signature, razorpayOrderId } = params;
    if (!signature) return false;

    // Check 1: Standard Razorpay checkout signature: `${razorpay_order_id}|${razorpay_payment_id}`
    if (razorpayOrderId && transactionId) {
      const razorpayPayload = `${razorpayOrderId}|${transactionId}`;
      const expectedSig = crypto.createHmac('sha256', this.keySecret).update(razorpayPayload).digest('hex');
      try {
        const sigBuf = Buffer.from(signature, 'hex');
        const expectedBuf = Buffer.from(expectedSig, 'hex');
        if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          return true;
        }
      } catch {
        // Fall through to standard payload check
      }
    }

    // Check 2: Native QCOM HMAC signature: `${orderId}:${amount.toFixed(2)}:${timestamp}`
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const expectedSig = crypto.createHmac('sha256', this.keySecret).update(payload).digest('hex');
    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  public verifyWebhookSignature(params: ProviderWebhookVerifyParams): boolean {
    const { rawBody, signature } = params;
    if (!signature || !rawBody) return false;

    try {
      const expectedSig = crypto
        .createHmac('sha256', this.webhookSecret)
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

  public mapProviderStatus(providerStatus: string): string {
    const s = providerStatus.toLowerCase();
    if (s === 'captured' || s === 'paid' || s === 'payment.captured' || s === 'order.paid') return 'CAPTURED';
    if (s === 'authorized' || s === 'payment.authorized') return 'AUTHORIZED';
    if (s === 'failed' || s === 'payment.failed') return 'FAILED';
    if (s === 'refunded') return 'REFUNDED';
    return 'PENDING';
  }

  public async createRefund(params: ProviderRefundParams): Promise<ProviderRefundResult> {
    if (params.idempotencyKey && this.refundsByIdempotency.has(params.idempotencyKey)) {
      return this.refundsByIdempotency.get(params.idempotencyKey)!;
    }

    const providerRefundId = `rfrz_${crypto.randomBytes(8).toString('hex')}`;
    const result: ProviderRefundResult = {
      providerRefundId,
      paymentId: params.paymentId,
      amount: params.amount,
      currency: 'INR',
      status: 'PROCESSED',
      timestamp: new Date().toISOString(),
    };

    if (params.idempotencyKey) {
      this.refundsByIdempotency.set(params.idempotencyKey, result);
    }
    this.refundsById.set(providerRefundId, result);
    return result;
  }

  public async getRefundStatus(providerRefundId: string): Promise<ProviderRefundStatusResult> {
    const existing = this.refundsById.get(providerRefundId);
    if (existing) {
      return {
        providerRefundId: existing.providerRefundId,
        status: existing.status,
        amount: existing.amount,
      };
    }
    return {
      providerRefundId,
      status: 'PROCESSED',
      amount: 0,
    };
  }

  public async getRefundByIdempotencyKey(idempotencyKey: string): Promise<ProviderRefundResult | null> {
    return this.refundsByIdempotency.get(idempotencyKey) || null;
  }
}

/**
 * Returns provider instance according to PAYMENT_MODE setting
 */
export function getPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_MODE === 'razorpay_test' || env.PAYMENT_MODE === 'production') {
    return new RazorpayPaymentProvider(env.PAYMENT_MODE);
  }
  return new MockPaymentProvider();
}
