import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { verifyAccessToken } from '../auth/jwt.js';
import { env } from '../../config/env.js';
import { getPool } from '../../database/connection.js';
import { getRedisClient, createRedisSubscriber } from '../../database/redis.js';
import { rbacService, UserAuthContext } from '../rbac/rbacService.js';
import { AuthenticatedSocketContext, RealtimeClientMessage, RealtimeServerMessage } from './realtimeTypes.js';
import { liveLocationService } from './liveLocationService.js';
import { calculateWebSocketReconnectDelay } from '../resilience/retryPolicy.js';

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  authContext?: AuthenticatedSocketContext;
  subscribedChannels: Set<string>;
}

export class RealtimeGateway {
  private wss: WebSocketServer | null = null;
  private clientRooms: Map<string, Set<ExtendedWebSocket>> = new Map();
  private userSockets: Map<string, Set<ExtendedWebSocket>> = new Map();
  private ipConnectionCounts: Map<string, number> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private maxSocketsPerUser = 5;
  private maxSocketsPerIp = 25;
  private instanceId = crypto.randomUUID();
  private redisSubscriber: any = null;

  /**
   * Attaches Redis Pub/Sub subscriber to enable multi-instance WebSocket broadcasts
   */
  public attachRedisBackplane(customSubscriber?: any): void {
    const sub = customSubscriber || createRedisSubscriber();
    if (!sub) return;
    this.redisSubscriber = sub;
    try {
      sub.subscribe('qcom:ws:broadcast', (err?: any) => {
        if (err && env.LOG_LEVEL === 'debug') {
          console.warn('[RealtimeGateway] Redis Pub/Sub subscription warning:', err.message);
        }
      });
      sub.on('message', (channel: string, dataStr: string) => {
        if (channel === 'qcom:ws:broadcast') {
          try {
            const data = JSON.parse(dataStr);
            if (data.originInstanceId !== this.instanceId) {
              this.broadcastLocally(data.room, data.message);
            }
          } catch {
            // ignore malformed broadcast message
          }
        }
      });
    } catch (err: any) {
      console.warn('[RealtimeGateway] Could not attach Redis backplane:', err.message);
    }
  }

  /**
   * Initializes and binds WebSocket server to Node.js HTTP server.
   */
  public setupWebSocketServer(httpServer: http.Server): WebSocketServer {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', async (request, socket, head) => {
      try {
        const clientIp =
          (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          request.socket.remoteAddress ||
          '127.0.0.1';

        // 1. IP Connection Limit Check
        const currentIpCount = this.ipConnectionCounts.get(clientIp) || 0;
        if (currentIpCount >= this.maxSocketsPerIp) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }

        // 2. Extract and Validate Token
        const host = request.headers.host || 'localhost';
        const parsedUrl = new URL(request.url || '/', `http://${host}`);
        let token = parsedUrl.searchParams.get('token');

        if (!token && request.headers['authorization']) {
          const authHeader = request.headers['authorization'];
          if (authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim();
          } else {
            token = authHeader.trim();
          }
        }

        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // 3. Cryptographic JWT Verification
        let payload: any;
        try {
          payload = verifyAccessToken(token);
        } catch {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // 4. Authoritative PostgreSQL Session Validation
        const pool = getPool();
        const sessionRes = await pool.query(
          `SELECT id, user_id, status, expires_at 
           FROM auth_sessions 
           WHERE id = $1 AND user_id = $2`,
          [payload.session_id, payload.sub]
        );

        if (sessionRes.rows.length === 0) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const session = sessionRes.rows[0];
        if (session.status !== 'ACTIVE' || new Date(session.expires_at).getTime() < Date.now()) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // 5. Authoritative User Context & Suspension Check
        const userContext = await rbacService.getUserAuthContext(payload.sub, pool);
        if (!userContext || userContext.isSuspended) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        // 6. User Connection Limit Check
        const existingUserSockets = this.userSockets.get(userContext.userId);
        if (existingUserSockets && existingUserSockets.size >= this.maxSocketsPerUser) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }

        // 7. Complete Handshake & Upgrade
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          const extWs = ws as ExtendedWebSocket;
          extWs.isAlive = true;
          extWs.subscribedChannels = new Set();
          extWs.authContext = {
            ...userContext,
            sessionId: session.id,
            connectedAt: Date.now(),
            lastPingAt: Date.now(),
          };

          this.handleConnection(extWs, clientIp);
        });
      } catch (err: any) {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });

    this.startHeartbeat();
    return this.wss;
  }

  private handleConnection(ws: ExtendedWebSocket, clientIp: string): void {
    const userId = ws.authContext!.userId;

    // Register socket
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(ws);

    this.ipConnectionCounts.set(clientIp, (this.ipConnectionCounts.get(clientIp) || 0) + 1);

    // Send connection welcome acknowledgment
    this.send(ws, {
      type: 'connected',
      message: 'Realtime gateway connection established successfully.',
      timestamp: new Date().toISOString(),
    });

    // Auto-subscribe user to their personal notification channel
    const userChannel = `user:${userId}`;
    this.addSocketToRoom(userChannel, ws);

    // If delivery partner, auto-subscribe to rider channel
    if (ws.authContext?.riderId) {
      this.addSocketToRoom(`rider:${ws.authContext.riderId}`, ws);
    }

    // Message handler
    ws.on('message', async (data) => {
      try {
        const text = data.toString();
        const msg: RealtimeClientMessage = JSON.parse(text);
        await this.handleClientMessage(ws, msg);
      } catch (err: any) {
        this.send(ws, {
          type: 'error',
          code: 'BAD_REQUEST',
          message: err.message || 'Invalid JSON format in message payload.',
        });
      }
    });

    ws.on('pong', () => {
      ws.isAlive = true;
      if (ws.authContext) {
        ws.authContext.lastPingAt = Date.now();
      }
    });

    ws.on('close', () => {
      this.cleanupSocket(ws, clientIp);
    });

    ws.on('error', () => {
      this.cleanupSocket(ws, clientIp);
    });
  }

  private async handleClientMessage(
    ws: ExtendedWebSocket,
    msg: RealtimeClientMessage
  ): Promise<void> {
    if (!ws.authContext) return;

    switch (msg.action) {
      case 'ping':
        this.send(ws, {
          type: 'pong',
          timestamp: new Date().toISOString(),
        });
        break;

      case 'subscribe':
        if (!msg.channel) {
          this.send(ws, {
            type: 'error',
            code: 'MISSING_CHANNEL',
            message: 'Channel name is required for subscription.',
          });
          return;
        }
        await this.handleChannelSubscription(ws, msg.channel);
        break;

      case 'unsubscribe':
        if (msg.channel) {
          this.removeSocketFromRoom(msg.channel, ws);
          this.send(ws, {
            type: 'unsubscribed',
            channel: msg.channel,
          });
        }
        break;

      case 'location:update':
        if (!ws.authContext.riderId) {
          this.send(ws, {
            type: 'error',
            code: 'NOT_A_RIDER',
            message: 'Only registered delivery partners can upload live location telemetry.',
          });
          return;
        }

        if (typeof msg.latitude !== 'number' || typeof msg.longitude !== 'number') {
          this.send(ws, {
            type: 'error',
            code: 'INVALID_LOCATION',
            message: 'Valid numeric latitude and longitude are required.',
          });
          return;
        }

        const ingestResult = await liveLocationService.ingestRiderLocation(
          {
            riderId: ws.authContext.riderId,
            latitude: msg.latitude,
            longitude: msg.longitude,
            heading: msg.heading,
            speed: msg.speed,
            timestamp: msg.timestamp || Date.now(),
          },
          (room, payload) => this.broadcastToRoom(room, payload)
        );

        if (!ingestResult.success) {
          this.send(ws, {
            type: 'error',
            code: ingestResult.error?.includes('GPS_VELOCITY_CHECK_FAILED')
              ? 'GPS_VELOCITY_CHECK_FAILED'
              : 'GPS_INGEST_FAILED',
            message: ingestResult.error,
          });
        }
        break;

      default:
        this.send(ws, {
          type: 'error',
          code: 'UNKNOWN_ACTION',
          message: `Action '${(msg as any).action}' is not supported.`,
        });
    }
  }

  /**
   * Enforces strict Resource-Level Authorization for Channel Subscriptions.
   */
  private async handleChannelSubscription(
    ws: ExtendedWebSocket,
    channel: string
  ): Promise<void> {
    const auth = ws.authContext!;

    // 1. Order Channel: order:{orderId}
    if (channel.startsWith('order:')) {
      const orderId = channel.slice(6);
      const isAuthorized = await this.verifyOrderAuthorization(orderId, auth);

      if (!isAuthorized) {
        this.send(ws, {
          type: 'error',
          code: 'FORBIDDEN_CHANNEL',
          message: `Access denied: You do not have ownership or assigned dispatch relationship for order '${orderId}'.`,
        });
        return;
      }

      this.addSocketToRoom(channel, ws);
      this.send(ws, { type: 'subscribed', channel });
      return;
    }

    // 2. Merchant Store Channel: merchant:{merchantId}
    if (channel.startsWith('merchant:')) {
      const merchantId = channel.slice(9);
      const isSuper = auth.isSuperAdmin || auth.roles.includes('SUPER_ADMIN') || auth.roles.includes('OPERATIONS');
      const isOwnMerchant = auth.merchantIds && auth.merchantIds.includes(merchantId);

      if (!isSuper && !isOwnMerchant) {
        this.send(ws, {
          type: 'error',
          code: 'FORBIDDEN_CHANNEL',
          message: `Access denied: You are not authorized to subscribe to merchant store '${merchantId}'.`,
        });
        return;
      }

      this.addSocketToRoom(channel, ws);
      this.send(ws, { type: 'subscribed', channel });
      return;
    }

    // 3. Rider Delivery Channel: rider:{riderId}
    if (channel.startsWith('rider:')) {
      const riderId = channel.slice(6);
      const isSuper = auth.isSuperAdmin || auth.roles.includes('SUPER_ADMIN') || auth.roles.includes('DISPATCHER');
      const isOwnRider = auth.riderId === riderId;

      if (!isSuper && !isOwnRider) {
        this.send(ws, {
          type: 'error',
          code: 'FORBIDDEN_CHANNEL',
          message: `Access denied: You cannot subscribe to channel of another delivery partner.`,
        });
        return;
      }

      this.addSocketToRoom(channel, ws);
      this.send(ws, { type: 'subscribed', channel });
      return;
    }

    // 4. Admin Fleet / Incident Channels: admin:*
    if (channel.startsWith('admin:')) {
      const isAuthorizedAdmin =
        auth.isSuperAdmin ||
        auth.roles.includes('SUPER_ADMIN') ||
        auth.roles.includes('OPERATIONS') ||
        auth.roles.includes('DISPATCHER') ||
        auth.roles.includes('FINANCE_ADMIN');

      if (!isAuthorizedAdmin) {
        this.send(ws, {
          type: 'error',
          code: 'FORBIDDEN_CHANNEL',
          message: `Access denied: Administrator privileges required for channel '${channel}'.`,
        });
        return;
      }

      this.addSocketToRoom(channel, ws);
      this.send(ws, { type: 'subscribed', channel });
      return;
    }

    // 5. User Personal Notification Channel: user:{userId}
    if (channel.startsWith('user:')) {
      const targetUserId = channel.slice(5);
      if (targetUserId !== auth.userId && !auth.isSuperAdmin) {
        this.send(ws, {
          type: 'error',
          code: 'FORBIDDEN_CHANNEL',
          message: 'Access denied: You cannot subscribe to another user notification channel.',
        });
        return;
      }

      this.addSocketToRoom(channel, ws);
      this.send(ws, { type: 'subscribed', channel });
      return;
    }

    // Unknown Channel Format
    this.send(ws, {
      type: 'error',
      code: 'INVALID_CHANNEL_PATTERN',
      message: `Channel pattern '${channel}' is unrecognized or unsupported.`,
    });
  }

  private async verifyOrderAuthorization(
    orderId: string,
    auth: AuthenticatedSocketContext
  ): Promise<boolean> {
    if (auth.isSuperAdmin || auth.roles.includes('SUPER_ADMIN') || auth.roles.includes('OPERATIONS')) {
      return true;
    }

    const pool = getPool();
    try {
      const res = await pool.query(
        `SELECT o.user_id, o.merchant_id, dt.rider_id
         FROM orders o
         LEFT JOIN delivery_trips dt ON dt.order_id = o.id
         WHERE o.id::text = $1 OR o.order_number = $1`,
        [orderId]
      );

      if (res.rows.length === 0) return false;
      const order = res.rows[0];

      // Customer ownership
      if (order.user_id === auth.userId) return true;

      // Merchant ownership
      if (auth.merchantIds && auth.merchantIds.includes(order.merchant_id)) return true;

      // Assigned Rider
      if (auth.riderId && order.rider_id === auth.riderId) return true;

      return false;
    } catch {
      return false;
    }
  }

  public broadcastLocally(room: string, message: RealtimeServerMessage): void {
    const sockets = this.clientRooms.get(room);
    if (!sockets) return;

    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  public broadcastToRoom(room: string, message: RealtimeServerMessage): void {
    // 1. Deliver to local sockets
    this.broadcastLocally(room, message);

    // 2. Publish to Redis Pub/Sub for cross-instance delivery
    try {
      const client = getRedisClient();
      if (client) {
        const payload = JSON.stringify({
          room,
          message,
          originInstanceId: this.instanceId,
          timestamp: Date.now(),
        });
        const res = client.publish('qcom:ws:broadcast', payload);
        if (res && typeof (res as any).catch === 'function') {
          (res as any).catch(() => {});
        }
      }
    } catch {
      // Local broadcast already succeeded
    }
  }

  public broadcastToUser(userId: string, message: RealtimeServerMessage): void {
    this.broadcastToRoom(`user:${userId}`, message);
  }

  /**
   * Handles user logout: instantly severs open sockets for the revoked session.
   */
  public handleSessionRevocation(sessionId: string): void {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      const extWs = client as ExtendedWebSocket;
      if (extWs.authContext?.sessionId === sessionId) {
        this.send(extWs, {
          type: 'revoked',
          code: 'SESSION_REVOKED',
          message: 'Your session has been logged out or revoked.',
        });
        extWs.close(4401, 'SESSION_REVOKED');
      }
    }
  }

  /**
   * Handles global logout-all: instantly severs all active sockets across all devices for this user.
   */
  public handleUserLogoutAll(userId: string): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    for (const ws of sockets) {
      this.send(ws, {
        type: 'revoked',
        code: 'LOGOUT_ALL',
        message: 'All sessions for your account have been terminated.',
      });
      ws.close(4401, 'LOGOUT_ALL');
    }
  }

  private addSocketToRoom(room: string, ws: ExtendedWebSocket): void {
    if (!this.clientRooms.has(room)) {
      this.clientRooms.set(room, new Set());
    }
    this.clientRooms.get(room)!.add(ws);
    ws.subscribedChannels.add(room);
  }

  private removeSocketFromRoom(room: string, ws: ExtendedWebSocket): void {
    const sockets = this.clientRooms.get(room);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.clientRooms.delete(room);
      }
    }
    ws.subscribedChannels.delete(room);
  }

  private cleanupSocket(ws: ExtendedWebSocket, clientIp: string): void {
    // Unsubscribe from all channels
    for (const channel of ws.subscribedChannels) {
      this.removeSocketFromRoom(channel, ws);
    }
    ws.subscribedChannels.clear();

    // Remove from user sockets
    if (ws.authContext) {
      const uSockets = this.userSockets.get(ws.authContext.userId);
      if (uSockets) {
        uSockets.delete(ws);
        if (uSockets.size === 0) {
          this.userSockets.delete(ws.authContext.userId);
        }
      }
    }

    // Decrement IP count
    const ipCount = this.ipConnectionCounts.get(clientIp);
    if (ipCount) {
      if (ipCount <= 1) {
        this.ipConnectionCounts.delete(clientIp);
      } else {
        this.ipConnectionCounts.set(clientIp, ipCount - 1);
      }
    }
  }

  private send(ws: WebSocket, message: RealtimeServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        const extWs = client as ExtendedWebSocket;
        if (!extWs.isAlive) {
          extWs.terminate();
          continue;
        }
        extWs.isAlive = false;
        extWs.ping();
      }
    }, 30000);
  }

  public close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clientRooms.clear();
    this.userSockets.clear();
    this.ipConnectionCounts.clear();
  }
}

export const realtimeGateway = new RealtimeGateway();
export { calculateWebSocketReconnectDelay };
