import { Request, Response, NextFunction } from 'express';

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Prevent cross-site scripting
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Hide server technology
  if (typeof res.removeHeader === 'function') {
    try {
      res.removeHeader('X-Powered-By');
    } catch {
      // ignore if headers container not yet initialized
    }
  }
  
  // Frame protection for web clients
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  next();
}
