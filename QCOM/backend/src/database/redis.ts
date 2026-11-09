import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

let redisClient: Redis | null = null;
let redisSubscriberClient: Redis | null = null;
let isRedisConnected = false;

/**
 * High-performance in-memory fallback store strictly intended for local development,
 * CI pipelines, or automated unit testing.
 * 
 * ARCHITECTURAL SAFETY NOTE:
 * This is a single-process, local memory implementation. It is NEVER a multi-instance
 * distributed lock or distributed cache. It is strictly disabled in production.
 */
class InMemoryCacheStore {
  private store = new Map<string, { val: string; expiresAt?: number }>();
  private locks = new Map<string, { token: string; expiresAt: number }>();
  private requestLogs = new Map<string, number[]>();
  private channelSubscribers = new Map<string, Set<(message: string) => void>>();

  get(key: string): string | null {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.val;
  }

  set(key: string, val: string, ttlSec?: number): void {
    const expiresAt = ttlSec ? Date.now() + ttlSec * 1000 : undefined;
    this.store.set(key, { val, expiresAt });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  incr(key: string, ttlSec?: number): number {
    const current = parseInt(this.get(key) || '0', 10);
    const next = current + 1;
    this.set(key, next.toString(), ttlSec);
    return next;
  }

  publish(channel: string, message: string): number {
    const subs = this.channelSubscribers.get(channel);
    if (!subs || subs.size === 0) return 0;
    for (const sub of subs) {
      try {
        sub(message);
      } catch (err: any) {
        console.warn('[InMemory Pub/Sub] Listener threw error:', err.message);
      }
    }
    return subs.size;
  }

  subscribe(channel: string, listener: (message: string) => void): () => void {
    let subs = this.channelSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.channelSubscribers.set(channel, subs);
    }
    subs.add(listener);
    return () => {
      subs?.delete(listener);
    };
  }

  acquireLock(lockKey: string, ttlMs: number, token: string): boolean {
    const now = Date.now();
    const existing = this.locks.get(lockKey);
    if (existing && existing.expiresAt > now) {
      return false;
    }
    this.locks.set(lockKey, { token, expiresAt: now + ttlMs });
    return true;
  }

  releaseLock(lockKey: string, token: string): boolean {
    const existing = this.locks.get(lockKey);
    if (!existing) return true;
    if (existing.token === token) {
      this.locks.delete(lockKey);
      return true;
    }
    return false;
  }

  slidingWindowRateLimit(key: string, limit: number, windowSec: number): { allowed: boolean; remaining: number; resetSec: number } {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const windowStart = now - windowMs;

    let timestamps = this.requestLogs.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0] || now;
      const resetSec = Math.ceil((oldest + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, resetSec: Math.max(1, resetSec) };
    }

    timestamps.push(now);
    this.requestLogs.set(key, timestamps);
    const resetSec = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
    return { allowed: true, remaining: limit - timestamps.length, resetSec };
  }

  clear(): void {
    this.store.clear();
    this.locks.clear();
    this.requestLogs.clear();
    this.channelSubscribers.clear();
  }
}

export const inMemoryStore = new InMemoryCacheStore();

/**
 * Production safeguard: Ensures in-memory fallbacks cannot silently execute in production.
 */
function assertInMemoryFallbackAllowed(operation: string): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `[CRITICAL DISTRIBUTED SAFETY] In-memory fallback for '${operation}' is strictly prohibited in production. ` +
      `Multi-instance coordination requires a reachable, authoritative Redis cluster.`
    );
  }
}

/**
 * Initializes or returns the Redis client.
 * Connects lazily. In development/testing, falls back to in-memory store if Redis is unavailable.
 */
export function getRedisClient(): Redis | null {
  if (process.env.NODE_ENV === 'test' && !process.env.FORCE_REDIS) {
    return null;
  }

  if (!redisClient && env.REDIS_URL) {
    try {
      redisClient = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: env.NODE_ENV === 'production' ? 3 : 1,
        retryStrategy: (times: number) => {
          if (env.NODE_ENV !== 'production' && times > 3) {
            console.warn('[Redis] Max dev connection retries reached. Operating in In-Memory fallback mode.');
            return null;
          }
          if (env.NODE_ENV === 'production' && times > 10) {
            console.error('[Redis Fatal] Unable to reach Redis cluster in production after 10 attempts.');
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        enableReadyCheck: true,
        connectTimeout: env.NODE_ENV === 'production' ? 5000 : 2000,
      });

      redisClient.on('connect', () => {
        isRedisConnected = true;
        console.log('[Redis] Ephemeral cache connected to:', env.REDIS_URL);
      });

      redisClient.on('error', (err: any) => {
        isRedisConnected = false;
        if (env.NODE_ENV === 'production') {
          console.error('[Redis Error] Connection failure in production:', err.message);
        } else if (env.LOG_LEVEL === 'debug') {
          console.warn('[Redis Warning] Connection error in development:', err.message);
        }
      });

      redisClient.on('close', () => {
        isRedisConnected = false;
      });

      redisClient.connect().catch((err: any) => {
        isRedisConnected = false;
        if (env.NODE_ENV === 'production') {
          console.error('[Redis Error] Failed to connect to Redis in production:', err.message);
        } else if (env.LOG_LEVEL === 'debug') {
          console.warn('[Redis Connect Note] Local Redis server not reachable, using in-memory store:', err.message);
        }
      });
    } catch (err: any) {
      isRedisConnected = false;
      if (env.NODE_ENV === 'production') {
        console.error('[Redis Init Fatal] Failed to initialize Redis in production:', err.message);
        throw err;
      }
      console.warn('[Redis Init] Failed to initialize client, using in-memory store:', err.message);
    }
  }

  return isRedisConnected ? redisClient : null;
}

/**
 * Creates a dedicated Redis subscriber instance.
 * In Redis, a connection in subscribe mode cannot execute regular data commands.
 * Therefore, pub/sub listeners must use a dedicated duplicated client.
 */
export function createRedisSubscriber(): Redis | null {
  if (process.env.NODE_ENV === 'test' && !process.env.FORCE_REDIS) {
    return null;
  }
  if (!env.REDIS_URL) {
    return null;
  }

  const mainClient = getRedisClient();
  if (!mainClient) {
    // If primary Redis client is not reachable / not connected, fall back to in-memory mode
    return null;
  }

  try {
    const sub = mainClient.duplicate();
    sub.connect().catch((err: any) => {
      if (env.LOG_LEVEL === 'debug') {
        console.warn('[Redis Subscriber Note] Duplicate subscriber connection error:', err.message);
      }
    });
    redisSubscriberClient = sub;
    return sub;
  } catch (err: any) {
    console.warn('[Redis Subscriber] Failed to create subscriber client:', err.message);
    return null;
  }
}

/**
 * Cache GET: In production, Redis downtime acts as a cache miss (forces read from PostgreSQL).
 * In development/test, reads from inMemoryStore.
 */
export async function cacheGet(key: string): Promise<string | null> {
  const client = getRedisClient();
  if (client && isRedisConnected) {
    try {
      return await client.get(key);
    } catch {
      // In production, treat Redis read failure as a safe cache miss
      if (env.NODE_ENV === 'production') {
        console.warn(`[Cache Warning] Redis read error for '${key}'. Bypassing cache to query durable database.`);
        return null;
      }
    }
  }

  if (env.NODE_ENV === 'production') {
    return null;
  }
  return inMemoryStore.get(key);
}

/**
 * Cache SET: In production, fails open (skips caching) if Redis is down.
 * In development/test, writes to inMemoryStore.
 */
export async function cacheSet(key: string, value: string, ttlSec?: number): Promise<void> {
  const client = getRedisClient();
  if (client && isRedisConnected) {
    try {
      if (ttlSec) {
        await client.set(key, value, 'EX', ttlSec);
      } else {
        await client.set(key, value);
      }
      return;
    } catch {
      if (env.NODE_ENV === 'production') {
        console.warn(`[Cache Warning] Redis write failed for '${key}'. Skipping ephemeral cache.`);
        return;
      }
    }
  }

  if (env.NODE_ENV === 'production') {
    return;
  }
  inMemoryStore.set(key, value, ttlSec);
}

/**
 * Cache DELETE
 */
export async function cacheDel(key: string): Promise<void> {
  const client = getRedisClient();
  if (client && isRedisConnected) {
    try {
      await client.del(key);
      return;
    } catch {
      if (env.NODE_ENV === 'production') return;
    }
  }

  if (env.NODE_ENV === 'production') return;
  inMemoryStore.del(key);
}

/**
 * Cache INCR: In production, atomic distributed counters strictly require Redis.
 */
export async function cacheIncr(key: string, ttlSec?: number): Promise<number> {
  const client = getRedisClient();
  if (client && isRedisConnected) {
    try {
      const val = await client.incr(key);
      if (val === 1 && ttlSec) {
        await client.expire(key, ttlSec);
      }
      return val;
    } catch (err: any) {
      if (env.NODE_ENV === 'production') {
        throw new Error(`[Atomic Counter Error] Failed to increment counter in Redis: ${err.message}`);
      }
    }
  }

  assertInMemoryFallbackAllowed('atomic_counter_incr');
  return inMemoryStore.incr(key, ttlSec);
}

/**
 * Distributed Lock / Mutex:
 * In production: Strictly requires Redis NX. Throws if Redis is unreachable.
 * In development/testing: Falls back to single-process in-memory mutex with explicit warning.
 */
export async function acquireLock(
  lockKey: string,
  ttlMs: number = 5000,
  token: string = Math.random().toString(36).substring(2)
): Promise<{ acquired: boolean; token: string }> {
  const fullKey = `lock:${lockKey}`;
  const client = getRedisClient();

  if (client && isRedisConnected) {
    try {
      const res = await client.set(fullKey, token, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        return { acquired: true, token };
      }
      return { acquired: false, token };
    } catch (err: any) {
      if (env.NODE_ENV === 'production') {
        console.error('[Distributed Lock] Redis lock operation failed in production:', err.message);
        throw new Error(`[Distributed Lock Error] Redis lock failed in production: ${err.message}`);
      }
    }
  }

  // Safety safeguard: strictly disallow in-memory lock in production
  assertInMemoryFallbackAllowed('distributed_lock_acquire');
  
  const acquired = inMemoryStore.acquireLock(fullKey, ttlMs, token);
  return { acquired, token };
}

/**
 * Releases a distributed lock safely using token comparison.
 */
export async function releaseLock(lockKey: string, token: string): Promise<boolean> {
  const fullKey = `lock:${lockKey}`;
  const client = getRedisClient();

  if (client && isRedisConnected) {
    try {
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const res = await client.eval(luaScript, 1, fullKey, token);
      return res === 1;
    } catch (err: any) {
      if (env.NODE_ENV === 'production') {
        console.error('[Distributed Lock] Redis release operation failed in production:', err.message);
        throw new Error(`[Distributed Lock Error] Redis release failed in production: ${err.message}`);
      }
    }
  }

  assertInMemoryFallbackAllowed('distributed_lock_release');
  return inMemoryStore.releaseLock(fullKey, token);
}

/**
 * Sliding Window Rate Limiter
 */
export async function slidingWindowRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
  const fullKey = `ratelimit:${key}`;
  const client = getRedisClient();

  if (client && isRedisConnected) {
    try {
      const now = Date.now();
      const script = `
        local now = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window_ms)
        local count = redis.call('ZCARD', KEYS[1])
        if count >= limit then
          local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
          local reset_sec = math.max(1, math.ceil((tonumber(oldest[2]) + window_ms - now) / 1000))
          return {0, 0, reset_sec}
        end
        redis.call('ZADD', KEYS[1], now, ARGV[4])
        redis.call('PEXPIRE', KEYS[1], window_ms)
        return {1, limit - count - 1, tonumber(ARGV[5])}
      `;
      const result = await client.eval(
        script,
        1,
        fullKey,
        now.toString(),
        (windowSec * 1000).toString(),
        limit.toString(),
        randomUUID(),
        windowSec.toString()
      ) as number[];

      return {
        allowed: Number(result[0]) === 1,
        remaining: Number(result[1]),
        resetSec: Number(result[2]),
      };
    } catch (err) {
      console.error('[RateLimit Error] Redis sliding-window check failed.');
      if (env.NODE_ENV === 'production') {
        throw new Error('DISTRIBUTED_RATE_LIMIT_UNAVAILABLE', { cause: err });
      }
    }
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('DISTRIBUTED_RATE_LIMIT_UNAVAILABLE');
  }

  return inMemoryStore.slidingWindowRateLimit(fullKey, limit, windowSec);
}

/**
 * Health check probe for Ephemeral Cache
 */
export async function checkRedisHealth(): Promise<{ alive: boolean; latencyMs: number; mode: 'redis' | 'memory'; error?: string }> {
  const start = Date.now();
  if (redisClient && isRedisConnected) {
    try {
      await redisClient.ping();
      return {
        alive: true,
        latencyMs: Date.now() - start,
        mode: 'redis',
      };
    } catch (err: any) {
      if (env.NODE_ENV === 'production') {
        return {
          alive: false,
          latencyMs: Date.now() - start,
          mode: 'redis',
          error: `Redis disconnected in production: ${err.message}`,
        };
      }
      return {
        alive: true,
        latencyMs: Date.now() - start,
        mode: 'memory',
        error: `Redis disconnected (${err.message}). In-memory fallback active.`,
      };
    }
  }

  if (env.NODE_ENV === 'production') {
    return {
      alive: false,
      latencyMs: 0,
      mode: 'redis',
      error: 'Redis connection is required in production environment but client is disconnected',
    };
  }

  return {
    alive: true,
    latencyMs: 0,
    mode: 'memory',
  };
}

/**
 * Gracefully closes Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisSubscriberClient) {
    try {
      await redisSubscriberClient.quit();
    } catch {
      redisSubscriberClient.disconnect();
    }
    redisSubscriberClient = null;
  }
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.disconnect();
    }
    redisClient = null;
    isRedisConnected = false;
  }
}
