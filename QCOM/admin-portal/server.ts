import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { adminRouter } from './server/routes/adminRoutes';
import {
  securityHeadersMiddleware,
  corsMiddleware,
  inputSanitizationMiddleware,
} from './server/security';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Disable technology leakage
  app.disable('x-powered-by');

  // Mount Security Headers & CSP (with secure framing for AI Studio)
  app.use(securityHeadersMiddleware);

  // Controlled CORS policy
  app.use(corsMiddleware);

  // JSON Body Parser & URL Encoded with size limit
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Input Sanitization & Prototype Pollution Defense
  app.use(inputSanitizationMiddleware);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'QCOM Marketplace Central Control API',
      timestamp: new Date().toISOString(),
      activeZone: process.env.ACTIVE_ZONE || 'Bengaluru (BLR-1)',
      securityStatus: 'HARDENED',
    });
  });

  // Mount Admin REST Router FIRST before Vite middleware
  app.use('/api/admin', adminRouter);

  // Centralized Error Handling for API routes (prevent leaking internal stack traces)
  app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled API Error:', err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(err.status || 500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'An internal error occurred.' : (err.message || 'An internal error occurred.'),
    });
  });

  // Vite middleware for development vs Static file serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`  QCOM Central Admin & Control Room API Running`);
    console.log(`  Port: ${PORT} | Bound: 0.0.0.0`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  Security: Hardened (CSP, CORS, RateLimiting, SessionAuth)`);
    console.log(`=======================================================`);
  });
}

startServer().catch((err) => {
  console.error('Fatal Server Boot Failure:', err);
});
