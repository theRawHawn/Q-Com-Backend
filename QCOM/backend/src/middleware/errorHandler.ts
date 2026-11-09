import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
}

export function notFoundHandler(req: Request, res: Response): void {
  const requestId = req.requestId || 'req_unknown';
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Resource not found: ${req.method} ${req.originalUrl}`,
      requestId,
    },
  });
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const code = err.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
  const requestId = req.requestId || 'req_unknown';
  
  // Safe message for clients
  const message = statusCode === 500 && env.NODE_ENV === 'production'
    ? 'An unexpected error occurred. Please try again later.'
    : err.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(`[Server Error] [${requestId}]`, err.stack || err);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      requestId,
      ...(env.NODE_ENV !== 'production' && err.details ? { details: err.details } : {}),
      ...(env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    },
  });
}
