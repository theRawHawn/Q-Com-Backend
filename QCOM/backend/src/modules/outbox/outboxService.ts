import pg from 'pg';
import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { OutboxEvent, OutboxEventHandler, StageEventInput } from './outboxTypes.js';
import { calculateFullJitterDelay } from '../resilience/retryPolicy.js';

export class OutboxService {
  private consumers: Map<string, OutboxEventHandler[]> = new Map();
  private wildcardConsumers: OutboxEventHandler[] = [];
  private relayerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private maxAttempts = 5;

  /**
   * Registers a domain event consumer callback.
   * Enables modular, decoupled event consumption (e.g. notifications, dispatch, settlements).
   */
  public registerConsumer(eventType: string, handler: OutboxEventHandler): void {
    if (eventType === '*') {
      this.wildcardConsumers.push(handler);
      return;
    }
    const list = this.consumers.get(eventType) || [];
    list.push(handler);
    this.consumers.set(eventType, list);
  }

  /**
   * Stages a domain event strictly WITHIN an active database transaction.
   * Guarantees atomic dual-write consistency: if the transaction rolls back,
   * the event is rolled back and will never be published.
   */
  public async stageEvent(
    client: pg.PoolClient,
    input: StageEventInput
  ): Promise<OutboxEvent> {
    const eventId = crypto.randomUUID();
    const res = await client.query(
      `INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id, payload,
        status, attempt_count, next_attempt_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, NOW(), NOW())
      RETURNING id, event_type, aggregate_type, aggregate_id, payload,
                status, attempt_count, next_attempt_at, created_at, published_at, last_error`,
      [
        eventId,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
      ]
    );

    const row = res.rows[0];
    return {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at ? row.published_at.toISOString() : undefined,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at.toISOString(),
      lastError: row.last_error || undefined,
      status: row.status,
    };
  }

  /**
   * Concurrently claims a batch of pending events using row-level locking.
   * Automatically skips locked rows if supported or locks claimed rows for update.
   */
  public async claimPendingEvents(
    batchSize: number = 20,
    clientOverride?: pg.PoolClient
  ): Promise<OutboxEvent[]> {
    const execute = async (client: pg.PoolClient) => {
      // Use FOR UPDATE to prevent race conditions across parallel relayer workers
      let query = `
        SELECT id, event_type, aggregate_type, aggregate_id, payload,
               status, attempt_count, next_attempt_at, created_at, published_at, last_error
        FROM outbox_events
        WHERE status = 'PENDING' AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE
      `;

      // Try FOR UPDATE SKIP LOCKED for high-throughput concurrency
      try {
        const testRes = await client.query(
          `SELECT id, event_type, aggregate_type, aggregate_id, payload,
                  status, attempt_count, next_attempt_at, created_at, published_at, last_error
           FROM outbox_events
           WHERE status = 'PENDING' AND next_attempt_at <= NOW()
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [batchSize]
        );
        return this.mapRowsToEvents(testRes.rows);
      } catch {
        // Fallback to standard FOR UPDATE if SKIP LOCKED not supported by dialect/mock
        const fallbackRes = await client.query(query, [batchSize]);
        return this.mapRowsToEvents(fallbackRes.rows);
      }
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Marks an outbox event as PUBLISHED after successful delivery to consumers.
   */
  public async markPublished(eventId: string, clientOverride?: pg.PoolClient): Promise<void> {
    const runner = clientOverride || getPool();
    await runner.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [eventId]
    );
  }

  /**
   * Marks an outbox event as FAILED, scheduling a retry with bounded exponential backoff
   * or moving to DEAD_LETTER when maximum attempts are exceeded.
   */
  public async markFailed(
    eventId: string,
    error: string,
    clientOverride?: pg.PoolClient
  ): Promise<void> {
    const runner = clientOverride || getPool();
    const eventRes = await runner.query(
      `SELECT attempt_count FROM outbox_events WHERE id = $1`,
      [eventId]
    );

    if (eventRes.rows.length === 0) return;

    const currentAttempts = (eventRes.rows[0].attempt_count || 0) + 1;
    if (currentAttempts >= this.maxAttempts) {
      await runner.query(
        `UPDATE outbox_events
         SET status = 'DEAD_LETTER', attempt_count = $1, last_error = $2
         WHERE id = $3`,
        [currentAttempts, error, eventId]
      );
    } else {
      // Exponential backoff with FULL JITTER: random(0, min(300s, 1s * 2^attempts))
      const delayMs = Math.max(1000, calculateFullJitterDelay(currentAttempts, 1000, 300000));
      const nextAttemptAt = new Date(Date.now() + delayMs);
      await runner.query(
        `UPDATE outbox_events
         SET status = 'PENDING',
             attempt_count = $1,
             last_error = $2,
             next_attempt_at = $3
         WHERE id = $4`,
        [currentAttempts, error, nextAttemptAt, eventId]
      );
    }
  }

  /**
   * Replays dead-lettered or failed events by resetting status to PENDING.
   */
  public async replayFailedEvents(eventIds?: string[]): Promise<number> {
    const pool = getPool();
    if (eventIds && eventIds.length > 0) {
      const placeholders = eventIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await pool.query(
        `UPDATE outbox_events
         SET status = 'PENDING', next_attempt_at = NOW(), attempt_count = 0, last_error = NULL
         WHERE id IN (${placeholders}) AND status IN ('FAILED', 'DEAD_LETTER')`,
        eventIds
      );
      return res.rowCount || 0;
    }

    const res = await pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', next_attempt_at = NOW(), attempt_count = 0, last_error = NULL
       WHERE status IN ('FAILED', 'DEAD_LETTER')`
    );
    return res.rowCount || 0;
  }

  /**
   * Processes a single batch of pending outbox events.
   * Atomically claims rows, invokes handlers, and updates status.
   */
  public async processOutboxBatch(
    batchSize: number = 20
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const events = await this.claimPendingEvents(batchSize);
    if (events.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    for (const evt of events) {
      try {
        const handlers = [
          ...(this.consumers.get(evt.eventType) || []),
          ...this.wildcardConsumers,
        ];

        if (handlers.length === 0) {
          throw new Error(`NO_REGISTERED_CONSUMER: No consumer registered for outbox event '${evt.eventType}'.`);
        }

        for (const handler of handlers) {
          await handler(evt);
        }

        await this.markPublished(evt.id);
        succeeded++;
      } catch (err: any) {
        await this.markFailed(evt.id, err.message || 'Unknown handler execution error');
        failed++;
      }
    }

    return { processed: events.length, succeeded, failed };
  }

  /**
   * Starts background outbox polling relayer.
   */
  public startOutboxRelayer(intervalMs: number = 1000): void {
    if (this.relayerTimer) return;
    this.relayerTimer = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.processOutboxBatch(50);
      } catch (err: any) {
        console.error('[OutboxRelayer Error]', err.message);
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);
  }

  /**
   * Stops background outbox polling relayer.
   */
  public stopOutboxRelayer(): void {
    if (this.relayerTimer) {
      clearInterval(this.relayerTimer);
      this.relayerTimer = null;
    }
  }

  private mapRowsToEvents(rows: any[]): OutboxEvent[] {
    return rows.map(row => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      publishedAt: row.published_at ? (row.published_at instanceof Date ? row.published_at.toISOString() : row.published_at) : undefined,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at instanceof Date ? row.next_attempt_at.toISOString() : row.next_attempt_at,
      lastError: row.last_error || undefined,
      status: row.status,
    }));
  }
}

export const outboxService = new OutboxService();

/**
 * Registers core application consumers for outbox events (OrderCreated, RefundInitiated, DispatchAssigned)
 */
export function registerCoreOutboxConsumers(options?: {
  onOrderCreated?: (payload: any) => Promise<void>;
  onRefundInitiated?: (payload: any) => Promise<void>;
  onDispatchAssigned?: (payload: any) => Promise<void>;
}): void {
  outboxService.registerConsumer('OrderCreated', async (event) => {
    if (options?.onOrderCreated) {
      await options.onOrderCreated(event.payload);
    }
  });

  outboxService.registerConsumer('RefundInitiated', async (event) => {
    if (options?.onRefundInitiated) {
      await options.onRefundInitiated(event.payload);
    }
  });

  outboxService.registerConsumer('DispatchAssigned', async (event) => {
    if (options?.onDispatchAssigned) {
      await options.onDispatchAssigned(event.payload);
    }
  });
}

