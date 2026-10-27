/**
 * Sprint 12.0: Provider-Agnostic Payment Domain Types
 * Expresses marketplace payment capabilities without assuming specific third-party provider APIs.
 */

export interface PaymentProviderCapabilities {
  readonly supportsPaymentSession: boolean;
  readonly supportsServerInitiatedOrder: boolean;
  readonly supportsPaymentVerification: boolean;
  readonly supportsWebhookVerification: boolean;
  readonly supportsStatusInquiry: boolean;
  readonly supportsRefunds: boolean;
  readonly supportsRefundStatusInquiry: boolean;
  readonly supportsNativeIdempotency: boolean;
  readonly supportsSeparateAuthAndCapture: boolean;
  readonly currencySubunitFactor: number; // e.g. 100 for paise/cents, 1 for JPY
}

export interface CreatePaymentSessionParams {
  readonly orderId: string;
  readonly attemptId: string;
  readonly amount: number; // In base currency unit (e.g. INR 499.50)
  readonly currency: string; // e.g. 'INR'
  readonly customer: {
    readonly id: string;
    readonly phone?: string;
    readonly email?: string;
    readonly name?: string;
  };
  readonly idempotencyKey: string;
  readonly returnUrl?: string;
  readonly metadata?: Record<string, any>;
}

export interface PaymentSessionResult {
  readonly providerId: string;
  readonly providerReference: string; // Provider order ID or session ID
  readonly clientToken?: string; // Client-side SDK token if applicable
  readonly paymentUrl?: string; // Hosted checkout redirect URL if applicable
  readonly amount: number;
  readonly currency: string;
  readonly expiresAt?: string;
  readonly signature?: string;
  readonly metadata?: Record<string, any>;
}

export interface VerifyPaymentParams {
  readonly orderId: string;
  readonly attemptId?: string;
  readonly amount: number;
  readonly currency: string;
  readonly providerReference: string;
  readonly providerPaymentId?: string;
  readonly evidence: Record<string, any>; // Provider-specific cryptographic proof / signatures
}

export interface PaymentVerificationResult {
  readonly verified: boolean;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'RECONCILIATION_REQUIRED';
  readonly providerPaymentId: string;
  readonly amount: number;
  readonly currency: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly rawResponse?: any;
}

export interface ProviderPaymentStatus {
  readonly providerId: string;
  readonly providerReference: string;
  readonly providerPaymentId?: string;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'AUTHORIZED' | 'REFUNDED' | 'UNKNOWN';
  readonly amount: number;
  readonly currency: string;
  readonly rawStatus: string;
  readonly failureReason?: string;
  readonly updatedAt?: string;
}

export type NormalizedWebhookEventType =
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_AUTHORIZED'
  | 'REFUND_SUCCESS'
  | 'REFUND_FAILED'
  | 'DISPUTE_CREATED'
  | 'UNKNOWN';

export interface ProviderWebhookEvent {
  readonly eventId: string;
  readonly eventType: NormalizedWebhookEventType;
  readonly rawEventType: string;
  readonly providerId: string;
  readonly orderId?: string;
  readonly providerReference?: string;
  readonly providerPaymentId?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly rawBody: Buffer | string;
  readonly rawPayload: any;
}

export interface ProviderRefundRequest {
  readonly paymentId: string; // Provider payment ID
  readonly amount: number;
  readonly currency: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly notes?: Record<string, string>;
}

export interface ProviderRefundResult {
  readonly providerRefundId: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: 'PROCESSED' | 'PENDING' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  readonly timestamp: string;
  readonly rawResponse?: any;
}

export type ProviderErrorCategory =
  | 'NETWORK_TIMEOUT'
  | 'AUTHENTICATION_ERROR'
  | 'INVALID_REQUEST'
  | 'DECLINED'
  | 'INSUFFICIENT_FUNDS'
  | 'GATEWAY_ERROR'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_OPERATION'
  | 'UNKNOWN';

export interface NormalizedProviderError {
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly rawError?: any;
}
