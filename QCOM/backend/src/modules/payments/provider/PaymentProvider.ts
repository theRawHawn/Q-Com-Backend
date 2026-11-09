/**
 * Sprint 12.0: Authoritative Payment Provider Contract
 * Stable internal contract defining what operations QCOM requires from payment gateways.
 */

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

export interface PaymentProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly isSimulated?: boolean;

  /**
   * Reports capabilities supported natively by this provider
   */
  getCapabilities(): PaymentProviderCapabilities;

  /**
   * Initiates a payment session or server-side order with the provider
   */
  createPaymentSession(params: CreatePaymentSessionParams): Promise<PaymentSessionResult>;

  /**
   * Verifies client-submitted payment evidence (e.g. signature or token)
   */
  verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult>;

  /**
   * Queries authoritative payment status directly from the provider
   */
  getPaymentStatus(providerReference: string, providerPaymentId?: string): Promise<ProviderPaymentStatus>;

  /**
   * Verifies webhook cryptographic authenticity (HMAC-SHA256, RSA, ordinances)
   */
  verifyWebhookSignature(params: {
    rawBody: Buffer | string;
    headers?: Record<string, string | string[] | undefined>;
    signature?: string;
  }): boolean;

  /**
   * Parses raw webhook payload into normalized QCOM provider event
   */
  parseWebhookEvent(params: {
    rawBody: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
  }): ProviderWebhookEvent;

  /**
   * Initiates a refund through the provider with idempotency protection
   */
  createRefund(params: ProviderRefundRequest): Promise<ProviderRefundResult>;
  getRefundByIdempotencyKey?(idempotencyKey: string): Promise<ProviderRefundResult | null>;

  /**
   * Inquires refund status from provider
   */
  getRefundStatus(providerRefundId: string): Promise<{
    providerRefundId: string;
    status: 'PROCESSED' | 'PENDING' | 'FAILED' | 'RECONCILIATION_REQUIRED';
    amount: number;
  }>;

  /**
   * Normalizes provider-specific error codes into standardized QCOM categories
   */
  normalizeError(error: any): NormalizedProviderError;
}
