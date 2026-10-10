import { cacheGet, cacheSet, cacheDel, acquireLock, releaseLock } from '../../database/redis.js';

export interface CacheProtectionOptions {
  ttlSec: number;
  lockTtlMs?: number;
  jitterPercent?: number;
  bypassCache?: boolean;
}

/**
 * In-process SingleFlight concurrency deduplicator.
 * Guarantees that within a single Node.js runtime process, multiple concurrent
 * requests for the exact same key or expensive computation share a single in-flight Promise.
 */
export class SingleFlightGroup {
  private inFlight = new Map<string, Promise<any>>();
  private executionsTotal = 0;
  private deduplicatedTotal = 0;

  public async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.deduplicatedTotal++;
      return existing as Promise<T>;
    }

    this.executionsTotal++;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  public isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  public getInFlightCount(): number {
    return this.inFlight.size;
  }

  public getMetrics(): { executionsTotal: number; deduplicatedTotal: number; inFlightCount: number } {
    return {
      executionsTotal: this.executionsTotal,
      deduplicatedTotal: this.deduplicatedTotal,
      inFlightCount: this.inFlight.size,
    };
  }

  public clear(): void {
    this.inFlight.clear();
    this.executionsTotal = 0;
    this.deduplicatedTotal = 0;
  }
}

/**
 * Cache Protection Service for Enterprise Workloads.
 * 
 * Non-Negotiable Invariants:
 * 1. PostgreSQL is the absolute source of truth.
 * 2. Caching is strictly an optimization shield for expensive reads (e.g. Master Catalog, Categories).
 * 3. Cache Stampede / Thundering Herd Prevention:
 *    - In-process: SingleFlight deduplicates concurrent requests.
 *    - Multi-instance: Distributed mutex (acquireLock) coordinates cache population.
 * 4. Jittered TTLs: Prevents simultaneous mass expiration across cached keys.
 * 5. Fail-Safe Degradation: If Redis fails, crashes, or is partitioned:
 *    - Automatically falls open to PostgreSQL loader via in-process SingleFlight.
 *    - ZERO request crashes, zero unhandled errors.
 * 6. Financial transactions (orders, refunds, settlements) NEVER use cache locks for truth.
 */
export class CacheProtectionService {
  private singleFlight = new SingleFlightGroup();
  private metrics = {
    hitsTotal: 0,
    missesTotal: 0,
    loadsTotal: 0,
    redisFailuresTotal: 0,
  };

  /**
   * Fetches data through ephemeral cache with complete stampede protection.
   */
  public async fetchThroughCache<T>(
    key: string,
    options: CacheProtectionOptions,
    loader: () => Promise<T>
  ): Promise<T> {
    if (options.bypassCache) {
      return loader();
    }

    const lockTtlMs = options.lockTtlMs ?? 2000;
    const jitterPercent = options.jitterPercent ?? 10;

    // 1. Initial Cache Check (fast path)
    try {
      const cached = await cacheGet(key);
      if (cached !== null) {
        this.metrics.hitsTotal++;
        return JSON.parse(cached) as T;
      }
    } catch (err: any) {
      this.metrics.redisFailuresTotal++;
      console.warn(`[CacheProtection] Redis read failed for '${key}', falling open:`, err.message);
    }

    this.metrics.missesTotal++;

    // 2. In-Process SingleFlight Deduplication
    return this.singleFlight.do(key, async () => {
      // 2a. Double-check cache in case a sibling request in this process populated it
      try {
        const doubleCheck = await cacheGet(key);
        if (doubleCheck !== null) {
          this.metrics.hitsTotal++;
          return JSON.parse(doubleCheck) as T;
        }
      } catch {
        // Fall through
      }

      // 2b. Coordinate across distributed cluster instances via distributed lock
      let lockResult: { acquired: boolean; token: string } = { acquired: false, token: '' };
      const lockKey = `cache:load:${key}`;

      try {
        lockResult = await acquireLock(lockKey, lockTtlMs);
      } catch (err: any) {
        this.metrics.redisFailuresTotal++;
        console.warn(`[CacheProtection] Distributed lock failed for '${lockKey}', continuing with loader:`, err.message);
      }

      if (lockResult.acquired) {
        try {
          // This node won the lock: execute loader and write to cache
          this.metrics.loadsTotal++;
          const data = await loader();

          // Calculate jittered TTL: base +/- jitterPercent
          const jitterFactor = 1 + ((Math.random() * 2 - 1) * jitterPercent) / 100;
          const ttlSec = Math.max(1, Math.round(options.ttlSec * jitterFactor));

          try {
            await cacheSet(key, JSON.stringify(data), ttlSec);
          } catch (setErr: any) {
            console.warn(`[CacheProtection] Cache write failed for '${key}':`, setErr.message);
          }

          return data;
        } finally {
          try {
            await releaseLock(lockKey, lockResult.token);
          } catch {
            // Ignore lock release error
          }
        }
      } else {
        // Another instance is loading this key. Wait briefly (50ms) and check cache
        await new Promise((resolve) => setTimeout(resolve, 50));

        try {
          const retried = await cacheGet(key);
          if (retried !== null) {
            this.metrics.hitsTotal++;
            return JSON.parse(retried) as T;
          }
        } catch {
          // Fall through
        }

        // If still not available (e.g. peer slow or failed), execute loader directly
        this.metrics.loadsTotal++;
        return loader();
      }
    });
  }

  /**
   * Invalidates a cached key.
   */
  public async invalidate(key: string): Promise<void> {
    try {
      await cacheDel(key);
    } catch (err: any) {
      console.warn(`[CacheProtection] Invalidation failed for '${key}':`, err.message);
    }
  }

  public getSingleFlight(): SingleFlightGroup {
    return this.singleFlight;
  }

  public getMetrics() {
    return {
      ...this.metrics,
      singleFlight: this.singleFlight.getMetrics(),
    };
  }

  public resetMetrics(): void {
    this.metrics = {
      hitsTotal: 0,
      missesTotal: 0,
      loadsTotal: 0,
      redisFailuresTotal: 0,
    };
    this.singleFlight.clear();
  }
}

export const cacheProtectionService = new CacheProtectionService();
