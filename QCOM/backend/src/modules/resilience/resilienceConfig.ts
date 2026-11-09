/**
 * Centralized Resilience and Database Protection Configuration
 * Eliminates scattered magic numbers and provides bounded parameters
 * for Bloom Filters, Exponential Backoff, Full Jitter, and Circuit Breakers.
 */

export const RESILIENCE_CONFIG = {
  // Bloom Filter Sizing and Cardinality Parameters
  BLOOM: {
    DEFAULT_EXPECTED_ITEMS: 100_000, // Expected cardinality per resource partition
    DEFAULT_FALSE_POSITIVE_RATE: 0.01, // 1% target false positive probability
    MAX_BITSET_SIZE_BITS: 10_000_000, // Bounded memory cap (~1.25 MB max per filter)
    AUTO_REBUILD_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24-hour periodic rebuild cycle
    REBUILD_BATCH_SIZE: 5_000, // Bounded keyset batch size to eliminate unbounded full table scans
    SYNC_CHANNEL: 'qcom:bloom:sync', // Multi-instance cross-process synchronization channel
    PROTECTED_RESOURCES: [
      'orders',
      'products',
      'merchants',
      'users',
      'returns',
      'refunds',
    ] as const,
  },

  // Bounded Exponential Backoff + Full Jitter Parameters
  RETRY: {
    BASE_DELAY_MS: 1_000, // Base delay: 1 second
    MAX_DELAY_MS: 300_000, // Maximum delay cap: 300 seconds (5 minutes)
    MAX_ATTEMPTS: 5, // Maximum retry attempts
    TRANSIENT_STATUS_CODES: [429, 502, 503, 504],
    TRANSIENT_ERROR_CODES: [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'EPIPE',
      'EAI_AGAIN',
      '57P01', // PostgreSQL admin shutdown
      '57P02', // PostgreSQL crash shutdown
      '57P03', // PostgreSQL cannot connect now
      '08006', // PostgreSQL connection failure
      '08001', // PostgreSQL unable to establish sqlconnection
      '08004', // PostgreSQL sqlserver rejected connection
    ],
  },

  // Circuit Breaker Parameters for External Providers
  CIRCUIT_BREAKER: {
    FAILURE_THRESHOLD: 5, // Consecutive transient failures to transition from CLOSED to OPEN
    RECOVERY_TIMEOUT_MS: 30_000, // 30 seconds wait before HALF_OPEN probe
    HALF_OPEN_SUCCESS_THRESHOLD: 2, // Consecutive successful probes to close circuit
    HALF_OPEN_MAX_PROBES: 1, // Maximum concurrent probes permitted in HALF_OPEN state
  },

  // WebSocket Client Reconnect Jitter Defaults
  WEBSOCKET: {
    RECONNECT_BASE_DELAY_MS: 500, // 500ms initial delay
    RECONNECT_MAX_DELAY_MS: 30_000, // 30s max reconnect cap
  },
} as const;

export type ProtectedResource = typeof RESILIENCE_CONFIG.BLOOM.PROTECTED_RESOURCES[number];
