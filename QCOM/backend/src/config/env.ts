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
  PAYMENT_MODE: z.enum(['mock', 'razorpay_test', 'production']).default('mock'),
  TELEPHONY_MODE: z.enum(['mock', 'exotel', 'twilio']).default('mock'),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default('*'),

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
  
  // External integrations & Payments
  OSRM_BASE_URL: z.string().default('https://router.project-osrm.org'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  PAYMENT_SECRET: z.string().default('qcom_secure_payment_secret_2026_isolated_key'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('qcom_secure_razorpay_webhook_secret_2026'),
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

    if (defaultDevSecrets.includes(config.JWT_ACCESS_SECRET) || config.JWT_ACCESS_SECRET.length < 32) {
      throw new Error('[Security Exception] Production requires a high-entropy JWT_ACCESS_SECRET of at least 32 characters.');
    }

    if (defaultDevSecrets.includes(config.JWT_REFRESH_SECRET) || config.JWT_REFRESH_SECRET.length < 32) {
      throw new Error('[Security Exception] Production requires a high-entropy JWT_REFRESH_SECRET of at least 32 characters.');
    }

    if (config.TELEPHONY_MODE === 'mock') {
      throw new Error('[Security Exception] Mock OTP/telephony provider is strictly prohibited in production mode.');
    }

    if (config.PAYMENT_MODE === 'mock') {
      throw new Error('[Security Exception] Mock payment provider is strictly prohibited in production mode. Live payment gateway is required.');
    }

    if (config.PAYMENT_SECRET === 'qcom_secure_payment_secret_2026_isolated_key') {
      throw new Error('[Security Exception] Production requires high-entropy non-default PAYMENT_SECRET.');
    }

    if (config.RAZORPAY_WEBHOOK_SECRET === 'qcom_secure_razorpay_webhook_secret_2026') {
      throw new Error('[Security Exception] Production requires high-entropy non-default RAZORPAY_WEBHOOK_SECRET.');
    }

    if (config.PAYMENT_MODE === 'production') {
      if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET || config.RAZORPAY_KEY_SECRET.length < 16) {
        throw new Error('[Security Exception] Production payment mode requires valid RAZORPAY_KEY_ID and high-entropy RAZORPAY_KEY_SECRET.');
      }
    }

    if (config.DATABASE_SSL_REJECT_UNAUTHORIZED === false) {
      throw new Error('[Security Exception] Database TLS certificate validation cannot be disabled in production (rejectUnauthorized must be true).');
    }

    if (config.CORS_ALLOWED_ORIGINS === '*') {
      throw new Error('[Security Exception] Wildcard CORS origin (*) is prohibited in authenticated production environments.');
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
