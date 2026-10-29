import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env if present
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database settings
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/qcom_db'),
  DATABASE_POOL_URL: z.string().optional(),
  DATABASE_MAX_POOL_SIZE: z.coerce.number().min(1).max(50).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().default(5000),
  DATABASE_SSL_REJECT_UNAUTHORIZED: z.coerce.boolean().default(true),
  DATABASE_CA_CERT: z.string().optional(),

  // Redis ephemeral settings
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Pluggable modes
  PAYMENT_MODE: z.enum(['none', 'mock', 'razorpay_test', 'production']).default('mock'),
  PAYMENT_PROVIDER: z.string().optional(),
  TELEPHONY_MODE: z.enum(['mock', 'exotel', 'twilio']).default('mock'),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default('*'),
  TRUST_PROXY_CIDRS: z.string().default(''),

  // Sprint 2: Centralized Authentication & JWT Security Settings
  JWT_SECRET: z.string().default('qcom_dev_access_secret_2026_super_secure_key'),
  JWT_ACCESS_SECRET: z.string().default('qcom_dev_access_secret_2026_super_secure_key'),
  JWT_REFRESH_SECRET: z.string().default('qcom_dev_refresh_secret_2026_super_secure_key'),
  JWT_ISSUER: z.string().default('qcom-auth-engine'),
  JWT_AUDIENCE: z.string().default('qcom-clients'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().default(15), // 15 minutes access token
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),  // 30 days refresh token
  
  // OTP Rate Limiting & Abuse Prevention Controls
  OTP_TTL_MINUTES: z.coerce.number().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_SECONDS: z.coerce.number().default(30),
  OTP_REQUEST_WINDOW_MINUTES: z.coerce.number().default(10),
  OTP_MAX_REQUESTS_PER_WINDOW: z.coerce.number().default(3),
  
  // Admin Session Settings
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().default(24),
  
  // External integrations & Payments (Provider-neutral with backwards-compatible aliases)
  OSRM_BASE_URL: z.string().default('https://router.project-osrm.org'),
  PAYMENT_GATEWAY_KEY_ID: z.preprocess(
    (val) => val ?? process.env.PAYMENT_GATEWAY_KEY_ID ?? process.env.RAZORPAY_KEY_ID,
    z.string().optional()
  ),
  PAYMENT_GATEWAY_KEY_SECRET: z.preprocess(
    (val) => val ?? process.env.PAYMENT_GATEWAY_KEY_SECRET ?? process.env.RAZORPAY_KEY_SECRET,
    z.string().optional()
  ),
  PAYMENT_WEBHOOK_SECRET: z.preprocess(
    (val) => val ?? process.env.PAYMENT_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET,
    z.string().default('qcom_secure_payment_webhook_secret_2026')
  ),
  RAZORPAY_KEY_ID: z.preprocess(
    (val) => val ?? process.env.RAZORPAY_KEY_ID ?? process.env.PAYMENT_GATEWAY_KEY_ID,
    z.string().optional()
  ),
  RAZORPAY_KEY_SECRET: z.preprocess(
    (val) => val ?? process.env.RAZORPAY_KEY_SECRET ?? process.env.PAYMENT_GATEWAY_KEY_SECRET,
    z.string().optional()
  ),
  PAYMENT_SECRET: z.string().default('qcom_secure_payment_secret_2026_isolated_key'),
  RAZORPAY_WEBHOOK_SECRET: z.preprocess(
    (val) => val ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? process.env.PAYMENT_WEBHOOK_SECRET,
    z.string().default('qcom_secure_razorpay_webhook_secret_2026')
  ),

  // Sprint 11.6.1: Configurable Checkout Reservation TTL (P2-A)
  RESERVATION_TTL_MINUTES: z.preprocess(
    (val) => val ?? process.env.CHECKOUT_RESERVATION_TTL_MINUTES ?? process.env.QCOM_RESERVATION_TTL_MINUTES,
    z.coerce.number().int().min(1).max(120).default(15)
  ),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates security rules and fails closed on insecure configurations in production.
 */
export function validateProductionSecurity(config: EnvConfig): void {
  if (config.NODE_ENV === 'production') {
    const defaultDevSecrets = [
      'qcom_dev_secret_key_2026',
      'qcom_dev_access_secret_2026_super_secure_key',
      'qcom_dev_refresh_secret_2026_super_secure_key',
    ];

    if (!config.JWT_ACCESS_SECRET || defaultDevSecrets.includes(config.JWT_ACCESS_SECRET) || config.JWT_ACCESS_SECRET.length < 32) {
      throw new Error('[Security Exception] Production requires a high-entropy JWT_ACCESS_SECRET of at least 32 characters.');
    }

    if (!config.JWT_REFRESH_SECRET || defaultDevSecrets.includes(config.JWT_REFRESH_SECRET) || config.JWT_REFRESH_SECRET.length < 32) {
      throw new Error('[Security Exception] Production requires a high-entropy JWT_REFRESH_SECRET of at least 32 characters.');
    }

    if (config.TELEPHONY_MODE === 'mock') {
      throw new Error('[Security Exception] Mock OTP/telephony provider is strictly prohibited in production mode.');
    }

    if (config.PAYMENT_MODE === 'mock' || config.PAYMENT_MODE === 'razorpay_test') {
      throw new Error('[Security Exception] Mock or test payment mode is strictly prohibited in production mode. Live payment gateway is required.');
    }

    if (config.PAYMENT_SECRET === 'qcom_secure_payment_secret_2026_isolated_key') {
      throw new Error('[Security Exception] Production requires high-entropy non-default PAYMENT_SECRET.');
    }

    if (config.DATABASE_SSL_REJECT_UNAUTHORIZED === false) {
      throw new Error('[Security Exception] Database TLS certificate validation cannot be disabled in production (rejectUnauthorized must be true).');
    }

    if (config.CORS_ALLOWED_ORIGINS === '*') {
      throw new Error('[Security Exception] Wildcard CORS origin (*) is prohibited in authenticated production environments.');
    }

    // Provider-neutral validation when a live payment gateway is enabled in production
    if (config.PAYMENT_MODE === 'production') {
      const selectedProvider = (config.PAYMENT_PROVIDER || (config.RAZORPAY_KEY_ID ? 'razorpay' : '')).toLowerCase().trim();

      if (!selectedProvider) {
        throw new Error('[Security Exception] In production mode, a concrete PAYMENT_PROVIDER must be explicitly configured (no gateway is pre-selected).');
      }

      if (
        selectedProvider === 'mock' ||
        selectedProvider === 'razorpay_test' ||
        selectedProvider.includes('mock') ||
        selectedProvider.includes('test') ||
        selectedProvider.includes('simulat')
      ) {
        throw new Error('[Security Exception] Mock or test payment mode is strictly prohibited in production mode. Live payment gateway is required.');
      }

      if (selectedProvider === 'razorpay') {
        const keyId = (config.RAZORPAY_KEY_ID || config.PAYMENT_GATEWAY_KEY_ID || '').trim();
        const keySecret = (config.RAZORPAY_KEY_SECRET || config.PAYMENT_GATEWAY_KEY_SECRET || '').trim();
        const webhookSecret = (config.RAZORPAY_WEBHOOK_SECRET || config.PAYMENT_WEBHOOK_SECRET || '').trim();

        if (!keyId || !keySecret || keySecret.length < 16) {
          throw new Error('[Security Exception] Production Razorpay mode requires valid RAZORPAY_KEY_ID and high-entropy RAZORPAY_KEY_SECRET.');
        }
        if (keyId.startsWith('rzp_test_') || keyId.startsWith('test_')) {
          throw new Error('[Security Exception] Test key ID (rzp_test_*) cannot be used for live payments in production.');
        }
        if (
          webhookSecret === 'qcom_secure_razorpay_webhook_secret_2026' ||
          webhookSecret === 'qcom_secure_payment_webhook_secret_2026'
        ) {
          throw new Error('[Security Exception] Production requires high-entropy non-default RAZORPAY_WEBHOOK_SECRET.');
        }
      } else {
        // Generic dynamic provider credential validation for any future provider (Cashfree, PayU, Stripe, etc.)
        const providerUpper = selectedProvider.toUpperCase();
        const providerKey = (
          (config as any)[`${providerUpper}_KEY_ID`] ||
          process.env[`${providerUpper}_KEY_ID`] ||
          process.env[`${providerUpper}_API_KEY`] ||
          config.PAYMENT_GATEWAY_KEY_ID ||
          ''
        ).trim();

        const providerSecret = (
          (config as any)[`${providerUpper}_KEY_SECRET`] ||
          process.env[`${providerUpper}_KEY_SECRET`] ||
          process.env[`${providerUpper}_SECRET_KEY`] ||
          config.PAYMENT_GATEWAY_KEY_SECRET ||
          ''
        ).trim();

        const webhookSecret = (
          (config as any)[`${providerUpper}_WEBHOOK_SECRET`] ||
          process.env[`${providerUpper}_WEBHOOK_SECRET`] ||
          config.PAYMENT_WEBHOOK_SECRET ||
          ''
        ).trim();

        if (!providerKey || !providerSecret || providerSecret.length < 16) {
          throw new Error(`[Security Exception] Production ${selectedProvider} mode requires valid ${providerUpper}_KEY_ID and high-entropy ${providerUpper}_KEY_SECRET (minimum 16 characters).`);
        }

        if (providerKey.startsWith('test_') || providerKey.startsWith('mock_') || providerKey.startsWith('sim_')) {
          throw new Error(`[Security Exception] Test key ID cannot be used for live payments in production.`);
        }

        if (
          webhookSecret === 'qcom_secure_payment_webhook_secret_2026' ||
          webhookSecret === 'qcom_secure_razorpay_webhook_secret_2026'
        ) {
          throw new Error(`[Security Exception] Production requires high-entropy non-default webhook secret for ${selectedProvider}.`);
        }
      }
    }
    // When config.PAYMENT_MODE === 'none', no gateway credentials are required.
    // General application services start cleanly and online payment endpoints fail safely.
  }

  if (config.NODE_ENV === 'test') {
    const keyId = (config.PAYMENT_GATEWAY_KEY_ID || config.RAZORPAY_KEY_ID || '').trim();
    if (keyId.startsWith('rzp_live_') || keyId.startsWith('live_')) {
      throw new Error('[Security Exception] Live payment credentials cannot be used in test environment.');
    }
  }
}

function parseEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errorDetails = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`[Configuration Error] Invalid environment configuration: ${errorDetails}`);
  }
  const config = result.data;
  validateProductionSecurity(config);
  return config;
}

export const env = parseEnv();

/**
 * Sanitizes connection URLs for safe logging without leaking passwords or secrets
 */
export function sanitizeConnectionString(connStr?: string): string {
  if (!connStr) return '[NOT CONFIGURED]';
  try {
    const parsed = new URL(connStr);
    if (parsed.password) {
      parsed.password = '******';
    }
    return parsed.toString();
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}
