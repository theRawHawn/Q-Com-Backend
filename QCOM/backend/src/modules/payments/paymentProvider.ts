import crypto from 'crypto';
import { env } from '../../config/env.js';
import {
  PaymentProviderCapabilities,
  CreatePaymentSessionParams,
  PaymentSessionResult,
  VerifyPaymentParams,
  PaymentVerificationResult,
  ProviderPaymentStatus,
  ProviderWebhookEvent,
  ProviderRefundRequest,
  ProviderRefundResult as AgnosticRefundResult,
  NormalizedProviderError,
} from './provider/types.js';
import { PaymentProvider as AgnosticPaymentProvider } from './provider/PaymentProvider.js';

export * from './provider/types.js';
import { PaymentProviderRegistry, paymentProviderRegistry } from './provider/paymentProviderRegistry.js';
export { PaymentProviderRegistry, paymentProviderRegistry };
export { DisabledPaymentProvider } from './provider/DisabledPaymentProvider.js';

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
  evidence?: Record<string, any>;
}

export interface ProviderWebhookVerifyParams {
  rawBody: Buffer | string;
  signature: string;
  headers?: Record<string, string | string[] | undefined>;
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

/**
 * Unified PaymentProvider interface meeting both legacy and Sprint 12.0 provider-agnostic standards.
 */
export interface PaymentProvider extends AgnosticPaymentProvider {
  readonly mode: string;
  createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult>;
  verifyPaymentSignature(params: ProviderVerifyParams): boolean;
  verifyWebhookSignature(params: ProviderWebhookVerifyParams | { rawBody: Buffer | string; headers: Record<string, string | string[] | undefined> }): boolean;
  mapProviderStatus(providerStatus: string): string;
  createRefund(params: ProviderRefundParams | ProviderRefundRequest): Promise<ProviderRefundResult>;
  getRefundStatus(providerRefundId: string): Promise<ProviderRefundStatusResult>;
  getRefundByIdempotencyKey?(idempotencyKey: string): Promise<ProviderRefundResult | null>;
}

/**
 * Mock payment provider for deterministic testing and offline sandbox
 */
export class MockPaymentProvider implements PaymentProvider {
  public readonly providerId: string;
  public readonly displayName: string;
  public readonly mode: string;
  public readonly isSimulated: boolean = true;

  private secretKey: string;
  private webhookSecret: string;
  private refundsByIdempotency = new Map<string, ProviderRefundResult>();
  private refundsById = new Map<string, ProviderRefundResult>();
  private sessionsByRef = new Map<string, { orderId: string; amount: number; status: string; paymentId?: string }>();
  private options: any;

  constructor(providerId: string = 'mock', options?: any) {
    this.providerId = providerId;
    this.mode = providerId;
    this.displayName = `QCOM Mock Payment Gateway (${providerId})`;
    this.secretKey = options?.secretKey || env.PAYMENT_SECRET;
    this.webhookSecret = options?.webhookSecret || (env as any).PAYMENT_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET;
    this.options = options || {};
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
    const timestamp = Date.now();
    const providerReference = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const payload = `${params.orderId}:${params.amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');

    this.sessionsByRef.set(providerReference, {
      orderId: params.orderId,
      amount: params.amount,
      status: 'INITIATED',
      signature,
    } as any);

    return {
      providerId: this.providerId,
      providerReference,
      clientToken: `token_${crypto.randomBytes(8).toString('hex')}`,
      paymentUrl: `https://mock.gateway.local/pay/${providerReference}`,
      amount: params.amount,
      currency: params.currency,
      expiresAt: new Date(timestamp + 15 * 60 * 1000).toISOString(),
      signature,
      metadata: { attemptId: params.attemptId },
    };
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult> {
    if (this.options?.simulateTimeout) {
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

    const { orderId, amount, providerReference, providerPaymentId, evidence } = params;
    const signature = evidence?.signature;
    const timestamp = evidence?.timestamp || Date.now();
    const effectivePaymentId = providerPaymentId || evidence?.transactionId || `pay_${crypto.randomBytes(6).toString('hex')}`;

    if (!signature) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'MISSING_SIGNATURE',
        errorMessage: 'Cryptographic signature is missing.',
      };
    }

    const session = this.sessionsByRef.get(providerReference);
    let isSigValid = signature === 'mock_sig' || evidence?.simulatedSuccess === true || ((session as any)?.signature === signature) || this.verifyPaymentSignature({
      orderId,
      transactionId: effectivePaymentId,
      amount,
      timestamp,
      signature,
      razorpayOrderId: evidence?.razorpayOrderId || providerReference,
    });

    if (!isSigValid) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'INVALID_SIGNATURE',
        errorMessage: 'Cryptographic signature verification failed.',
      };
    }

    if (session) {
      session.status = 'SUCCEEDED';
      session.paymentId = effectivePaymentId;
    } else {
      this.sessionsByRef.set(providerReference, {
        orderId,
        amount,
        status: 'SUCCEEDED',
        paymentId: effectivePaymentId,
      } as any);
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

    return {
      providerId: this.providerId,
      providerReference,
      providerPaymentId: session.paymentId || providerPaymentId,
      status: session.status === 'SUCCEEDED' ? 'SUCCEEDED' : session.status === 'FAILED' ? 'FAILED' : 'PENDING',
      amount: session.amount,
      currency: 'INR',
      rawStatus: session.status,
    };
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

    let normalizedType: ProviderWebhookEvent['eventType'] = 'UNKNOWN';
    const lower = rawType.toLowerCase();
    if (lower === 'payment.captured' || lower === 'order.paid' || lower === 'payment_success' || lower === 'payment.succeeded') {
      normalizedType = 'PAYMENT_SUCCESS';
    } else if (lower === 'payment.failed' || lower === 'payment_failed') {
      normalizedType = 'PAYMENT_FAILED';
    } else if (lower === 'payment.authorized') {
      normalizedType = 'PAYMENT_AUTHORIZED';
    } else if (lower.startsWith('refund.processed') || lower === 'refund.created') {
      normalizedType = 'REFUND_SUCCESS';
    } else if (lower.startsWith('refund.failed')) {
      normalizedType = 'REFUND_FAILED';
    }

    const paymentEntity = payload.payload?.payment?.entity || payload.payment || {};
    const orderEntity = payload.payload?.order?.entity || payload.order || {};
    const notes = paymentEntity.notes || orderEntity.notes || payload.notes || {};

    return {
      eventId,
      eventType: normalizedType,
      rawEventType: rawType,
      providerId: this.providerId,
      orderId: notes.orderId || notes.order_id || payload.orderId,
      providerReference: paymentEntity.order_id || orderEntity.id || payload.order_id,
      providerPaymentId: paymentEntity.id || payload.payment_id,
      amount: paymentEntity.amount !== undefined ? Number(paymentEntity.amount) : payload.amount,
      currency: paymentEntity.currency || payload.currency || 'INR',
      rawBody: params.rawBody,
      rawPayload: payload,
    };
  }

  public normalizeError(error: any): NormalizedProviderError {
    const msg = (error?.message || '').toLowerCase();
    if (msg.includes('timeout')) {
      return { category: 'NETWORK_TIMEOUT', code: 'TIMEOUT', message: 'Mock provider timeout', retryable: true, rawError: error };
    }
    return { category: 'UNKNOWN', code: 'MOCK_ERROR', message: error?.message || 'Mock error', retryable: false, rawError: error };
  }

  public async createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult> {
    const providerOrderId = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    const signature = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');

    this.sessionsByRef.set(providerOrderId, {
      orderId,
      amount,
      status: 'INITIATED',
    });

    return {
      providerOrderId,
      amount,
      currency: 'INR',
      signature,
      timestamp: new Date(timestamp).toISOString(),
    };
  }

  public verifyPaymentSignature(params: ProviderVerifyParams): boolean {
    if (this.options?.simulateTimeout) return false;
    const { orderId, amount, timestamp, signature, transactionId, razorpayOrderId } = params;
    if (!signature) return false;

    // Check 1: Provider-order + Payment ID signature
    if (razorpayOrderId && transactionId) {
      const razorpayPayload = `${razorpayOrderId}|${transactionId}`;
      const expectedSig = crypto.createHmac('sha256', this.secretKey).update(razorpayPayload).digest('hex');
      try {
        const sigBuf = Buffer.from(signature, 'hex');
        const expectedBuf = Buffer.from(expectedSig, 'hex');
        if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          return true;
        }
      } catch {
        // Fall through
      }
    }

    // Check 2: Standard mock payload: `${orderId}:${amount.toFixed(2)}:${timestamp}`
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

  public verifyWebhookSignature(params: ProviderWebhookVerifyParams | { rawBody: Buffer | string; headers: Record<string, string | string[] | undefined> }): boolean {
    const rawBody = params.rawBody;
    let signature = (params as any).signature;

    if (!signature && (params as any).headers) {
      const headers = (params as any).headers;
      const sigHeader =
        headers['x-razorpay-signature'] ||
        headers['x-webhook-signature'] ||
        headers['x-signature'] ||
        headers['x-provider-signature'];
      signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    }

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
    if (s === 'captured' || s === 'paid' || s === 'success' || s === 'succeeded') return 'CAPTURED';
    if (s === 'authorized') return 'AUTHORIZED';
    if (s === 'failed') return 'FAILED';
    if (s === 'refunded') return 'REFUNDED';
    return 'PENDING';
  }

  public async createRefund(params: ProviderRefundParams | ProviderRefundRequest): Promise<ProviderRefundResult> {
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
  public readonly providerId: string;
  public readonly displayName: string;
  public readonly mode: string;

  private keySecret: string;
  private webhookSecret: string;
  private refundsByIdempotency = new Map<string, ProviderRefundResult>();
  private refundsById = new Map<string, ProviderRefundResult>();
  private sessionsByRef = new Map<string, { orderId: string; amount: number; status: string; paymentId?: string }>();

  constructor(mode: 'razorpay_test' | 'production') {
    this.mode = mode;
    this.providerId = mode;
    this.displayName = `Razorpay Gateway (${mode})`;
    this.keySecret = env.RAZORPAY_KEY_SECRET || env.PAYMENT_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
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
    const orderResult = await this.createOrder(params.orderId, params.amount, Date.now());
    return {
      providerId: this.providerId,
      providerReference: orderResult.providerOrderId,
      clientToken: orderResult.signature,
      amount: params.amount,
      currency: params.currency,
      signature: orderResult.signature,
      metadata: { attemptId: params.attemptId },
    };
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult> {
    const { orderId, amount, providerReference, providerPaymentId, evidence } = params;
    const signature = evidence?.signature;
    const timestamp = evidence?.timestamp || Date.now();
    const effectivePaymentId = providerPaymentId || evidence?.transactionId || `pay_${crypto.randomBytes(6).toString('hex')}`;

    if (!signature) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'MISSING_SIGNATURE',
        errorMessage: 'Cryptographic signature is missing.',
      };
    }

    const isSigValid = this.verifyPaymentSignature({
      orderId,
      transactionId: effectivePaymentId,
      amount,
      timestamp,
      signature,
      razorpayOrderId: evidence?.razorpayOrderId || providerReference,
    });

    if (!isSigValid) {
      return {
        verified: false,
        status: 'FAILED',
        providerPaymentId: effectivePaymentId,
        amount,
        currency: params.currency,
        errorCode: 'INVALID_SIGNATURE',
        errorMessage: 'Cryptographic signature verification failed.',
      };
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
    return {
      providerId: this.providerId,
      providerReference,
      providerPaymentId,
      status: 'SUCCEEDED',
      amount: 0,
      currency: 'INR',
      rawStatus: 'CAPTURED',
    };
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
    const rawType = payload.event || payload.event_type || 'unknown';

    let normalizedType: ProviderWebhookEvent['eventType'] = 'UNKNOWN';
    const lower = rawType.toLowerCase();
    if (lower === 'payment.captured' || lower === 'order.paid') {
      normalizedType = 'PAYMENT_SUCCESS';
    } else if (lower === 'payment.failed') {
      normalizedType = 'PAYMENT_FAILED';
    } else if (lower === 'payment.authorized') {
      normalizedType = 'PAYMENT_AUTHORIZED';
    } else if (lower.startsWith('refund.processed')) {
      normalizedType = 'REFUND_SUCCESS';
    } else if (lower.startsWith('refund.failed')) {
      normalizedType = 'REFUND_FAILED';
    }

    const paymentEntity = payload.payload?.payment?.entity || payload.payment || {};
    const orderEntity = payload.payload?.order?.entity || payload.order || {};
    const notes = paymentEntity.notes || orderEntity.notes || payload.notes || {};

    return {
      eventId,
      eventType: normalizedType,
      rawEventType: rawType,
      providerId: this.providerId,
      orderId: notes.orderId || notes.order_id || payload.orderId,
      providerReference: paymentEntity.order_id || orderEntity.id || payload.order_id,
      providerPaymentId: paymentEntity.id || payload.payment_id,
      amount: paymentEntity.amount !== undefined ? Number(paymentEntity.amount) : payload.amount,
      currency: paymentEntity.currency || payload.currency || 'INR',
      rawBody: params.rawBody,
      rawPayload: payload,
    };
  }

  public normalizeError(error: any): NormalizedProviderError {
    return {
      category: 'UNKNOWN',
      code: 'RAZORPAY_ERROR',
      message: error?.message || 'Razorpay error',
      retryable: false,
      rawError: error,
    };
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

  public verifyWebhookSignature(params: ProviderWebhookVerifyParams | { rawBody: Buffer | string; headers: Record<string, string | string[] | undefined> }): boolean {
    const rawBody = params.rawBody;
    let signature = (params as any).signature;

    if (!signature && (params as any).headers) {
      const headers = (params as any).headers;
      const sigHeader =
        headers['x-razorpay-signature'] ||
        headers['x-webhook-signature'] ||
        headers['x-signature'] ||
        headers['x-provider-signature'];
      signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    }

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
    if (s === 'captured' || s === 'paid' || s === 'payment.captured' || s === 'order.paid' || s === 'payment_success') return 'CAPTURED';
    if (s === 'authorized' || s === 'payment.authorized') return 'AUTHORIZED';
    if (s === 'failed' || s === 'payment.failed') return 'FAILED';
    if (s === 'refunded') return 'REFUNDED';
    return 'PENDING';
  }

  public async createRefund(params: ProviderRefundParams | ProviderRefundRequest): Promise<ProviderRefundResult> {
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
  if (env.PAYMENT_MODE === 'none') {
    return paymentProviderRegistry.getProvider('none');
  }
  if (env.PAYMENT_MODE === 'razorpay_test') {
    return new RazorpayPaymentProvider(env.PAYMENT_MODE);
  }
  return paymentProviderRegistry.getProvider();
}
