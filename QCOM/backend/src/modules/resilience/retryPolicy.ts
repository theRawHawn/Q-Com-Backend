import { RESILIENCE_CONFIG } from './resilienceConfig.js';

export interface RetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  onRetry?: (attempt: number, delayMs: number, error: any) => void;
  shouldRetry?: (error: any) => boolean;
}

/**
 * Calculates exponential backoff with FULL JITTER.
 * 
 * Formula:
 * delay = random(0, min(MAX_DELAY, BASE_DELAY * 2^attempt))
 * 
 * Full Jitter decorrelates concurrent retries across distributed clients
 * and background workers, completely eliminating thundering herds and
 * queue resonance spikes on downstream services and payment gateways.
 */
export function calculateFullJitterDelay(
  attempt: number,
  baseDelayMs: number = RESILIENCE_CONFIG.RETRY.BASE_DELAY_MS,
  maxDelayMs: number = RESILIENCE_CONFIG.RETRY.MAX_DELAY_MS
): number {
  // Prevent overflow on high attempt counts: cap exponential multiplier at 30
  const expFactor = Math.pow(2, Math.min(attempt, 30));
  const cappedUpper = Math.min(maxDelayMs, baseDelayMs * expFactor);
  // Uniform random value in [0, cappedUpper]
  return Math.floor(Math.random() * cappedUpper);
}

/**
 * Classifies whether an error is transient (safe to retry) or permanent (reject immediately).
 */
export function isTransientFailure(err: any): boolean {
  if (!err) return false;

  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const status = Number(err.status || err.statusCode || 0);

  // 1. Explicit HTTP Transient Status Codes (429 Rate Limit, 502 Bad Gateway, 503 Unavailable, 504 Timeout)
  if (RESILIENCE_CONFIG.RETRY.TRANSIENT_STATUS_CODES.includes(status as any)) {
    return true;
  }

  // 2. Network and System Error Codes
  if (RESILIENCE_CONFIG.RETRY.TRANSIENT_ERROR_CODES.includes(code as any)) {
    return true;
  }

  // 3. String-based transient heuristic
  if (
    msg.includes('network timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('connection terminated') ||
    msg.includes('socket hang up') ||
    msg.includes('gateway timeout') ||
    msg.includes('service unavailable') ||
    msg.includes('database is closed') ||
    msg.includes('temporary failure')
  ) {
    return true;
  }

  // Permanent Failures: 400 Bad Request, 401 Unauthorized, 403 Forbidden, 422 Unprocessable, business validation
  return false;
}

/**
 * Executes an async operation with bounded exponential backoff and FULL JITTER.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const baseDelayMs = options?.baseDelayMs ?? RESILIENCE_CONFIG.RETRY.BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? RESILIENCE_CONFIG.RETRY.MAX_DELAY_MS;
  const maxAttempts = options?.maxAttempts ?? RESILIENCE_CONFIG.RETRY.MAX_ATTEMPTS;
  const shouldRetry = options?.shouldRetry ?? isTransientFailure;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const delayMs = calculateFullJitterDelay(attempt - 1, baseDelayMs, maxDelayMs);
      if (options?.onRetry) {
        options.onRetry(attempt, delayMs, err);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Calculates WebSocket client reconnect delay with Full Jitter
 */
export function calculateWebSocketReconnectDelay(
  attempt: number,
  baseDelayMs: number = RESILIENCE_CONFIG.WEBSOCKET.RECONNECT_BASE_DELAY_MS,
  maxDelayMs: number = RESILIENCE_CONFIG.WEBSOCKET.RECONNECT_MAX_DELAY_MS
): number {
  return calculateFullJitterDelay(attempt, baseDelayMs, maxDelayMs);
}
