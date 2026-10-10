import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { checkDatabaseHealth } from './database/connection.js';
import { checkRedisHealth } from './database/redis.js';
import {
  requestIdMiddleware,
  securityHeadersMiddleware,
  sanitizationMiddleware,
  requestLoggerMiddleware,
  generalRateLimiter,
  notFoundHandler,
  errorHandler,
} from './middleware/index.js';
import { authRouter, adminAuthRouter } from './routes/authRoutes.js';
import { rbacRouter } from './routes/rbacRoutes.js';
import { resourceRouter } from './routes/resourceDemoRoutes.js';
import { pricingRouter } from './routes/pricingRoutes.js';
import { customerRouter } from './routes/customerRoutes.js';
import { orderRouter } from './routes/orderRoutes.js';
import { paymentRouter, handleWebhookRequest } from './routes/paymentRoutes.js';
import { invoiceRouter } from './routes/invoiceRoutes.js';
import { settlementRouter } from './routes/settlementRoutes.js';
import { routingRouter } from './routes/routingRoutes.js';
import { deliveryRouter } from './routes/deliveryRoutes.js';
import { dispatchRouter } from './routes/dispatchRoutes.js';
import { aiRouter } from './routes/aiRoutes.js';
import { notificationRouter } from './routes/notificationRoutes.js';
import { adminCampaignRouter } from './routes/adminCampaignRoutes.js';
import { returnRouter } from './routes/returnRoutes.js';
import { refundRouter } from './routes/refundRoutes.js';

export function createApp(): Express {
  const app = express();

  // 1. Trust proxy headers when deployed behind reverse proxy / load balancer
  app.set('trust proxy', 1);

  // 2. Request ID & Security Headers
  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware);

  // 3. CORS configuration
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS === '*'
    ? '*'
    : env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim());

  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'x-admin-session-token',
      'x-razorpay-signature',
      'x-razorpay-event-id',
      'x-signature',
    ],
  }));

  // 4. Request Body Parsing with strict limits & rawBody retention for webhook HMAC signature validation
  app.use(express.json({
    limit: '2mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({
    extended: true,
    limit: '2mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }));

  // 5. Input Sanitization, Rate Limiting & Logging
  app.use(sanitizationMiddleware);
  app.use(generalRateLimiter);
  app.use(requestLoggerMiddleware);

  // 6. Base Health Check (Process Liveness Probe)
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      status: 'OK',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      service: 'qcom-backend',
      version: '1.0.0',
    });
  });

  // 7. Authoritative Readiness Probe (Checks PostgreSQL & Cache Connectivity)
  app.get('/ready', async (req: Request, res: Response) => {
    const dbHealth = await checkDatabaseHealth();
    const cacheHealth = await checkRedisHealth();

    if (dbHealth.alive) {
      res.status(200).json({
        success: true,
        status: 'READY',
        database: {
          status: 'UP',
          latencyMs: dbHealth.latencyMs,
        },
        cache: {
          status: cacheHealth.alive ? 'UP' : 'DEGRADED',
          mode: cacheHealth.mode,
          latencyMs: cacheHealth.latencyMs,
          ...(cacheHealth.error ? { warning: cacheHealth.error } : {}),
        },
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(503).json({
        success: false,
        status: 'NOT_READY',
        database: {
          status: 'DOWN',
          error: dbHealth.error,
        },
        cache: {
          status: cacheHealth.alive ? 'UP' : 'DOWN',
          mode: cacheHealth.mode,
          latencyMs: cacheHealth.latencyMs,
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // 8. API Router Foundation
  const apiRouter = express.Router();
  apiRouter.get('/', (req: Request, res: Response) => {
    res.json({
      success: true,
      message: 'QCOM Unified Backend API v1 Foundation',
      version: '1.0.0',
      modules: {
        auth: 'Sprint 2 (Active - Centralized Auth, JWT, Sessions & Dynamic RBAC)',
        pricing_tax: 'Sprint 3 (Active - Centralized Pricing Engine, GST, Tax Rules & Snapshots)',
        orders_cas: 'Sprint 4',
        dispatch: 'Sprint 5',
        ledgers_settlements: 'Sprint 6',
        websockets: 'Sprint 7',
      },
    });
  });

  // Sprint 2: Mount Authentication, RBAC, and Resource Routers
  apiRouter.use('/auth', authRouter);
  apiRouter.use('/admin/auth', adminAuthRouter);
  apiRouter.use('/admin/rbac', rbacRouter);
  apiRouter.use('/', resourceRouter);

  // Sprint 3: Mount Centralized Pricing & Tax Engine Routers
  apiRouter.use('/pricing', pricingRouter);
  apiRouter.use('/checkout', pricingRouter);

  // Sprint 4: Mount Consolidated Customer & Operations Domain Routers
  apiRouter.use('/profile', customerRouter);
  apiRouter.use('/orders', orderRouter);
  apiRouter.use('/payment', paymentRouter);
  apiRouter.use('/payments', paymentRouter);
  apiRouter.post('/webhooks/razorpay', handleWebhookRequest);
  apiRouter.use('/invoices', invoiceRouter);
  apiRouter.use('/settlement', settlementRouter);
  apiRouter.use('/settlements', settlementRouter);
  apiRouter.use('/routing', routingRouter);
  apiRouter.use('/delivery', deliveryRouter);
  apiRouter.use('/dispatch', dispatchRouter);
  apiRouter.use('/ai', aiRouter);
  apiRouter.use('/notifications', notificationRouter);
  apiRouter.use('/admin/notifications', adminCampaignRouter);
  apiRouter.use('/', returnRouter);
  apiRouter.use('/', refundRouter);
  apiRouter.use('/returns', returnRouter);
  apiRouter.use('/refunds', refundRouter);
  apiRouter.use('/', aiRouter);

  // Mount on /api/v1 as primary versioned endpoint
  app.use('/api/v1', apiRouter);

  // Compatibility mount on /api for frontend convenience
  app.use('/api', apiRouter);

  // 9. Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
