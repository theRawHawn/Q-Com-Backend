import { Request, Response, NextFunction } from 'express';
import { recordAuditEvent } from '../modules/audit/auditService.js';

/**
 * Middleware requiring the authenticated user to possess at least one of the specified roles.
 * Super Admin bypasses general role restrictions where appropriate.
 */
export function requireRole(allowedRoles: string | string[]) {
  const rolesList = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication is required for this operation.',
      });
      return;
    }

    if (req.auth.isSuperAdmin) {
      return next();
    }

    const hasRole = req.auth.roles.some(r => rolesList.includes(r));
    if (!hasRole) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'USER',
        action: 'ROLE_AUTHORIZATION_DENIED',
        entityType: 'ENDPOINT',
        entityId: req.originalUrl,
        newState: { requiredRoles: rolesList, userRoles: req.auth.roles },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'FORBIDDEN_ROLE',
        message: 'You do not have the required role to perform this action.',
      });
      return;
    }

    next();
  };
}

/**
 * Middleware requiring the authenticated user to possess a specific granular permission.
 * Super Admin bypasses permission checks where appropriate.
 */
export function requirePermission(requiredPermission: string | string[]) {
  const permList = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication is required for this operation.',
      });
      return;
    }

    if (req.auth.isSuperAdmin) {
      return next();
    }

    // Check if user has all required permissions
    const hasAllPermissions = permList.every(p => req.auth!.permissions.includes(p));
    if (!hasAllPermissions) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'USER',
        action: 'PERMISSION_AUTHORIZATION_DENIED',
        entityType: 'ENDPOINT',
        entityId: req.originalUrl,
        newState: { requiredPermissions: permList, userPermissions: req.auth.permissions },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'FORBIDDEN_PERMISSION',
        message: 'You lack the specific permission required to access this resource.',
      });
      return;
    }

    next();
  };
}

/**
 * Middleware requiring the user to have AT LEAST ONE of the listed permissions.
 */
export function requireAnyPermission(permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication is required for this operation.',
      });
      return;
    }

    if (req.auth.isSuperAdmin) {
      return next();
    }

    const hasAny = permissions.some(p => req.auth!.permissions.includes(p));
    if (!hasAny) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'USER',
        action: 'PERMISSION_AUTHORIZATION_DENIED',
        entityType: 'ENDPOINT',
        entityId: req.originalUrl,
        newState: { requiredAny: permissions, userPermissions: req.auth.permissions },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'FORBIDDEN_PERMISSION',
        message: 'You lack the permission required to access this resource.',
      });
      return;
    }

    next();
  };
}
