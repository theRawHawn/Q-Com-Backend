import { createApp } from './app.js';
import { env, sanitizeConnectionString } from './config/env.js';
import { closePool, checkDatabaseHealth } from './database/connection.js';
import { closeRedis, checkRedisHealth } from './database/redis.js';
import { realtimeGateway } from './modules/realtime/websocketServer.js';
import { outboxService, registerCoreOutboxConsumers } from './modules/outbox/outboxService.js';
import { notificationService } from './modules/notifications/notificationService.js';
import { inventoryService } from './modules/inventory/inventoryService.js';
import { bloomFilterService } from './modules/resilience/bloomFilterService.js';
import { bloomSyncBus } from './modules/resilience/bloomSyncBus.js';
import { RESILIENCE_CONFIG } from './modules/resilience/resilienceConfig.js';

const app = createApp();

let rebuildIntervalTimer: NodeJS.Timeout | null = null;

const server = app.listen(env.PORT, async () => {
  console.log(`[QCOM Backend] Server started on port ${env.PORT} (NODE_ENV: ${env.NODE_ENV})`);
  console.log(`[QCOM Backend] Database Target: ${sanitizeConnectionString(env.DATABASE_POOL_URL || env.DATABASE_URL)}`);
  
  // Attach WebSocket gateway to HTTP server
  realtimeGateway.setupWebSocketServer(server);
  realtimeGateway.attachRedisBackplane();
  console.log('[QCOM Backend] Realtime WebSocket gateway and Redis Pub/Sub backplane attached.');

  // Register core outbox consumers before starting the relayer
  registerCoreOutboxConsumers({
    onOrderCreated: async (payload) => {
      try {
        if (payload?.userId) {
          await notificationService.sendNotification({
            userId: payload.userId,
            notificationType: 'TRANSACTIONAL',
            title: 'Order Confirmed',
            body: `Your order #${payload.orderNumber || payload.orderId} has been confirmed.`,
            dedupeKey: `notif_order_confirmed_${payload.orderId}`,
            data: { orderId: payload.orderId },
          });
        }
        realtimeGateway.broadcastToRoom(`order:${payload?.orderId}`, {
          type: 'event',
          eventType: 'ORDER_STATUS_CHANGED',
          payload: { orderId: payload?.orderId, status: 'CONFIRMED' },
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn('[Outbox OrderCreated Consumer Warning]', err.message);
      }
    },
    onRefundInitiated: async (payload) => {
      try {
        realtimeGateway.broadcastToRoom(`order:${payload?.orderId}`, {
          type: 'event',
          eventType: 'REFUND_PROCESSING',
          payload: {
            orderId: payload?.orderId,
            refundNumber: payload?.refundNumber,
            amount: payload?.amount,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn('[Outbox RefundInitiated Consumer Warning]', err.message);
      }
    },
    onDispatchAssigned: async (payload) => {
      try {
        if (payload?.riderId) {
          realtimeGateway.broadcastToRoom(`rider:${payload.riderId}`, {
            type: 'event',
            eventType: 'NEW_DISPATCH_OFFER',
            payload: {
              assignmentId: payload.assignmentId,
              orderId: payload.orderId,
            },
            timestamp: new Date().toISOString(),
          });
        }
        realtimeGateway.broadcastToRoom(`order:${payload?.orderId}`, {
          type: 'event',
          eventType: 'RIDER_ASSIGNED',
          payload: {
            orderId: payload?.orderId,
            riderId: payload?.riderId,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn('[Outbox DispatchAssigned Consumer Warning]', err.message);
      }
    },
  });

  // Start background outbox polling relayer
  if (env.NODE_ENV !== 'test') {
    outboxService.startOutboxRelayer(1000);
  }

  // Start inventory reservation expiry reaper
  if (env.NODE_ENV !== 'test') {
    setInterval(async () => {
      try {
        await inventoryService.reapExpiredReservations(50);
      } catch (err: any) {
        console.warn('[Inventory Reaper Error]', err.message);
      }
    }, 30000).unref();
    console.log('[QCOM Backend] Inventory reservation expiry reaper worker active.');
  }

  // Perform initial readiness probe check on startup
  const dbHealth = await checkDatabaseHealth();
  if (dbHealth.alive) {
    console.log(`[QCOM Backend] Authoritative Database Connected (Latency: ${dbHealth.latencyMs}ms)`);
  } else {
    console.warn(`[QCOM Backend] Warning: Initial Database connectivity check failed (${dbHealth.error})`);
  }

  const cacheHealth = await checkRedisHealth();
  console.log(`[QCOM Backend] Ephemeral Cache Mode: ${cacheHealth.mode} (Latency: ${cacheHealth.latencyMs}ms)`);

  // Initialize Bloom Filters for PostgreSQL overload protection
  await bloomFilterService.initializeFromDatabase();
  console.log('[QCOM Backend] Bloom Filter database overload protection initialized.');

  // Attach Redis subscriber for multi-instance Bloom synchronization (F-9.1-01 remediation)
  bloomSyncBus.attachRedisSubscriber();
  console.log('[QCOM Backend] Redis Pub/Sub subscriber attached for multi-instance synchronization.');

  // Start periodic 24-hour Bloom filter rebuild timer (F-9.1-03 remediation)
  rebuildIntervalTimer = setInterval(async () => {
    try {
      console.log('[QCOM Backend] Executing periodic 24-hour Bloom filter rebuild...');
      await bloomFilterService.initializeFromDatabase();
      console.log('[QCOM Backend] Periodic 24-hour Bloom filter rebuild completed.');
    } catch (err: any) {
      console.warn('[QCOM Backend] Periodic Bloom filter rebuild failed (active filter preserved):', err.message);
    }
  }, RESILIENCE_CONFIG.BLOOM.AUTO_REBUILD_INTERVAL_MS);
  rebuildIntervalTimer.unref();
});

// Graceful shutdown handling
let isShuttingDown = false;

async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[QCOM Backend] Received ${signal}. Starting graceful shutdown...`);

  if (rebuildIntervalTimer) {
    clearInterval(rebuildIntervalTimer);
    rebuildIntervalTimer = null;
  }

  outboxService.stopOutboxRelayer();
  realtimeGateway.close();

  // Stop accepting new connections
  server.close(async () => {
    console.log('[QCOM Backend] HTTP server closed.');
    try {
      await bloomSyncBus.detachRedisSubscriber();
      console.log('[QCOM Backend] Bloom sync bus Redis subscriber detached.');
      await closePool();
      console.log('[QCOM Backend] PostgreSQL connection pool drained.');
      await closeRedis();
      console.log('[QCOM Backend] Ephemeral Cache connection closed.');
      process.exit(0);
    } catch (err: any) {
      console.error('[QCOM Backend] Error during shutdown:', err.message);
      process.exit(1);
    }
  });

  // Force close if graceful shutdown hangs
  setTimeout(() => {
    console.error('[QCOM Backend] Graceful shutdown timeout exceeded. Forcing process exit.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
