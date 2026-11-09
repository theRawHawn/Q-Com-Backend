import { EventEmitter } from 'events';
import { ProtectedResource, RESILIENCE_CONFIG } from './resilienceConfig.js';
import { getRedisClient, createRedisSubscriber, inMemoryStore } from '../../database/redis.js';

export interface BloomSyncEvent {
  resource: ProtectedResource;
  operation: 'ADD';
  resourceId: string;
  instanceId: string;
  timestamp: number;
}

export type BloomSyncListener = (event: BloomSyncEvent) => void;

/**
 * Cross-Instance Synchronization Bus for Bloom Filter Additions.
 * 
 * Flow:
 * 1. PostgreSQL transaction completes and commits.
 * 2. Originating instance calls bloomSyncBus.publish(event).
 * 3. Event is broadcast to other instances via Redis Pub/Sub (in distributed mode)
 *    and internal event emitter (for in-process sibling instances in tests/clusters).
 * 4. Sibling instances receive event and idempotently update their local Bloom filters.
 * 
 * Non-Negotiable Safety Invariant:
 * - Redis and Bloom are strictly non-authoritative. PostgreSQL remains the sole source of truth.
 * - If Redis Pub/Sub fails, disconnects, or is degraded, isHealthy() returns false.
 * - Sibling instances detect degraded synchronization health and safely BYPASS Bloom filters,
 *   falling back directly to authoritative PostgreSQL queries.
 * - Under NO circumstances will an un-synchronized or degraded Bloom filter return a false negative.
 */
export class BloomSyncBus {
  private emitter = new EventEmitter();
  private healthy = true;
  private subscriberClient: any = null;
  private inMemoryUnsubscribe?: () => void;
  private redisSubscriberAttached = false;
  private eventCount = 0;
  private messagesReceived = 0;
  private syncChannel: string = RESILIENCE_CONFIG.BLOOM.SYNC_CHANNEL;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publishes a Bloom synchronization event to all cluster nodes.
   * Dispatches locally, via in-memory pubsub, and via Redis Pub/Sub if connected.
   */
  public async publish(event: BloomSyncEvent): Promise<void> {
    if (!event || !event.resourceId) return;

    this.eventCount++;

    // 1. Dispatch to in-process listeners (sibling instances / mock cluster)
    this.emitter.emit('bloom:sync', event);

    // 2. Broadcast across distributed nodes via Redis Pub/Sub if available
    try {
      const client = getRedisClient();
      if (client) {
        await client.publish(this.syncChannel, JSON.stringify(event));
      } else {
        // In test/local mode without Redis daemon, broadcast via in-memory pubsub
        inMemoryStore.publish(this.syncChannel, JSON.stringify(event));
      }
    } catch (err: any) {
      console.warn('[BloomSyncBus Warning] Redis publish failed. Synchronization marked degraded:', err.message);
      this.healthy = false;
    }
  }

  /**
   * Subscribes an instance to synchronization events.
   */
  public subscribe(listener: BloomSyncListener): () => void {
    this.emitter.on('bloom:sync', listener);
    return () => {
      this.emitter.off('bloom:sync', listener);
    };
  }

  /**
   * Returns current synchronization bus health.
   * If false, all consuming Bloom filters MUST enter DEGRADED bypass mode.
   */
  public isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Manually sets health state (used for testing degraded mode and Redis outage simulation).
   */
  public setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /**
   * Attaches Redis subscriber if in distributed mode.
   * Listens on the cross-instance Redis channel and dispatches incoming events.
   */
  public attachRedisSubscriber(subscriberOverride?: any): void {
    if (this.redisSubscriberAttached && (this.subscriberClient || this.inMemoryUnsubscribe)) {
      return;
    }

    try {
      const client = subscriberOverride || createRedisSubscriber();

      if (client) {
        this.subscriberClient = client;

        // Register message handler on dedicated subscriber client
        client.on('message', (channel: string, message: string) => {
          if (channel === this.syncChannel) {
            try {
              const event: BloomSyncEvent = JSON.parse(message);
              this.messagesReceived++;
              this.emitter.emit('bloom:sync', event);
            } catch (err: any) {
              console.warn('[BloomSyncBus Warning] Failed to parse Redis sync message:', err.message);
            }
          }
        });

        // Register connection event handlers
        client.on('error', (err: any) => {
          console.warn('[BloomSyncBus Warning] Redis subscriber connection error, marking degraded:', err.message);
          this.healthy = false;
        });

        client.on('close', () => {
          console.warn('[BloomSyncBus Warning] Redis subscriber connection closed, marking degraded');
          this.healthy = false;
        });

        client.on('connect', () => {
          this.healthy = true;
        });

        client.on('ready', () => {
          this.healthy = true;
        });

        // Issue active subscribe command
        if (typeof client.subscribe === 'function') {
          const subRes = client.subscribe(this.syncChannel);
          if (subRes && typeof subRes.catch === 'function') {
            subRes.catch((err: any) => {
              console.warn('[BloomSyncBus Warning] Failed to subscribe to Redis channel:', err.message);
              this.healthy = false;
            });
          }
        }

        this.redisSubscriberAttached = true;
      } else {
        // Fallback: Attach in-memory pubsub listener for tests or local dev
        this.inMemoryUnsubscribe = inMemoryStore.subscribe(this.syncChannel, (message: string) => {
          try {
            const event: BloomSyncEvent = JSON.parse(message);
            this.messagesReceived++;
            this.emitter.emit('bloom:sync', event);
          } catch (err: any) {
            console.warn('[BloomSyncBus Warning] Failed to parse in-memory message:', err.message);
          }
        });
        this.redisSubscriberAttached = true;
      }
    } catch (err: any) {
      console.warn('[BloomSyncBus Warning] Failed to attach subscriber:', err.message);
      this.healthy = false;
    }
  }

  /**
   * Detaches and closes subscriber cleanly.
   */
  public async detachRedisSubscriber(): Promise<void> {
    if (this.inMemoryUnsubscribe) {
      this.inMemoryUnsubscribe();
      this.inMemoryUnsubscribe = undefined;
    }

    if (this.subscriberClient) {
      try {
        if (typeof this.subscriberClient.unsubscribe === 'function') {
          await this.subscriberClient.unsubscribe(this.syncChannel);
        }
        if (typeof this.subscriberClient.quit === 'function') {
          await this.subscriberClient.quit();
        } else if (typeof this.subscriberClient.disconnect === 'function') {
          this.subscriberClient.disconnect();
        }
      } catch {
        // Suppress teardown errors
      }
      this.subscriberClient = null;
    }

    this.redisSubscriberAttached = false;
  }

  public isSubscriberAttached(): boolean {
    return this.redisSubscriberAttached;
  }

  public getMessagesReceived(): number {
    return this.messagesReceived;
  }

  /**
   * Resets bus state for test isolation.
   */
  public reset(): void {
    this.emitter.removeAllListeners();
    this.healthy = true;
    this.eventCount = 0;
    this.messagesReceived = 0;
  }

  public getEventCount(): number {
    return this.eventCount;
  }
}

export const bloomSyncBus = new BloomSyncBus();
