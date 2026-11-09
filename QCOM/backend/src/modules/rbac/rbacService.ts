import pg from 'pg';
import { getPool } from '../../database/connection.js';
import { recordAuditEvent } from '../audit/auditService.js';

export interface RoleRecord {
  id: string;
  code: string;
  name: string;
  description?: string;
  is_system_role?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface PermissionRecord {
  id: string;
  key: string;
  module: string;
  name: string;
  description?: string;
}

export interface UserAuthContext {
  userId: string;
  phone: string;
  name?: string;
  email?: string;
  accountType: string;
  isSuspended: boolean;
  suspensionReason?: string;
  roles: string[];
  permissions: string[];
  merchantIds: string[];
  storeIds: string[];
  riderId?: string;
  isSuperAdmin: boolean;
}

export class RbacService {
  /**
   * Fetches all active roles for a user from PostgreSQL
   */
  async getUserRoles(userId: string, poolOverride?: pg.Pool): Promise<string[]> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT r.code 
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [userId]
    );
    return res.rows.map(r => r.code);
  }

  /**
   * Fetches all distinct granular permissions for a user from PostgreSQL
   */
  async getUserPermissions(userId: string, poolOverride?: pg.Pool): Promise<string[]> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT DISTINCT p.key 
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`,
      [userId]
    );
    return res.rows.map(r => r.key);
  }

  /**
   * Resolves authoritative user context including roles, permissions, merchant associations,
   * store staff scopes, and rider profile mapping.
   */
  async getUserAuthContext(userId: string, poolOverride?: pg.Pool): Promise<UserAuthContext | null> {
    const runner = poolOverride || getPool();

    // 1. Fetch User Record
    const userRes = await runner.query(
      `SELECT id, phone, name, email, account_type, is_suspended, suspension_reason 
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) return null;
    const user = userRes.rows[0];

    // 2. Concurrently fetch roles, permissions, store staff, merchant ownership, and rider profile
    const [roles, permissions, staffRes, merchRes, riderRes] = await Promise.all([
      this.getUserRoles(userId, runner),
      this.getUserPermissions(userId, runner),
      runner.query(
        `SELECT DISTINCT merchant_id FROM store_staff WHERE user_id = $1 OR phone = $2`,
        [userId, user.phone]
      ),
      runner.query(
        `SELECT DISTINCT id FROM merchants WHERE phone = $1 OR email = $2`,
        [user.phone, user.email || '']
      ),
      runner.query(
        `SELECT id FROM riders WHERE phone = $1 OR user_id = $2 LIMIT 1`,
        [user.phone, userId]
      ),
    ]);
    const isSuperAdmin = roles.includes('SUPER_ADMIN');

    const merchantIdsSet = new Set<string>();
    staffRes.rows.forEach(r => merchantIdsSet.add(r.merchant_id));
    merchRes.rows.forEach(r => merchantIdsSet.add(r.id));
    const merchantIds = Array.from(merchantIdsSet);

    // Fetch associated store IDs if merchants exist
    let storeIds: string[] = [];
    if (merchantIds.length > 0) {
      const storeRes = await runner.query(
        `SELECT id FROM merchant_stores WHERE merchant_id = ANY($1::uuid[])`,
        [merchantIds]
      );
      storeIds = storeRes.rows.map(r => r.id);
    }

    const riderId = riderRes.rows[0]?.id;

    return {
      userId: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      accountType: user.account_type || 'individual',
      isSuspended: Boolean(user.is_suspended),
      suspensionReason: user.suspension_reason,
      roles,
      permissions,
      merchantIds,
      storeIds,
      riderId,
      isSuperAdmin,
    };
  }

  /**
   * Lists all roles in the system
   */
  async listRoles(poolOverride?: pg.Pool): Promise<RoleRecord[]> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT id, code, name, description, is_system_role, created_at, updated_at 
       FROM roles ORDER BY is_system_role DESC, name ASC`
    );
    return res.rows;
  }

  /**
   * Lists all permissions in the system
   */
  async listPermissions(poolOverride?: pg.Pool): Promise<PermissionRecord[]> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT id, key, module, name, description FROM permissions ORDER BY module ASC, key ASC`
    );
    return res.rows;
  }

  /**
   * Creates a dynamic role
   */
  async createRole(
    params: { code: string; name: string; description?: string; isSystemRole?: boolean; actorId?: string },
    poolOverride?: pg.Pool
  ): Promise<RoleRecord> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `INSERT INTO roles (code, name, description, is_system_role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, code, name, description, is_system_role, created_at, updated_at`,
      [params.code.toUpperCase(), params.name, params.description || '', Boolean(params.isSystemRole)]
    );
    const newRole = res.rows[0];

    await recordAuditEvent({
      actorId: params.actorId || 'SYSTEM',
      actorType: 'ADMIN',
      action: 'ROLE_CREATED',
      entityType: 'ROLE',
      entityId: newRole.id,
      newState: newRole,
      poolOverride: runner,
    });

    return newRole;
  }

  /**
   * Assigns a permission to a role
   */
  async assignPermissionToRole(
    roleId: string,
    permissionId: string,
    actorId?: string,
    poolOverride?: pg.Pool
  ): Promise<void> {
    const runner = poolOverride || getPool();
    await runner.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ($1, $2)
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, permissionId]
    );

    await recordAuditEvent({
      actorId: actorId || 'SYSTEM',
      actorType: 'ADMIN',
      action: 'PERMISSION_GRANTED_TO_ROLE',
      entityType: 'ROLE_PERMISSION',
      entityId: `${roleId}:${permissionId}`,
      poolOverride: runner,
    });
  }

  /**
   * Removes a permission from a role
   */
  async removePermissionFromRole(
    roleId: string,
    permissionId: string,
    actorId?: string,
    poolOverride?: pg.Pool
  ): Promise<void> {
    const runner = poolOverride || getPool();
    await runner.query(
      `DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [roleId, permissionId]
    );

    await recordAuditEvent({
      actorId: actorId || 'SYSTEM',
      actorType: 'ADMIN',
      action: 'PERMISSION_REVOKED_FROM_ROLE',
      entityType: 'ROLE_PERMISSION',
      entityId: `${roleId}:${permissionId}`,
      poolOverride: runner,
    });
  }

  /**
   * Assigns a role to a user
   */
  async assignRoleToUser(
    userId: string,
    roleId: string,
    actorId?: string,
    poolOverride?: pg.Pool
  ): Promise<void> {
    const runner = poolOverride || getPool();
    await runner.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleId]
    );

    await recordAuditEvent({
      actorId: actorId || 'SYSTEM',
      actorType: 'ADMIN',
      action: 'ROLE_ASSIGNED_TO_USER',
      entityType: 'USER_ROLE',
      entityId: `${userId}:${roleId}`,
      poolOverride: runner,
    });
  }

  /**
   * Removes a role from a user
   */
  async removeRoleFromUser(
    userId: string,
    roleId: string,
    actorId?: string,
    poolOverride?: pg.Pool
  ): Promise<void> {
    const runner = poolOverride || getPool();
    await runner.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId]
    );

    await recordAuditEvent({
      actorId: actorId || 'SYSTEM',
      actorType: 'ADMIN',
      action: 'ROLE_REMOVED_FROM_USER',
      entityType: 'USER_ROLE',
      entityId: `${userId}:${roleId}`,
      poolOverride: runner,
    });
  }
}

export const rbacService = new RbacService();
