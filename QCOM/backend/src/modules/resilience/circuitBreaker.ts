import { RESILIENCE_CONFIG } from './resilienceConfig.js';
import { isTransientFailure } from './retryPolicy.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  halfOpenSuccessThreshold?: number;
  halfOpenMaxProbes?: number;
  name?: string;
}

export class CircuitBreakerOpenError extends Error {
  public readonly code = 'CIRCUIT_BREAKER_OPEN';
  constructor(name: string) {
    super(`CIRCUIT_BREAKER_OPEN: External provider '${name}' circuit is OPEN. Requests blocked to prevent cascading overload.`);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Enterprise Circuit Breaker for External Providers (e.g. Razorpay, SMS Gateways).
 * 
 * States:
 * - CLOSED: Normal operation. All requests pass through.
 * - OPEN: Failures exceeded threshold. Requests fail immediately with CircuitBreakerOpenError.
 * - HALF_OPEN: Recovery timer elapsed. Allows a bounded probe stream (throttled to halfOpenMaxProbes)
 *              to verify downstream recovery without overwhelming recovering services.
 * 
 * Safety Guarantee:
 * The Circuit Breaker is strictly non-authoritative for financial state.
 * It protects external provider saturation, while PostgreSQL remains the sole source of truth.
 */
export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastFailureTime: number = 0;
  private activeHalfOpenProbes: number = 0;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly halfOpenMaxProbes: number;

  constructor(options?: CircuitBreakerOptions) {
    this.name = options?.name || 'ExternalProvider';
    this.failureThreshold = options?.failureThreshold ?? RESILIENCE_CONFIG.CIRCUIT_BREAKER.FAILURE_THRESHOLD;
    this.recoveryTimeoutMs = options?.recoveryTimeoutMs ?? RESILIENCE_CONFIG.CIRCUIT_BREAKER.RECOVERY_TIMEOUT_MS;
    this.halfOpenSuccessThreshold = options?.halfOpenSuccessThreshold ?? RESILIENCE_CONFIG.CIRCUIT_BREAKER.HALF_OPEN_SUCCESS_THRESHOLD;
    this.halfOpenMaxProbes = options?.halfOpenMaxProbes ?? RESILIENCE_CONFIG.CIRCUIT_BREAKER.HALF_OPEN_MAX_PROBES ?? 1;
  }

  public getState(): CircuitBreakerState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.recoveryTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.consecutiveSuccesses = 0;
        this.activeHalfOpenProbes = 0;
      }
    }
    return this.state;
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      throw new CircuitBreakerOpenError(this.name);
    }

    // Phase 6: Throttled probe execution during HALF_OPEN to prevent probe storms
    if (currentState === 'HALF_OPEN') {
      if (this.activeHalfOpenProbes >= this.halfOpenMaxProbes) {
        throw new CircuitBreakerOpenError(this.name);
      }
      this.activeHalfOpenProbes++;
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err: any) {
      if (isTransientFailure(err)) {
        this.recordFailure();
      }
      throw err;
    } finally {
      if (currentState === 'HALF_OPEN') {
        this.activeHalfOpenProbes = Math.max(0, this.activeHalfOpenProbes - 1);
      }
    }
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.activeHalfOpenProbes = 0;
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  public recordFailure(): void {
    this.lastFailureTime = Date.now();
    this.consecutiveFailures++;

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.consecutiveSuccesses = 0;
      this.activeHalfOpenProbes = 0;
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = 0;
    this.activeHalfOpenProbes = 0;
  }
}
