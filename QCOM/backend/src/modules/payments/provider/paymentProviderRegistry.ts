/**
 * Sprint 12.0: Payment Provider Registry
 * Decouples provider selection and configuration from checkout and payment business logic.
 * Enables zero-touch plugging of future gateways without altering order, inventory, or ledger services.
 */

import { PaymentProvider } from './PaymentProvider.js';
import { MockPaymentProvider } from './MockPaymentProvider.js';
import { DisabledPaymentProvider } from './DisabledPaymentProvider.js';
import { env } from '../../../config/env.js';

export class PaymentProviderRegistry {
  private static instance: PaymentProviderRegistry;
  private providers = new Map<string, PaymentProvider>();
  private defaultProviderId: string = 'mock';

  private constructor() {
    this.registerDefaultProviders();
  }

  public static getInstance(): PaymentProviderRegistry {
    if (!PaymentProviderRegistry.instance) {
      PaymentProviderRegistry.instance = new PaymentProviderRegistry();
    }
    return PaymentProviderRegistry.instance;
  }

  private registerDefaultProviders(): void {
    // 1. Always register DisabledPaymentProvider ('none')
    const disabledProvider = new DisabledPaymentProvider();
    this.providers.set('none', disabledProvider);

    // 2. Register mock sandbox providers strictly in non-production environments
    if (env.NODE_ENV !== 'production') {
      const defaultMock = new MockPaymentProvider('mock');
      this.providers.set('mock', defaultMock);

      const razorpayTestMock = new MockPaymentProvider('razorpay_test');
      this.providers.set('razorpay_test', razorpayTestMock);
      this.providers.set('razorpay', razorpayTestMock);
    }

    // Set default based on configuration
    const configuredMode = env.PAYMENT_MODE;
    if (configuredMode === 'none') {
      this.defaultProviderId = 'none';
    } else if (this.providers.has(configuredMode)) {
      this.defaultProviderId = configuredMode;
    } else if (env.NODE_ENV === 'production') {
      this.defaultProviderId = 'none';
    } else {
      this.defaultProviderId = 'mock';
    }
  }

  /**
   * Registers a payment provider adapter into the registry
   */
  public registerProvider(provider: PaymentProvider, setAsDefault: boolean = false): void {
    if (!provider || !provider.providerId) {
      throw new Error('INVALID_PROVIDER: PaymentProvider must have a valid providerId');
    }
    const isMock = provider.isSimulated === true ||
      provider.providerId === 'mock' ||
      provider.providerId === 'razorpay_test' ||
      provider.providerId.toLowerCase().includes('mock') ||
      provider.providerId.toLowerCase().includes('test') ||
      provider.providerId.toLowerCase().includes('simulat');

    if (env.NODE_ENV === 'production' && isMock) {
      throw new Error(`SECURITY_VIOLATION: Mock or simulated payment provider '${provider.providerId}' cannot be registered in production mode.`);
    }
    this.providers.set(provider.providerId, provider);
    this.providers.set(provider.providerId.toLowerCase(), provider);
    if (setAsDefault) {
      this.defaultProviderId = provider.providerId;
    }
  }

  /**
   * Retrieves provider by ID, or returns the default active provider.
   * In strict mode and in production, unknown providers throw UNREGISTERED_PAYMENT_PROVIDER
   * with zero silent fallback to mock.
   */
  public getProvider(providerId?: string): PaymentProvider {
    if (providerId) {
      const normalizedId = providerId.toLowerCase().trim();
      let provider = this.providers.get(providerId) || this.providers.get(normalizedId);
      if (!provider && env.NODE_ENV !== 'production' && (normalizedId === 'razorpay' || normalizedId === 'mock')) {
        provider = this.providers.get('razorpay_test') || this.providers.get('mock');
      }

      if (env.NODE_ENV === 'production' && provider) {
        const isMock = provider.isSimulated === true ||
          provider.providerId === 'mock' ||
          provider.providerId === 'razorpay_test' ||
          provider.providerId.toLowerCase().includes('mock') ||
          provider.providerId.toLowerCase().includes('test') ||
          provider.providerId.toLowerCase().includes('simulat');
        if (isMock) {
          throw new Error(`SECURITY_VIOLATION: Mock payment provider '${providerId}' cannot be accessed in production mode.`);
        }
      }
      if (!provider) {
        if (env.NODE_ENV === 'production') {
          throw new Error(`UNREGISTERED_PAYMENT_PROVIDER: Provider '${providerId}' is not registered`);
        }
        return this.getProvider();
      }
      return provider;
    }

    // Default provider requested
    const provider = this.providers.get(this.defaultProviderId);
    if (!provider || (env.NODE_ENV === 'production' && provider.isSimulated)) {
      if (env.NODE_ENV === 'production') {
        const disabled = this.providers.get('none');
        if (disabled) return disabled;
        throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED: No payment gateway is configured in production.');
      }
      const fallback = this.providers.get('mock');
      if (fallback) return fallback;
      throw new Error(`UNREGISTERED_PAYMENT_PROVIDER: Default provider '${this.defaultProviderId}' is not registered`);
    }
    return provider;
  }

  /**
   * Returns whether a real or configured payment provider is active
   */
  public isPaymentConfigured(): boolean {
    return this.defaultProviderId !== 'none';
  }

  /**
   * Checks if a provider with the given ID is registered
   */
  public hasProvider(providerId: string): boolean {
    const normalizedId = providerId.toLowerCase().trim();
    return this.providers.has(providerId) || this.providers.has(normalizedId);
  }

  /**
   * Returns list of all registered provider IDs and their display names
   */
  public listProviders(): { providerId: string; displayName: string; isDefault: boolean }[] {
    return Array.from(this.providers.values()).map(p => ({
      providerId: p.providerId,
      displayName: p.displayName,
      isDefault: p.providerId === this.defaultProviderId,
    }));
  }

  /**
   * Resets registry to initial state (useful in test teardown)
   */
  public reset(): void {
    this.providers.clear();
    this.registerDefaultProviders();
  }
}

export const paymentProviderRegistry = PaymentProviderRegistry.getInstance();
