import crypto from 'crypto';
import pg from 'pg';
import { BloomFilter } from './bloomFilter.js';
import { ProtectedResource, RESILIENCE_CONFIG } from './resilienceConfig.js';
import { getPool } from '../../database/connection.js';
import { cacheGet, cacheSet } from '../../database/redis.js';
import { bloomSyncBus, BloomSyncEvent } from './bloomSyncBus.js';

export type BloomServiceState = 'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'DEGRADED' | 'REBUILDING';

export interface BloomFilterMetrics {
  state: BloomServiceState;
  checksTotal: number;
  negativeTotal: number;
  positiveTotal: number;
  falsePositiveTotal: number;
  bypassTotal: number;
  rebuildTotal: number;
  rebuildDurationMs: number;
  syncEventsSent: number;
  syncEventsReceived: number;
  items: Record<ProtectedResource, number>;
  versions: Record<ProtectedResource, number>;
  memoryBytes: Record<ProtectedResource, number>;
  isBypassMode: boolean;
  isSyncHealthy: boolean;
}

/**
 * Enterprise Bloom Filter Service for Database Overload Protection.
 * 
 * Non-Negotiable Core Invariants:
 * 1. PostgreSQL is the absolute, durable source of truth.
 * 2. Bloom Filter is an optimization shield ONLY.
 * 3. Bloom Positive -> MAY EXIST -> Must query PostgreSQL authoritatively.
 * 4. Bloom Negative -> DEFINITELY ABSENT -> Safe to 404 without querying DB,
 *    BUT ONLY WHEN Bloom is in 'READY' state and multi-instance sync is healthy.
 * 5. If Bloom is UNINITIALIZED, INITIALIZING, DEGRADED, REBUILDING, or sync is uncertain:
 *    SAFE DEGRADATION: BYPASS BLOOM -> QUERY POSTGRESQL.
 *    Never return 404 based on an uncertain Bloom filter!
 * 6. Multi-Instance Synchronized: Committed writes broadcast via BloomSyncBus.
 * 7. Rebuild Race-Free: Delta buffer captures concurrent additions and applies them before swap.
 */
export class BloomFilterService {
  public readonly instanceId: string = crypto.randomUUID();
  private filters: Map<ProtectedResource, BloomFilter> = new Map();
  private versions: Map<ProtectedResource, number> = new Map();
  private state: BloomServiceState = 'UNINITIALIZED';
  private isBypassMode: boolean = false;

  // Active shadow rebuilds, concurrent-write delta buffers, and recent additions buffer
  private activeRebuilds: Map<ProtectedResource, Promise<void>> = new Map();
  private rebuildDeltaBuffers: Map<ProtectedResource, Set<string>> = new Map();
  private recentAdditions: Map<ProtectedResource, Set<string>> = new Map();

  private unsubscribeBus?: () => void;

  // Telemetry & Observability
  private metrics = {
    checksTotal: 0,
    negativeTotal: 0,
    positiveTotal: 0,
    falsePositiveTotal: 0,
    bypassTotal: 0,
    rebuildTotal: 0,
    rebuildDurationMs: 0,
    syncEventsSent: 0,
    syncEventsReceived: 0,
  };

  constructor() {
    this.resetFilters();

    // Subscribe this instance to cluster-wide synchronization events
    this.unsubscribeBus = bloomSyncBus.subscribe((event: BloomSyncEvent) => {
      // Discard events originating from this exact instance
      if (event.instanceId === this.instanceId) return;
      this.handleRemoteSync(event);
    });
  }

  /**
   * Resets all resource filters to empty state.
   */
  public resetFilters(): void {
    for (const res of RESILIENCE_CONFIG.BLOOM.PROTECTED_RESOURCES) {
      this.filters.set(
        res,
        new BloomFilter({
          expectedItems: RESILIENCE_CONFIG.BLOOM.DEFAULT_EXPECTED_ITEMS,
          falsePositiveRate: RESILIENCE_CONFIG.BLOOM.DEFAULT_FALSE_POSITIVE_RATE,
        })
      );
      this.versions.set(res, 1);
      this.recentAdditions.set(res, new Set<string>());
    }
  }

  /**
   * Handles remote synchronization additions from sibling instances.
   */
  private handleRemoteSync(event: BloomSyncEvent): void {
    if (event.operation === 'ADD' && event.resourceId) {
      this.addLocal(event.resource, event.resourceId);
      this.metrics.syncEventsReceived++;
    }
  }

  /**
   * Registers a newly committed entity identifier into the Bloom Filter.
   * CRITICAL: Must be called strictly AFTER the PostgreSQL transaction commits.
   * Updates local bitset, in-flight rebuild delta buffer, and broadcasts to sibling nodes.
   */
  public add(resource: ProtectedResource, id: string): void {
    if (!id || typeof id !== 'string') return;

    // 1. Add to local active filter and delta buffer
    this.addLocal(resource, id);

    // 2. Stage ephemeral recent write flag in Redis (10s TTL) for read-after-write propagation safety
    cacheSet(`bloom:recent:${resource}:${id}`, '1', 10).catch(() => {});

    // 3. Broadcast across distributed cluster via BloomSyncBus
    bloomSyncBus.publish({
      resource,
      operation: 'ADD',
      resourceId: id,
      instanceId: this.instanceId,
      timestamp: Date.now(),
    }).catch((err) => {
      console.warn('[BloomFilterService Warning] Failed to publish sync event:', err.message);
    });

    this.metrics.syncEventsSent++;
  }

  /**
   * Internal local addition: mutates active filter AND any in-flight rebuild delta buffer.
   */
  public addLocal(resource: ProtectedResource, id: string): void {
    if (!id || typeof id !== 'string') return;

    // Mutate current active filter
    const filter = this.filters.get(resource);
    if (filter) {
      filter.add(id);
    }

    // Capture in recent additions window (WAL/boundary buffer)
    let recents = this.recentAdditions.get(resource);
    if (!recents) {
      recents = new Set<string>();
      this.recentAdditions.set(resource, recents);
    }
    recents.add(id);
    if (recents.size > 20000) {
      const iter = recents.values();
      for (let i = 0; i < 5000; i++) {
        const next = iter.next();
        if (next.done) break;
        recents.delete(next.value);
      }
    }

    // Phase 2: If a shadow rebuild is currently in flight for this resource,
    // buffer this concurrent addition so it is guaranteed to be merged into
    // the shadow filter before activation!
    const deltaBuffer = this.rebuildDeltaBuffers.get(resource);
    if (deltaBuffer) {
      deltaBuffer.add(id);
    }
  }

  /**
   * Evaluates if a resource ID might exist.
   * 
   * Returns:
   * - false: DEFINITELY ABSENT. Safe to reject with 404 without querying PostgreSQL.
   * - true:  MAY EXIST or UNCERTAIN. Must query PostgreSQL authoritatively.
   */
  public mightContain(resource: ProtectedResource, id: string): boolean {
    this.metrics.checksTotal++;

    // NON-NEGOTIABLE SAFETY INVARIANT:
    // If the service is NOT in READY state (e.g. UNINITIALIZED, INITIALIZING, DEGRADED, REBUILDING),
    // or if in explicit bypass mode, or if ID is empty/invalid, or if cluster sync is unhealthy:
    // ALWAYS return true to force authoritative PostgreSQL lookup!
    // Never produce a false negative when uncertain!
    if (
      this.state !== 'READY' ||
      this.isBypassMode ||
      !bloomSyncBus.isHealthy() ||
      !id ||
      typeof id !== 'string'
    ) {
      this.metrics.bypassTotal++;
      return true; // True triggers authoritative PostgreSQL query
    }

    const filter = this.filters.get(resource);
    if (!filter) {
      this.metrics.bypassTotal++;
      return true;
    }

    const exists = filter.mightContain(id);
    if (!exists) {
      // Check local recent-additions boundary window before concluding absent
      const recents = this.recentAdditions.get(resource);
      if (recents && recents.has(id)) {
        this.metrics.positiveTotal++;
        return true;
      }

      this.metrics.negativeTotal++;
      return false; // Definitely not present
    }

    this.metrics.positiveTotal++;
    return true; // May be present
  }

  /**
   * Safe asynchronous Bloom check that guards against the transient
   * read-after-write propagation window across distributed nodes (Finding F-9.1-02).
   * 
   * Flow:
   * 1. Check local in-memory Bloom filter (fast, 0ms, 0 I/O).
   * 2. If Bloom returns true -> return true immediately (MAY EXIST -> query PostgreSQL).
   * 3. If Bloom returns false:
   *    Check if the ID was recently written across the cluster within the
   *    propagation window (via Redis fast key 'bloom:recent:{resource}:{id}').
   *    - If recent key exists -> return true (prevents 404 during pub/sub latency window).
   *    - If recent key absent -> return false (safe to 404 without querying PostgreSQL).
   *    - If Redis is degraded/down -> bloomSyncBus.isHealthy() is false, so it fails open (returns true).
   */
  public async mightContainSafe(resource: ProtectedResource, id: string): Promise<boolean> {
    if (this.mightContain(resource, id)) {
      return true;
    }

    // Local filter returned false. Check distributed recent-writes window across cluster
    try {
      const recentKey = `bloom:recent:${resource}:${id}`;
      const isRecent = await cacheGet(recentKey);
      if (isRecent) {
        return true; // Recently committed on a sibling node, force authoritative DB query
      }
    } catch {
      // On cache read error, fail safe to authoritative DB
      return true;
    }

    return false;
  }

  /**
   * Records a confirmed false positive when Bloom returned true but PostgreSQL returned null.
   */
  public recordFalsePositive(): void {
    this.metrics.falsePositiveTotal++;
  }

  /**
   * Bootstraps all protected resource filters from PostgreSQL authoritative tables.
   */
  public async initializeFromDatabase(poolOverride?: pg.Pool): Promise<void> {
    const startTime = Date.now();
    const pool = poolOverride || getPool();

    this.state = 'INITIALIZING';

    const resourceTableMap: Record<ProtectedResource, { table: string; col: string }> = {
      orders: { table: 'orders', col: 'id' },
      products: { table: 'products', col: 'id' },
      merchants: { table: 'merchants', col: 'id' },
      users: { table: 'users', col: 'id' },
      returns: { table: 'order_returns', col: 'id' },
      refunds: { table: 'refunds', col: 'id' },
    };

    try {
      for (const res of RESILIENCE_CONFIG.BLOOM.PROTECTED_RESOURCES) {
        await this.rebuildResourceFilter(res, pool, resourceTableMap[res]);
      }
      this.state = 'READY';
      this.metrics.rebuildTotal++;
      this.metrics.rebuildDurationMs = Date.now() - startTime;
    } catch (err: any) {
      // In case of any bootstrap error, engage safe degraded mode to never block queries
      console.warn('[BloomFilter Warning] Failed to bootstrap filters from DB. Engaging safe degraded bypass mode:', err.message);
      this.state = 'DEGRADED';
    }
  }

  /**
   * Atomically rebuilds a single resource's Bloom Filter from PostgreSQL.
   * 
   * Phase 2 & Phase 5 Hardening:
   * 1. Coordinated Mutex: Deduplicates concurrent rebuild requests for the same resource.
   * 2. Keyset Pagination: Reads database in bounded batches (5,000 rows) to eliminate unbounded memory spikes.
   * 3. Delta Buffer: Captures all concurrent writes occurring during the rebuild and merges them before swap.
   * 4. Failure Safety: If rebuild throws, the existing active filter is left 100% intact.
   */
  public rebuildResourceFilter(
    resource: ProtectedResource,
    pool?: pg.Pool,
    mapping?: { table: string; col: string }
  ): Promise<void> {
    // 1. Deduplicate concurrent rebuilds for the same resource
    const existingRebuild = this.activeRebuilds.get(resource);
    if (existingRebuild) {
      return existingRebuild;
    }

    const rebuildPromise = (async () => {
      const runner = pool || getPool();
      const tableInfo = mapping || {
        orders: { table: 'orders', col: 'id' },
        products: { table: 'products', col: 'id' },
        merchants: { table: 'merchants', col: 'id' },
        users: { table: 'users', col: 'id' },
        returns: { table: 'order_returns', col: 'id' },
        refunds: { table: 'refunds', col: 'id' },
      }[resource];

      const shadowFilter = new BloomFilter({
        expectedItems: RESILIENCE_CONFIG.BLOOM.DEFAULT_EXPECTED_ITEMS,
        falsePositiveRate: RESILIENCE_CONFIG.BLOOM.DEFAULT_FALSE_POSITIVE_RATE,
      });

      // Initialize concurrent-write delta buffer
      const deltaBuffer = new Set<string>();
      this.rebuildDeltaBuffers.set(resource, deltaBuffer);

      try {
        // Phase 5: Bounded Keyset Pagination to protect PostgreSQL and Node.js memory
        const batchSize = RESILIENCE_CONFIG.BLOOM.REBUILD_BATCH_SIZE;
        let lastId: string | null = null;

        while (true) {
          const sqlQuery: string = lastId !== null
            ? `SELECT ${tableInfo.col} FROM ${tableInfo.table} WHERE ${tableInfo.col} > $1 ORDER BY ${tableInfo.col} ASC LIMIT ${batchSize}`
            : `SELECT ${tableInfo.col} FROM ${tableInfo.table} ORDER BY ${tableInfo.col} ASC LIMIT ${batchSize}`;
          const sqlParams: any[] = lastId !== null ? [lastId] : [];

          const res: any = await runner.query(sqlQuery, sqlParams);
          if (res.rows.length === 0) break;

          for (const row of res.rows) {
            const val = (row as Record<string, any>)[tableInfo.col];
            if (val) {
              shadowFilter.add(String(val));
              lastId = String(val);
            }
          }

          if (res.rows.length < batchSize) break;
        }

        // Phase 2: Apply all concurrent deltas and recent boundary additions
        const recents = this.recentAdditions.get(resource);
        if (recents) {
          for (const recentId of recents) {
            shadowFilter.add(recentId);
          }
        }

        for (const deltaId of deltaBuffer) {
          shadowFilter.add(deltaId);
        }

        // Atomic swap
        this.filters.set(resource, shadowFilter);
        const currentVersion = this.versions.get(resource) || 1;
        this.versions.set(resource, currentVersion + 1);
      } catch (err: any) {
        const msg = err.message || '';
        if (!msg.includes('relation') && !msg.includes('does not exist')) {
          console.warn(`[BloomFilter Warning] Rebuild failed for '${resource}'. Active filter preserved:`, err.message);
          throw err;
        }
      } finally {
        this.rebuildDeltaBuffers.delete(resource);
        this.activeRebuilds.delete(resource);
      }
    })();

    this.activeRebuilds.set(resource, rebuildPromise);
    return rebuildPromise;
  }

  /**
   * Controls bypass mode (true = force all checks to pass to PostgreSQL)
   */
  public setBypassMode(enabled: boolean): void {
    this.isBypassMode = enabled;
  }

  public getState(): BloomServiceState {
    return this.state;
  }

  public setState(state: BloomServiceState): void {
    this.state = state;
  }

  public getIsInitialized(): boolean {
    return this.state === 'READY';
  }

  /**
   * Retrieves operational observability metrics
   */
  public getMetrics(): BloomFilterMetrics {
    const items: any = {};
    const versions: any = {};
    const memoryBytes: any = {};

    for (const res of RESILIENCE_CONFIG.BLOOM.PROTECTED_RESOURCES) {
      const filter = this.filters.get(res);
      items[res] = filter ? filter.getItemCount() : 0;
      versions[res] = this.versions.get(res) || 1;
      memoryBytes[res] = filter ? filter.getMemoryBytes() : 0;
    }

    return {
      state: this.state,
      checksTotal: this.metrics.checksTotal,
      negativeTotal: this.metrics.negativeTotal,
      positiveTotal: this.metrics.positiveTotal,
      falsePositiveTotal: this.metrics.falsePositiveTotal,
      bypassTotal: this.metrics.bypassTotal,
      rebuildTotal: this.metrics.rebuildTotal,
      rebuildDurationMs: this.metrics.rebuildDurationMs,
      syncEventsSent: this.metrics.syncEventsSent,
      syncEventsReceived: this.metrics.syncEventsReceived,
      items,
      versions,
      memoryBytes,
      isBypassMode: this.isBypassMode,
      isSyncHealthy: bloomSyncBus.isHealthy(),
    };
  }

  public destroy(): void {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
  }
}

export const bloomFilterService = new BloomFilterService();
