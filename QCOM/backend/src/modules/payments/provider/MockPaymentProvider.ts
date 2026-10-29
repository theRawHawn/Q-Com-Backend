/**
 * Sprint 12.0: Decoupled Mock Payment Provider
 * Full implementation of the PaymentProvider contract for testing, staging, and local sandboxes.
 * Completely free of external network calls and third-party SDK dependencies.
 */

import crypto from 'crypto';
import { env } from '../../../config/env.js';
import { PaymentProvider } from './PaymentProvider.js';
import {
  PaymentProviderCapabilities,
  CreatePaymentSessionParams,
  PaymentSessionResult,
  VerifyPaymentParams,
  PaymentVerificationResult,
  ProviderPaymentStatus,
  ProviderWebhookEvent,
  ProviderRefundRequest,
  ProviderRefundResult,
  NormalizedProviderError,
} from './types.js';

export interface MockProviderOptions {
  secretKey?: string;
  webhookSecret?: string;
  simulateTimeout?: boolean;
  simulateNetworkError?: boolean;
  simulateFailureCode?: string;
}

export class MockPaymentProvider implements PaymentProvider {
  public readonly providerId: string;
  public readonly displayName: string;
  public readonly isSimulated: boolean = true;

  private secretKey: string;
  private webhookSecret: string;
  private options: MockProviderOptions;

  // In-memory state tracking for sandbox lifecycle
  private sessionsByRef = new Map<string, { params: CreatePaymentSessionParams; status: string; paymentId?: string }>();
  private refundsById = new Map<string, ProviderRefundResult>();
  private refundsByIdempotency = new Map<string, ProviderRefundResult>();

  constructor(providerId: string = 'mock', options?: MockProviderOptions) {
    this.providerId = providerId;
    this.displayName = `QCOM Mock Sandbox Gateway (${providerId})`;
    this.secretKey = options?.secretKey || env.PAYMENT_SECRET;
    this.webhookSecret = options?.webhookSecret || env.RAZORPAY_WEBHOOK_SECRET;
    this.options = options || {};
  }

  public setOptions(options: Partial<MockProviderOptions>): void {
    this.options = { ...this.options, ...options };
  }

  public getCapabilities(): PaymentProviderCapabilities {
    return {
      supportsPaymentSession: true,
      supportsServerInitiatedOrder: true,
      supportsPaymentVerification: true,
      supportsWebhookVerification: true,
      supportsStatusInquiry: true,
      supportsRefunds: true,
      supportsRefundStatusInquiry: true,
      supportsNativeIdempotency: true,
      supportsSeparateAuthAndCapture: true,
      currencySubunitFactor: 100,
    };
  }

  public async createPaymentSession(params: CreatePaymentSessionParams): Promise<PaymentSessionResult> {
    if (this.options.simulateNetworkError) {
      throw new Error('MOCK_NETWORK_ERROR: Simulated connection reset');
    }
    if (this.options.simulateTimeout) {
      throw new Error('MOCK_GATEWAY_TIMEOUT: Simulated gateway gateway timeout (504)');
    }

    const providerReference = `ord_${this.providerId}_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = Date.now();
    const payload = `${params.orderId}:${params.amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');

    this.sessionsByRef.set(providerReference, {
      params,
      status: 'INITIATED',
    });

    return {
      providerId: this.providerId,
      providerReference,
      clientToken: `token_${crypto.randomBytes(12).toString('hex')}`,
      paymentUrl: `https://checkout.sandbox.qcom.internal/pay/${providerReference}`,
      amount: params.amount,
      currency: params.currency,
      expiresAt: new Date(timestamp + 15 * 60 * 1000).toISOString(),
      signature,
      metadata: {
        timestamp,
        attemptId: params.attemptId,
      },
    };
  }

  public async createOrder(orderId: string, amount: number, currency: string = 'INR'): Promise<{
    providerOrderId: string;
    amount: number;
    currency: string;
    signature: string;
    timestamp: number;
    keyId: string;
  }> {
    const timestamp = Date.now();
    const providerOrderId = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');

    return {
      providerOrderId,
      amount,
      currency,
      signature,
      timestamp,
      keyId: 'mock_key_id',
    };
  }

  public verifyPaymentSignature(params: {
    orderId: string;
    transactionId: string;
    amount: number;
    timestamp: number;
    signature: string;
    razorpayOrderId?: string;
  }): boolean {
    if (this.options.simulateTimeout || this.options.simulateNetworkError) {
      return false;
    }
    const { orderId, amount, timestamp, signature, razorpayOrderId, transactionId } = params;
    if (!signature) return false;
    if (signature === 'mock_sig') return true;

    if (razorpayOrderId && transactionId) {
      const p1 = `${razorpayOrderId}|${transactionId}`;
      const sig1 = crypto.createHmac('sha256', this.secretKey).update(p1).digest('hex');
      try {
        const b1 = Buffer.from(signature, 'hex');
        const b2 = Buffer.from(sig1, 'hex');
        if (b1.length === b2.length && crypto.timingSafeEqual(b1, b2)) {
          return true;
        }
      } catch {}
    }

    const p2 = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const sig2 = crypto.createHmac('sha256', this.secretKey).update(p2).digest('hex');
    try {
      const b1 = Buffer.from(signature, 'hex');
      const b2 = Buffer.from(sig2, 'hex');
      if (b1.length === b2.length && crypto.timingSafeEqual(b1, b2)) {
        return true;
      }
    } catch {}

    return false;
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult> {
    if (this.options.simulateNetworkError) {
      throw new Error('MOCK_NETWORK_ERROR: Simulated connection reset during verification');
    }
    if (this.options.simulateTimeout) {
      return {
        verified: false,
        status: 'RECONCILIATION_REQUIRED',
        providerPaymentId: params.providerPaymentId || `pay_ambiguous_${Date.now()}`,
        amount: params.amount,
        currency: params.currency,
        errorCode: 'GATEWAY_TIMEOUT',
        errorMessage: 'Provider verification timed out. State is ambiguous and requires reconciliation.',
      };
    }

    if (this.options.simulateFailureCode) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: params.providerPaymentId || `pay_failed_${Date.now()}`,
        amount: params.amount,
        currency: params.currency,
        errorCode: this.options.simulateFailureCode,
        errorMessage: `Payment declined by mock provider with code ${this.options.simulateFailureCode}`,
      };
    }

    const { evidence, orderId, amount, providerReference, providerPaymentId } = params;
    const signature = evidence?.signature;
    const timestamp = evidence?.timestamp || Date.now();
    const razorpayOrderId = evidence?.razorpayOrderId || providerReference;
    const effectivePaymentId = providerPaymentId || evidence?.transactionId || `pay_${this.providerId}_${crypto.randomBytes(6).toString('hex')}`;

    if (!signature) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'MISSING_SIGNATURE',
        errorMessage: 'Cryptographic signature is missing in evidence.',
      };
    }

    let isSigMatch = false;
    if (signature === 'mock_sig' || evidence?.simulatedSuccess === true) {
      isSigMatch = true;
    }

    // Check 1: Provider-order + Payment ID signature (`${order_id}|${payment_id}`)
    if (razorpayOrderId && effectivePaymentId) {
      const p1 = `${razorpayOrderId}|${effectivePaymentId}`;
      const sig1 = crypto.createHmac('sha256', this.secretKey).update(p1).digest('hex');
      try {
        const b1 = Buffer.from(signature, 'hex');
        const b2 = Buffer.from(sig1, 'hex');
        if (b1.length === b2.length && crypto.timingSafeEqual(b1, b2)) {
          isSigMatch = true;
        }
      } catch {
        // Continue
      }
    }

    // Check 2: Order + Amount + Timestamp signature (`${orderId}:${amount.toFixed(2)}:${timestamp}`)
    if (!isSigMatch) {
      const p2 = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
      const sig2 = crypto.createHmac('sha256', this.secretKey).update(p2).digest('hex');
      try {
        const b1 = Buffer.from(signature, 'hex');
        const b2 = Buffer.from(sig2, 'hex');
        if (b1.length === b2.length && crypto.timingSafeEqual(b1, b2)) {
          isSigMatch = true;
        }
      } catch {
        // Continue
      }
    }

    if (!isSigMatch) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'INVALID_SIGNATURE',
        errorMessage: 'Cryptographic signature verification failed. Evidence tampered.',
      };
    }

    // Mark session succeeded
    const session = this.sessionsByRef.get(providerReference);
    if (session) {
      session.status = 'SUCCEEDED';
      session.paymentId = effectivePaymentId;
    }

    return {
      verified: true,
      status: 'SUCCEEDED',
      providerPaymentId: effectivePaymentId,
      amount,
      currency: params.currency,
      rawResponse: { providerReference, effectivePaymentId, verified: true },
    };
  }

  public async getPaymentStatus(providerReference: string, providerPaymentId?: string): Promise<ProviderPaymentStatus> {
    if (this.options.simulateTimeout) {
      return {
        providerId: this.providerId,
        providerReference,
        providerPaymentId,
        status: 'UNKNOWN',
        amount: 0,
        currency: 'INR',
        rawStatus: 'TIMEOUT',
        failureReason: 'Provider inquiry timed out',
      };
    }

    const session = this.sessionsByRef.get(providerReference);
    if (!session) {
      return {
        providerId: this.providerId,
        providerReference,
        providerPaymentId,
        status: 'UNKNOWN',
        amount: 0,
        currency: 'INR',
        rawStatus: 'NOT_FOUND',
      };
    }

    const mappedStatus = session.status === 'SUCCEEDED' ? 'SUCCEEDED' : session.status === 'FAILED' ? 'FAILED' : 'PENDING';

    return {
      providerId: this.providerId,
      providerReference,
      providerPaymentId: session.paymentId || providerPaymentId,
      status: mappedStatus,
      amount: session.params.amount,
      currency: session.params.currency,
      rawStatus: session.status,
      updatedAt: new Date().toISOString(),
    };
  }

  public verifyWebhookSignature(params: {
    rawBody: Buffer | string;
    headers?: Record<string, string | string[] | undefined>;
    signature?: string;
  }): boolean {
    const rawBody = params.rawBody;
    if (!rawBody) return false;

    let signature = params.signature;
    if (!signature && params.headers) {
      const headers = params.headers;
      // Check header agnostic lookup: x-razorpay-signature, x-webhook-signature, x-signature, x-provider-signature
      const sigHeader =
        headers['x-razorpay-signature'] ||
        headers['x-webhook-signature'] ||
        headers['x-signature'] ||
        headers['x-provider-signature'] ||
        headers['signature'];
      signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    }

    if (!signature) return false;

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

  public parseWebhookEvent(params: {
    rawBody: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
  }): ProviderWebhookEvent {
    let payload: any;
    try {
      payload = typeof params.rawBody === 'string' ? JSON.parse(params.rawBody) : JSON.parse(params.rawBody.toString('utf8'));
    } catch {
      throw new Error('INVALID_WEBHOOK_PAYLOAD: Failed to parse raw body JSON');
    }

    const eventId = payload.id || payload.event_id || `evt_${crypto.randomBytes(6).toString('hex')}`;
    const rawType = payload.event || payload.event_type || payload.type || 'unknown';

    // Normalize event type
    let normalizedType: ProviderWebhookEvent['eventType'] = 'UNKNOWN';
    const lower = rawType.toLowerCase();

    if (lower === 'payment.captured' || lower === 'order.paid' || lower === 'payment_success' || lower === 'charge.successful') {
      normalizedType = 'PAYMENT_SUCCESS';
    } else if (lower === 'payment.failed' || lower === 'payment_failed' || lower === 'charge.failed') {
      normalizedType = 'PAYMENT_FAILED';
    } else if (lower === 'payment.authorized' || lower === 'payment_authorized') {
      normalizedType = 'PAYMENT_AUTHORIZED';
    } else if (lower.startsWith('refund.processed') || lower === 'refund.created' || lower === 'refund_success') {
      normalizedType = 'REFUND_SUCCESS';
    } else if (lower.startsWith('refund.failed') || lower === 'refund_failed') {
      normalizedType = 'REFUND_FAILED';
    }

    const paymentEntity = payload.payload?.payment?.entity || payload.payment || payload.data?.object || {};
    const orderEntity = payload.payload?.order?.entity || payload.order || {};
    const notes = paymentEntity.notes || orderEntity.notes || payload.notes || {};

    const providerPaymentId = paymentEntity.id || payload.payment_id;
    const providerReference = paymentEntity.order_id || orderEntity.id || payload.order_id || payload.provider_reference;
    const orderId = notes.orderId || notes.order_id || payload.orderId;

    let amount: number | undefined;
    if (paymentEntity.amount !== undefined) {
      // Subunit factor check: if passed in subunit (paise/cents), convert or retain
      amount = Number(paymentEntity.amount);
    } else if (payload.amount !== undefined) {
      amount = Number(payload.amount);
    }

    return {
      eventId,
      eventType: normalizedType,
      rawEventType: rawType,
      providerId: this.providerId,
      orderId,
      providerReference,
      providerPaymentId,
      amount,
      currency: paymentEntity.currency || payload.currency || 'INR',
      rawBody: params.rawBody,
      rawPayload: payload,
    };
  }

  public async createRefund(params: ProviderRefundRequest): Promise<ProviderRefundResult> {
    if (this.options.simulateNetworkError) {
      throw new Error('MOCK_NETWORK_ERROR: Simulated connection reset during refund');
    }

    if (params.idempotencyKey && this.refundsByIdempotency.has(params.idempotencyKey)) {
      return this.refundsByIdempotency.get(params.idempotencyKey)!;
    }

    const providerRefundId = `rfrz_${this.providerId}_${crypto.randomBytes(6).toString('hex')}`;
    const result: ProviderRefundResult = {
      providerRefundId,
      paymentId: params.paymentId,
      amount: params.amount,
      currency: params.currency,
      status: 'PROCESSED',
      timestamp: new Date().toISOString(),
    };

    if (params.idempotencyKey) {
      this.refundsByIdempotency.set(params.idempotencyKey, result);
    }
    this.refundsById.set(providerRefundId, result);

    return result;
  }

  public async getRefundStatus(providerRefundId: string): Promise<ProviderRefundResult> {
    const existing = this.refundsById.get(providerRefundId);
    if (existing) return existing;

    return {
      providerRefundId,
      paymentId: 'unknown',
      amount: 0,
      currency: 'INR',
      status: 'PROCESSED',
      timestamp: new Date().toISOString(),
    };
  }

  public async getRefundByIdempotencyKey(idempotencyKey: string): Promise<ProviderRefundResult | null> {
    return this.refundsByIdempotency.get(idempotencyKey) || null;
  }

  public normalizeError(error: any): NormalizedProviderError {
    const msg = (error?.message || '').toLowerCase();
    const code = (error?.code || '').toUpperCase();

    if (msg.includes('timeout') || code === 'ETIMEDOUT') {
      return {
        category: 'NETWORK_TIMEOUT',
        code: 'TIMEOUT',
        message: 'Provider request timed out',
        retryable: true,
        rawError: error,
      };
    }

    if (msg.includes('auth') || msg.includes('unauthorized') || code === '401') {
      return {
        category: 'AUTHENTICATION_ERROR',
        code: 'UNAUTHORIZED',
        message: 'Provider authentication failed',
        retryable: false,
        rawError: error,
      };
    }

    if (msg.includes('rate') || code === '429') {
      return {
        category: 'RATE_LIMITED',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Provider rate limit encountered',
        retryable: true,
        rawError: error,
      };
    }

    return {
      category: 'UNKNOWN',
      code: code || 'PROVIDER_ERROR',
      message: error?.message || 'Unknown provider error',
      retryable: false,
      rawError: error,
    };
  }
}
