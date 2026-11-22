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
    const configuredMode = process.env.PAYMENT_MODE || env.PAYMENT_MODE;
    if (configuredMode === 'none') {
      this.defaultProviderId = 'none';
    } else if (this.providers.has(configuredMode)) {
      this.defaultProviderId = configuredMode;
    } else if ((env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production')) {
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
    const isProduction = (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');
    const isMock = provider.isSimulated === true ||
      provider.providerId === 'mock' ||
      provider.providerId === 'razorpay_test' ||
      provider.providerId.toLowerCase().includes('mock') ||
      provider.providerId.toLowerCase().includes('test') ||
      provider.providerId.toLowerCase().includes('simulat');

    if (isProduction && isMock) {
      throw new Error(`SECURITY_VIOLATION: Mock or simulated payment provider '${provider.providerId}' cannot be registered in production mode.`);
    }
    this.providers.set(provider.providerId, provider);
    this.providers.set(provider.providerId.toLowerCase(), provider);
    if (setAsDefault) {
      this.defaultProviderId = provider.providerId;
    }
  }

  /**
   * Sets the default provider ID explicitly (must already be registered).
   */
  public setDefaultProvider(providerId: string): void {
    const normalized = providerId.toLowerCase().trim();
    if (normalized === 'none' || normalized === 'unselected') {
      this.defaultProviderId = 'none';
      return;
    }
    if (!this.hasProvider(providerId)) {
      throw new Error(`UNREGISTERED_PAYMENT_PROVIDER: Provider '${providerId}' is not registered`);
    }
    const prov = this.getProvider(providerId);
    const isProduction = (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');
    if (isProduction && prov.isSimulated) {
      throw new Error(`SECURITY_VIOLATION: Mock or simulated payment provider '${providerId}' cannot be set as default in production mode.`);
    }
    this.defaultProviderId = prov.providerId;
  }

  public getDefaultProviderId(): string {
    return this.defaultProviderId;
  }

  /**
   * Retrieves provider by ID, or returns the default active provider.
   * When providerId is 'none' or 'UNSELECTED', strictly returns DisabledPaymentProvider.
   * In production, unknown or simulated providers fail closed with ZERO silent fallback to mock.
   */
  public getProvider(providerId?: string): PaymentProvider {
    const isProduction = (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');
    const runtimeMode = process.env.PAYMENT_MODE || env.PAYMENT_MODE;

    if (providerId) {
      const normalizedId = providerId.toLowerCase().trim();
      if (normalizedId === 'none' || normalizedId === 'unselected') {
        return this.providers.get('none')!;
      }

      let provider = this.providers.get(providerId) || this.providers.get(normalizedId);
      if (!provider && !isProduction && (normalizedId === 'razorpay' || normalizedId === 'mock')) {
        provider = this.providers.get('razorpay_test') || this.providers.get('mock');
      }

      if (isProduction && provider) {
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
        if (isProduction) {
          throw new Error(`UNREGISTERED_PAYMENT_PROVIDER: Provider '${providerId}' is not registered`);
        }
        return this.getProvider();
      }
      return provider;
    }

    // Check dynamic runtime mode override
    if (runtimeMode === 'none') {
      return this.providers.get('none')!;
    }

    // Default provider requested
    const provider = this.providers.get(this.defaultProviderId);
    if (!provider || (isProduction && provider.isSimulated)) {
      if (isProduction) {
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
    const runtimeMode = process.env.PAYMENT_MODE || env.PAYMENT_MODE;
    if (runtimeMode === 'none') return false;
    return this.defaultProviderId !== 'none' && this.defaultProviderId !== 'UNSELECTED';
  }

  /**
   * Checks if a provider with the given ID is registered
   */
  public hasProvider(providerId: string): boolean {
    const normalizedId = providerId.toLowerCase().trim();
    return this.providers.has(providerId) || this.providers.has(normalizedId);
  }

  /**
   * Returns list of unique registered providers (excluding simulated providers in production).
   */
  public listProviders(): { providerId: string; displayName: string; isDefault: boolean; isSimulated: boolean }[] {
    const isProduction = (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');
    const seen = new Set<string>();
    const list: { providerId: string; displayName: string; isDefault: boolean; isSimulated: boolean }[] = [];

    for (const p of this.providers.values()) {
      if (seen.has(p.providerId)) continue;
      if (isProduction && p.isSimulated) continue;
      seen.add(p.providerId);
      list.push({
        providerId: p.providerId,
        displayName: p.displayName,
        isDefault: p.providerId === this.defaultProviderId,
        isSimulated: Boolean(p.isSimulated),
      });
    }
    return list;
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
