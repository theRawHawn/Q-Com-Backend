import { Router, Request, Response, NextFunction } from 'express';
import { authoritativeAdminStore } from '../store/adminStore';
import { calculateEmployeePermissions, MODULE_PERMISSION_GROUPS, ALL_SYSTEM_PERMISSIONS } from '../rbac';
import { AdminPermission, AdminRole, AdminUser, AdminEmployeeUser, AdminRoleDefinition } from '../../src/types/admin';
import { sessionManager, sensitiveOpsLimiter, generalApiLimiter } from '../security';

export const adminRouter = Router();

// Middleware to extract authenticated admin persona
export interface AuthenticatedRequest extends Request {
  admin?: AdminUser;
  employee?: AdminEmployeeUser;
  effectivePermissions?: AdminPermission[];
  sessionToken?: string;
}

// ----------------------------------------------------
// Public Auth Endpoints (Session Handshake & Persona)
// ----------------------------------------------------
adminRouter.post('/auth/session', (req: Request, res: Response) => {
  const { employeeId, employeeCode } = req.body || {};
  const authHeader = req.headers.authorization;
  const existingToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-admin-session-token'] as string);

  // If existing valid session, return it
  if (existingToken) {
    const session = sessionManager.validateSession(existingToken);
    if (session) {
      const emp = authoritativeAdminStore.getEmployees().find((e) => e.id === session.employeeId);
      if (emp && emp.status === 'ACTIVE') {
        const roles = authoritativeAdminStore.getRoles();
        const perms = calculateEmployeePermissions(emp, roles);
        return res.json({
          success: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          employee: emp,
          effectivePermissions: perms,
        });
      }
    }
  }

  // Find requested employee or default to the primary administrator
  let emp: AdminEmployeeUser | undefined;
  if (employeeId || employeeCode) {
    emp = authoritativeAdminStore.getEmployees().find(
      (e) => e.id === employeeId || e.employeeCode === employeeCode || e.id === employeeCode
    );
  }

  if (!emp) {
    // Default bootstrap administrator for the portal session
    emp = authoritativeAdminStore.getEmployees().find((e) => e.role === 'SUPER_ADMIN') || authoritativeAdminStore.getEmployees()[0];
  }

  if (!emp) {
    return res.status(500).json({ success: false, error: 'NO_EMPLOYEES', message: 'No admin accounts configured in system.' });
  }

  if (emp.status !== 'ACTIVE') {
    return res.status(403).json({ success: false, error: 'ACCOUNT_SUSPENDED', message: `Account is ${emp.status}. Access denied.` });
  }

  const session = sessionManager.createSession(emp);
  const roles = authoritativeAdminStore.getRoles();
  const perms = calculateEmployeePermissions(emp, roles);

  res.json({
    success: true,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    employee: emp,
    effectivePermissions: perms,
  });
});

// ----------------------------------------------------
// Authenticate Admin Middleware (Token Verification)
// ----------------------------------------------------
function authenticateAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-admin-session-token'] as string);

  let emp: AdminEmployeeUser | undefined;

  // 1. Verify cryptographic session token
  if (sessionToken) {
    const session = sessionManager.validateSession(sessionToken);
    if (session) {
      emp = authoritativeAdminStore.getEmployees().find((e) => e.id === session.employeeId);
      req.sessionToken = sessionToken;
    }
  }

  // If still unauthenticated, deny request (Strict session required - no header spoofing or dev fallback)
  if (!emp) {
    authoritativeAdminStore.logAudit({
      actorName: 'Unknown Caller',
      actorRole: 'ANONYMOUS',
      actionType: 'UNAUTHENTICATED_ACCESS_ATTEMPT',
      targetModule: 'Security Perimeter',
      summary: `Rejected unauthenticated request to ${req.method} ${req.originalUrl}.`,
      severity: 'HIGH',
    });

    return res.status(401).json({
      success: false,
      error: 'UNAUTHENTICATED',
      message: 'Valid admin authentication session required.',
    });
  }

  // Check if employee account is suspended or inactive
  if (emp.status !== 'ACTIVE') {
    return res.status(403).json({
      success: false,
      error: 'ACCOUNT_INACTIVE',
      status: emp.status,
      message: `Access Denied: Your account status is '${emp.status}'. Please contact Super Admin.`,
    });
  }

  // Set authenticated employee & user
  req.employee = emp;
  req.admin = {
    id: emp.id,
    name: emp.name,
    email: emp.email,
    role: emp.role, // Strictly server-authoritative role; never spoofable
    roleTitle: emp.roleTitle,
    avatar: emp.avatar,
    department: emp.department,
    lastLogin: emp.lastLogin,
    status: emp.status,
  };

  const allRoles = authoritativeAdminStore.getRoles();
  req.effectivePermissions = calculateEmployeePermissions(emp, allRoles);
  next();
}

adminRouter.post('/auth/switch-persona', sensitiveOpsLimiter, authenticateAdmin, (req: AuthenticatedRequest, res: Response) => {
  if (req.employee?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Only Super Administrators can switch personas.' });
  }

  const { employeeId, roleCode } = req.body || {};

  let targetEmp: AdminEmployeeUser | undefined;
  if (employeeId) {
    targetEmp = authoritativeAdminStore.getEmployees().find((e) => e.id === employeeId || e.employeeCode === employeeId);
  } else if (roleCode) {
    targetEmp = authoritativeAdminStore.getEmployees().find((e) => e.role === roleCode || e.assignedRoleIds?.includes(roleCode));
  }

  if (!targetEmp) {
    return res.status(404).json({ success: false, error: 'EMPLOYEE_NOT_FOUND', message: 'Target employee profile not found.' });
  }

  if (targetEmp.status !== 'ACTIVE') {
    return res.status(403).json({ success: false, error: 'ACCOUNT_SUSPENDED', message: `Cannot switch to ${targetEmp.status} account.` });
  }

  const session = sessionManager.createSession(targetEmp);
  const roles = authoritativeAdminStore.getRoles();
  const perms = calculateEmployeePermissions(targetEmp, roles);

  authoritativeAdminStore.logAudit({
    actorName: req.employee?.name || targetEmp.name,
    actorRole: req.employee?.role || targetEmp.role,
    actionType: 'ADMIN_PERSONA_SWITCHED',
    targetModule: 'Session & Auth',
    summary: `Switched active administrative session to "${targetEmp.name}" (${targetEmp.roleTitle}).`,
    severity: 'MEDIUM',
  });

  res.json({
    success: true,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    employee: targetEmp,
    effectivePermissions: perms,
  });
});

adminRouter.post('/auth/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-admin-session-token'] as string);

  if (token) {
    sessionManager.revokeSession(token);
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

function requirePermission(permission: AdminPermission) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const emp = req.employee;
    const permissions = req.effectivePermissions || [];

    if (!emp) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHENTICATED',
        message: 'Admin authentication required',
      });
    }

    // Check if employee is inactive or suspended
    if (emp.status !== 'ACTIVE') {
      authoritativeAdminStore.logAudit({
        actorName: emp.name,
        actorRole: emp.role,
        actionType: 'BLOCKED_INACTIVE_USER_ACCESS',
        targetModule: 'RBAC Security',
        summary: `Blocked access attempt by ${emp.status} user "${emp.name}" (${emp.email}).`,
        severity: 'CRITICAL',
      });

      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_INACTIVE',
        status: emp.status,
        message: `Access Denied: Your account status is '${emp.status}'. Please contact Super Admin.`,
      });
    }

    // Super Admin bypass & alias permissions mapping
    const isSuperAdmin = emp.role === 'SUPER_ADMIN' || emp.assignedRoleIds?.includes('role-super-admin') || emp.assignedRoleIds?.includes('SUPER_ADMIN');

    const hasPerm =
      isSuperAdmin ||
      permissions.includes(permission) ||
      permissions.includes('*' as any) ||
      (permission === 'riders.payout' && (permissions.includes('riders.payout') || permissions.includes('settlements.process') || permissions.includes('riders.edit'))) ||
      (permission === 'support.manage' && permissions.includes('support.resolve_ticket')) ||
      (permission === 'users.view' && (permissions.includes('employees.view') || permissions.includes('roles.view'))) ||
      (permission === 'roles.view' && permissions.includes('users.view')) ||
      (permission === 'employees.view' && permissions.includes('users.view'));

    if (!hasPerm) {
      authoritativeAdminStore.logAudit({
        actorName: emp.name,
        actorRole: emp.role,
        actionType: `PERMISSION_DENIED_${permission.toUpperCase().replace(/\./g, '_')}`,
        targetModule: 'RBAC Security',
        summary: `User "${emp.name}" (${emp.roleTitle}) attempted forbidden action requiring '${permission}'.`,
        severity: 'HIGH',
      });

      return res.status(403).json({
        success: false,
        error: 'PERMISSION_DENIED',
        requiredPermission: permission,
        userRole: emp.roleTitle,
        message: `Forbidden: Your role '${emp.roleTitle}' does not possess the required permission '${permission}'`,
      });
    }

    next();
  };
}

adminRouter.use(generalApiLimiter);
adminRouter.use(authenticateAdmin);

// ==================== DYNAMIC RBAC: ROLES & PERMISSIONS API ====================

// 1. Get all dynamic roles & permission breakdown
const handleGetRoles = (req: AuthenticatedRequest, res: Response) => {
  const roles = authoritativeAdminStore.getRoles();
  const employees = authoritativeAdminStore.getEmployees();

  // Enrich roles with assigned employee counts
  const enrichedRoles = roles.map((role) => {
    const assignedCount = employees.filter(
      (e) => e.status === 'ACTIVE' && (e.assignedRoleIds?.includes(role.id) || e.assignedRoleIds?.includes(role.code) || e.role === role.code)
    ).length;

    return {
      ...role,
      assignedEmployeeCount: assignedCount,
    };
  });

  res.json({
    success: true,
    roles: enrichedRoles,
  });
};

adminRouter.get('/roles', requirePermission('roles.view'), handleGetRoles);
adminRouter.get('/roles/list', requirePermission('roles.view'), handleGetRoles);

// 2. Get full permission matrix structure & list
const handleGetPermissions = (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    moduleGroups: MODULE_PERMISSION_GROUPS,
    allPermissions: ALL_SYSTEM_PERMISSIONS,
  });
};

adminRouter.get('/permissions', requirePermission('permissions.view'), handleGetPermissions);
adminRouter.get('/permissions/matrix', requirePermission('permissions.view'), handleGetPermissions);

// 3. Create a new custom role dynamically
adminRouter.post('/roles/create', requirePermission('roles.create'), (req: AuthenticatedRequest, res: Response) => {
  const { name, department, description, permissions, code, status } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 3) {
    return res.status(400).json({ success: false, error: 'INVALID_ROLE_NAME', message: 'Role name must be at least 3 characters long.' });
  }

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ success: false, error: 'INVALID_PERMISSIONS', message: 'Permissions must be provided as an array of permission keys.' });
  }

  // Prevent privilege escalation via wildcard or permissions outside creator's ceiling
  if (permissions.includes('*' as any) && req.employee?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, error: 'CANNOT_GRANT_WILDCARD', message: 'Only Super Admin may grant wildcard permissions.' });
  }

  if (req.employee?.role !== 'SUPER_ADMIN') {
    const callerPerms = new Set(req.effectivePermissions || []);
    const unauthorizedPerms = permissions.filter((p) => (p as string) !== '*' && !callerPerms.has(p));
    if (unauthorizedPerms.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'PRIVILEGE_CEILING_EXCEEDED',
        message: `Cannot grant permissions you do not possess: ${unauthorizedPerms.slice(0, 3).join(', ')}${unauthorizedPerms.length > 3 ? '...' : ''}`,
      });
    }
  }

  const createdRole = authoritativeAdminStore.createRole({
    name: name.trim(),
    code: code || name.trim().toUpperCase().replace(/\s+/g, '_'),
    department: department || 'General Operations',
    description: description || 'Custom dynamic role created by Main Admin.',
    permissions,
    status: status || 'ACTIVE',
  });

  res.status(201).json({
    success: true,
    role: createdRole,
    message: `Dynamic role "${createdRole.name}" created successfully with ${createdRole.permissions.length} action permissions.`,
  });
});

// 3b. Clone an existing role
adminRouter.post('/roles/:id/clone', requirePermission('roles.create'), (req: AuthenticatedRequest, res: Response) => {
  const sourceRole = authoritativeAdminStore.getRoleById(req.params.id);
  if (!sourceRole) {
    return res.status(404).json({ success: false, error: 'SOURCE_ROLE_NOT_FOUND', message: 'Source role not found.' });
  }

  // Enforce privilege ceiling on cloned permissions
  if (req.employee?.role !== 'SUPER_ADMIN') {
    const callerPerms = new Set(req.effectivePermissions || []);
    const unauthorizedPerms = sourceRole.permissions.filter((p) => (p as string) !== '*' && !callerPerms.has(p));
    if (unauthorizedPerms.length > 0 || sourceRole.permissions.includes('*' as any)) {
      return res.status(403).json({
        success: false,
        error: 'PRIVILEGE_CEILING_EXCEEDED',
        message: 'Cannot clone a role that possesses permissions exceeding your own authorization ceiling.',
      });
    }
  }

  const { name } = req.body;
  const cloneName = name || `${sourceRole.name} (Copy)`;
  const cloneCode = `${sourceRole.code}_COPY_${Date.now().toString(36).toUpperCase()}`;

  const clonedRole = authoritativeAdminStore.createRole({
    name: cloneName,
    code: cloneCode,
    department: sourceRole.department,
    description: `Cloned from ${sourceRole.name}. ${sourceRole.description || ''}`,
    permissions: [...sourceRole.permissions],
    status: 'ACTIVE',
  });

  res.status(201).json({
    success: true,
    role: clonedRole,
    message: `Role "${clonedRole.name}" cloned with ${clonedRole.permissions.length} permissions.`,
  });
});

// 4. Update an existing role definition & permission matrix
adminRouter.put('/roles/:id', requirePermission('roles.edit'), (req: AuthenticatedRequest, res: Response) => {
  const roleId = req.params.id;
  const { name, department, description, permissions, status, code } = req.body;

  const existing = authoritativeAdminStore.getRoleById(roleId);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'Role not found.' });
  }

  if (existing.isSystemRole && existing.code === 'SUPER_ADMIN' && permissions && permissions.length < ALL_SYSTEM_PERMISSIONS.length) {
    return res.status(400).json({ success: false, error: 'PROTECTED_SYSTEM_ROLE', message: 'Super Admin system role permissions cannot be restricted.' });
  }

  if (Array.isArray(permissions)) {
    if (permissions.includes('*' as any) && req.employee?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, error: 'CANNOT_GRANT_WILDCARD', message: 'Only Super Admin may grant wildcard permissions.' });
    }

    if (req.employee?.role !== 'SUPER_ADMIN') {
      const callerPerms = new Set(req.effectivePermissions || []);
      const unauthorizedPerms = permissions.filter((p) => (p as string) !== '*' && !callerPerms.has(p));
      if (unauthorizedPerms.length > 0) {
        return res.status(403).json({
          success: false,
          error: 'PRIVILEGE_CEILING_EXCEEDED',
          message: `Cannot assign permissions you do not possess: ${unauthorizedPerms.slice(0, 3).join(', ')}${unauthorizedPerms.length > 3 ? '...' : ''}`,
        });
      }
    }
  }

  const updated = authoritativeAdminStore.updateRole(roleId, {
    ...(name && { name: name.trim() }),
    ...(code && { code: code.trim().toUpperCase().replace(/\s+/g, '_') }),
    ...(department && { department }),
    ...(description !== undefined && { description }),
    ...(permissions && { permissions }),
    ...(status && { status }),
  });

  res.json({
    success: true,
    role: updated,
    message: `Role "${updated?.name}" updated successfully.`,
  });
});

// 4b. Assign or unassign employees directly to/from a role
adminRouter.post('/roles/:id/assign-employees', requirePermission('roles.assign'), (req: AuthenticatedRequest, res: Response) => {
  const roleId = req.params.id;
  const { employeeIds } = req.body; // array of employee IDs that should have this role

  const role = authoritativeAdminStore.getRoleById(roleId);
  if (!role) {
    return res.status(404).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'Role not found.' });
  }

  if (!Array.isArray(employeeIds)) {
    return res.status(400).json({ success: false, error: 'INVALID_EMPLOYEE_IDS', message: 'employeeIds must be an array.' });
  }

  const allEmployees = authoritativeAdminStore.getEmployees();
  let updatedCount = 0;

  allEmployees.forEach((emp) => {
    const hasRoleCurrently = emp.assignedRoleIds?.includes(role.id) || emp.assignedRoleIds?.includes(role.code);
    const shouldHaveRole = employeeIds.includes(emp.id);

    if (shouldHaveRole && !hasRoleCurrently) {
      const currentRoles = emp.assignedRoleIds || [];
      authoritativeAdminStore.updateEmployee(emp.id, {
        assignedRoleIds: [...currentRoles, role.id],
      });
      updatedCount++;
    } else if (!shouldHaveRole && hasRoleCurrently) {
      // Don't remove SUPER_ADMIN if it's the only one
      const newRoles = (emp.assignedRoleIds || []).filter((r) => r !== role.id && r !== role.code);
      if (newRoles.length > 0 || emp.role !== 'SUPER_ADMIN') {
        authoritativeAdminStore.updateEmployee(emp.id, {
          assignedRoleIds: newRoles.length > 0 ? newRoles : ['role-order-ops-exec'],
        });
        updatedCount++;
      }
    }
  });

  res.json({
    success: true,
    message: `Updated role assignments for ${updatedCount} employee(s).`,
  });
});

// 5. Deactivate a role (with employee impact warning and audit log)
adminRouter.patch('/roles/:id/deactivate', requirePermission('roles.deactivate'), (req: AuthenticatedRequest, res: Response) => {
  const roleId = req.params.id;
  const result = authoritativeAdminStore.deactivateRole(roleId);

  if (!result.success) {
    return res.status(400).json({
      success: false,
      error: 'ROLE_DEACTIVATION_FAILED',
      message: result.message,
    });
  }

  res.json({
    success: true,
    role: result.role,
    affectedEmployeesCount: result.affectedEmployeesCount,
    message: result.message,
  });
});

// 5b. Delete dynamic role
adminRouter.delete('/roles/:id', requirePermission('roles.deactivate'), (req: AuthenticatedRequest, res: Response) => {
  const roleId = req.params.id;
  const role = authoritativeAdminStore.getRoleById(roleId);
  
  if (role && (role.isSystemRole || role.code === 'SUPER_ADMIN')) {
    return res.status(400).json({ success: false, error: 'PROTECTED_SYSTEM_ROLE', message: 'System Super Admin role cannot be deleted.' });
  }

  // Check if active employees have this role and clean up
  if (role) {
    const allEmployees = authoritativeAdminStore.getEmployees();
    allEmployees.forEach((emp) => {
      if (emp.assignedRoleIds?.includes(role.id) || emp.assignedRoleIds?.includes(role.code)) {
        const remaining = (emp.assignedRoleIds || []).filter((r) => r !== role.id && r !== role.code);
        emp.assignedRoleIds = remaining.length > 0 ? remaining : ['role-order-ops-exec'];
      }
    });
  }

  const result = authoritativeAdminStore.deleteRole(roleId);
  if (!result.success) {
    return res.status(400).json({ success: false, error: 'ROLE_DELETE_FAILED', message: result.message });
  }
  res.json({ success: true, message: result.message });
});

// 6. Get employee directory with dynamic permissions summary
const handleGetEmployees = (req: AuthenticatedRequest, res: Response) => {
  const employees = authoritativeAdminStore.getEmployees();
  const allRoles = authoritativeAdminStore.getRoles();

  const enrichedEmployees = employees.map((emp) => {
    const effectivePerms = calculateEmployeePermissions(emp, allRoles);
    const assignedRoles = allRoles.filter(
      (r) => emp.assignedRoleIds?.includes(r.id) || emp.assignedRoleIds?.includes(r.code) || emp.role === r.code
    );

    return {
      ...emp,
      effectivePermissionsCount: effectivePerms.length,
      assignedRolesDetails: assignedRoles,
    };
  });

  res.json({
    success: true,
    employees: enrichedEmployees,
  });
};

adminRouter.get('/employees', requirePermission('employees.view'), handleGetEmployees);
adminRouter.get('/employees/list', requirePermission('employees.view'), handleGetEmployees);

// 7. Create new employee with multi-role assignment
adminRouter.post('/employees/create', requirePermission('employees.create'), (req: AuthenticatedRequest, res: Response) => {
  const { name, email, phone, designation, department, assignedRoleIds, joiningDate } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'Name and email are required.' });
  }

  const newEmp = authoritativeAdminStore.createEmployee({
    name,
    email,
    phone,
    designation,
    department,
    assignedRoleIds: assignedRoleIds || ['role-order-ops-exec'],
    joiningDate,
    status: 'ACTIVE',
  });

  res.status(201).json({
    success: true,
    employee: newEmp,
    message: `Employee "${newEmp.name}" (${newEmp.employeeCode}) created successfully.`,
  });
});

// 8. Update employee details & role assignments
adminRouter.put('/employees/:id/update', requirePermission('employees.edit'), (req: AuthenticatedRequest, res: Response) => {
  const empId = req.params.id;
  const { name, email, phone, designation, department, assignedRoleIds, customPermissionsOverride, reason, status } = req.body;

  const updated = authoritativeAdminStore.updateEmployee(empId, {
    ...(name && { name }),
    ...(email && { email }),
    ...(phone && { phone }),
    ...(designation && { designation }),
    ...(department && { department }),
    ...(assignedRoleIds && { assignedRoleIds }),
    ...(status && { status }),
    ...(customPermissionsOverride !== undefined && { customPermissionsOverride }),
  });

  if (!updated) {
    return res.status(404).json({ success: false, error: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
  }

  res.json({
    success: true,
    employee: updated,
    message: `Employee "${updated.name}" updated successfully.`,
  });
});

// 8b. Quick assign roles to employee
adminRouter.post('/employees/:id/assign-roles', requirePermission('roles.assign'), (req: AuthenticatedRequest, res: Response) => {
  const empId = req.params.id;
  const { assignedRoleIds, reason } = req.body;

  if (!Array.isArray(assignedRoleIds)) {
    return res.status(400).json({ success: false, error: 'INVALID_ROLES', message: 'assignedRoleIds must be an array.' });
  }

  const updated = authoritativeAdminStore.updateEmployee(empId, {
    assignedRoleIds: assignedRoleIds.length > 0 ? assignedRoleIds : ['role-order-ops-exec'],
  });

  if (!updated) {
    return res.status(404).json({ success: false, error: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
  }

  res.json({
    success: true,
    employee: updated,
    message: `Updated roles for "${updated.name}".`,
  });
});

// 9. Update employee status (Activate / Deactivate / Suspend)
adminRouter.patch('/employees/:id/status', requirePermission('employees.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const empId = req.params.id;
  const { status, reason } = req.body;

  if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: 'Status must be ACTIVE, INACTIVE, or SUSPENDED.' });
  }

  if ((status === 'SUSPENDED' || status === 'INACTIVE') && (!reason || reason.trim().length < 5)) {
    return res.status(400).json({
      success: false,
      error: 'JUSTIFICATION_REQUIRED',
      message: 'Deactivating or suspending an employee requires an administrative justification reason.',
    });
  }

  const updated = authoritativeAdminStore.setEmployeeStatus(empId, status, reason);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
  }

  res.json({
    success: true,
    employee: updated,
    message: `Employee status changed to ${status}.`,
  });
});

// 10. Delete employee record
adminRouter.delete('/employees/:id', requirePermission('employees.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.deleteEmployee(req.params.id);
  if (!result.success) {
    return res.status(400).json({ success: false, error: 'EMPLOYEE_DELETE_FAILED', message: result.message });
  }
  res.json({ success: true, message: result.message });
});


// 1. Current Admin Profile & Permissions
const handleAdminMe = (req: AuthenticatedRequest, res: Response) => {
  const admin = req.admin!;
  const emp = req.employee!;
  const permissions = req.effectivePermissions || [];
  const allRoles = authoritativeAdminStore.getRoles();
  const allEmployees = authoritativeAdminStore.getEmployees();

  res.json({
    success: true,
    user: {
      ...admin,
      status: emp.status,
      assignedRoleIds: emp.assignedRoleIds,
      permissions,
    },
    permissions,
    allAvailableRoles: allRoles,
    allEmployees: allEmployees,
  });
};

adminRouter.get('/me', handleAdminMe);
adminRouter.get('/auth/me', handleAdminMe);

// 2. Operational Overview Dashboard Metrics
adminRouter.get('/dashboard/metrics', requirePermission('dashboard.view'), (req: AuthenticatedRequest, res: Response) => {
  const cityFilter = (req.query.city as string || 'all').toLowerCase();
  const timeframe = (req.query.timeframe as string || 'daily').toLowerCase();
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  
  let orders = authoritativeAdminStore.orders;
  let sellers = authoritativeAdminStore.sellers;
  let riders = authoritativeAdminStore.riders;
  let products = authoritativeAdminStore.products;

  if (cityFilter !== 'all') {
    orders = orders.filter((o) => (o.cityId || '').toLowerCase() === cityFilter || (o.deliveryLocation?.city || '').toLowerCase().includes(cityFilter));
    sellers = sellers.filter((s) => (s.cityId || '').toLowerCase() === cityFilter || (s.address.city || '').toLowerCase().includes(cityFilter));
    riders = riders.filter((r) => (r.cityId || '').toLowerCase() === cityFilter || (r.assignedZoneName || '').toLowerCase().includes(cityFilter));
    products = products.filter((p) => (p.cityId || '').toLowerCase() === cityFilter || !p.cityId);
  }

  const preparingCount = orders.filter((o) => o.status === 'picking').length + (cityFilter === 'all' ? 79 : 8);
  const readyPickupCount = orders.filter((o) => o.status === 'packed').length + (cityFilter === 'all' ? 22 : 3);
  const ridersOnlineCount = riders.filter((r) => r.status === 'ONLINE').length + (cityFilter === 'all' ? 143 : 15);
  const ridersDeliveringCount = riders.filter((r) => r.status === 'ON_DELIVERY').length + (cityFilter === 'all' ? 57 : 6);

  const unassignedOrders = orders.filter((o) => o.status === 'packed' && !o.rider);
  const offlineSellers = sellers.filter((s) => !s.isStoreOnline && s.status === 'ACTIVE');
  const lowStockProducts = products.filter((p) => p.stockCount <= p.minStockAlert);

  const baseDayGmv = orders.reduce((acc, curr) => acc + (curr.pricing?.total || 0), 0) + (cityFilter === 'all' ? 672450 : 68000);
  const baseDayOrders = orders.length + (cityFilter === 'all' ? 1342 : 140);

  // Timeframe-specific multiplier & trend calculations
  let multiplier = 1;
  let periodLabel = "Today's";
  let chartTitle = "Hourly Order Volume";
  let peakLabel = "Peak: 312 ord/hr";
  let trendData: { hour: string; orders: number; gmv: number }[] = [];

  if (timeframe === 'weekly') {
    multiplier = 7;
    periodLabel = "This Week's";
    chartTitle = "Daily Order Volume (7-Day Trend)";
    peakLabel = "Peak Day: 1,580 ord";
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    trendData = days.map((d, i) => {
      const dayFactor = [0.12, 0.13, 0.14, 0.15, 0.17, 0.16, 0.13][i];
      return {
        hour: d,
        orders: Math.round(baseDayOrders * multiplier * dayFactor),
        gmv: Math.round(baseDayGmv * multiplier * dayFactor),
      };
    });
  } else if (timeframe === 'monthly') {
    multiplier = 30;
    periodLabel = "This Month's";
    chartTitle = "Weekly Volume (Current Month)";
    peakLabel = "Peak Wk: 11,200 ord";
    const weeks = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
    trendData = weeks.map((w, i) => {
      const wkFactor = [0.22, 0.26, 0.28, 0.24][i];
      return {
        hour: w,
        orders: Math.round(baseDayOrders * multiplier * wkFactor),
        gmv: Math.round(baseDayGmv * multiplier * wkFactor),
      };
    });
  } else if (timeframe === 'quarterly') {
    multiplier = 90;
    periodLabel = "This Quarter's";
    chartTitle = "Monthly Volume (Quarter 3)";
    peakLabel = "Peak Mo: 44,500 ord";
    const months = ['Month 1', 'Month 2', 'Month 3'];
    trendData = months.map((m, i) => {
      const mFactor = [0.31, 0.34, 0.35][i];
      return {
        hour: m,
        orders: Math.round(baseDayOrders * multiplier * mFactor),
        gmv: Math.round(baseDayGmv * multiplier * mFactor),
      };
    });
  } else if (timeframe === 'annual') {
    multiplier = 365;
    periodLabel = "Annual (FY25-26)";
    chartTitle = "Quarterly Volume (Fiscal Year)";
    peakLabel = "Peak Qtr: 135,000 ord";
    const quarters = ['Q1 FY25', 'Q2 FY25', 'Q3 FY26', 'Q4 FY26'];
    trendData = quarters.map((q, i) => {
      const qFactor = [0.22, 0.24, 0.27, 0.27][i];
      return {
        hour: q,
        orders: Math.round(baseDayOrders * multiplier * qFactor),
        gmv: Math.round(baseDayGmv * multiplier * qFactor),
      };
    });
  } else if (timeframe === 'custom') {
    let diffDays = 7;
    if (startDate && endDate) {
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      const days = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
      diffDays = Math.max(1, Math.min(days, 365));
    }
    multiplier = diffDays;
    periodLabel = `Custom Range (${diffDays}D)`;
    chartTitle = `Volume Distribution (${diffDays} Days)`;
    peakLabel = `Avg: ${Math.round((baseDayOrders * multiplier) / Math.max(1, diffDays))} ord/day`;
    
    // Divide the custom range into up to 7 segments for clean visual representation
    const segments = Math.min(diffDays, 7);
    trendData = Array.from({ length: segments }).map((_, i) => ({
      hour: segments === 1 ? 'Day 1' : `P${i + 1}`,
      orders: Math.round((baseDayOrders * multiplier) / segments),
      gmv: Math.round((baseDayGmv * multiplier) / segments),
    }));
  } else {
    // Default: Daily
    multiplier = 1;
    periodLabel = "Today's";
    chartTitle = "Hourly Order Volume";
    peakLabel = "Peak: 312 ord/hr";
    trendData = [
      { hour: '06 AM', orders: Math.round(baseDayOrders * 0.03), gmv: Math.round(baseDayGmv * 0.03) },
      { hour: '07 AM', orders: Math.round(baseDayOrders * 0.08), gmv: Math.round(baseDayGmv * 0.08) },
      { hour: '08 AM', orders: Math.round(baseDayOrders * 0.18), gmv: Math.round(baseDayGmv * 0.18) },
      { hour: '09 AM', orders: Math.round(baseDayOrders * 0.23), gmv: Math.round(baseDayGmv * 0.23) },
      { hour: '10 AM', orders: Math.round(baseDayOrders * 0.21), gmv: Math.round(baseDayGmv * 0.21) },
      { hour: '11 AM', orders: Math.round(baseDayOrders * 0.15), gmv: Math.round(baseDayGmv * 0.15) },
      { hour: '12 PM', orders: Math.round(baseDayOrders * 0.12), gmv: Math.round(baseDayGmv * 0.12) },
    ];
  }

  const periodGmv = Math.round(baseDayGmv * multiplier);
  const periodOrders = Math.round(baseDayOrders * multiplier);

  res.json({
    success: true,
    timeframe,
    periodLabel,
    chartMeta: {
      chartTitle,
      peakLabel,
    },
    kpis: {
      todayOrders: periodOrders,
      todayGmv: periodGmv,
      successfulOrders: Math.round(periodOrders * 0.96),
      deliveredOrders: Math.round(periodOrders * 0.96),
      cancelledOrders: Math.round(periodOrders * 0.025),
      refundsCount: Math.round(periodOrders * 0.01),
      avgDeliverySlaMins: cityFilter === 'all' ? 14.8 : 13.5,
      b2bPercentage: 74.2,
      totalItcClaimed: Math.round(periodGmv * 0.15),
      activeSellersCount: sellers.filter((s) => s.status === 'ACTIVE').length + (cityFilter === 'all' ? 48 : 6),
      activeRidersCount: riders.filter((r) => r.status === 'ONLINE' || r.status === 'ON_DELIVERY').length + (cityFilter === 'all' ? 143 : 15),
    },
    activeNow: {
      ordersPreparing: preparingCount,
      ordersReadyForPickup: readyPickupCount,
      ridersOnline: ridersOnlineCount,
      ridersDelivering: ridersDeliveringCount,
    },
    alerts: {
      ordersWithoutRider: unassignedOrders.length + (cityFilter === 'all' ? 5 : 1),
      sellersOffline: offlineSellers.length + (cityFilter === 'all' ? 11 : 2),
      paymentIssues: cityFilter === 'all' ? 3 : 1,
      lowStockAlerts: lowStockProducts.length + (cityFilter === 'all' ? 4 : 1),
      criticalList: [
        { id: 'alt-1', type: 'NO_RIDER', message: 'Packed orders awaiting rapid dispatch in high-density hub', severity: 'HIGH', link: '/dispatch' },
        { id: 'alt-2', type: 'SELLER_OFFLINE', message: 'Hardware & electrical merchant depot offline during peak business hours', severity: 'MEDIUM', link: '/sellers' },
        { id: 'alt-3', type: 'LOW_STOCK', message: 'Heavy-duty cables and switchgears below safety buffer in regional hub', severity: 'HIGH', link: '/inventory' },
      ],
    },
    hourlyTrend: trendData,
  });
});

// 3. Orders List & Control Center
adminRouter.get('/orders', requirePermission('orders.view'), (req: AuthenticatedRequest, res: Response) => {
  const query = (req.query.q as string || '').toLowerCase();
  const status = req.query.status as string;
  const paymentStatus = req.query.paymentStatus as string;
  const city = (req.query.city as string || 'all').toLowerCase();

  let filtered = [...authoritativeAdminStore.orders];

  if (city !== 'all') {
    filtered = filtered.filter(
      (o) => (o.cityId || '').toLowerCase() === city || (o.deliveryLocation?.city || '').toLowerCase().includes(city)
    );
  }

  if (status && status !== 'ALL') {
    filtered = filtered.filter((o) => o.status === status);
  }

  if (paymentStatus && paymentStatus !== 'ALL') {
    filtered = filtered.filter((o) => o.payment.status === paymentStatus);
  }

  if (query) {
    filtered = filtered.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(query) ||
        o.customer.name.toLowerCase().includes(query) ||
        o.customer.phone.includes(query) ||
        o.seller.name.toLowerCase().includes(query) ||
        (o.rider && o.rider.name.toLowerCase().includes(query)) ||
        (o.deliveryLocation?.areaName && o.deliveryLocation.areaName.toLowerCase().includes(query)) ||
        (o.cityName && o.cityName.toLowerCase().includes(query))
    );
  }

  res.json({
    success: true,
    orders: filtered,
    totalCount: filtered.length,
  });
});

// 4. Order Detail
adminRouter.get('/orders/:id', requirePermission('orders.view'), (req: AuthenticatedRequest, res: Response) => {
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id || o.orderNumber === req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
  }
  res.json({ success: true, order });
});

// 5. Assign / Re-assign Rider (Dispatch Control)
adminRouter.post('/orders/:id/assign-rider', requirePermission('orders.assign_rider'), (req: AuthenticatedRequest, res: Response) => {
  const { riderId } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  const rider = authoritativeAdminStore.riders.find((r) => r.id === riderId);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  order.rider = {
    id: rider.id,
    name: rider.name,
    phone: rider.phone,
    vehicle: rider.vehicleNumber,
    rating: rider.rating,
    currentSpeedKmH: 26,
    distanceMeters: 800,
  };
  order.status = 'out_for_delivery';
  rider.status = 'ON_DELIVERY';
  rider.currentOrderId = order.id;

  order.timeline.push({
    stage: 'Rider Assigned (Manual Dispatch)',
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: `Manual dispatch override by ${req.admin!.name}: Assigned rider ${rider.name}`,
    completed: true,
  });

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_MANUALLY_ASSIGNED',
    targetEntity: 'Order',
    targetId: order.id,
    details: `Assigned rider ${rider.name} (${rider.id}) to order ${order.orderNumber}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, order });
});

// 6. Update Order Status (Force State Transition)
adminRouter.post('/orders/:id/update-status', requirePermission('orders.edit_status'), (req: AuthenticatedRequest, res: Response) => {
  const { status, note } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  const previousStatus = order.status;
  order.status = status;

  order.timeline.push({
    stage: `Status Changed: ${status.toUpperCase()}`,
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: `Admin updated status from ${previousStatus} to ${status}. Note: ${note || 'Manual action'}`,
    completed: true,
  });

  if (status === 'delivered') {
    order.deliveredAt = 'Just now';
    if (order.rider) {
      const rider = authoritativeAdminStore.riders.find((r) => r.id === order.rider!.id);
      if (rider) {
        rider.status = 'ONLINE';
        rider.todayDeliveries += 1;
        rider.todayEarnings += 65;
        rider.currentOrderId = undefined;
      }
    }
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'ORDER_STATUS_TRANSITION',
    targetEntity: 'Order',
    targetId: order.id,
    details: `Transitioned ${order.orderNumber} from ${previousStatus} -> ${status}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, order });
});

// 7. Cancel Order
adminRouter.post('/orders/:id/cancel', requirePermission('orders.cancel'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json({ success: false, error: 'CANCELLATION_REASON_REQUIRED' });
  }

  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  order.status = 'cancelled';
  order.cancelReason = reason;
  order.cancelledAt = 'Just now';

  // Restore inventory
  for (const item of order.items) {
    const prod = authoritativeAdminStore.products.find((p) => p.id === item.productId);
    if (prod) {
      prod.stockCount += item.quantity;
      prod.inStock = true;
    }
  }

  // If paid, create pending refund
  if (order.payment.status === 'PAID') {
    order.payment.status = 'REFUNDED';
    authoritativeAdminStore.refunds.unshift({
      id: `ref-${Date.now().toString(36)}`,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      amount: order.pricing.total,
      maxRefundable: order.pricing.total,
      reason: `Order cancelled by Admin: ${reason}`,
      requestedBy: req.admin!.name,
      status: 'APPROVED',
      createdAt: 'Just now',
      approvedBy: req.admin!.name,
      approvedAt: 'Just now',
    });
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'ORDER_CANCELLED',
    targetEntity: 'Order',
    targetId: order.id,
    details: `Cancelled ${order.orderNumber}. Reason: ${reason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, order });
});

// 7b. Add Internal Audit Note to Order
adminRouter.post('/orders/:id/notes', requirePermission('orders.view'), (req: AuthenticatedRequest, res: Response) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, error: 'NOTE_TEXT_REQUIRED' });
  }

  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  if (!order.notes) order.notes = [];

  const newNote = {
    id: `note-${Date.now().toString(36)}`,
    author: req.admin!.name,
    role: req.admin!.role,
    text: text.trim(),
    createdAt: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
  };

  order.notes.unshift(newNote);

  order.timeline.push({
    stage: 'Internal Note Added',
    timestamp: newNote.createdAt,
    description: `Note logged by ${req.admin!.name}: "${text.trim().substring(0, 60)}${text.length > 60 ? '...' : ''}"`,
    completed: true,
  });

  res.json({ success: true, order, note: newNote });
});

// 7c. Update Delivery Address / Contact Details
adminRouter.put('/orders/:id/delivery-address', requirePermission('orders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { address, landmark, gateCode, contactPhone, areaName } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  if (address) order.deliveryLocation.address = address;
  if (landmark !== undefined) order.deliveryLocation.landmark = landmark;
  if (gateCode !== undefined) order.deliveryLocation.gateCode = gateCode;
  if (contactPhone) order.deliveryLocation.contactPhone = contactPhone;
  if (areaName) order.deliveryLocation.areaName = areaName;

  order.timeline.push({
    stage: 'Delivery Address Updated',
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: `Delivery address/gate instructions altered by ${req.admin!.name}.`,
    completed: true,
  });

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'ORDER_ADDRESS_UPDATED',
    targetEntity: 'Order',
    targetId: order.id,
    details: `Admin updated destination coordinates / address for ${order.orderNumber}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, order });
});

// 7d. Toggle Order Hold Status
adminRouter.post('/orders/:id/toggle-hold', requirePermission('orders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { hold, reason } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  order.isHold = Boolean(hold);
  order.holdReason = hold ? (reason || 'Admin operational hold') : undefined;

  order.timeline.push({
    stage: hold ? 'Order Placed On Hold' : 'Order Released from Hold',
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: hold
      ? `Dispatch paused by ${req.admin!.name}. Reason: ${order.holdReason}`
      : `Hold cleared by ${req.admin!.name}. Resuming delivery lifecycle.`,
    completed: true,
  });

  res.json({ success: true, order });
});

// 7e. Update Priority / Urgency Tag
adminRouter.post('/orders/:id/priority', requirePermission('orders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { priority } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  const validPriorities = ['NORMAL', 'HIGH', 'CRITICAL_SITE'];
  if (!validPriorities.includes(priority)) {
    return res.status(400).json({ success: false, error: 'INVALID_PRIORITY' });
  }

  order.priority = priority;

  order.timeline.push({
    stage: `Priority Set: ${priority}`,
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: `Priority updated to ${priority} by ${req.admin!.name}`,
    completed: true,
  });

  res.json({ success: true, order });
});

// 7f. Item-Level Action: Substitute or Mark Out of Stock
adminRouter.post('/orders/:id/items/:itemIndex/action', requirePermission('orders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const itemIndex = parseInt(req.params.itemIndex, 10);
  const { action, substituteName, substitutePrice, note } = req.body;
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  if (isNaN(itemIndex) || !order.items[itemIndex]) {
    return res.status(404).json({ success: false, error: 'ORDER_ITEM_NOT_FOUND' });
  }

  const targetItem = order.items[itemIndex];

  if (action === 'OUT_OF_STOCK') {
    targetItem.itemStatus = 'OUT_OF_STOCK';
    targetItem.substitutionNote = note || 'Item confirmed out of stock by partner store staff';
    
    // Recalculate order total minus this item
    const deduction = targetItem.price * targetItem.quantity;
    order.pricing.subtotal = Math.max(0, order.pricing.subtotal - deduction);
    order.pricing.tax = Math.round(order.pricing.subtotal * 0.18);
    order.pricing.itcAmount = order.pricing.tax;
    order.pricing.total = Math.max(0, order.pricing.subtotal + order.pricing.tax + order.pricing.deliveryFee + order.pricing.urgencyFee - order.pricing.discount);

    order.timeline.push({
      stage: 'Item Out of Stock',
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      description: `Store staff marked "${targetItem.productName}" as Out of Stock. Order total adjusted by -₹${deduction}.`,
      completed: true,
    });
  } else if (action === 'SUBSTITUTE') {
    if (!substituteName) {
      return res.status(400).json({ success: false, error: 'SUBSTITUTE_NAME_REQUIRED' });
    }
    targetItem.originalProductName = targetItem.productName;
    targetItem.productName = substituteName;
    targetItem.itemStatus = 'SUBSTITUTED';
    targetItem.substitutionNote = note || `Approved replacement for ${targetItem.originalProductName}`;
    if (substitutePrice && typeof substitutePrice === 'number') {
      targetItem.price = substitutePrice;
      // Recalculate
      order.pricing.subtotal = order.items.reduce((acc, it) => acc + (it.itemStatus === 'OUT_OF_STOCK' ? 0 : it.price * it.quantity), 0);
      order.pricing.tax = Math.round(order.pricing.subtotal * 0.18);
      order.pricing.itcAmount = order.pricing.tax;
      order.pricing.total = Math.max(0, order.pricing.subtotal + order.pricing.tax + order.pricing.deliveryFee + order.pricing.urgencyFee - order.pricing.discount);
    }

    order.timeline.push({
      stage: 'Item Substituted',
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      description: `Substituted "${targetItem.originalProductName}" with "${substituteName}" by ${req.admin!.name}.`,
      completed: true,
    });
  } else if (action === 'RESTORE') {
    if (targetItem.originalProductName) {
      targetItem.productName = targetItem.originalProductName;
      targetItem.originalProductName = undefined;
    }
    targetItem.itemStatus = 'FULFILLED';
    targetItem.substitutionNote = undefined;
    
    // Recalculate
    order.pricing.subtotal = order.items.reduce((acc, it) => acc + (it.itemStatus === 'OUT_OF_STOCK' ? 0 : it.price * it.quantity), 0);
    order.pricing.tax = Math.round(order.pricing.subtotal * 0.18);
    order.pricing.itcAmount = order.pricing.tax;
    order.pricing.total = Math.max(0, order.pricing.subtotal + order.pricing.tax + order.pricing.deliveryFee + order.pricing.urgencyFee - order.pricing.discount);

    order.timeline.push({
      stage: 'Item Status Restored',
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      description: `Restored ${targetItem.productName} to standard fulfillment.`,
      completed: true,
    });
  }

  res.json({ success: true, order, item: targetItem });
});

// 7g. Regenerate Delivery OTP (Re-issue token synced to Customer App / SMS and Rider Terminal)
adminRouter.post('/orders/:id/regenerate-otp', requirePermission('orders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const order = authoritativeAdminStore.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });

  const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
  order.deliveryOtp = newOtp;

  order.timeline.push({
    stage: 'Delivery OTP Re-issued',
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    description: `Security OTP regenerated by ${req.admin!.name}. Synced via WebSocket/FCM push to Customer App (${order.customer.phone}) and Rider Terminal validation cache.`,
    completed: true,
  });

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'ORDER_OTP_REISSUED',
    targetEntity: 'Order',
    targetId: order.id,
    details: `Admin re-issued delivery verification OTP for order ${order.orderNumber}. Realtime sync dispatched to customer device & rider verification terminal.`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, order, otp: newOtp });
});

// 8. Sellers Directory & Applications
adminRouter.get('/sellers', requirePermission('sellers.view'), (req: AuthenticatedRequest, res: Response) => {
  const city = (req.query.city as string || 'all').toLowerCase();
  let sellers = authoritativeAdminStore.sellers;
  if (city !== 'all') {
    sellers = sellers.filter((s) => (s.cityId || '').toLowerCase() === city || (s.address.city || '').toLowerCase().includes(city));
  }
  res.json({
    success: true,
    sellers,
  });
});

// 9. Approve Seller Application
adminRouter.post('/sellers/:id/approve', requirePermission('sellers.approve'), (req: AuthenticatedRequest, res: Response) => {
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  seller.status = 'ACTIVE';
  seller.isStoreOnline = true;
  seller.canReceiveOrders = true;
  seller.isOrderingEnabled = true;
  seller.documents.gstVerified = true;
  seller.documents.panVerified = true;
  seller.documents.bankVerified = true;
  seller.documents.tradeLicenseVerified = true;

  if (seller.uploadedDocuments) {
    seller.uploadedDocuments.forEach((doc) => {
      doc.verificationStatus = 'VERIFIED';
    });
  }
  if (seller.bgvSummary) {
    seller.bgvSummary.status = 'CLEARED';
    seller.bgvSummary.checks.forEach((chk) => {
      chk.status = 'PASSED';
    });
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_APPLICATION_APPROVED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Approved KYC documents, verified BGV and onboarded store ${seller.name}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 9b. Verify Single Document for Seller
adminRouter.post('/sellers/:id/documents/:docId/verify', requirePermission('sellers.approve'), (req: AuthenticatedRequest, res: Response) => {
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  const doc = seller.uploadedDocuments?.find((d) => d.id === req.params.docId);
  if (doc) {
    doc.verificationStatus = 'VERIFIED';
    delete doc.rejectionReason;

    // Sync legacy boolean flags if applicable
    if (doc.docType === 'GST_CERTIFICATE') seller.documents.gstVerified = true;
    if (doc.docType === 'PAN_CARD') seller.documents.panVerified = true;
    if (doc.docType === 'BANK_PASSBOOK') seller.documents.bankVerified = true;
    if (doc.docType === 'FSSAI_LICENSE' || doc.docType === 'TRADE_LICENSE') seller.documents.tradeLicenseVerified = true;
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_DOCUMENT_VERIFIED',
    targetEntity: 'SellerDocument',
    targetId: req.params.docId,
    details: `Verified document ${doc?.title || req.params.docId} for seller ${seller.name}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 9c. Request Re-upload for Seller Document
adminRouter.post('/sellers/:id/documents/:docId/request-reupload', requirePermission('sellers.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  const doc = seller.uploadedDocuments?.find((d) => d.id === req.params.docId);
  if (doc) {
    doc.verificationStatus = 'PENDING';
    doc.rejectionReason = `Re-upload requested: ${reason || 'Document unclear or invalid'}`;
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_DOCUMENT_REUPLOAD_REQUESTED',
    targetEntity: 'SellerDocument',
    targetId: req.params.docId,
    details: `Requested re-upload for ${doc?.title || req.params.docId}. Reason: ${reason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 10. Reject Seller Application
adminRouter.post('/sellers/:id/reject', requirePermission('sellers.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  seller.status = 'REJECTED';
  seller.rejectionReason = reason || 'KYC verification criteria not met';

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_APPLICATION_REJECTED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Rejected applicant ${seller.name}. Reason: ${seller.rejectionReason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 11. Toggle Seller Store Controls (Online, Can Receive, Suspend)
adminRouter.post('/sellers/:id/toggle-status', requirePermission('sellers.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const { isStoreOnline, canReceiveOrders, isOrderingEnabled, status } = req.body;
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  if (typeof isStoreOnline === 'boolean') seller.isStoreOnline = isStoreOnline;
  if (typeof canReceiveOrders === 'boolean') seller.canReceiveOrders = canReceiveOrders;
  if (typeof isOrderingEnabled === 'boolean') seller.isOrderingEnabled = isOrderingEnabled;
  if (status) seller.status = status;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_CONTROLS_MODIFIED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Updated controls for ${seller.name}: Online=${seller.isStoreOnline}, Receive=${seller.canReceiveOrders}, Status=${seller.status}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12. Update Seller Commission
adminRouter.post('/sellers/:id/update-commission', requirePermission('sellers.edit_commission'), (req: AuthenticatedRequest, res: Response) => {
  const { commissionRatePercent } = req.body;
  if (typeof commissionRatePercent !== 'number' || commissionRatePercent < 15 || commissionRatePercent > 50) {
    return res.status(400).json({ success: false, error: 'INVALID_COMMISSION_PERCENT', message: 'Platform commission take rate must be at least 15.0%' });
  }

  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  const oldRate = seller.commissionRatePercent;
  seller.commissionRatePercent = commissionRatePercent;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_COMMISSION_ADJUSTED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Changed commission for ${seller.name} from ${oldRate}% to ${commissionRatePercent}%`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12b. Onboard / Create New Partner Store
adminRouter.post('/sellers/create', requirePermission('sellers.create'), (req: AuthenticatedRequest, res: Response) => {
  const {
    name,
    ownerName,
    hubType,
    categories,
    phone,
    email,
    address,
    areaName,
    cityId,
    gstin,
    panNumber,
    bankAccount,
    commissionRatePercent,
    avgPrepTimeMins,
    documents,
    status = 'ACTIVE',
  } = req.body;

  if (!name || !ownerName || !phone || !gstin) {
    return res.status(400).json({ success: false, error: 'REQUIRED_FIELDS_MISSING', message: 'Name, Owner, Phone, and GSTIN are required.' });
  }

  const newSeller: any = {
    id: `sel-${Date.now().toString().slice(-6)}`,
    name: name.trim(),
    ownerName: ownerName.trim(),
    hubType: hubType || 'General Marketplace Hub',
    categories: Array.isArray(categories) && categories.length > 0 ? categories : (hubType ? [hubType] : ['Hardware & Fasteners', 'Electrical & Lighting']),
    phone: phone.trim(),
    email: email || `${name.toLowerCase().replace(/[^a-z0-9]/g, '.')}@qcom-sellers.in`,
    address: typeof address === 'string' ? address : (address?.street || `${areaName || 'Central Marketplace'}, Bengaluru`),
    cityId: cityId || 'bengaluru',
    areaName: areaName || 'Bengaluru Central',
    gstin: gstin.toUpperCase().trim(),
    panNumber: (panNumber || gstin.substring(2, 12)).toUpperCase().trim(),
    bankAccount: {
      accountNumber: bankAccount?.accountNumber || '100098273645',
      ifsc: bankAccount?.ifsc || 'HDFC0000124',
      bankName: bankAccount?.bankName || 'HDFC Bank, Commercial Branch',
    },
    status: status || 'ACTIVE',
    isStoreOnline: status === 'ACTIVE',
    canReceiveOrders: status === 'ACTIVE',
    isOrderingEnabled: status === 'ACTIVE',
    commissionRatePercent: typeof commissionRatePercent === 'number' && commissionRatePercent >= 15 ? commissionRatePercent : 15.0,
    rating: 5.0,
    totalOrders: 0,
    activeOrdersCount: 0,
    avgPrepTimeMins: typeof avgPrepTimeMins === 'number' ? avgPrepTimeMins : 2.5,
    slaAdherencePercent: 100.0,
    joinedDate: new Date().toISOString().split('T')[0],
    documents: {
      gstVerified: documents?.gstVerified ?? true,
      panVerified: documents?.panVerified ?? true,
      bankVerified: documents?.bankVerified ?? true,
      tradeLicenseVerified: documents?.tradeLicenseVerified ?? true,
      tradeLicenseNumber: documents?.tradeLicenseNumber || 'TL-BBMP-2026-9812',
    },
  };

  authoritativeAdminStore.sellers.unshift(newSeller);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_ONBOARDED',
    targetEntity: 'Seller',
    targetId: newSeller.id,
    details: `Onboarded partner store ${newSeller.name} (${newSeller.gstin}) at ${newSeller.areaName}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller: newSeller });
});

// 12c. Full Update Partner Store Profile & Operations
adminRouter.put('/sellers/:id', requirePermission('sellers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  const {
    name,
    ownerName,
    hubType,
    categories,
    phone,
    email,
    address,
    areaName,
    cityId,
    gstin,
    panNumber,
    bankAccount,
    commissionRatePercent,
    avgPrepTimeMins,
    slaAdherencePercent,
    isStoreOnline,
    canReceiveOrders,
    isOrderingEnabled,
    status,
    suspensionReason,
    rejectionReason,
    documents,
  } = req.body;

  if (name) seller.name = name;
  if (ownerName) seller.ownerName = ownerName;
  if (hubType) seller.hubType = hubType;
  if (Array.isArray(categories)) seller.categories = categories;
  if (phone) seller.phone = phone;
  if (email) seller.email = email;
  if (address) seller.address = address;
  if (areaName) seller.areaName = areaName;
  if (cityId) seller.cityId = cityId;
  if (gstin) seller.gstin = gstin.toUpperCase();
  if (panNumber) seller.panNumber = panNumber.toUpperCase();
  if (bankAccount) {
    seller.bankAccount = {
      ...seller.bankAccount,
      ...bankAccount,
    };
  }
  if (typeof commissionRatePercent === 'number') seller.commissionRatePercent = Math.max(15.0, commissionRatePercent);
  if (typeof avgPrepTimeMins === 'number') seller.avgPrepTimeMins = avgPrepTimeMins;
  if (typeof slaAdherencePercent === 'number') seller.slaAdherencePercent = slaAdherencePercent;
  if (typeof isStoreOnline === 'boolean') seller.isStoreOnline = isStoreOnline;
  if (typeof canReceiveOrders === 'boolean') seller.canReceiveOrders = canReceiveOrders;
  if (typeof isOrderingEnabled === 'boolean') seller.isOrderingEnabled = isOrderingEnabled;
  if (status) seller.status = status;
  if (suspensionReason !== undefined) seller.suspensionReason = suspensionReason;
  if (rejectionReason !== undefined) seller.rejectionReason = rejectionReason;
  if (documents) {
    seller.documents = {
      ...seller.documents,
      ...documents,
    };
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_PROFILE_UPDATED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Updated full profile and parameters for partner store ${seller.name} (${seller.id})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12d. Suspend Partner Store
adminRouter.post('/sellers/:id/suspend', requirePermission('sellers.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const { reason = 'Compliance audit failure' } = req.body;
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  seller.status = 'SUSPENDED';
  seller.suspensionReason = reason;
  seller.isStoreOnline = false;
  seller.canReceiveOrders = false;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_SUSPENDED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Suspended partner store ${seller.name}. Reason: ${reason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12e. Reactivate Partner Store
adminRouter.post('/sellers/:id/reactivate', requirePermission('sellers.reactivate'), (req: AuthenticatedRequest, res: Response) => {
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  seller.status = 'ACTIVE';
  seller.suspensionReason = undefined;
  seller.isStoreOnline = true;
  seller.canReceiveOrders = true;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_REACTIVATED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Reactivated partner store ${seller.name} (${seller.id})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12f. Update KYC Document Verifications
adminRouter.post('/sellers/:id/update-kyc', requirePermission('sellers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { documents, gstin, panNumber, bankAccount } = req.body;
  const seller = authoritativeAdminStore.sellers.find((s) => s.id === req.params.id);
  if (!seller) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  if (gstin) seller.gstin = gstin.toUpperCase();
  if (panNumber) seller.panNumber = panNumber.toUpperCase();
  if (bankAccount) seller.bankAccount = { ...seller.bankAccount, ...bankAccount };
  if (documents) seller.documents = { ...seller.documents, ...documents };

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_KYC_UPDATED',
    targetEntity: 'Seller',
    targetId: seller.id,
    details: `Updated KYC document verifications for ${seller.name}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, seller });
});

// 12g. Delete Partner Store
adminRouter.delete('/sellers/:id', requirePermission('sellers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const sellerIndex = authoritativeAdminStore.sellers.findIndex((s) => s.id === req.params.id);
  if (sellerIndex === -1) return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND' });

  const deletedSeller = authoritativeAdminStore.sellers.splice(sellerIndex, 1)[0];

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_DELETED',
    targetEntity: 'Seller',
    targetId: deletedSeller.id,
    details: `De-boarded and removed partner store ${deletedSeller.name} (${deletedSeller.gstin})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: `Partner store ${deletedSeller.name} removed successfully.` });
});

// 13. Riders / Fleet Management - List
adminRouter.get('/riders', requirePermission('riders.view'), (req: AuthenticatedRequest, res: Response) => {
  const city = (req.query.city as string || 'all').toLowerCase();
  const status = req.query.status as string;
  const search = (req.query.search as string || '').toLowerCase();

  let riders = authoritativeAdminStore.riders;
  if (city !== 'all') {
    riders = riders.filter((r) => (r.cityId || '').toLowerCase() === city || (r.assignedZoneName || '').toLowerCase().includes(city));
  }
  if (status && status !== 'ALL') {
    riders = riders.filter((r) => r.status === status);
  }
  if (search) {
    riders = riders.filter((r) =>
      r.name.toLowerCase().includes(search) ||
      r.phone.includes(search) ||
      (r.email && r.email.toLowerCase().includes(search)) ||
      r.vehicleNumber.toLowerCase().includes(search) ||
      (r.assignedZoneName && r.assignedZoneName.toLowerCase().includes(search))
    );
  }
  res.json({
    success: true,
    riders,
  });
});

// 13b. Single Rider Profile
adminRouter.get('/riders/:id', requirePermission('riders.view'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });
  res.json({ success: true, rider });
});

// 13c. Onboard / Create Rider Profile
adminRouter.post('/riders', requirePermission('riders.create'), (req: AuthenticatedRequest, res: Response) => {
  const {
    name,
    phone,
    email,
    emergencyContact,
    bloodGroup,
    avatar,
    cityId,
    cityName,
    assignedZoneId,
    assignedZoneName,
    vehicleType,
    vehicleMakeModel,
    vehicleNumber,
    maxPayloadKg,
    batteryPercent,
    fuelType,
    dutyType,
    shiftHours,
    documents,
    bankDetails,
    status = 'ONLINE',
  } = req.body;

  if (!name || !phone || !vehicleNumber) {
    return res.status(400).json({ success: false, error: 'NAME_PHONE_VEHICLE_REQUIRED' });
  }

  const newRider: any = {
    id: `rdr-${Date.now().toString().slice(-6)}`,
    name,
    phone,
    email: email || `${name.toLowerCase().replace(/\s+/g, '.')}@qcomfleet.in`,
    emergencyContact: emergencyContact || { name: 'Emergency Contact', relationship: 'Family', phone: phone },
    bloodGroup: bloodGroup || 'B+',
    avatar: avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
    cityId: cityId || 'bengaluru',
    cityName: cityName || 'Bengaluru',
    assignedZoneId: assignedZoneId || 'zone-blr-01',
    assignedZoneName: assignedZoneName || 'Central Delivery Hub',
    vehicleType: vehicleType || 'EV_SCOOTER',
    vehicleMakeModel: vehicleMakeModel || 'EV Commercial Scooter',
    vehicleNumber: vehicleNumber.toUpperCase().trim(),
    maxPayloadKg: maxPayloadKg || (vehicleType === 'E_LOADER' ? 350 : 60),
    batteryPercent: batteryPercent !== undefined ? batteryPercent : 90,
    fuelType: fuelType || 'ELECTRIC',
    hasInsulatedThermalBag: true,
    hasHelmetAndSafetyGear: true,
    status: status || 'ONLINE',
    dutyType: dutyType || 'FULL_TIME',
    shiftHours: shiftHours || '07:00 AM - 04:00 PM',
    currentLocation: {
      lat: 12.9716,
      lng: 77.5946,
      areaName: `${assignedZoneName || 'Central Hub'}, ${cityName || 'Bengaluru'}`,
    },
    rating: 5.0,
    totalDeliveries: 0,
    todayDeliveries: 0,
    todayEarnings: 0,
    totalLifetimeEarnings: 0,
    onTimeDeliveryRate: 100,
    cancellationRate: 0,
    activeSince: 'Just Onboarded',
    lastActiveTimestamp: 'Just now',
    documents: {
      drivingLicenseNumber: documents?.drivingLicenseNumber || '',
      drivingLicenseVerified: documents?.drivingLicenseVerified ?? true,
      drivingLicenseExpiry: documents?.drivingLicenseExpiry || '2035-12-31',
      rcNumber: documents?.rcNumber || '',
      rcVerified: documents?.rcVerified ?? true,
      aadharNumber: documents?.aadharNumber || '',
      aadharVerified: documents?.aadharVerified ?? true,
      panNumber: documents?.panNumber || '',
      panVerified: documents?.panVerified ?? true,
      insurancePolicyNumber: documents?.insurancePolicyNumber || '',
      insuranceVerified: documents?.insuranceVerified ?? true,
      backgroundCheckPassed: documents?.backgroundCheckPassed ?? true,
      policeVerificationDocVerified: documents?.policeVerificationDocVerified ?? true,
    },
    bankDetails: {
      accountHolderName: bankDetails?.accountHolderName || name,
      accountNumber: bankDetails?.accountNumber || '',
      ifscCode: bankDetails?.ifscCode || '',
      bankName: bankDetails?.bankName || '',
      upiId: bankDetails?.upiId || '',
      payoutFrequency: bankDetails?.payoutFrequency || 'DAILY',
    },
  };

  authoritativeAdminStore.riders.unshift(newRider);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_ONBOARDED',
    targetEntity: 'Rider',
    targetId: newRider.id,
    details: `Onboarded delivery partner ${newRider.name} (${newRider.vehicleNumber}) to ${newRider.assignedZoneName}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider: newRider });
});

// 13d. Update / Edit Rider Profile
adminRouter.put('/riders/:id', requirePermission('riders.edit'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const {
    name,
    phone,
    email,
    emergencyContact,
    bloodGroup,
    avatar,
    cityId,
    cityName,
    assignedZoneId,
    assignedZoneName,
    vehicleType,
    vehicleMakeModel,
    vehicleNumber,
    maxPayloadKg,
    batteryPercent,
    fuelType,
    hasInsulatedThermalBag,
    hasHelmetAndSafetyGear,
    status,
    dutyType,
    shiftHours,
    rating,
    documents,
    bankDetails,
  } = req.body;

  if (name !== undefined) rider.name = name;
  if (phone !== undefined) rider.phone = phone;
  if (email !== undefined) rider.email = email;
  if (emergencyContact !== undefined) rider.emergencyContact = emergencyContact;
  if (bloodGroup !== undefined) rider.bloodGroup = bloodGroup;
  if (avatar !== undefined) rider.avatar = avatar;
  if (cityId !== undefined) rider.cityId = cityId;
  if (cityName !== undefined) rider.cityName = cityName;
  if (assignedZoneId !== undefined) rider.assignedZoneId = assignedZoneId;
  if (assignedZoneName !== undefined) rider.assignedZoneName = assignedZoneName;
  if (vehicleType !== undefined) rider.vehicleType = vehicleType;
  if (vehicleMakeModel !== undefined) rider.vehicleMakeModel = vehicleMakeModel;
  if (vehicleNumber !== undefined) rider.vehicleNumber = vehicleNumber.toUpperCase().trim();
  if (maxPayloadKg !== undefined) rider.maxPayloadKg = Number(maxPayloadKg);
  if (batteryPercent !== undefined) rider.batteryPercent = Number(batteryPercent);
  if (fuelType !== undefined) rider.fuelType = fuelType;
  if (hasInsulatedThermalBag !== undefined) rider.hasInsulatedThermalBag = Boolean(hasInsulatedThermalBag);
  if (hasHelmetAndSafetyGear !== undefined) rider.hasHelmetAndSafetyGear = Boolean(hasHelmetAndSafetyGear);
  if (status !== undefined) rider.status = status;
  if (dutyType !== undefined) rider.dutyType = dutyType;
  if (shiftHours !== undefined) rider.shiftHours = shiftHours;
  if (rating !== undefined) rider.rating = Number(rating);

  if (documents) {
    rider.documents = {
      ...rider.documents,
      ...documents,
    };
  }

  if (bankDetails) {
    rider.bankDetails = {
      ...rider.bankDetails,
      ...bankDetails,
    };
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_PROFILE_UPDATED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Updated fleet profile & details for rider ${rider.name} (${rider.vehicleNumber})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 13e. Suspend Rider
adminRouter.post('/riders/:id/suspend', requirePermission('riders.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const { reason = 'Operational policy or SLA compliance violation' } = req.body;
  rider.status = 'SUSPENDED';
  rider.suspensionReason = reason;
  rider.suspendedAt = new Date().toISOString();

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_SUSPENDED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Suspended rider ${rider.name}. Reason: ${reason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 13f. Reactivate Rider
adminRouter.post('/riders/:id/reactivate', requirePermission('riders.reactivate'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  rider.status = 'ONLINE';
  delete rider.suspensionReason;
  delete rider.suspendedAt;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_REACTIVATED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Reactivated suspended rider ${rider.name} to ONLINE status`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 13g. Reassign Zone / Local Seller Cluster (3-4 km)
adminRouter.post('/riders/:id/assign-zone', requirePermission('riders.assign'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const { zoneId, zoneName, cityId, cityName } = req.body;
  if (!zoneName) return res.status(400).json({ success: false, error: 'ZONE_NAME_REQUIRED' });

  rider.assignedZoneId = zoneId || rider.assignedZoneId;
  rider.assignedZoneName = zoneName;
  if (cityId) rider.cityId = cityId;
  if (cityName) rider.cityName = cityName;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_ZONE_REASSIGNED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Reassigned rider ${rider.name} to zone: ${zoneName}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 13h. Delete Rider
adminRouter.delete('/riders/:id', requirePermission('riders.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.riders.findIndex((r) => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const removedRider = authoritativeAdminStore.riders.splice(index, 1)[0];

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_DELETED',
    targetEntity: 'Rider',
    targetId: removedRider.id,
    details: `Deleted fleet profile for rider ${removedRider.name} (${removedRider.vehicleNumber})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Rider profile removed successfully' });
});

// 14. Approve Rider Application
adminRouter.post('/riders/:id/approve', requirePermission('riders.approve'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  rider.status = 'ONLINE';
  rider.documents.drivingLicenseVerified = true;
  rider.documents.rcVerified = true;
  rider.documents.aadharVerified = true;
  rider.documents.panVerified = true;
  rider.documents.insuranceVerified = true;
  rider.documents.backgroundCheckPassed = true;
  rider.documents.policeVerificationDocVerified = true;

  if (rider.uploadedDocuments) {
    rider.uploadedDocuments.forEach((doc) => {
      doc.verificationStatus = 'VERIFIED';
    });
  }
  if (rider.bgvSummary) {
    rider.bgvSummary.status = 'CLEARED';
    rider.bgvSummary.checks.forEach((chk) => {
      chk.status = 'PASSED';
    });
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_APPROVED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Approved fleet onboarding and verified KYC/BGV for rider ${rider.name}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 14b. Reject Rider Application
adminRouter.post('/riders/:id/reject', requirePermission('riders.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  rider.status = 'SUSPENDED';

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_APPLICATION_REJECTED',
    targetEntity: 'Rider',
    targetId: rider.id,
    details: `Rejected rider applicant ${rider.name}. Reason: ${reason || 'KYC / BGV criteria not met'}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider, message: 'Rider application rejected' });
});

// 14c. Verify Single Rider Document
adminRouter.post('/riders/:id/documents/:docId/verify', requirePermission('riders.approve'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const doc = rider.uploadedDocuments?.find((d) => d.id === req.params.docId);
  if (doc) {
    doc.verificationStatus = 'VERIFIED';
    delete doc.rejectionReason;

    if (doc.docType === 'AADHAAR') rider.documents.aadharVerified = true;
    if (doc.docType === 'DRIVING_LICENSE') rider.documents.drivingLicenseVerified = true;
    if (doc.docType === 'VEHICLE_RC') rider.documents.rcVerified = true;
    if (doc.docType === 'INSURANCE') rider.documents.insuranceVerified = true;
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_DOCUMENT_VERIFIED',
    targetEntity: 'RiderDocument',
    targetId: req.params.docId,
    details: `Verified document ${doc?.title || req.params.docId} for rider ${rider.name}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 14d. Request Re-upload for Rider Document
adminRouter.post('/riders/:id/documents/:docId/request-reupload', requirePermission('riders.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  const doc = rider.uploadedDocuments?.find((d) => d.id === req.params.docId);
  if (doc) {
    doc.verificationStatus = 'PENDING';
    doc.rejectionReason = `Re-upload requested: ${reason || 'Document unclear or invalid'}`;
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'RIDER_DOCUMENT_REUPLOAD_REQUESTED',
    targetEntity: 'RiderDocument',
    targetId: req.params.docId,
    details: `Requested re-upload for ${doc?.title || req.params.docId}. Reason: ${reason}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, rider });
});

// 15. Broadcast to Riders
adminRouter.post('/riders/broadcast', requirePermission('riders.broadcast'), (req: AuthenticatedRequest, res: Response) => {
  const { message, zoneId, incentiveAmount } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'BROADCAST_MESSAGE_REQUIRED' });

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'FLEET_BROADCAST_SENT',
    targetEntity: 'RiderFleet',
    targetId: zoneId || 'ALL_ZONES',
    details: `Broadcast: "${message}" (Incentive: ₹${incentiveAmount || 0})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    sentCount: authoritativeAdminStore.riders.filter((r) => r.status === 'ONLINE' || r.status === 'ON_DELIVERY').length,
    message: 'Broadcast sent to active riders',
  });
});

// 15b. Single Rider Ledger
adminRouter.get('/riders/:id/ledger', requirePermission('riders.view'), (req: AuthenticatedRequest, res: Response) => {
  const rider = authoritativeAdminStore.riders.find((r) => r.id === req.params.id);
  if (!rider) return res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND' });

  res.json({
    success: true,
    riderId: rider.id,
    riderName: rider.name,
    todayEarnings: rider.todayEarnings || 0,
    todayDeliveries: rider.todayDeliveries || 0,
    weeklyEarnings: rider.weeklyEarnings || Math.round((rider.todayEarnings || 0) * 5.4),
    weeklyDeliveries: rider.weeklyDeliveries || Math.round((rider.todayDeliveries || 0) * 5.8),
    monthlyEarnings: rider.monthlyEarnings || Math.round((rider.todayEarnings || 0) * 24.5),
    monthlyDeliveries: rider.monthlyDeliveries || Math.round((rider.todayDeliveries || 0) * 25.2),
    totalDeliveries: rider.totalDeliveries || 0,
    totalLifetimeEarnings: rider.totalLifetimeEarnings || 142000,
    pendingPayableBalance: rider.pendingPayableBalance ?? (rider.todayEarnings || 0),
    payoutStatus: rider.payoutStatus || 'PENDING_RELEASE',
    bankDetails: rider.bankDetails,
    ledgerEntries: rider.ledgerEntries || [],
  });
});

// 15c. Release Rider Payout (Single)
adminRouter.post('/riders/:id/release-payout', sensitiveOpsLimiter, requirePermission('riders.payout'), (req: AuthenticatedRequest, res: Response) => {
  const { payoutType = 'DAILY', amount, paymentMode = 'UPI' } = req.body;
  const result = authoritativeAdminStore.releaseRiderPayout(
    req.params.id,
    payoutType,
    amount,
    paymentMode,
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json(result);
});

// 15d. Bulk Release Rider Payouts
adminRouter.post('/riders/bulk-release-payout', sensitiveOpsLimiter, requirePermission('riders.payout'), (req: AuthenticatedRequest, res: Response) => {
  const { payoutType = 'DAILY', city = 'all' } = req.body;
  const result = authoritativeAdminStore.bulkReleaseRiderPayouts(
    payoutType,
    city,
    req.employee || req.admin
  );

  res.json(result);
});

// 15e. Toggle Rider Payout Hold
adminRouter.post('/riders/:id/toggle-payout-hold', sensitiveOpsLimiter, requirePermission('riders.payout'), (req: AuthenticatedRequest, res: Response) => {
  const { reason = '' } = req.body;
  const result = authoritativeAdminStore.toggleRiderPayoutHold(
    req.params.id,
    reason,
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json(result);
});

// 16. Customers
adminRouter.get('/customers', requirePermission('customers.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    customers: authoritativeAdminStore.customers,
  });
});

// 16b. Update Customer Status (Suspend, Ban, Flag, Reactivate)
adminRouter.patch('/customers/:id/status', sensitiveOpsLimiter, requirePermission('customers.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const { status, reason } = req.body;
  if (!['ACTIVE', 'FLAGGED', 'SUSPENDED', 'BANNED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: 'Status must be ACTIVE, FLAGGED, SUSPENDED, or BANNED.' });
  }

  if ((status === 'SUSPENDED' || status === 'BANNED' || status === 'FLAGGED') && (!reason || reason.trim().length < 3)) {
    return res.status(400).json({
      success: false,
      error: 'REASON_REQUIRED',
      message: `Changing customer status to ${status} requires a valid administrative justification reason.`,
    });
  }

  const result = authoritativeAdminStore.setCustomerStatus(
    req.params.id,
    status,
    reason,
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// 16c. Update Customer Fraud & Risk Controls
adminRouter.post('/customers/:id/fraud-controls', sensitiveOpsLimiter, requirePermission('customers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { riskLevel, isVip, creditLimitINR, fraudFlags } = req.body;
  const result = authoritativeAdminStore.updateCustomerFraudControls(
    req.params.id,
    { riskLevel, isVip, creditLimitINR, fraudFlags },
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// 16d. Add Customer Administrative Note
adminRouter.post('/customers/:id/notes', requirePermission('customers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { noteText } = req.body;
  if (!noteText || typeof noteText !== 'string' || !noteText.trim()) {
    return res.status(400).json({ success: false, error: 'NOTE_TEXT_REQUIRED', message: 'Note text cannot be empty.' });
  }

  const result = authoritativeAdminStore.addCustomerNote(
    req.params.id,
    noteText,
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// 16e. Force Reset / Invalidate Customer Active Sessions
adminRouter.post('/customers/:id/reset-session', sensitiveOpsLimiter, requirePermission('customers.suspend'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.resetCustomerSession(
    req.params.id,
    req.employee || req.admin
  );

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// 16f. Update Customer Profile Details
adminRouter.put('/customers/:id', requirePermission('customers.edit'), (req: AuthenticatedRequest, res: Response) => {
  const customer = authoritativeAdminStore.customers.find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, error: 'CUSTOMER_NOT_FOUND', message: 'Customer account not found.' });

  const { name, phone, email, companyName, accountType } = req.body;
  if (name) customer.name = name.trim();
  if (phone) customer.phone = phone.trim();
  if (email !== undefined) customer.email = email.trim();
  if (companyName !== undefined) customer.companyName = companyName.trim();
  if (accountType) customer.accountType = accountType;

  res.json({
    success: true,
    customer,
    message: `Updated profile details for customer "${customer.name}".`,
  });
});

// 17. Inventory Management
adminRouter.get('/inventory', requirePermission('inventory.view'), (req: AuthenticatedRequest, res: Response) => {
  const city = (req.query.city as string || 'all').toLowerCase();
  let products = authoritativeAdminStore.products.map((p) => {
    const sellers = p.sellers || [];
    const totalStock = sellers.reduce((sum, s) => sum + (s.stockCount || 0), 0);
    const minAlert = p.minStockAlert || 20;
    
    // Check seller-level stock health
    const lowStockSellers = sellers.filter((s) => s.stockCount > 0 && s.stockCount <= (s.minStockAlert || 10));
    const outOfStockSellers = sellers.filter((s) => s.stockCount === 0);

    // Compute dynamic Average Listed Price across all active seller listings
    const sellerPrices = sellers.map((s) => s.price).filter((pr) => typeof pr === 'number' && pr > 0);
    const avgPrice = sellerPrices.length > 0
      ? Math.round(sellerPrices.reduce((sum, pr) => sum + pr, 0) / sellerPrices.length)
      : p.price;
    const minPrice = sellerPrices.length > 0 ? Math.min(...sellerPrices) : p.price;
    const maxPrice = sellerPrices.length > 0 ? Math.max(...sellerPrices) : p.price;

    let status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' = 'IN_STOCK';
    if (totalStock === 0 || outOfStockSellers.length > 0) {
      status = 'OUT_OF_STOCK';
    } else if (totalStock <= minAlert || lowStockSellers.length > 0) {
      status = 'LOW_STOCK';
    }

    return {
      ...p,
      price: avgPrice,
      avgPrice,
      minPrice,
      maxPrice,
      stockCount: totalStock,
      sellerCount: sellers.length,
      lowStockSellerCount: lowStockSellers.length,
      outOfStockSellerCount: outOfStockSellers.length,
      inStock: totalStock > 0,
      status,
    };
  });

  if (city !== 'all') {
    // Return all products that have sellers in that city
    products = products.filter((p) => {
      if (!p.sellers || p.sellers.length === 0) return true;
      return p.sellers.some((s) => s.cityId === city || s.cityName.toLowerCase().includes(city));
    });
  }

  res.json({
    success: true,
    products,
  });
});

// Adjust stock & price for a specific seller for a given SKU
adminRouter.post('/inventory/:id/adjust-seller-stock', requirePermission('inventory.edit_stock'), (req: AuthenticatedRequest, res: Response) => {
  const { sellerId, newStockCount, newPrice, newMinStockAlert, reason } = req.body;
  if (typeof newStockCount !== 'number' && typeof newPrice !== 'number' && typeof newMinStockAlert !== 'number') {
    return res.status(400).json({ success: false, error: 'NO_VALID_UPDATE_FIELDS_PROVIDED' });
  }
  if (!sellerId) {
    return res.status(400).json({ success: false, error: 'SELLER_ID_REQUIRED' });
  }

  const prod = authoritativeAdminStore.products.find((p) => p.id === req.params.id || p.sku === req.params.id);
  if (!prod) return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });

  if (!prod.sellers) prod.sellers = [];
  const sellerEntry = prod.sellers.find((s) => s.sellerId === sellerId);
  if (!sellerEntry) {
    return res.status(404).json({ success: false, error: 'SELLER_NOT_FOUND_FOR_SKU' });
  }

  const oldStock = sellerEntry.stockCount;
  const oldPrice = sellerEntry.price;

  if (typeof newStockCount === 'number' && newStockCount >= 0) {
    sellerEntry.stockCount = newStockCount;
  }
  if (typeof newPrice === 'number' && newPrice > 0) {
    sellerEntry.price = newPrice;
  }
  if (typeof newMinStockAlert === 'number' && newMinStockAlert >= 0) {
    sellerEntry.minStockAlert = newMinStockAlert;
  }
  sellerEntry.lastRestockedAt = 'Just now (Admin Audited)';

  // Recalculate overall product stock, dynamic avgPrice, and status
  const totalStock = prod.sellers.reduce((sum, s) => sum + (s.stockCount || 0), 0);
  const sellerPrices = prod.sellers.map((s) => s.price).filter((pr) => typeof pr === 'number' && pr > 0);
  const avgPrice = sellerPrices.length > 0
    ? Math.round(sellerPrices.reduce((sum, pr) => sum + pr, 0) / sellerPrices.length)
    : prod.price;
  const minPrice = sellerPrices.length > 0 ? Math.min(...sellerPrices) : prod.price;
  const maxPrice = sellerPrices.length > 0 ? Math.max(...sellerPrices) : prod.price;

  prod.stockCount = totalStock;
  prod.price = avgPrice;
  prod.avgPrice = avgPrice;
  prod.minPrice = minPrice;
  prod.maxPrice = maxPrice;
  prod.inStock = totalStock > 0;

  const lowStockSellers = prod.sellers.filter((s) => s.stockCount > 0 && s.stockCount <= (s.minStockAlert || 10));
  const outOfStockSellers = prod.sellers.filter((s) => s.stockCount === 0);

  if (totalStock === 0 || outOfStockSellers.length > 0) {
    prod.status = 'OUT_OF_STOCK';
  } else if (totalStock <= (prod.minStockAlert || 20) || lowStockSellers.length > 0) {
    prod.status = 'LOW_STOCK';
  } else {
    prod.status = 'IN_STOCK';
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'INVENTORY_SELLER_STOCK_ADJUSTED',
    targetEntity: 'ProductSellerStock',
    targetId: `${prod.sku}:${sellerId}`,
    details: `Adjusted SKU ${prod.sku} (${prod.name}) for seller ${sellerEntry.sellerName} (${sellerEntry.cityName}): Stock ${oldStock} -> ${sellerEntry.stockCount}u, Price ₹${oldPrice} -> ₹${sellerEntry.price}. Reason: ${reason || 'Store physical cycle count & price sync'}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    product: {
      ...prod,
      price: avgPrice,
      avgPrice,
      minPrice,
      maxPrice,
      stockCount: totalStock,
      sellerCount: prod.sellers.length,
      status: prod.status,
    },
  });
});

adminRouter.post('/inventory/:id/adjust-stock', requirePermission('inventory.edit_stock'), (req: AuthenticatedRequest, res: Response) => {
  const { newStockCount, reason } = req.body;
  if (typeof newStockCount !== 'number' || newStockCount < 0) {
    return res.status(400).json({ success: false, error: 'INVALID_STOCK_COUNT' });
  }

  const prod = authoritativeAdminStore.products.find((p) => p.id === req.params.id || p.sku === req.params.id);
  if (!prod) return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });

  const oldStock = prod.stockCount;
  prod.stockCount = newStockCount;
  prod.inStock = newStockCount > 0;
  if (newStockCount === 0) {
    prod.status = 'OUT_OF_STOCK';
  } else if (newStockCount <= prod.minStockAlert) {
    prod.status = 'LOW_STOCK';
  } else {
    prod.status = 'IN_STOCK';
  }

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'INVENTORY_STOCK_ADJUSTED',
    targetEntity: 'Product',
    targetId: prod.id,
    details: `Adjusted ${prod.name} (${prod.sku}) overall from ${oldStock} -> ${newStockCount} units. Reason: ${reason || 'Physical cycle count'}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, product: prod });
});

// Master Catalog: Add New Master Product / SKU
adminRouter.post('/catalog/products', requirePermission('inventory.view'), (req: AuthenticatedRequest, res: Response) => {
  const { name, sku, category, subcategory, brand, hsnCode, gstRatePercent, mrp, unit, price, image } = req.body;
  
  if (!name || !sku || !category || !brand || !hsnCode) {
    return res.status(400).json({ success: false, error: 'MISSING_REQUIRED_FIELDS', message: 'Name, SKU, Category, Brand, and HSN Code are required.' });
  }

  // Check for duplicate SKU
  const existing = authoritativeAdminStore.products.find((p) => p.sku?.toUpperCase() === sku.toUpperCase());
  if (existing) {
    return res.status(409).json({ success: false, error: 'DUPLICATE_SKU', message: `SKU "${sku}" already exists in the Master Catalog.` });
  }

  const newId = `prod-cat-${Date.now()}`;
  const newProduct: any = {
    id: newId,
    sku: sku.trim().toUpperCase(),
    name: name.trim(),
    category: category.trim(),
    subcategory: subcategory?.trim() || '',
    brand: brand.trim(),
    price: Number(price) || Number(mrp) || 100,
    mrp: Number(mrp) || Number(price) || 100,
    unit: unit?.trim() || 'Piece',
    stockCount: 0,
    minStockAlert: 10,
    hsnCode: hsnCode.trim(),
    gstRatePercent: Number(gstRatePercent) || 18,
    image: image?.trim() || '',
    inStock: false,
    status: 'OUT_OF_STOCK',
    rating: 5.0,
    sellers: [],
  };

  authoritativeAdminStore.products.unshift(newProduct);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CATALOG_PRODUCT_CREATED',
    targetEntity: 'MasterProduct',
    targetId: newId,
    details: `Added new Master Product SKU "${newProduct.sku}" (${newProduct.name}) under ${newProduct.category}. HSN: ${newProduct.hsnCode}, GST: ${newProduct.gstRatePercent}%.`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.status(201).json({ success: true, product: newProduct, message: `Product "${newProduct.name}" added to Master Catalog.` });
});

// Master Catalog: Edit / Override Master SKU Details
adminRouter.put('/catalog/products/:id', requirePermission('inventory.view'), (req: AuthenticatedRequest, res: Response) => {
  const prod = authoritativeAdminStore.products.find((p) => p.id === req.params.id || p.sku === req.params.id);
  if (!prod) return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });

  const { name, category, subcategory, brand, hsnCode, gstRatePercent, mrp, unit, price, image } = req.body;

  if (name) prod.name = name.trim();
  if (category) prod.category = category.trim();
  if (subcategory !== undefined) prod.subcategory = subcategory.trim();
  if (brand) prod.brand = brand.trim();
  if (hsnCode) prod.hsnCode = hsnCode.trim();
  if (gstRatePercent !== undefined) prod.gstRatePercent = Number(gstRatePercent);
  if (mrp !== undefined) prod.mrp = Number(mrp);
  if (unit) prod.unit = unit.trim();
  if (price !== undefined) prod.price = Number(price);
  if (image !== undefined) prod.image = image.trim();

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CATALOG_PRODUCT_UPDATED',
    targetEntity: 'MasterProduct',
    targetId: prod.id,
    details: `Overrode Master Catalog details for SKU ${prod.sku} (${prod.name}).`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, product: prod, message: `Master Catalog SKU ${prod.sku} updated successfully.` });
});

// Master Catalog: Delete / Archive SKU
adminRouter.delete('/catalog/products/:id', requirePermission('inventory.view'), (req: AuthenticatedRequest, res: Response) => {
  const idx = authoritativeAdminStore.products.findIndex((p) => p.id === req.params.id || p.sku === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });

  const removed = authoritativeAdminStore.products.splice(idx, 1)[0];

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CATALOG_PRODUCT_DELETED',
    targetEntity: 'MasterProduct',
    targetId: removed.id,
    details: `Removed SKU ${removed.sku} (${removed.name}) from Master Catalog.`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: `SKU ${removed.sku} removed from Master Catalog.` });
});

// 18. Refunds Desk
adminRouter.get('/refunds', requirePermission('refunds.view'), (req: AuthenticatedRequest, res: Response) => {
  const allRefunds = authoritativeAdminStore.refunds;
  const completedRefunds = allRefunds.filter((r) => r.status === 'COMPLETED');
  const pendingRefunds = allRefunds.filter((r) => r.status === 'PENDING');
  const onHoldRefunds = allRefunds.filter((r) => r.status === 'ON_HOLD');
  const rejectedRefunds = allRefunds.filter((r) => r.status === 'REJECTED');

  const totalRefundedAmount = completedRefunds.reduce((sum, r) => sum + r.amount, 0);
  const pendingApprovalAmount = pendingRefunds.reduce((sum, r) => sum + r.amount, 0);

  res.json({
    success: true,
    refunds: allRefunds,
    disputes: authoritativeAdminStore.refundDisputes,
    policy: authoritativeAdminStore.refundPolicy,
    summary: {
      totalRefundsCount: allRefunds.length,
      completedCount: completedRefunds.length,
      pendingCount: pendingRefunds.length,
      onHoldCount: onHoldRefunds.length,
      rejectedCount: rejectedRefunds.length,
      totalRefundedAmount,
      pendingApprovalAmount,
      instantUpiSlaMinutes: 3.5,
    },
  });
});

adminRouter.post('/refunds/create', requirePermission('refunds.create'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.createRefundRequest(req.body, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.post('/refunds/:id/approve', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.approveRefundExecution(req.params.id, req.body, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.post('/refunds/:id/reject', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const result = authoritativeAdminStore.rejectRefundRequest(req.params.id, reason, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.post('/refunds/:id/hold', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { reason } = req.body;
  const result = authoritativeAdminStore.toggleRefundHoldStatus(req.params.id, reason, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.post('/refunds/:id/retry', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.retryRefundDisbursement(req.params.id, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.post('/refunds/bulk-approve', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { refundIds } = req.body;
  if (!Array.isArray(refundIds) || refundIds.length === 0) {
    return res.status(400).json({ success: false, message: 'No refund IDs provided for bulk approval.' });
  }
  const result = authoritativeAdminStore.bulkApproveRefundRequests(refundIds, req.admin);
  res.json(result);
});

// Update / Edit Refund Request Details
adminRouter.put('/refunds/:id', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const refund = authoritativeAdminStore.refunds.find((r) => r.id === req.params.id);
  if (!refund) {
    return res.status(404).json({ success: false, message: 'Refund request not found.' });
  }

  const { amount, reason, channel, customerName, customerPhone, bankUtr, sellerClawback, adminNotes, status, holdReason, rejectionReason } = req.body;

  if (amount !== undefined && typeof amount === 'number' && amount > 0) {
    refund.amount = Math.min(amount, refund.maxRefundable || amount);
  }
  if (reason !== undefined) refund.reason = reason;
  if (channel !== undefined) refund.channel = channel;
  if (customerName !== undefined) refund.customerName = customerName;
  if (customerPhone !== undefined) refund.customerPhone = customerPhone;
  if (bankUtr !== undefined) refund.bankUtr = bankUtr;
  if (sellerClawback !== undefined) refund.sellerClawback = !!sellerClawback;
  if (adminNotes !== undefined) refund.internalNotes = adminNotes;
  
  if (status !== undefined) {
    refund.status = status;
    const nowTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!refund.timeline) refund.timeline = [];

    if (status === 'COMPLETED') {
      refund.approvedBy = req.employee?.name || req.admin?.name || 'Finance Admin';
      refund.approvedAt = `Today, ${nowTimeStr}`;
      if (!refund.bankUtr) {
        refund.bankUtr = `REF-UPI-${Date.now().toString().slice(-8)}${Math.floor(1000 + Math.random() * 9000)}`;
      }
      refund.transactionId = refund.bankUtr;
      refund.timeline.push({
        stage: 'Disbursed & Completed',
        timestamp: nowTimeStr,
        note: `Marked as Refunded by ${req.admin?.name || 'Finance Admin'}. Payout UTR: ${refund.bankUtr}`,
        actor: req.admin?.name || 'Finance Admin',
      });
    } else if (status === 'APPROVED') {
      refund.approvedBy = req.employee?.name || req.admin?.name || 'Finance Admin';
      refund.approvedAt = `Today, ${nowTimeStr}`;
      refund.timeline.push({
        stage: 'Refund Approved',
        timestamp: nowTimeStr,
        note: `Approved by ${req.admin?.name || 'Finance Admin'}. Ready for gateway disbursement.`,
        actor: req.admin?.name || 'Finance Admin',
      });
    } else if (status === 'PENDING') {
      refund.timeline.push({
        stage: 'Marked Pending',
        timestamp: nowTimeStr,
        note: `Re-queued to pending review by ${req.admin?.name || 'Finance Admin'}.`,
        actor: req.admin?.name || 'Finance Admin',
      });
    } else if (status === 'ON_HOLD') {
      refund.holdReason = holdReason || 'Operational verification check';
      refund.timeline.push({
        stage: 'Put On Hold',
        timestamp: nowTimeStr,
        note: `Placed on hold by ${req.admin?.name || 'Finance Admin'}. Reason: ${refund.holdReason}`,
        actor: req.admin?.name || 'Finance Admin',
      });
    } else if (status === 'REJECTED') {
      refund.rejectionReason = rejectionReason || 'Declined by Finance compliance officer';
      refund.rejectedBy = req.employee?.name || req.admin?.name || 'Finance Admin';
      refund.rejectedAt = `Today, ${nowTimeStr}`;
      refund.timeline.push({
        stage: 'Refund Declined',
        timestamp: nowTimeStr,
        note: `Declined by ${req.admin?.name || 'Finance Admin'}. Reason: ${refund.rejectionReason}`,
        actor: req.admin?.name || 'Finance Admin',
      });
    }
  }

  authoritativeAdminStore.logAudit({
    adminId: req.employee?.id || req.admin?.id || 'admin',
    adminName: req.employee?.name || req.admin?.name || 'Administrator',
    adminRole: req.employee?.roleTitle || req.admin?.role || 'SUPER_ADMIN',
    action: 'REFUND_MODIFIED',
    targetEntity: 'Refund',
    targetId: refund.id,
    details: `Updated refund ${refund.id} for order ${refund.orderNumber}. Amount: ₹${refund.amount}, Channel: ${refund.channel}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    message: `Refund ${refund.orderNumber} successfully updated.`,
    refund,
  });
});

// Delete / Void Refund Request
adminRouter.delete('/refunds/:id', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.refunds.findIndex((r) => r.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Refund request not found.' });
  }

  const removed = authoritativeAdminStore.refunds.splice(index, 1)[0];

  authoritativeAdminStore.logAudit({
    adminId: req.employee?.id || req.admin?.id || 'admin',
    adminName: req.employee?.name || req.admin?.name || 'Administrator',
    adminRole: req.employee?.roleTitle || req.admin?.role || 'SUPER_ADMIN',
    action: 'REFUND_DELETED',
    targetEntity: 'Refund',
    targetId: removed.id,
    details: `Voided and deleted refund record ${removed.id} for order ${removed.orderNumber}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    message: `Refund record ${removed.orderNumber} voided and removed.`,
  });
});

// Manual Offline Settlement (Cash or Direct Bank Wire)
adminRouter.post('/refunds/:id/manual-settle', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const refund = authoritativeAdminStore.refunds.find((r) => r.id === req.params.id);
  if (!refund) {
    return res.status(404).json({ success: false, message: 'Refund request not found.' });
  }

  const { settlementMode = 'CASH_HANDOVER', referenceNumber = '', notes = '' } = req.body;
  const utr = referenceNumber.trim() || `OFFLINE-${Date.now().toString().slice(-6)}`;

  refund.status = 'COMPLETED';
  refund.bankUtr = utr;
  refund.approvedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  refund.internalNotes = notes || `Manually settled via ${settlementMode}`;

  // Update underlying order payment status if matching
  const ord = authoritativeAdminStore.orders.find((o) => o.id === refund.orderId || o.orderNumber === refund.orderNumber);
  if (ord) {
    ord.payment.status = refund.amount >= ord.pricing.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }

  authoritativeAdminStore.logAudit({
    adminId: req.employee?.id || req.admin?.id || 'admin',
    adminName: req.employee?.name || req.admin?.name || 'Administrator',
    adminRole: req.employee?.roleTitle || req.admin?.role || 'SUPER_ADMIN',
    action: 'REFUND_MANUALLY_SETTLED',
    targetEntity: 'Refund',
    targetId: refund.id,
    details: `Manually marked refund as completed via ${settlementMode} with ref ${utr} for order ${refund.orderNumber}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    message: `Refund ${refund.orderNumber} successfully marked as settled via ${settlementMode}.`,
    refund,
  });
});

adminRouter.get('/refunds/disputes', requirePermission('refunds.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    disputes: authoritativeAdminStore.refundDisputes,
  });
});

adminRouter.post('/refunds/disputes/:id/resolve', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const { action, notes } = req.body;
  const result = authoritativeAdminStore.resolveDisputeCase(req.params.id, action, notes, req.admin);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

adminRouter.get('/refunds/policy', requirePermission('refunds.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    policy: authoritativeAdminStore.refundPolicy,
  });
});

adminRouter.post('/refunds/policy/update', requirePermission('refunds.approve'), (req: AuthenticatedRequest, res: Response) => {
  const result = authoritativeAdminStore.updateRefundPolicySettings(req.body, req.admin);
  res.json(result);
});

// 19. Seller Settlements
adminRouter.get('/settlements', requirePermission('settlements.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    settlements: authoritativeAdminStore.settlements,
  });
});

adminRouter.post('/settlements/:id/process', requirePermission('settlements.process'), (req: AuthenticatedRequest, res: Response) => {
  const settlement = authoritativeAdminStore.settlements.find((s) => s.id === req.params.id);
  if (!settlement) return res.status(404).json({ success: false, error: 'SETTLEMENT_NOT_FOUND' });

  settlement.status = 'PAID';
  settlement.payoutDate = 'Today (Automated NEFT Batch)';
  settlement.utrNumber = `QCOMSETTL${Date.now().toString(36).toUpperCase()}`;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SELLER_PAYOUT_EXECUTED',
    targetEntity: 'Settlement',
    targetId: settlement.id,
    details: `Processed net payable ₹${settlement.netPayable} for ${settlement.sellerName}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, settlement });
});

// 20. Service Areas & Hyperlocal Zones
adminRouter.get('/service-areas', requirePermission('service_areas.view'), (req: AuthenticatedRequest, res: Response) => {
  const city = (req.query.city as string || 'all').toLowerCase();
  let zones = authoritativeAdminStore.serviceAreas;
  if (city !== 'all') {
    zones = zones.filter((z) => (z.cityId || '').toLowerCase() === city);
  }
  res.json({
    success: true,
    zones,
  });
});

adminRouter.post('/service-areas', requirePermission('service_areas.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { name, cityId, hubLocation, serviceableRadiusKm, baseSlaMins, surgeMultiplier } = req.body;
  if (!name || !cityId) {
    return res.status(400).json({ success: false, error: 'NAME_AND_CITY_REQUIRED' });
  }

  const city = authoritativeAdminStore.cities.find((c) => c.id === cityId);
  const newZone = {
    id: `zone-${Date.now().toString(36)}`,
    name,
    cityId,
    cityName: city ? city.name : 'Regional Zone',
    state: city ? city.state : 'India',
    region: city ? city.region : 'North',
    hubLocation: hubLocation || `${name} Quick Hub`,
    activeRidersCount: 12,
    activeOrdersCount: 4,
    avgSlaMins: baseSlaMins || 15,
    surgeMultiplier: surgeMultiplier || 1.0,
    isActive: true,
    serviceableRadiusKm: serviceableRadiusKm || 6.5,
  };

  authoritativeAdminStore.serviceAreas.push(newZone);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SERVICE_ZONE_CREATED',
    targetEntity: 'ServiceAreaZone',
    targetId: newZone.id,
    details: `Created new zone '${newZone.name}' in ${newZone.cityName} (${newZone.state})`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, zone: newZone });
});

adminRouter.post('/service-areas/:id/toggle', requirePermission('service_areas.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { isActive, surgeMultiplier } = req.body;
  const zone = authoritativeAdminStore.serviceAreas.find((z) => z.id === req.params.id);
  if (!zone) return res.status(404).json({ success: false, error: 'ZONE_NOT_FOUND' });

  if (typeof isActive === 'boolean') zone.isActive = isActive;
  if (typeof surgeMultiplier === 'number') zone.surgeMultiplier = surgeMultiplier;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SERVICE_ZONE_MODIFIED',
    targetEntity: 'ServiceAreaZone',
    targetId: zone.id,
    details: `Updated ${zone.name}: Active=${zone.isActive}, Surge=${zone.surgeMultiplier}x`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, zone });
});

// 20b. Indian Cities & Regional Expansion Control
adminRouter.get('/cities', requirePermission('service_areas.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    cities: authoritativeAdminStore.cities,
  });
});

adminRouter.post('/cities', requirePermission('service_areas.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { name, state, region, tier, code } = req.body;
  if (!name || !state || !region) {
    return res.status(400).json({ success: false, error: 'NAME_STATE_REGION_REQUIRED' });
  }

  const id = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const existing = authoritativeAdminStore.cities.find((c) => c.id === id);
  if (existing) {
    return res.status(400).json({ success: false, error: 'CITY_ALREADY_EXISTS' });
  }

  const newCity = {
    id,
    name,
    state,
    region: region || 'North',
    tier: tier || 'Tier 2',
    code: code || name.substring(0, 3).toUpperCase(),
    isActive: true,
    operationalMode: 'PILOT' as const,
    activePartnerStores: 1,
    activeContractorsCount: 50,
    dailyGmvTarget: 150000,
    surgeMultiplier: 1.0,
    minOrderValue: 249,
    baseDeliveryFee: 39,
  };

  authoritativeAdminStore.cities.push(newCity);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'INDIAN_CITY_EXPANSION_LAUNCHED',
    targetEntity: 'IndianCityConfig',
    targetId: newCity.id,
    details: `Launched new territory ${newCity.name}, ${newCity.state} (${newCity.region} India) in PILOT mode`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, city: newCity });
});

adminRouter.post('/cities/:id/toggle', requirePermission('service_areas.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { isActive, operationalMode } = req.body;
  const city = authoritativeAdminStore.cities.find((c) => c.id === req.params.id);
  if (!city) return res.status(404).json({ success: false, error: 'CITY_NOT_FOUND' });

  if (typeof isActive === 'boolean') city.isActive = isActive;
  if (operationalMode) city.operationalMode = operationalMode;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CITY_STATUS_UPDATED',
    targetEntity: 'IndianCityConfig',
    targetId: city.id,
    details: `Updated ${city.name} (${city.state}): Active=${city.isActive}, Mode=${city.operationalMode}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, city });
});

adminRouter.post('/cities/:id/config', requirePermission('service_areas.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { minOrderValue, baseDeliveryFee, surgeMultiplier, operationalMode, dailyGmvTarget } = req.body;
  const city = authoritativeAdminStore.cities.find((c) => c.id === req.params.id);
  if (!city) return res.status(404).json({ success: false, error: 'CITY_NOT_FOUND' });

  if (typeof minOrderValue === 'number') city.minOrderValue = minOrderValue;
  if (typeof baseDeliveryFee === 'number') city.baseDeliveryFee = baseDeliveryFee;
  if (typeof surgeMultiplier === 'number') city.surgeMultiplier = surgeMultiplier;
  if (typeof dailyGmvTarget === 'number') city.dailyGmvTarget = dailyGmvTarget;
  if (operationalMode) city.operationalMode = operationalMode;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CITY_ECONOMICS_CONFIG_UPDATED',
    targetEntity: 'IndianCityConfig',
    targetId: city.id,
    details: `Updated parameters for ${city.name}: MinOrder=₹${city.minOrderValue}, BaseFee=₹${city.baseDeliveryFee}, Surge=${city.surgeMultiplier}x`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, city });
});

// 21. Pricing Configuration
adminRouter.get(['/pricing', '/pricing-config'], requirePermission('pricing.view'), (req: AuthenticatedRequest, res: Response) => {
  const p = authoritativeAdminStore.pricingConfig;
  res.json({
    success: true,
    pricing: p,
    config: {
      baseDeliveryFee: p.baseDeliveryFee,
      freeDeliveryThreshold: p.freeDeliveryThreshold,
      platformFee: p.platformFee,
      urgencyFee: p.urgencyHandlingFee,
      defaultCommissionPercent: Math.max(15.0, p.defaultSellerCommissionPercent),
      riderBasePayout: p.riderBasePay,
      riderPerKmIncentive: p.riderPerKmPay,
      surgeActive: p.surgeActive,
      surgeMultiplier: p.surgeMultiplier,
    },
  });
});

adminRouter.post(['/pricing/update', '/pricing-config'], requirePermission('pricing.manage'), (req: AuthenticatedRequest, res: Response) => {
  const newConfig = req.body || {};
  const commRate = newConfig.defaultCommissionPercent ?? newConfig.defaultSellerCommissionPercent;
  
  const updatedSellerComm = typeof commRate === 'number' ? Math.max(15.0, commRate) : authoritativeAdminStore.pricingConfig.defaultSellerCommissionPercent;

  authoritativeAdminStore.pricingConfig = {
    ...authoritativeAdminStore.pricingConfig,
    baseDeliveryFee: newConfig.baseDeliveryFee ?? authoritativeAdminStore.pricingConfig.baseDeliveryFee,
    freeDeliveryThreshold: newConfig.freeDeliveryThreshold ?? authoritativeAdminStore.pricingConfig.freeDeliveryThreshold,
    platformFee: newConfig.platformFee ?? authoritativeAdminStore.pricingConfig.platformFee,
    urgencyHandlingFee: newConfig.urgencyFee ?? newConfig.urgencyHandlingFee ?? authoritativeAdminStore.pricingConfig.urgencyHandlingFee,
    defaultSellerCommissionPercent: updatedSellerComm,
    riderBasePay: newConfig.riderBasePayout ?? newConfig.riderBasePay ?? authoritativeAdminStore.pricingConfig.riderBasePay,
    riderPerKmPay: newConfig.riderPerKmIncentive ?? newConfig.riderPerKmPay ?? authoritativeAdminStore.pricingConfig.riderPerKmPay,
    surgeActive: newConfig.surgeActive ?? authoritativeAdminStore.pricingConfig.surgeActive,
    surgeMultiplier: newConfig.surgeMultiplier ?? authoritativeAdminStore.pricingConfig.surgeMultiplier,
  };

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'PRICING_ECONOMICS_CONFIG_UPDATED',
    targetEntity: 'PricingConfig',
    targetId: 'GLOBAL_CONFIG',
    details: `Updated parameters: Free Threshold=₹${authoritativeAdminStore.pricingConfig.freeDeliveryThreshold}, Base Fee=₹${authoritativeAdminStore.pricingConfig.baseDeliveryFee}, Min Commission=${authoritativeAdminStore.pricingConfig.defaultSellerCommissionPercent}%`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  const p = authoritativeAdminStore.pricingConfig;
  res.json({
    success: true,
    pricing: p,
    config: {
      baseDeliveryFee: p.baseDeliveryFee,
      freeDeliveryThreshold: p.freeDeliveryThreshold,
      platformFee: p.platformFee,
      urgencyFee: p.urgencyHandlingFee,
      defaultCommissionPercent: p.defaultSellerCommissionPercent,
      riderBasePayout: p.riderBasePay,
      riderPerKmIncentive: p.riderPerKmPay,
      surgeActive: p.surgeActive,
      surgeMultiplier: p.surgeMultiplier,
    },
  });
});

// 22. Audit Logs
adminRouter.get('/audit-logs', requirePermission('audit.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    logs: authoritativeAdminStore.auditLogs,
  });
});

// 23. Support Desk
const handleGetSupportTickets = (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    tickets: authoritativeAdminStore.supportTickets,
  });
};

adminRouter.get('/support/tickets', requirePermission('support.view'), handleGetSupportTickets);
adminRouter.get('/support-tickets', requirePermission('support.view'), handleGetSupportTickets);

const handleResolveSupportTicket = (req: AuthenticatedRequest, res: Response) => {
  const resolutionNotes = req.body.resolutionNotes || req.body.resolutionNote;
  const ticket = authoritativeAdminStore.supportTickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });

  ticket.status = 'RESOLVED';
  ticket.resolutionNotes = resolutionNotes || 'Resolved by Contractor Support Specialist';
  ticket.resolutionNote = ticket.resolutionNotes;

  const adminActor = req.admin || req.employee;
  authoritativeAdminStore.logAudit({
    adminId: adminActor?.id || 'adm-001',
    adminName: adminActor?.name || 'Admin',
    adminRole: adminActor?.role || 'SUPER_ADMIN',
    action: 'SUPPORT_TICKET_RESOLVED',
    targetEntity: 'SupportTicket',
    targetId: ticket.id,
    details: `Resolved ticket ${ticket.ticketNumber || ticket.id} for customer ${ticket.customerName || ticket.raisedByName}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, ticket });
};

adminRouter.post('/support/tickets/:id/resolve', requirePermission('support.manage'), handleResolveSupportTicket);
adminRouter.post('/support-tickets/:id/resolve', requirePermission('support.manage'), handleResolveSupportTicket);

// ==================== 24. PROMOTIONS & COUPONS MATRIX ====================
adminRouter.get('/promotions', requirePermission('promotions.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    promotions: authoritativeAdminStore.promotions,
  });
});

adminRouter.post('/promotions/create', requirePermission('promotions.create'), (req: AuthenticatedRequest, res: Response) => {
  const { code, name, type, discountValue, isPercentage, minOrderValue, maxDiscountCap, fundingSource, fundingSharePercent, applicableBrand, applicableCategory, validUntil, maxUsageLimit } = req.body;

  if (!code || !name || !discountValue) {
    return res.status(400).json({ success: false, error: 'MISSING_PROMOTION_FIELDS' });
  }

  const newPromo = {
    id: `prm-${Date.now().toString(36)}`,
    code: code.toUpperCase().trim(),
    name,
    type: type || 'COUPON',
    discountValue: Number(discountValue),
    isPercentage: Boolean(isPercentage),
    minOrderValue: Number(minOrderValue) || 0,
    maxDiscountCap: Number(maxDiscountCap) || 500,
    fundingSource: fundingSource || 'PLATFORM',
    fundingSharePercent: fundingSharePercent || { platform: 100, seller: 0, brand: 0 },
    applicableBrand,
    applicableCategory,
    validFrom: new Date().toISOString().split('T')[0],
    validUntil: validUntil || '2026-12-31',
    usageCount: 0,
    maxUsageLimit: Number(maxUsageLimit) || 1000,
    status: 'ACTIVE' as const,
    createdBy: `${req.admin!.name} (${req.admin!.roleTitle})`,
  };

  authoritativeAdminStore.promotions.unshift(newPromo);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'PROMOTION_COUPON_CREATED',
    targetEntity: 'AdminPromotion',
    targetId: newPromo.id,
    details: `Created promo coupon '${newPromo.code}' funded by ${newPromo.fundingSource}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, promotion: newPromo });
});

adminRouter.post('/promotions/:id/update', requirePermission('promotions.create'), (req: AuthenticatedRequest, res: Response) => {
  const promo = authoritativeAdminStore.promotions.find((p) => p.id === req.params.id);
  if (!promo) return res.status(404).json({ success: false, error: 'PROMOTION_NOT_FOUND' });

  const { code, name, type, discountValue, isPercentage, minOrderValue, maxDiscountCap, fundingSource, applicableCategory, validUntil, maxUsageLimit, status } = req.body;

  if (code) promo.code = code.toUpperCase().trim();
  if (name) promo.name = name;
  if (type) promo.type = type;
  if (discountValue !== undefined) promo.discountValue = Number(discountValue);
  if (isPercentage !== undefined) promo.isPercentage = Boolean(isPercentage);
  if (minOrderValue !== undefined) promo.minOrderValue = Number(minOrderValue);
  if (maxDiscountCap !== undefined) promo.maxDiscountCap = Number(maxDiscountCap);
  if (fundingSource) promo.fundingSource = fundingSource;
  if (applicableCategory !== undefined) promo.applicableCategory = applicableCategory;
  if (validUntil) promo.validUntil = validUntil;
  if (maxUsageLimit !== undefined) promo.maxUsageLimit = Number(maxUsageLimit);
  if (status) promo.status = status;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'PROMOTION_COUPON_UPDATED',
    targetEntity: 'AdminPromotion',
    targetId: promo.id,
    details: `Updated promo coupon '${promo.code}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, promotion: promo });
});

adminRouter.post('/promotions/:id/toggle', requirePermission('promotions.create'), (req: AuthenticatedRequest, res: Response) => {
  const promo = authoritativeAdminStore.promotions.find((p) => p.id === req.params.id);
  if (!promo) return res.status(404).json({ success: false, error: 'PROMOTION_NOT_FOUND' });

  promo.status = promo.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'PROMOTION_STATUS_TOGGLED',
    targetEntity: 'AdminPromotion',
    targetId: promo.id,
    details: `Toggled status of coupon '${promo.code}' to ${promo.status}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, promotion: promo });
});

adminRouter.delete('/promotions/:id', requirePermission('promotions.create'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.promotions.findIndex((p) => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, error: 'PROMOTION_NOT_FOUND' });

  const [deleted] = authoritativeAdminStore.promotions.splice(index, 1);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'PROMOTION_DELETED',
    targetEntity: 'AdminPromotion',
    targetId: req.params.id,
    details: `Deleted promo coupon '${deleted.code}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Promotion deleted successfully' });
});

// ==================== 25. SPONSORED ADS & RETAIL MEDIA ENGINE ====================
adminRouter.get('/ads/campaigns', requirePermission('ads.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    campaigns: authoritativeAdminStore.sponsoredAds,
  });
});

adminRouter.post('/ads/campaigns/create', requirePermission('ads.create'), (req: AuthenticatedRequest, res: Response) => {
  const { campaignName, advertiserBrand, brandContactEmail, placement, startDate, endDate, totalBudget, billingMethod, cpmRate, cpcRate, targetGeography, targetCategory, creativeUrl, headline, ctaText, destinationUrl } = req.body;

  if (!campaignName || !advertiserBrand || !placement) {
    return res.status(400).json({ success: false, error: 'MISSING_AD_FIELDS' });
  }

  const newCampaign = {
    id: `ad-${Date.now().toString(36)}`,
    campaignName,
    advertiserBrand,
    brandContactEmail: brandContactEmail || `${advertiserBrand.toLowerCase().replace(/\s+/g, '')}@brand.in`,
    placement,
    startDate: startDate || new Date().toISOString().split('T')[0],
    endDate: endDate || '2026-10-31',
    totalBudget: Number(totalBudget) || 100000,
    spentBudget: 0,
    billingMethod: billingMethod || 'CPM',
    cpmRate: Number(cpmRate) || 100,
    cpcRate: Number(cpcRate) || 10,
    targetGeography: targetGeography || 'Pan-India',
    targetCategory,
    creativeUrl: creativeUrl || 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&auto=format&fit=crop&q=80',
    headline: headline || `${advertiserBrand} Authorized Range`,
    ctaText: ctaText || 'Know More',
    destinationUrl: destinationUrl || '',
    priorityScore: 80,
    status: 'PENDING_APPROVAL' as const,
    approvalWorkflow: {
      createdBy: `${req.admin!.name} (${req.admin!.roleTitle})`,
      createdAt: new Date().toISOString().replace('T', ' ').substring(0, 16),
      currentStage: 'MANAGER_REVIEW' as const,
    },
    analytics: {
      impressions: 0,
      clicks: 0,
      ctrPercent: 0,
      productViews: 0,
      addToCarts: 0,
      attributableOrders: 0,
      attributableRevenue: 0,
      roasMultiplier: 0,
    },
  };

  authoritativeAdminStore.sponsoredAds.unshift(newCampaign);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SPONSORED_AD_CAMPAIGN_SUBMITTED',
    targetEntity: 'SponsoredAdCampaign',
    targetId: newCampaign.id,
    details: `Created Retail Media ad campaign '${newCampaign.campaignName}' for brand ${newCampaign.advertiserBrand}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, campaign: newCampaign });
});

adminRouter.post('/ads/campaigns/:id/update', requirePermission('ads.create'), (req: AuthenticatedRequest, res: Response) => {
  const campaign = authoritativeAdminStore.sponsoredAds.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });

  const { campaignName, advertiserBrand, brandContactEmail, placement, startDate, endDate, totalBudget, cpmRate, cpcRate, targetGeography, targetCategory, creativeUrl, headline, ctaText, destinationUrl, status } = req.body;

  if (campaignName) campaign.campaignName = campaignName;
  if (advertiserBrand) campaign.advertiserBrand = advertiserBrand;
  if (brandContactEmail) campaign.brandContactEmail = brandContactEmail;
  if (placement) campaign.placement = placement;
  if (startDate) campaign.startDate = startDate;
  if (endDate) campaign.endDate = endDate;
  if (totalBudget !== undefined) campaign.totalBudget = Number(totalBudget);
  if (cpmRate !== undefined) campaign.cpmRate = Number(cpmRate);
  if (cpcRate !== undefined) campaign.cpcRate = Number(cpcRate);
  if (targetGeography) campaign.targetGeography = targetGeography;
  if (targetCategory !== undefined) campaign.targetCategory = targetCategory;
  if (creativeUrl) campaign.creativeUrl = creativeUrl;
  if (headline) campaign.headline = headline;
  if (ctaText) campaign.ctaText = ctaText;
  if (destinationUrl !== undefined) campaign.destinationUrl = destinationUrl;
  if (status) campaign.status = status;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SPONSORED_AD_CAMPAIGN_UPDATED',
    targetEntity: 'SponsoredAdCampaign',
    targetId: campaign.id,
    details: `Updated ad campaign '${campaign.campaignName}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, campaign });
});

adminRouter.post('/ads/campaigns/:id/approve', requirePermission('ads.approve'), (req: AuthenticatedRequest, res: Response) => {
  const campaign = authoritativeAdminStore.sponsoredAds.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });

  campaign.status = 'LIVE';
  campaign.approvalWorkflow.superAdminApprovedBy = `${req.admin!.name} (${req.admin!.roleTitle})`;
  campaign.approvalWorkflow.currentStage = 'LIVE';

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SPONSORED_AD_APPROVED_LIVE',
    targetEntity: 'SponsoredAdCampaign',
    targetId: campaign.id,
    details: `Approved & published Retail Media ad campaign '${campaign.campaignName}' for ${campaign.advertiserBrand}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, campaign });
});

adminRouter.post('/ads/campaigns/:id/toggle', requirePermission('ads.publish'), (req: AuthenticatedRequest, res: Response) => {
  const campaign = authoritativeAdminStore.sponsoredAds.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });

  campaign.status = campaign.status === 'LIVE' ? 'PAUSED' : 'LIVE';

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SPONSORED_AD_STATUS_TOGGLED',
    targetEntity: 'SponsoredAdCampaign',
    targetId: campaign.id,
    details: `Toggled status of campaign '${campaign.campaignName}' to ${campaign.status}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, campaign });
});

adminRouter.delete('/ads/campaigns/:id', requirePermission('ads.create'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.sponsoredAds.findIndex((c) => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });

  const [deleted] = authoritativeAdminStore.sponsoredAds.splice(index, 1);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'SPONSORED_AD_CAMPAIGN_DELETED',
    targetEntity: 'SponsoredAdCampaign',
    targetId: req.params.id,
    details: `Deleted ad campaign '${deleted.campaignName}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Ad campaign deleted successfully' });
});

// ==================== 26. CMS CONTENT & BANNER MANAGEMENT ====================
adminRouter.get('/cms/banners', requirePermission('cms.view'), (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    banners: authoritativeAdminStore.cmsBanners,
    collections: authoritativeAdminStore.cmsCollections,
  });
});

adminRouter.post('/cms/banners/create', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { title, subtitle, imageUrl, mediaType, videoUrl, ctaText, ctaUrl, actionType, targetScreen, cityScope } = req.body;
  if (!title || (!imageUrl && !videoUrl)) {
    return res.status(400).json({ success: false, error: 'TITLE_AND_MEDIA_REQUIRED' });
  }

  const newBanner = {
    id: `cms-ban-${Date.now().toString(36)}`,
    title,
    subtitle: subtitle || 'Limited time offer for verified trade contractors',
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1200&auto=format&fit=crop&q=80',
    mediaType: mediaType || 'IMAGE',
    videoUrl: videoUrl || '',
    ctaText: ctaText || 'Know More',
    ctaUrl: ctaUrl || '',
    actionType: actionType || 'DEEP_LINK',
    targetScreen: targetScreen || 'HOME_EXPLORE',
    cityScope: cityScope || 'all',
    priority: 1,
    isActive: true,
    validUntil: '2026-12-31',
  };

  authoritativeAdminStore.cmsBanners.unshift(newBanner);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_BANNER_CREATED',
    targetEntity: 'CmsHeroBanner',
    targetId: newBanner.id,
    details: `Created CMS hero banner '${newBanner.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, banner: newBanner });
});

adminRouter.post('/cms/banners/:id/update', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const banner = authoritativeAdminStore.cmsBanners.find((b) => b.id === req.params.id);
  if (!banner) return res.status(404).json({ success: false, error: 'BANNER_NOT_FOUND' });

  const { title, subtitle, imageUrl, mediaType, videoUrl, ctaText, ctaUrl, actionType, targetScreen, cityScope, isActive } = req.body;
  if (title) banner.title = title;
  if (subtitle !== undefined) banner.subtitle = subtitle;
  if (imageUrl) banner.imageUrl = imageUrl;
  if (mediaType) banner.mediaType = mediaType;
  if (videoUrl !== undefined) banner.videoUrl = videoUrl;
  if (ctaText !== undefined) banner.ctaText = ctaText;
  if (ctaUrl !== undefined) banner.ctaUrl = ctaUrl;
  if (actionType !== undefined) banner.actionType = actionType;
  if (targetScreen) banner.targetScreen = targetScreen;
  if (cityScope) banner.cityScope = cityScope;
  if (isActive !== undefined) banner.isActive = Boolean(isActive);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_BANNER_UPDATED',
    targetEntity: 'CmsHeroBanner',
    targetId: banner.id,
    details: `Updated CMS hero banner '${banner.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, banner });
});

adminRouter.post('/cms/banners/:id/toggle', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const banner = authoritativeAdminStore.cmsBanners.find((b) => b.id === req.params.id);
  if (!banner) return res.status(404).json({ success: false, error: 'BANNER_NOT_FOUND' });

  banner.isActive = !banner.isActive;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_BANNER_TOGGLED',
    targetEntity: 'CmsHeroBanner',
    targetId: banner.id,
    details: `Toggled active state of banner '${banner.title}' to ${banner.isActive}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, banner });
});

adminRouter.delete('/cms/banners/:id', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.cmsBanners.findIndex((b) => b.id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, error: 'BANNER_NOT_FOUND' });

  const [deleted] = authoritativeAdminStore.cmsBanners.splice(index, 1);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_BANNER_DELETED',
    targetEntity: 'CmsHeroBanner',
    targetId: req.params.id,
    details: `Deleted CMS hero banner '${deleted.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Hero banner deleted successfully' });
});

// Curated Collections Endpoints
adminRouter.post('/cms/collections/create', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const { title, slug, subtitle, bannerBgColor, productIds } = req.body;
  if (!title || !slug) {
    return res.status(400).json({ success: false, error: 'TITLE_AND_SLUG_REQUIRED' });
  }

  const newCollection = {
    id: `col-${Date.now().toString(36)}`,
    title,
    slug: slug.toLowerCase().trim().replace(/\s+/g, '-'),
    subtitle: subtitle || 'Handpicked trade supplies',
    bannerBgColor: bannerBgColor || '#059669',
    productIds: productIds || ['prod-01', 'prod-02', 'prod-03'],
    cityScope: 'all',
    isActive: true,
  };

  authoritativeAdminStore.cmsCollections.unshift(newCollection);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_COLLECTION_CREATED',
    targetEntity: 'CmsCuratedCollection',
    targetId: newCollection.id,
    details: `Created curated trade collection '${newCollection.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, collection: newCollection });
});

adminRouter.post('/cms/collections/:id/update', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const collection = authoritativeAdminStore.cmsCollections.find((c) => c.id === req.params.id);
  if (!collection) return res.status(404).json({ success: false, error: 'COLLECTION_NOT_FOUND' });

  const { title, slug, subtitle, bannerBgColor, productIds, isActive } = req.body;
  if (title) collection.title = title;
  if (slug) collection.slug = slug.toLowerCase().trim().replace(/\s+/g, '-');
  if (subtitle !== undefined) collection.subtitle = subtitle;
  if (bannerBgColor) collection.bannerBgColor = bannerBgColor;
  if (productIds) collection.productIds = productIds;
  if (isActive !== undefined) collection.isActive = Boolean(isActive);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_COLLECTION_UPDATED',
    targetEntity: 'CmsCuratedCollection',
    targetId: collection.id,
    details: `Updated curated trade collection '${collection.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, collection });
});

adminRouter.post('/cms/collections/:id/toggle', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const collection = authoritativeAdminStore.cmsCollections.find((c) => c.id === req.params.id);
  if (!collection) return res.status(404).json({ success: false, error: 'COLLECTION_NOT_FOUND' });

  collection.isActive = !collection.isActive;

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_COLLECTION_TOGGLED',
    targetEntity: 'CmsCuratedCollection',
    targetId: collection.id,
    details: `Toggled active state of collection '${collection.title}' to ${collection.isActive}`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, collection });
});

adminRouter.delete('/cms/collections/:id', requirePermission('cms.manage'), (req: AuthenticatedRequest, res: Response) => {
  const index = authoritativeAdminStore.cmsCollections.findIndex((c) => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, error: 'COLLECTION_NOT_FOUND' });

  const [deleted] = authoritativeAdminStore.cmsCollections.splice(index, 1);

  authoritativeAdminStore.logAudit({
    adminId: req.admin!.id,
    adminName: req.admin!.name,
    adminRole: req.admin!.role,
    action: 'CMS_COLLECTION_DELETED',
    targetEntity: 'CmsCuratedCollection',
    targetId: req.params.id,
    details: `Deleted curated trade collection '${deleted.title}'`,
    ipAddress: req.ip || '127.0.0.1',
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Curated collection deleted successfully' });
});

// ==================== 28. REPORTS & ANALYTICS SUMMARY ====================
function parseYmd(dateInput: any): string {
  if (!dateInput) return new Date().toISOString().split('T')[0];
  const str = String(dateInput).trim();
  if (str.toLowerCase().includes('today') || str.toLowerCase().includes('just now')) {
    return new Date().toISOString().split('T')[0];
  }
  if (str.toLowerCase().includes('yesterday')) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    return new Date(parsed).toISOString().split('T')[0];
  }
  return new Date().toISOString().split('T')[0];
}

adminRouter.get('/reports/summary', requirePermission('reports.view'), (req: AuthenticatedRequest, res: Response) => {
  const city = (req.query.city as string || 'all').toLowerCase();
  const rawTimeframe = (req.query.timeframe as string || req.query.period as string || 'daily').toLowerCase();
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;

  // Standardize timeframe aliases
  let timeframe = rawTimeframe;
  if (rawTimeframe === 'day' || rawTimeframe === 'today') timeframe = 'daily';
  else if (rawTimeframe === 'week') timeframe = 'weekly';
  else if (rawTimeframe === 'month' || rawTimeframe === 'this_month') timeframe = 'monthly';
  else if (rawTimeframe === 'quarter' || rawTimeframe === 'this_quarter') timeframe = 'quarterly';
  else if (rawTimeframe === 'year' || rawTimeframe === 'this_year' || rawTimeframe === 'all') timeframe = 'annual';

  const allOrders = authoritativeAdminStore.orders;
  const allSellers = authoritativeAdminStore.sellers;
  const allRiders = authoritativeAdminStore.riders;
  const allProducts = authoritativeAdminStore.products;
  const allRefunds = authoritativeAdminStore.refunds;
  const allAds = authoritativeAdminStore.sponsoredAds;

  const filteredOrders = allOrders.filter((o) => {
    return city === 'all' || (o.cityName || o.deliveryLocation?.city || '').toLowerCase() === city;
  });

  const filteredSellers = allSellers.filter((s) => {
    return city === 'all' || (s.cityId || '').toLowerCase() === city || (s.address?.city || '').toLowerCase().includes(city);
  });

  const filteredRiders = allRiders.filter((r) => {
    return city === 'all' || (r.cityName || r.assignedZoneName || '').toLowerCase().includes(city);
  });

  // Base daily numbers from current store records
  const baseDayOrders = filteredOrders.length + (city === 'all' ? 1346 : 140);
  const baseDayGmv = filteredOrders.reduce((acc, o) => acc + (o.pricing?.total || 0), 0) + (city === 'all' ? 693844.62 : 78500);

  // Platform commission take-rate (minimum 15.0%)
  const takeRate = Math.max(0.15, (authoritativeAdminStore.pricingConfig?.defaultSellerCommissionPercent || 15.0) / 100);

  let multiplier = 1;
  let periodLabel = "Today's Live";
  let comparisonLabel = "vs yesterday";
  let trendData: { period: string; gmv: number; commission: number; orders: number }[] = [];

  if (timeframe === 'weekly') {
    multiplier = 7;
    periodLabel = "This Week's (7 Days)";
    comparisonLabel = "vs prev week";
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    trendData = days.map((d, i) => {
      const dayFactor = [0.12, 0.13, 0.14, 0.15, 0.17, 0.16, 0.13][i];
      const gmv = Math.round(baseDayGmv * multiplier * dayFactor);
      return {
        period: d,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round(baseDayOrders * multiplier * dayFactor),
      };
    });
  } else if (timeframe === 'monthly') {
    multiplier = 30;
    periodLabel = "This Month's (30 Days)";
    comparisonLabel = "vs last month";
    const weeks = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
    trendData = weeks.map((w, i) => {
      const wkFactor = [0.22, 0.26, 0.28, 0.24][i];
      const gmv = Math.round(baseDayGmv * multiplier * wkFactor);
      return {
        period: w,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round(baseDayOrders * multiplier * wkFactor),
      };
    });
  } else if (timeframe === 'quarterly') {
    multiplier = 90;
    periodLabel = "This Quarter's (Q3 FY26)";
    comparisonLabel = "vs prev quarter";
    const months = ['Month 1 (Jul)', 'Month 2 (Aug)', 'Month 3 (Sep)'];
    trendData = months.map((m, i) => {
      const mFactor = [0.31, 0.34, 0.35][i];
      const gmv = Math.round(baseDayGmv * multiplier * mFactor);
      return {
        period: m,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round(baseDayOrders * multiplier * mFactor),
      };
    });
  } else if (timeframe === 'annual') {
    multiplier = 365;
    periodLabel = "Annual Financial Year (FY25-26)";
    comparisonLabel = "vs last fiscal year";
    const quarters = ['Q1 FY25', 'Q2 FY25', 'Q3 FY26', 'Q4 FY26'];
    trendData = quarters.map((q, i) => {
      const qFactor = [0.22, 0.24, 0.27, 0.27][i];
      const gmv = Math.round(baseDayGmv * multiplier * qFactor);
      return {
        period: q,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round(baseDayOrders * multiplier * qFactor),
      };
    });
  } else if (timeframe === 'custom') {
    let diffDays = 7;
    if (startDate && endDate) {
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      const days = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
      diffDays = Math.max(1, Math.min(days, 365));
    }
    multiplier = diffDays;
    periodLabel = `Custom Date Range (${diffDays} Days)`;
    comparisonLabel = `across ${diffDays} day window`;

    const segments = Math.min(diffDays, 7);
    trendData = Array.from({ length: segments }).map((_, i) => {
      const gmv = Math.round((baseDayGmv * multiplier) / segments);
      return {
        period: segments === 1 ? 'Day 1' : `Segment ${i + 1}`,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round((baseDayOrders * multiplier) / segments),
      };
    });
  } else {
    // Default: Daily
    multiplier = 1;
    periodLabel = "Today's Live";
    comparisonLabel = "vs yesterday";
    const hours = ['06 AM', '08 AM', '10 AM', '12 PM', '02 PM', '04 PM', '06 PM', '08 PM'];
    trendData = hours.map((h, i) => {
      const hFactor = [0.03, 0.18, 0.21, 0.14, 0.12, 0.11, 0.13, 0.08][i];
      const gmv = Math.round(baseDayGmv * hFactor);
      return {
        period: h,
        gmv,
        commission: Math.round(gmv * takeRate),
        orders: Math.round(baseDayOrders * hFactor),
      };
    });
  }

  const totalGmv = Math.round(baseDayGmv * multiplier * 100) / 100;
  const totalOrdersCount = Math.round(baseDayOrders * multiplier);
  const platformCommissionRevenue = Math.round(totalGmv * takeRate * 100) / 100; // 15.0% minimum take rate
  
  // Rider delivery fleet payouts (100% disbursed to riders based on base trip pay, distance, material weight & surge)
  const avgRiderTripCompensation = 48; // avg ₹48 compensation per delivery trip disbursed to fleet
  const riderDeliveryPayouts = Math.round(totalOrdersCount * avgRiderTripCompensation);
  const deliveryFeeRevenue = riderDeliveryPayouts;

  const retailMediaAdRevenue = Math.round(allAds.reduce((acc, a) => acc + (a.spentBudget || 0), 0) * (multiplier / 7) * 100) / 100;
  const totalRefundsProcessed = Math.round(totalGmv * 0.0085 * 100) / 100; // 0.85% refund rate
  const totalRefundsCount = Math.max(1, Math.round(totalOrdersCount * 0.009));
  
  // Net Platform Profit excludes delivery fees (which are 100% disbursed to delivery riders)
  const netPlatformProfit = Math.round((platformCommissionRevenue + retailMediaAdRevenue - totalRefundsProcessed) * 100) / 100;

  // Category breakdown for B2B Quick Commerce
  const categories = [
    { name: 'Electrical & Wiring', sharePct: 34, gmv: Math.round(totalGmv * 0.34), orders: Math.round(totalOrdersCount * 0.32), marginPct: 11.2 },
    { name: 'Plumbing & Sanitary', sharePct: 26, gmv: Math.round(totalGmv * 0.26), orders: Math.round(totalOrdersCount * 0.27), marginPct: 9.8 },
    { name: 'Power Tools & Hardware', sharePct: 21, gmv: Math.round(totalGmv * 0.21), orders: Math.round(totalOrdersCount * 0.19), marginPct: 8.5 },
    { name: 'Construction Chemicals', sharePct: 12, gmv: Math.round(totalGmv * 0.12), orders: Math.round(totalOrdersCount * 0.14), marginPct: 10.4 },
    { name: 'Commercial Lighting', sharePct: 7, gmv: Math.round(totalGmv * 0.07), orders: Math.round(totalOrdersCount * 0.08), marginPct: 12.0 },
  ];

  // Operational SLA metrics
  const avgSla = filteredRiders.length > 0
    ? Number((filteredRiders.reduce((acc, r) => acc + (r.rating >= 4.5 ? 98.4 : 95.2), 0) / filteredRiders.length).toFixed(1))
    : 97.8;

  const activeAds = allAds.filter((a) => a.status === 'LIVE');
  const totalImpressions = Math.round(allAds.reduce((acc, a) => acc + (a.analytics?.impressions || 0), 0) * (multiplier / 7));
  const totalClicks = Math.round(allAds.reduce((acc, a) => acc + (a.analytics?.clicks || 0), 0) * (multiplier / 7));
  const avgRoas = 7.65;

  res.json({
    success: true,
    summary: {
      filterMeta: {
        timeframe,
        periodLabel,
        comparisonLabel,
        city: city.toUpperCase(),
        startDate: startDate || null,
        endDate: endDate || null,
        totalOrdersCount,
        totalRefundsCount,
        activeSellersCount: filteredSellers.length,
        activeRidersCount: filteredRiders.length,
        lastUpdated: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      },
      financials: {
        totalGmv,
        platformCommissionRevenue,
        commissionTakeRatePct: Math.round(takeRate * 1000) / 10,
        riderDeliveryPayouts,
        deliveryFeeRevenue: riderDeliveryPayouts,
        retailMediaAdRevenue,
        totalRefundsProcessed,
        refundRatePct: 0.85,
        netPlatformProfit,
        grossProfitMarginPct: Number(((netPlatformProfit / totalGmv) * 100).toFixed(2)),
      },
      operationalSla: {
        avgPrepTimeMins: 3.4, // Store preparation time (≤ 5.0 mins)
        avgDispatchTimeMins: 3.4,
        avgRiderPickupMins: 4.1,
        avgDoorstepDeliveryMins: 14.2,
        slaCompliancePercent: avgSla,
        onTimeDeliveryPercent: 98.2,
      },
      b2bTrade: {
        b2bOrderSharePct: 74.2,
        b2bGmv: Math.round(totalGmv * 0.742),
        totalGstItcPassed: Math.round(totalGmv * 0.18 * 0.742),
        contractorReorderRatePct: 86.4,
        avgB2bTicketSize: Math.round((totalGmv * 0.742) / Math.max(1, totalOrdersCount * 0.742)),
        avgRetailTicketSize: Math.round((totalGmv * 0.258) / Math.max(1, totalOrdersCount * 0.258)),
      },
      categories,
      trendData,
      retailMediaMetrics: {
        totalActiveCampaigns: activeAds.length,
        totalImpressions,
        totalClicks,
        avgRoas,
      },
    },
  });
});
