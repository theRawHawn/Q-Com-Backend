import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only log if not in test environment or if debug is enabled
  if (env.NODE_ENV === 'test') {
    return next();
  }

  res.on('finish', () => {
    const duration = req.startTime ? Date.now() - req.startTime : 0;
    const statusCode = res.statusCode;
    const method = req.method;
    const url = req.originalUrl || req.url;
    const requestId = req.requestId || '-';

    // Structured JSON log output
    const logData = {
      timestamp: new Date().toISOString(),
      requestId,
      method,
      url,
      statusCode,
      durationMs: duration,
      ip: req.ip || req.socket.remoteAddress,
    };

    if (statusCode >= 500) {
      console.error(`[HTTP ERROR]`, JSON.stringify(logData));
    } else if (statusCode >= 400) {
      console.warn(`[HTTP WARN]`, JSON.stringify(logData));
    } else {
      console.log(`[HTTP INFO]`, JSON.stringify(logData));
    }
  });

  next();
}
