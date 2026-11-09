import { Router, Request, Response } from 'express';
import { rbacService } from '../modules/rbac/rbacService.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

export const rbacRouter = Router();

// All RBAC management routes require authentication and 'rbac.manage' permission (or SUPER_ADMIN)
rbacRouter.use(authenticate);
rbacRouter.use(requirePermission('rbac.manage'));

/**
 * GET /admin/rbac/roles - Lists all roles
 */
rbacRouter.get('/roles', async (req: Request, res: Response): Promise<void> => {
  try {
    const roles = await rbacService.listRoles();
    res.status(200).json({ success: true, roles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * POST /admin/rbac/roles - Creates a new dynamic role
 */
rbacRouter.post('/roles', async (req: Request, res: Response): Promise<void> => {
  const { code, name, description, isSystemRole } = req.body;
  if (!code || !name) {
    res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'Role code and name are required.' });
    return;
  }

  try {
    const role = await rbacService.createRole({
      code,
      name,
      description,
      isSystemRole: req.auth!.isSuperAdmin ? Boolean(isSystemRole) : false,
      actorId: req.auth!.userId,
    });
    res.status(201).json({ success: true, message: 'Role created successfully.', role });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'CREATE_FAILED', message: err.message });
  }
});

/**
 * GET /admin/rbac/permissions - Lists all available system permissions
 */
rbacRouter.get('/permissions', async (req: Request, res: Response): Promise<void> => {
  try {
    const permissions = await rbacService.listPermissions();
    res.status(200).json({ success: true, permissions });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * POST /admin/rbac/roles/:roleId/permissions - Assigns a permission to a role
 */
rbacRouter.post('/roles/:roleId/permissions', async (req: Request, res: Response): Promise<void> => {
  const { roleId } = req.params;
  const { permissionId } = req.body;
  if (!permissionId) {
    res.status(400).json({ success: false, error: 'MISSING_PERMISSION_ID', message: 'permissionId is required.' });
    return;
  }

  try {
    await rbacService.assignPermissionToRole(roleId, permissionId, req.auth!.userId);
    res.status(200).json({ success: true, message: 'Permission assigned to role successfully.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'ASSIGN_FAILED', message: err.message });
  }
});

/**
 * DELETE /admin/rbac/roles/:roleId/permissions/:permissionId - Revokes a permission from a role
 */
rbacRouter.delete('/roles/:roleId/permissions/:permissionId', async (req: Request, res: Response): Promise<void> => {
  const { roleId, permissionId } = req.params;

  try {
    await rbacService.removePermissionFromRole(roleId, permissionId, req.auth!.userId);
    res.status(200).json({ success: true, message: 'Permission removed from role successfully.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'REMOVE_FAILED', message: err.message });
  }
});

/**
 * POST /admin/rbac/users/:userId/roles - Assigns a role to a user
 */
rbacRouter.post('/users/:userId/roles', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const { roleId } = req.body;
  if (!roleId) {
    res.status(400).json({ success: false, error: 'MISSING_ROLE_ID', message: 'roleId is required.' });
    return;
  }

  try {
    await rbacService.assignRoleToUser(userId, roleId, req.auth!.userId);
    res.status(200).json({ success: true, message: 'Role assigned to user successfully.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'ASSIGN_FAILED', message: err.message });
  }
});

/**
 * DELETE /admin/rbac/users/:userId/roles/:roleId - Removes a role from a user
 */
rbacRouter.delete('/users/:userId/roles/:roleId', async (req: Request, res: Response): Promise<void> => {
  const { userId, roleId } = req.params;

  try {
    await rbacService.removeRoleFromUser(userId, roleId, req.auth!.userId);
    res.status(200).json({ success: true, message: 'Role removed from user successfully.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'REMOVE_FAILED', message: err.message });
  }
});
