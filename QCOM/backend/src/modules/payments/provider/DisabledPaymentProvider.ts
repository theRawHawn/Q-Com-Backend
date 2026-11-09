/**
 * Sprint 12.5: Disabled Payment Provider
 * Represents the authoritative state when QCOM backend is operating in production
 * without an active external payment gateway selected or configured.
 *
 * Invariants:
 * - Online payment initiation fails explicitly and safely with PAYMENT_GATEWAY_NOT_CONFIGURED.
 * - Capabilities accurately report all payment operations as unsupported.
 * - Prevents silent or accidental fallback to mock or test adapters in production.
 * - Allows non-payment business services (COD orders, inventory, dispatch, auth) to run.
 */

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

export class DisabledPaymentProvider implements PaymentProvider {
  public readonly providerId: string = 'none';
  public readonly displayName: string = 'No Payment Gateway Configured';
  public readonly isSimulated: boolean = false;

  public getCapabilities(): PaymentProviderCapabilities {
    return {
      supportsPaymentSession: false,
      supportsServerInitiatedOrder: false,
      supportsPaymentVerification: false,
      supportsWebhookVerification: false,
      supportsStatusInquiry: false,
      supportsRefunds: false,
      supportsRefundStatusInquiry: false,
      supportsNativeIdempotency: false,
      supportsSeparateAuthAndCapture: false,
      currencySubunitFactor: 100,
    };
  }

  public async createPaymentSession(_params: CreatePaymentSessionParams): Promise<PaymentSessionResult> {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Online payment initiation is unavailable because no payment gateway has been configured.');
  }

  public async createOrder(_orderId: string, _amount: number, _timestamp?: number): Promise<any> {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Online payment initiation is unavailable because no payment gateway has been configured.');
  }

  public async verifyPayment(_params: VerifyPaymentParams): Promise<PaymentVerificationResult> {
    return {
      verified: false,
      status: 'FAILED',
      providerPaymentId: '',
      amount: 0,
      currency: 'INR',
      errorCode: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      errorMessage: 'Online payment verification is unavailable because no payment gateway has been configured.',
    };
  }

  public verifyPaymentSignature(_params: any): boolean {
    return false;
  }

  public async getPaymentStatus(_providerReference: string, _providerPaymentId?: string): Promise<ProviderPaymentStatus> {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Payment status inquiry is unavailable because no payment gateway has been configured.');
  }

  public verifyWebhookSignature(_params: {
    rawBody: Buffer | string;
    headers?: Record<string, string | string[] | undefined>;
    signature?: string;
  }): boolean {
    return false;
  }

  public normalizeError(error: unknown): NormalizedProviderError {
    const message = error instanceof Error ? error.message : 'Payment gateway is not configured.';
    return {
      category: 'UNSUPPORTED_OPERATION',
      code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      message,
      retryable: false,
      rawError: error,
    };
  }

  public parseWebhookEvent(_params: {
    rawBody: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
  }): ProviderWebhookEvent {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Webhook processing is unavailable because no payment gateway has been configured.');
  }

  public async createRefund(_params: ProviderRefundRequest): Promise<ProviderRefundResult> {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Online refunds are unavailable because no payment gateway has been configured.');
  }

  public async getRefundStatus(_providerRefundId: string): Promise<ProviderRefundResult> {
    throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: Refund status inquiry is unavailable because no payment gateway has been configured.');
  }
}
