import React, { useState, useEffect } from 'react';
import {
  Shield,
  Users,
  Plus,
  Search,
  RefreshCw,
  CheckCircle2,
  Lock,
  Key,
  Sliders,
  X,
  Building2,
  Mail,
  Phone,
  AlertTriangle,
  Edit2,
  Trash2,
  Copy,
  Check,
  UserCheck,
  UserX,
  ChevronRight,
  Eye,
  Sparkles,
  Filter,
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
  AlertCircle,
  Layers,
  CheckSquare,
  Square,
  UserPlus,
  UserMinus,
  Briefcase
} from 'lucide-react';
import { AdminEmployeeUser, AdminRoleDefinition, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface PermissionDetail {
  key: AdminPermission;
  name: string;
  level: string;
  description: string;
}

interface PermissionModuleGroup {
  moduleId: string;
  moduleName: string;
  description: string;
  permissions: PermissionDetail[];
}

export const EmployeeRoleManager: React.FC = () => {
  const [employees, setEmployees] = useState<AdminEmployeeUser[]>([]);
  const [roles, setRoles] = useState<AdminRoleDefinition[]>([]);
  const [moduleGroups, setModuleGroups] = useState<PermissionModuleGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'ROLES' | 'EMPLOYEES' | 'MATRIX'>('ROLES');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusNotification, setStatusNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Modals state
  const [editingRole, setEditingRole] = useState<AdminRoleDefinition | null>(null);
  const [isCreateRoleOpen, setIsCreateRoleOpen] = useState(false);
  const [roleToManageEmployees, setRoleToManageEmployees] = useState<AdminRoleDefinition | null>(null);
  const [roleEmployeeSelections, setRoleEmployeeSelections] = useState<string[]>([]);
  const [roleEmployeeSearch, setRoleEmployeeSearch] = useState('');
  const [roleToDelete, setRoleToDelete] = useState<AdminRoleDefinition | null>(null);

  // Employee modals state
  const [isCreateEmployeeOpen, setIsCreateEmployeeOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<AdminEmployeeUser | null>(null);
  const [employeeToAssignRoles, setEmployeeToAssignRoles] = useState<AdminEmployeeUser | null>(null);
  const [selectedRoleIdsForEmployee, setSelectedRoleIdsForEmployee] = useState<string[]>([]);
  const [employeeToDelete, setEmployeeToDelete] = useState<AdminEmployeeUser | null>(null);

  // Quick inline add dropdown state (roleId -> selected employeeId)
  const [quickAddSelection, setQuickAddSelection] = useState<{ [roleId: string]: string }>({});

  // Form states
  const [roleForm, setRoleForm] = useState<{
    id?: string;
    name: string;
    code: string;
    department: string;
    description: string;
    permissions: AdminPermission[];
    status: 'ACTIVE' | 'INACTIVE';
  }>({
    name: '',
    code: '',
    department: 'Operations',
    description: '',
    permissions: [],
    status: 'ACTIVE',
  });

  const [employeeForm, setEmployeeForm] = useState({
    name: '',
    email: '',
    phone: '',
    designation: '',
    department: 'Live Operations',
    assignedRoleIds: [] as string[],
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE' | 'SUSPENDED',
  });

  const [permSearch, setPermSearch] = useState('');
  const [saving, setSaving] = useState(false);

  // Toast notification helper
  const showNotification = (type: 'success' | 'error', message: string) => {
    setStatusNotification({ type, message });
    setTimeout(() => {
      setStatusNotification(null);
    }, 4500);
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [empRes, roleRes, permRes]: [any, any, any] = await Promise.all([
        adminApi.get('/api/admin/employees/list').catch(() => ({ success: false })),
        adminApi.get('/api/admin/roles').catch(() => ({ success: false })),
        adminApi.get('/api/admin/permissions').catch(() => ({ success: false })),
      ]);

      if (empRes.success && empRes.employees) {
        setEmployees(empRes.employees);
      }
      if (roleRes.success && roleRes.roles) {
        setRoles(roleRes.roles);
      }
      if (permRes.success && permRes.moduleGroups) {
        setModuleGroups(permRes.moduleGroups);
      }
    } catch (err) {
      console.error('Failed to load employee/role data:', err);
      showNotification('error', 'Failed to fetch latest governance data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Helper: check if employee has role
  const isEmployeeInRole = (emp: AdminEmployeeUser, role: AdminRoleDefinition) => {
    return (
      emp.assignedRoleIds?.includes(role.id) ||
      emp.assignedRoleIds?.includes(role.code) ||
      emp.role === role.code
    );
  };

  // Helper: get all employees assigned to a role
  const getEmployeesForRole = (role: AdminRoleDefinition) => {
    return employees.filter((emp) => isEmployeeInRole(emp, role));
  };

  // ==================== ROLE CRUD ACTIONS ====================

  const openCreateRoleModal = (cloneSource?: AdminRoleDefinition) => {
    if (cloneSource) {
      setRoleForm({
        name: `${cloneSource.name} (Copy)`,
        code: `${cloneSource.code}_COPY`,
        department: cloneSource.department,
        description: `Cloned from ${cloneSource.name}. ${cloneSource.description || ''}`,
        permissions: [...cloneSource.permissions],
        status: 'ACTIVE',
      });
    } else {
      const defaultPerms: AdminPermission[] = [
        'dashboard.view',
        'orders.view',
        'orders.update_status',
        'customers.view',
        'sellers.view',
        'riders.view',
        'delivery.view',
        'reports.view',
      ];
      setRoleForm({
        name: '',
        code: '',
        department: 'Operations & Dispatch',
        description: '',
        permissions: defaultPerms,
        status: 'ACTIVE',
      });
    }
    setPermSearch('');
    setIsCreateRoleOpen(true);
  };

  const openEditRoleModal = (role: AdminRoleDefinition) => {
    setEditingRole(role);
    setRoleForm({
      id: role.id,
      name: role.name,
      code: role.code,
      department: role.department,
      description: role.description || '',
      permissions: [...role.permissions],
      status: role.status || 'ACTIVE',
    });
    setPermSearch('');
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleForm.name.trim()) {
      showNotification('error', 'Role name is required.');
      return;
    }

    try {
      setSaving(true);
      if (editingRole) {
        const res: any = await adminApi.put(`/api/admin/roles/${editingRole.id}`, {
          name: roleForm.name,
          code: roleForm.code,
          department: roleForm.department,
          description: roleForm.description,
          permissions: roleForm.permissions,
          status: roleForm.status,
        });

        if (res.success) {
          showNotification('success', `Role "${roleForm.name}" updated successfully.`);
          setEditingRole(null);
          await fetchData();
        }
      } else {
        const res: any = await adminApi.post('/api/admin/roles/create', {
          name: roleForm.name,
          code: roleForm.code || roleForm.name.toUpperCase().replace(/\s+/g, '_'),
          department: roleForm.department,
          description: roleForm.description,
          permissions: roleForm.permissions,
          status: roleForm.status,
        });

        if (res.success) {
          showNotification('success', `New role "${res.role.name}" created with ${res.role.permissions.length} permissions.`);
          setIsCreateRoleOpen(false);
          await fetchData();
        }
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to save role.');
    } finally {
      setSaving(false);
    }
  };

  const handleCloneRole = async (role: AdminRoleDefinition) => {
    try {
      setSaving(true);
      const res: any = await adminApi.post(`/api/admin/roles/${role.id}/clone`, {
        name: `${role.name} (Copy)`,
      });

      if (res.success) {
        showNotification('success', `Role "${role.name}" cloned successfully.`);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to clone role.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRoleStatus = async (role: AdminRoleDefinition) => {
    if (role.isSystemRole && role.code === 'SUPER_ADMIN') {
      showNotification('error', 'Super Admin master role cannot be deactivated.');
      return;
    }

    try {
      setSaving(true);
      const newStatus = role.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      const res: any = await adminApi.put(`/api/admin/roles/${role.id}`, {
        status: newStatus,
      });

      if (res.success) {
        showNotification('success', `Role "${role.name}" status changed to ${newStatus}.`);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to toggle role status.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRoleConfirm = async () => {
    if (!roleToDelete) return;

    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/roles/${roleToDelete.id}`);
      if (res.success) {
        showNotification('success', `Role "${roleToDelete.name}" permanently deleted.`);
        setRoleToDelete(null);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to delete role.');
    } finally {
      setSaving(false);
    }
  };

  // ==================== ROLE PERMISSION TOGGLERS ====================

  const togglePermission = (permKey: AdminPermission) => {
    if (editingRole?.code === 'SUPER_ADMIN') {
      showNotification('error', 'Super Admin possesses all permissions by system design.');
      return;
    }

    setRoleForm((prev) => {
      const exists = prev.permissions.includes(permKey);
      if (exists) {
        return {
          ...prev,
          permissions: prev.permissions.filter((p) => p !== permKey),
        };
      } else {
        return {
          ...prev,
          permissions: [...prev.permissions, permKey],
        };
      }
    });
  };

  const toggleModulePermissions = (group: PermissionModuleGroup) => {
    if (editingRole?.code === 'SUPER_ADMIN') return;

    const groupKeys = group.permissions.map((p) => p.key);
    const allSelected = groupKeys.every((k) => roleForm.permissions.includes(k));

    setRoleForm((prev) => {
      if (allSelected) {
        return {
          ...prev,
          permissions: prev.permissions.filter((p) => !groupKeys.includes(p)),
        };
      } else {
        const set = new Set([...prev.permissions, ...groupKeys]);
        return {
          ...prev,
          permissions: Array.from(set),
        };
      }
    });
  };

  const selectAllPermissions = () => {
    if (editingRole?.code === 'SUPER_ADMIN') return;
    const allKeys = moduleGroups.flatMap((g) => g.permissions.map((p) => p.key));
    setRoleForm((prev) => ({
      ...prev,
      permissions: Array.from(new Set(allKeys)),
    }));
  };

  const clearAllPermissions = () => {
    if (editingRole?.code === 'SUPER_ADMIN') return;
    setRoleForm((prev) => ({
      ...prev,
      permissions: [],
    }));
  };

  // ==================== MANAGE EMPLOYEES ON A ROLE ====================

  const openManageRoleEmployeesModal = (role: AdminRoleDefinition) => {
    setRoleToManageEmployees(role);
    const assignedIds = employees
      .filter((e) => isEmployeeInRole(e, role))
      .map((e) => e.id);
    setRoleEmployeeSelections(assignedIds);
    setRoleEmployeeSearch('');
  };

  const handleSaveRoleEmployees = async () => {
    if (!roleToManageEmployees) return;

    try {
      setSaving(true);
      const res: any = await adminApi.post(`/api/admin/roles/${roleToManageEmployees.id}/assign-employees`, {
        employeeIds: roleEmployeeSelections,
      });

      if (res.success) {
        showNotification('success', `Employee assignments for role "${roleToManageEmployees.name}" updated successfully.`);
        setRoleToManageEmployees(null);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to update employee role assignments.');
    } finally {
      setSaving(false);
    }
  };

  // Direct quick remove an employee from a role directly from the card
  const handleQuickRemoveEmployeeFromRole = async (role: AdminRoleDefinition, emp: AdminEmployeeUser) => {
    if (role.code === 'SUPER_ADMIN' && (emp.id === 'emp-001' || emp.role === 'SUPER_ADMIN')) {
      const currentAdmins = employees.filter((e) => isEmployeeInRole(e, role));
      if (currentAdmins.length <= 1) {
        showNotification('error', 'Cannot remove the only active Super Admin.');
        return;
      }
    }

    try {
      setSaving(true);
      const currentRoleIds = emp.assignedRoleIds || [emp.role];
      const updatedRoles = currentRoleIds.filter((r) => r !== role.id && r !== role.code);

      const res: any = await adminApi.post(`/api/admin/employees/${emp.id}/assign-roles`, {
        assignedRoleIds: updatedRoles.length > 0 ? updatedRoles : ['role-order-ops-exec'],
        reason: `Super Admin removed ${emp.name} from role ${role.name}`,
      });

      if (res.success) {
        showNotification('success', `Removed "${emp.name}" from ${role.name}.`);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to remove employee.');
    } finally {
      setSaving(false);
    }
  };

  // Direct quick add an employee to a role from dropdown on card
  const handleQuickAddEmployeeToRole = async (role: AdminRoleDefinition, empId: string) => {
    if (!empId) return;
    const emp = employees.find((e) => e.id === empId);
    if (!emp) return;

    try {
      setSaving(true);
      const currentRoles = emp.assignedRoleIds || [emp.role];
      if (currentRoles.includes(role.id) || currentRoles.includes(role.code)) {
        showNotification('error', `${emp.name} already has this role.`);
        return;
      }

      const res: any = await adminApi.post(`/api/admin/employees/${emp.id}/assign-roles`, {
        assignedRoleIds: [...currentRoles, role.id],
        reason: `Super Admin added ${emp.name} to role ${role.name}`,
      });

      if (res.success) {
        showNotification('success', `Added "${emp.name}" to ${role.name}.`);
        // Reset selection
        setQuickAddSelection((prev) => ({ ...prev, [role.id]: '' }));
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to add employee to role.');
    } finally {
      setSaving(false);
    }
  };

  // ==================== EMPLOYEE ROLE ASSIGNMENT ACTIONS ====================

  const openAssignRolesForEmployeeModal = (emp: AdminEmployeeUser) => {
    setEmployeeToAssignRoles(emp);
    setSelectedRoleIdsForEmployee(emp.assignedRoleIds || [emp.role]);
  };

  const handleSaveEmployeeRoles = async () => {
    if (!employeeToAssignRoles) return;

    try {
      setSaving(true);
      const res: any = await adminApi.post(`/api/admin/employees/${employeeToAssignRoles.id}/assign-roles`, {
        assignedRoleIds: selectedRoleIdsForEmployee,
        reason: 'Super Admin administrative role assignment',
      });

      if (res.success) {
        showNotification('success', `Roles updated for "${employeeToAssignRoles.name}".`);
        setEmployeeToAssignRoles(null);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to assign roles.');
    } finally {
      setSaving(false);
    }
  };

  // ==================== EMPLOYEE CRUD ====================

  const openCreateEmployeeModal = () => {
    setEmployeeForm({
      name: '',
      email: '',
      phone: '+91 ',
      designation: 'Operations Coordinator',
      department: 'Live Dispatch Operations',
      assignedRoleIds: roles.length > 0 ? [roles[0].id] : ['role-order-ops-exec'],
      status: 'ACTIVE',
    });
    setIsCreateEmployeeOpen(true);
  };

  const openEditEmployeeModal = (emp: AdminEmployeeUser) => {
    setEditingEmployee(emp);
    setEmployeeForm({
      name: emp.name,
      email: emp.email,
      phone: emp.phone || '',
      designation: emp.designation || emp.roleTitle,
      department: emp.department,
      assignedRoleIds: emp.assignedRoleIds || [emp.role],
      status: emp.status || 'ACTIVE',
    });
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeForm.name || !employeeForm.email) {
      showNotification('error', 'Name and email are required.');
      return;
    }

    try {
      setSaving(true);
      if (editingEmployee) {
        const res: any = await adminApi.put(`/api/admin/employees/${editingEmployee.id}/update`, {
          name: employeeForm.name,
          email: employeeForm.email,
          phone: employeeForm.phone,
          designation: employeeForm.designation,
          department: employeeForm.department,
          assignedRoleIds: employeeForm.assignedRoleIds,
          status: employeeForm.status,
        });

        if (res.success) {
          showNotification('success', `Employee "${employeeForm.name}" updated successfully.`);
          setEditingEmployee(null);
          await fetchData();
        }
      } else {
        const res: any = await adminApi.post('/api/admin/employees/create', {
          ...employeeForm,
        });

        if (res.success) {
          showNotification('success', `Staff member "${res.employee.name}" created successfully.`);
          setIsCreateEmployeeOpen(false);
          await fetchData();
        }
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to save employee.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEmployeeStatus = async (emp: AdminEmployeeUser) => {
    if (emp.role === 'SUPER_ADMIN' || emp.id === 'emp-001') {
      showNotification('error', 'Master Super Admin account cannot be suspended.');
      return;
    }

    const nextStatus = emp.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    try {
      setSaving(true);
      const res: any = await adminApi.patch(`/api/admin/employees/${emp.id}/status`, {
        status: nextStatus,
        reason: 'Super Admin manual status toggle',
      });

      if (res.success) {
        showNotification('success', `Employee "${emp.name}" status updated to ${nextStatus}.`);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to update employee status.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEmployeeConfirm = async () => {
    if (!employeeToDelete) return;

    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/employees/${employeeToDelete.id}`);
      if (res.success) {
        showNotification('success', res.message || 'Employee record deleted.');
        setEmployeeToDelete(null);
        await fetchData();
      }
    } catch (err: any) {
      showNotification('error', err.message || 'Failed to delete employee.');
    } finally {
      setSaving(false);
    }
  };

  // Filtered queries
  const filteredRoles = roles.filter(
    (r) =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.department.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.description && r.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredEmployees = employees.filter(
    (e) =>
      e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      e.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (e.roleTitle && e.roleTitle.toLowerCase().includes(searchQuery.toLowerCase())) ||
      e.department.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (e.employeeCode && e.employeeCode.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Filter module groups for permission picker modal
  const filteredModuleGroups = moduleGroups
    .map((group) => {
      if (!permSearch.trim()) return group;
      const q = permSearch.toLowerCase();
      const filteredPerms = group.permissions.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.key.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.level.toLowerCase().includes(q)
      );
      return { ...group, permissions: filteredPerms };
    })
    .filter((g) => g.permissions.length > 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Toast Notification */}
      {statusNotification && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-xl text-xs font-semibold border animate-in slide-in-from-top-3 duration-200 ${
            statusNotification.type === 'success'
              ? 'bg-emerald-950 text-emerald-100 border-emerald-800'
              : 'bg-rose-950 text-rose-100 border-rose-800'
          }`}
        >
          {statusNotification.type === 'success' ? (
            <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0" />
          )}
          <span>{statusNotification.message}</span>
          <button onClick={() => setStatusNotification(null)} className="ml-2 opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Employee Roles & RBAC
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 px-3.5 py-2 rounded-xl text-xs font-medium border border-slate-200 transition-colors shadow-2xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>

          {activeTab === 'ROLES' ? (
            <button
              onClick={() => openCreateRoleModal()}
              className="flex items-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-xs transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Create Custom Role</span>
            </button>
          ) : activeTab === 'EMPLOYEES' ? (
            <button
              onClick={openCreateEmployeeModal}
              className="flex items-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-xs transition-colors"
            >
              <UserPlus className="h-4 w-4" />
              <span>Add Staff Member</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Tabs & Search Filter Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('ROLES')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'ROLES'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Shield className="h-4 w-4" />
            <span>Roles & Assigned Staff ({roles.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('EMPLOYEES')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'EMPLOYEES'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Staff Directory ({employees.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('MATRIX')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'MATRIX'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Layers className="h-4 w-4" />
            <span>Governance Matrix</span>
          </button>
        </div>

        <div className="relative w-full sm:w-80">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              activeTab === 'ROLES'
                ? 'Search roles by title or department...'
                : 'Search staff by name, email or designation...'
            }
            className="w-full pl-9 pr-4 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 shadow-2xs"
          />
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: ROLES & PERMISSIONS CARDS WITH VISIBLE EMPLOYEES & CLEAN ACTIONS   */}
      {/* ========================================================================= */}
      {activeTab === 'ROLES' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {loading && roles.length === 0 ? (
              <div className="col-span-full py-16 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto text-emerald-600 mb-2" />
                <p className="text-xs font-medium">Loading RBAC role definitions...</p>
              </div>
            ) : filteredRoles.length === 0 ? (
              <div className="col-span-full py-16 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">
                <Shield className="h-8 w-8 mx-auto text-slate-300 mb-2" />
                <p className="text-sm font-semibold">No roles found matching "{searchQuery}"</p>
                <p className="text-xs text-slate-400 mt-1">Try clearing your search query or create a new role.</p>
              </div>
            ) : (
              filteredRoles.map((role) => {
                const assignedEmployees = getEmployeesForRole(role);
                const isSuperAdminRole = role.code === 'SUPER_ADMIN';

                return (
                  <div
                    key={role.id}
                    className={`bg-white border rounded-2xl p-5 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between ${
                      role.status === 'INACTIVE'
                        ? 'border-slate-200 opacity-75 bg-slate-50/50'
                        : isSuperAdminRole
                        ? 'border-amber-300 ring-1 ring-amber-300/60 bg-gradient-to-b from-amber-50/30 via-white to-white'
                        : 'border-slate-200/90'
                    }`}
                  >
                    <div>
                      {/* Card Top: Role Name & Status */}
                      <div className="flex items-start justify-between gap-3 mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-slate-900 text-sm sm:text-base leading-snug">{role.name}</h3>
                          {isSuperAdminRole && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
                              <Sparkles className="h-2.5 w-2.5" /> MASTER
                            </span>
                          )}
                        </div>

                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 border ${
                            role.status === 'ACTIVE'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}
                        >
                          {role.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                        </span>
                      </div>

                      {/* Department & Permissions Count */}
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-2.5">
                        <span className="font-medium text-slate-700">{role.department}</span>
                        <span>•</span>
                        <span className="font-semibold text-emerald-700 flex items-center gap-1">
                          <Key className="h-3 w-3 text-emerald-600" />
                          <span>{role.permissions?.length || 0} permissions</span>
                        </span>
                      </div>

                      {/* Description */}
                      <p className="text-xs text-slate-600 line-clamp-2 min-h-[32px] mb-4 leading-relaxed">
                        {role.description || 'Access policy and operational permissions mandate.'}
                      </p>

                      {/* Assigned Employees Section */}
                      <div className="bg-slate-50/90 rounded-xl p-3 border border-slate-200/80 mb-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                            <Users className="h-3.5 w-3.5 text-slate-500" />
                            <span>Assigned Staff ({assignedEmployees.length})</span>
                          </div>

                          <button
                            onClick={() => openManageRoleEmployeesModal(role)}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:bg-emerald-100/70 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200 transition-colors shadow-2xs"
                            title="Assign or unassign staff"
                          >
                            <Plus className="h-3 w-3" />
                            <span>Assign Staff</span>
                          </button>
                        </div>

                        {/* Visible Employee List */}
                        {assignedEmployees.length === 0 ? (
                          <div className="py-3 px-3 bg-white rounded-lg border border-dashed border-slate-200 text-center">
                            <p className="text-xs text-slate-400 font-medium">No staff currently assigned</p>
                            <button
                              onClick={() => openManageRoleEmployeesModal(role)}
                              className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-800"
                            >
                              <Plus className="h-3 w-3" /> Click to assign staff members
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
                            {assignedEmployees.map((emp) => (
                              <div
                                key={emp.id}
                                className="group flex items-center justify-between gap-2 p-1.5 bg-white rounded-lg border border-slate-200/80 hover:border-slate-300 transition-all shadow-2xs"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <img
                                    src={emp.avatar}
                                    alt={emp.name}
                                    className="h-6 w-6 rounded-full object-cover border border-slate-200 shrink-0"
                                  />
                                  <div className="min-w-0">
                                    <div className="font-bold text-slate-900 text-xs truncate leading-tight flex items-center gap-1">
                                      <span>{emp.name}</span>
                                      {emp.status === 'SUSPENDED' && (
                                        <span className="text-[9px] px-1 py-0.2 rounded bg-rose-100 text-rose-700 font-normal">
                                          Suspended
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[10px] text-slate-500 truncate leading-tight">
                                      {emp.designation || emp.roleTitle || emp.department}
                                    </div>
                                  </div>
                                </div>

                                <button
                                  onClick={() => handleQuickRemoveEmployeeFromRole(role, emp)}
                                  className="opacity-40 group-hover:opacity-100 hover:bg-rose-100 text-slate-400 hover:text-rose-700 p-1 rounded transition-colors shrink-0"
                                  title={`Remove ${emp.name} from this role`}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Action Buttons Toolbar at Card Bottom */}
                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                      <button
                        onClick={() => openEditRoleModal(role)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors border border-emerald-200/80 shadow-2xs"
                        title="Edit role permissions matrix"
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <span>Edit Permissions</span>
                      </button>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleCloneRole(role)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors border border-transparent hover:border-slate-200"
                          title="Clone as new custom role"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>

                        {!isSuperAdminRole && (
                          <button
                            onClick={() => handleToggleRoleStatus(role)}
                            className={`p-1.5 rounded-lg text-xs font-semibold transition-colors ${
                              role.status === 'ACTIVE'
                                ? 'text-amber-600 hover:bg-amber-50'
                                : 'text-emerald-600 hover:bg-emerald-50'
                            }`}
                            title={role.status === 'ACTIVE' ? 'Deactivate role' : 'Activate role'}
                          >
                            {role.status === 'ACTIVE' ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                          </button>
                        )}

                        {!role.isSystemRole && (
                          <button
                            onClick={() => setRoleToDelete(role)}
                            className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition-colors"
                            title="Delete custom role"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: STAFF DIRECTORY & ROLE ASSIGNING                                   */}
      {/* ========================================================================= */}
      {activeTab === 'EMPLOYEES' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Staff Member</th>
                  <th className="px-5 py-3.5">Assigned Roles</th>
                  <th className="px-5 py-3.5">Department & Title</th>
                  <th className="px-5 py-3.5">Access Status</th>
                  <th className="px-5 py-3.5 text-right">Super Admin Governance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && employees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-slate-400">
                      <RefreshCw className="h-5 w-5 animate-spin mx-auto text-emerald-600 mb-2" />
                      Loading staff directory...
                    </td>
                  </tr>
                ) : filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-slate-500">
                      No staff members matching "{searchQuery}"
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => {
                    const assignedRoleDefs = roles.filter((r) => isEmployeeInRole(emp, r));
                    const isMasterAdmin = emp.role === 'SUPER_ADMIN' || emp.id === 'emp-001';

                    return (
                      <tr key={emp.id} className="hover:bg-slate-50/80 transition-colors">
                        {/* Profile */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <img
                              src={emp.avatar}
                              alt={emp.name}
                              className="h-9 w-9 rounded-full object-cover border border-slate-200 shrink-0"
                            />
                            <div>
                              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                                {emp.name}
                                {isMasterAdmin && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-200">
                                    ROOT
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono flex items-center gap-2">
                                <span>{emp.employeeCode}</span>
                                <span>•</span>
                                <span>{emp.email}</span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Assigned Roles */}
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap items-center gap-1.5 max-w-xs">
                            {assignedRoleDefs.length === 0 ? (
                              <span className="text-[11px] text-slate-400 italic">No roles assigned</span>
                            ) : (
                              assignedRoleDefs.map((r) => (
                                <span
                                  key={r.id}
                                  className={`font-semibold px-2 py-0.5 rounded text-[11px] border ${
                                    r.code === 'SUPER_ADMIN'
                                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                                      : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  }`}
                                >
                                  {r.name}
                                </span>
                              ))
                            )}
                            <button
                              onClick={() => openAssignRolesForEmployeeModal(emp)}
                              className="text-[10px] font-bold text-blue-600 hover:text-blue-800 underline px-1"
                              title="Assign or edit roles"
                            >
                              + Edit Roles
                            </button>
                          </div>
                        </td>

                        {/* Department & Title */}
                        <td className="px-5 py-4">
                          <div className="text-slate-900 font-semibold">{emp.designation || emp.roleTitle}</div>
                          <div className="text-[11px] text-slate-500">{emp.department}</div>
                        </td>

                        {/* Status */}
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                              emp.status === 'ACTIVE'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : emp.status === 'SUSPENDED'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                emp.status === 'ACTIVE'
                                  ? 'bg-emerald-500'
                                  : emp.status === 'SUSPENDED'
                                  ? 'bg-rose-500'
                                  : 'bg-slate-400'
                              }`}
                            />
                            {emp.status || 'ACTIVE'}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Role Assign button */}
                            <button
                              onClick={() => openAssignRolesForEmployeeModal(emp)}
                              className="px-2.5 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-xs font-semibold transition-colors border border-blue-200/80"
                              title="Assign and manage roles"
                            >
                              Assign Roles
                            </button>

                            {/* Edit employee info */}
                            <button
                              onClick={() => openEditEmployeeModal(emp)}
                              className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors border border-slate-200"
                              title="Edit employee details"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>

                            {/* Suspend / Reactivate */}
                            {!isMasterAdmin && (
                              <button
                                onClick={() => handleToggleEmployeeStatus(emp)}
                                className={`p-1.5 rounded-lg transition-colors border ${
                                  emp.status === 'ACTIVE'
                                    ? 'bg-rose-50 text-rose-600 hover:bg-rose-100 border-rose-200'
                                    : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border-emerald-200'
                                }`}
                                title={emp.status === 'ACTIVE' ? 'Suspend staff access' : 'Activate staff access'}
                              >
                                {emp.status === 'ACTIVE' ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                              </button>
                            )}

                            {/* Delete Employee */}
                            {!isMasterAdmin && (
                              <button
                                onClick={() => setEmployeeToDelete(emp)}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                title="Delete employee record"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: INTERACTIVE GOVERNANCE MATRIX                                      */}
      {/* ========================================================================= */}
      {activeTab === 'MATRIX' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden p-5 space-y-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Layers className="h-4 w-4 text-emerald-600" />
              Role Permission Matrix by Operational Module
            </h2>
            <p className="text-xs text-slate-500">
              Cross-reference roles against granular action permissions across all 12 operational domains.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border border-slate-200 rounded-xl">
              <thead className="bg-slate-100 text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 border-b border-r border-slate-200 min-w-[200px]">
                    Operational Module
                  </th>
                  {roles.map((r) => (
                    <th key={r.id} className="px-3 py-3 border-b border-r border-slate-200 text-center min-w-[120px]">
                      <div className="font-bold text-slate-900 text-xs">{r.name}</div>
                      <div className="text-[10px] text-slate-500 font-normal">{r.department}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {moduleGroups.map((group) => {
                  const groupPermKeys = group.permissions.map((p) => p.key);

                  return (
                    <tr key={group.moduleId} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3.5 border-r border-slate-200">
                        <div className="font-bold text-slate-900">{group.moduleName}</div>
                        <div className="text-[11px] text-slate-500">{group.permissions.length} Action Permissions</div>
                      </td>

                      {roles.map((r) => {
                        const matchedCount = groupPermKeys.filter((k) => r.permissions?.includes(k)).length;
                        const isAll = matchedCount === groupPermKeys.length;
                        const isNone = matchedCount === 0;

                        return (
                          <td key={r.id} className="px-3 py-3.5 border-r border-slate-200 text-center">
                            {r.code === 'SUPER_ADMIN' || isAll ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                <CheckCircle2 className="h-3 w-3" /> Full ({matchedCount})
                              </span>
                            ) : isNone ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-400 border border-slate-200">
                                <X className="h-3 w-3" /> None
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                <Sliders className="h-3 w-3" /> {matchedCount} / {groupPermKeys.length}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CREATE / EDIT ROLE WITH FULL PERMISSION MATRIX                      */}
      {/* ========================================================================= */}
      {(isCreateRoleOpen || editingRole) && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-100 text-emerald-800">
                  <Shield className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    {editingRole ? `Edit Role: ${editingRole.name}` : 'Create Dynamic Custom Role'}
                  </h2>
                  <p className="text-xs text-slate-500">
                    Configure role identity and assign granular operational permissions.
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsCreateRoleOpen(false);
                  setEditingRole(null);
                }}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSaveRole} className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
              {/* Basic Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-slate-50/70 p-4 rounded-xl border border-slate-200">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Role Title *</label>
                  <input
                    type="text"
                    required
                    value={roleForm.name}
                    onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                    placeholder="e.g. Catalog Specialist"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Role Code *</label>
                  <input
                    type="text"
                    required
                    disabled={editingRole?.isSystemRole}
                    value={roleForm.code}
                    onChange={(e) => setRoleForm({ ...roleForm, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    placeholder="e.g. CATALOG_MANAGER"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Department</label>
                  <select
                    value={roleForm.department}
                    onChange={(e) => setRoleForm({ ...roleForm, department: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  >
                    <option value="Executive Governance">Executive Governance</option>
                    <option value="Live Dispatch Operations">Live Dispatch Operations</option>
                    <option value="Customer Support">Customer Support</option>
                    <option value="Catalogue & Inventory">Catalogue & Inventory</option>
                    <option value="Finance & Accounts">Finance & Accounts</option>
                    <option value="Marketing & Growth">Marketing & Growth</option>
                    <option value="Fleet Operations">Fleet Operations</option>
                    <option value="Security & Compliance">Security & Compliance</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Status</label>
                  <select
                    value={roleForm.status}
                    disabled={editingRole?.code === 'SUPER_ADMIN'}
                    onChange={(e) => setRoleForm({ ...roleForm, status: e.target.value as 'ACTIVE' | 'INACTIVE' })}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-slate-100"
                  >
                    <option value="ACTIVE">ACTIVE (Operational)</option>
                    <option value="INACTIVE">INACTIVE (Disabled)</option>
                  </select>
                </div>

                <div className="col-span-full">
                  <label className="block font-semibold text-slate-700 mb-1">Role Description</label>
                  <textarea
                    rows={2}
                    value={roleForm.description}
                    onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
                    placeholder="Describe key responsibilities and operational mandate..."
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </div>
              </div>

              {/* Permission Matrix Controls */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-200">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Key className="h-4 w-4 text-emerald-600" />
                      Granular Permission Matrix ({roleForm.permissions.length} Enabled)
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Toggle exact actions across modules. Permissions enforce instant UI and backend authorization.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={editingRole?.code === 'SUPER_ADMIN'}
                      onClick={selectAllPermissions}
                      className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      disabled={editingRole?.code === 'SUPER_ADMIN'}
                      onClick={clearAllPermissions}
                      className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 disabled:opacity-50"
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                {/* Filter / Search Permissions */}
                <div className="relative">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={permSearch}
                    onChange={(e) => setPermSearch(e.target.value)}
                    placeholder="Search permissions by name, key or action type (e.g., refund, dispatch, edit)..."
                    className="w-full pl-8 pr-4 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                {/* Module Permission Groups Accordion / Grid */}
                <div className="space-y-4">
                  {filteredModuleGroups.map((group) => {
                    const groupPermKeys = group.permissions.map((p) => p.key);
                    const selectedInGroup = groupPermKeys.filter((k) => roleForm.permissions.includes(k)).length;
                    const isAllSelected = selectedInGroup === groupPermKeys.length;

                    return (
                      <div
                        key={group.moduleId}
                        className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs"
                      >
                        {/* Group Header */}
                        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                          <div>
                            <div className="font-bold text-slate-900 text-xs flex items-center gap-2">
                              <span>{group.moduleName}</span>
                              <span className="text-[10px] font-semibold text-slate-500">
                                ({selectedInGroup} of {group.permissions.length} active)
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-500">{group.description}</div>
                          </div>

                          <button
                            type="button"
                            disabled={editingRole?.code === 'SUPER_ADMIN'}
                            onClick={() => toggleModulePermissions(group)}
                            className="text-[11px] font-bold text-emerald-700 hover:text-emerald-900 flex items-center gap-1 bg-white px-2.5 py-1 rounded border border-slate-200 shadow-2xs"
                          >
                            {isAllSelected ? (
                              <>
                                <CheckSquare className="h-3.5 w-3.5" />
                                <span>Deselect Group</span>
                              </>
                            ) : (
                              <>
                                <Square className="h-3.5 w-3.5" />
                                <span>Select All in Group</span>
                              </>
                            )}
                          </button>
                        </div>

                        {/* Permissions in module */}
                        <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                          {group.permissions.map((perm) => {
                            const isChecked = roleForm.permissions.includes(perm.key);

                            return (
                              <label
                                key={perm.key}
                                className={`flex items-start gap-2.5 p-2 rounded-lg border transition-all cursor-pointer ${
                                  isChecked
                                    ? 'bg-emerald-50/50 border-emerald-300'
                                    : 'bg-white border-slate-100 hover:border-slate-200'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={editingRole?.code === 'SUPER_ADMIN'}
                                  onChange={() => togglePermission(perm.key)}
                                  className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-semibold text-slate-900">{perm.name}</span>
                                    <span
                                      className={`text-[9px] font-bold uppercase px-1.5 py-0.2 rounded border ${
                                        perm.level === 'View'
                                          ? 'bg-slate-100 text-slate-700 border-slate-200'
                                          : perm.level === 'Create'
                                          ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                                          : perm.level === 'Edit'
                                          ? 'bg-blue-100 text-blue-800 border-blue-200'
                                          : perm.level === 'Delete' || perm.level === 'Suspend'
                                          ? 'bg-rose-100 text-rose-800 border-rose-200'
                                          : 'bg-purple-100 text-purple-800 border-purple-200'
                                      }`}
                                    >
                                      {perm.level}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-500 font-mono mt-0.5">{perm.key}</div>
                                  <div className="text-[10px] text-slate-600 mt-0.5">{perm.description}</div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="pt-4 border-t border-slate-200 flex items-center justify-between sticky bottom-0 bg-white py-2">
                <div className="text-xs text-slate-500">
                  {roleForm.permissions.length} total permissions enabled
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateRoleOpen(false);
                      setEditingRole(null);
                    }}
                    className="px-4 py-2 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-xl font-semibold shadow-xs transition-colors flex items-center gap-1.5"
                  >
                    {saving ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4" />
                        <span>{editingRole ? 'Save Changes' : 'Create Role'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: MANAGE & ADD STAFF MEMBERS FOR A SPECIFIC ROLE                      */}
      {/* ========================================================================= */}
      {roleToManageEmployees && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Users className="h-5 w-5 text-emerald-600" />
                  Assign Staff to Role: {roleToManageEmployees.name}
                </h2>
                <p className="text-xs text-slate-500">
                  Check staff members to assign them this role, or uncheck to revoke access.
                </p>
              </div>
              <button
                onClick={() => setRoleToManageEmployees(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Search & Bulk Select Controls */}
            <div className="p-4 border-b border-slate-100 bg-white flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={roleEmployeeSearch}
                  onChange={(e) => setRoleEmployeeSearch(e.target.value)}
                  placeholder="Search staff by name, email, department..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  const allActiveIds = employees.filter((e) => e.status === 'ACTIVE').map((e) => e.id);
                  setRoleEmployeeSelections(allActiveIds);
                }}
                className="text-xs font-semibold px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg border border-slate-200 shrink-0"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() => setRoleEmployeeSelections([])}
                className="text-xs font-semibold px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg border border-slate-200 shrink-0"
              >
                Clear
              </button>
            </div>

            {/* Employee List */}
            <div className="p-4 space-y-2 flex-1 overflow-y-auto text-xs">
              {employees
                .filter(
                  (emp) =>
                    emp.name.toLowerCase().includes(roleEmployeeSearch.toLowerCase()) ||
                    emp.email.toLowerCase().includes(roleEmployeeSearch.toLowerCase()) ||
                    emp.department.toLowerCase().includes(roleEmployeeSearch.toLowerCase())
                )
                .map((emp) => {
                  const isChecked = roleEmployeeSelections.includes(emp.id);

                  return (
                    <label
                      key={emp.id}
                      className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                        isChecked
                          ? 'bg-emerald-50/70 border-emerald-300 shadow-2xs'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            if (isChecked) {
                              setRoleEmployeeSelections(roleEmployeeSelections.filter((id) => id !== emp.id));
                            } else {
                              setRoleEmployeeSelections([...roleEmployeeSelections, emp.id]);
                            }
                          }}
                          className="rounded text-emerald-600 focus:ring-emerald-500 h-4 w-4"
                        />
                        <img
                          src={emp.avatar}
                          alt={emp.name}
                          className="h-8 w-8 rounded-full object-cover border border-slate-200"
                        />
                        <div>
                          <div className="font-bold text-slate-900 flex items-center gap-1.5">
                            <span>{emp.name}</span>
                            <span className="text-[10px] font-mono text-slate-400">({emp.employeeCode})</span>
                          </div>
                          <div className="text-[11px] text-slate-500">{emp.email} • {emp.department}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isChecked && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">
                            Assigned
                          </span>
                        )}
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            emp.status === 'ACTIVE'
                              ? 'bg-slate-100 text-slate-700'
                              : 'bg-rose-100 text-rose-700'
                          }`}
                        >
                          {emp.status}
                        </span>
                      </div>
                    </label>
                  );
                })}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-600 font-medium">
                <strong>{roleEmployeeSelections.length}</strong> staff member{roleEmployeeSelections.length === 1 ? '' : 's'} assigned to {roleToManageEmployees.name}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRoleToManageEmployees(null)}
                  className="px-3.5 py-1.5 border border-slate-200 rounded-xl text-slate-700 hover:bg-white text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveRoleEmployees}
                  className="px-4 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-xl text-xs font-bold shadow-xs transition-colors flex items-center gap-1"
                >
                  {saving ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>Save Assignments</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: ASSIGN ROLES TO A SINGLE EMPLOYEE                                  */}
      {/* ========================================================================= */}
      {employeeToAssignRoles && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-emerald-600" />
                  Assign Roles: {employeeToAssignRoles.name}
                </h2>
                <p className="text-xs text-slate-500">
                  Select all dynamic & system roles to grant this staff member.
                </p>
              </div>
              <button
                onClick={() => setEmployeeToAssignRoles(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-6 space-y-3 max-h-[60vh] overflow-y-auto text-xs">
              {roles.map((role) => {
                const isChecked =
                  selectedRoleIdsForEmployee.includes(role.id) ||
                  selectedRoleIdsForEmployee.includes(role.code);

                return (
                  <label
                    key={role.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                      isChecked
                        ? 'bg-emerald-50/60 border-emerald-300'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        if (isChecked) {
                          setSelectedRoleIdsForEmployee(
                            selectedRoleIdsForEmployee.filter((id) => id !== role.id && id !== role.code)
                          );
                        } else {
                          setSelectedRoleIdsForEmployee([...selectedRoleIdsForEmployee, role.id]);
                        }
                      }}
                      className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 h-4 w-4"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900 text-xs">{role.name}</span>
                        <span className="text-[11px] text-slate-500 font-medium">{role.department}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{role.description}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <span className="text-xs text-slate-500 font-medium">
                {selectedRoleIdsForEmployee.length} role(s) selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEmployeeToAssignRoles(null)}
                  className="px-3.5 py-1.5 border border-slate-200 rounded-xl text-slate-700 hover:bg-white text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveEmployeeRoles}
                  className="px-4 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-xl text-xs font-bold shadow-xs transition-colors flex items-center gap-1"
                >
                  {saving ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>Save Roles</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CREATE / EDIT STAFF MEMBER                                         */}
      {/* ========================================================================= */}
      {(isCreateEmployeeOpen || editingEmployee) && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  {editingEmployee ? `Edit Staff: ${editingEmployee.name}` : 'Add New Staff Member'}
                </h2>
                <p className="text-xs text-slate-500">
                  Provision new employee profile and configure initial role assignments.
                </p>
              </div>
              <button
                onClick={() => {
                  setIsCreateEmployeeOpen(false);
                  setEditingEmployee(null);
                }}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEmployee} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Full Name *</label>
                  <input
                    type="text"
                    required
                    value={employeeForm.name}
                    onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })}
                    placeholder="e.g. Ramesh Patel"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Email Address *</label>
                    <input
                      type="email"
                      required
                      value={employeeForm.email}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, email: e.target.value })}
                      placeholder="ramesh@quickmart.in"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Phone Number</label>
                    <input
                      type="text"
                      value={employeeForm.phone}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, phone: e.target.value })}
                      placeholder="+91 98765 43210"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Job Designation</label>
                    <input
                      type="text"
                      value={employeeForm.designation}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, designation: e.target.value })}
                      placeholder="e.g. Senior Dispatch Lead"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Department</label>
                    <select
                      value={employeeForm.department}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, department: e.target.value })}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    >
                      <option value="Live Operations">Live Operations</option>
                      <option value="Customer Support">Customer Support</option>
                      <option value="Catalog & Sellers">Catalog & Sellers</option>
                      <option value="Finance & Settlements">Finance & Settlements</option>
                      <option value="Marketing & Growth">Marketing & Growth</option>
                      <option value="Security & Compliance">Security & Compliance</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Assigned Roles</label>
                  <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2 bg-slate-50">
                    {roles.map((r) => {
                      const isChecked = employeeForm.assignedRoleIds.includes(r.id) || employeeForm.assignedRoleIds.includes(r.code);
                      return (
                        <label key={r.id} className="flex items-center gap-2 text-[11px] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setEmployeeForm({
                                  ...employeeForm,
                                  assignedRoleIds: employeeForm.assignedRoleIds.filter((id) => id !== r.id && id !== r.code),
                                });
                              } else {
                                setEmployeeForm({
                                  ...employeeForm,
                                  assignedRoleIds: [...employeeForm.assignedRoleIds, r.id],
                                });
                              }
                            }}
                            className="rounded text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
                          />
                          <span className="truncate font-medium text-slate-800">{r.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateEmployeeOpen(false);
                    setEditingEmployee(null);
                  }}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-slate-700 hover:bg-slate-100 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-xl font-bold shadow-xs transition-colors flex items-center gap-1"
                >
                  {saving ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>{editingEmployee ? 'Save Changes' : 'Create Staff Member'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* CONFIRM DELETE MODALS                                                     */}
      {/* ========================================================================= */}
      {roleToDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-3 bg-rose-100 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete Custom Role</h3>
                <p className="text-xs text-slate-500">This action cannot be undone.</p>
              </div>
            </div>

            <p className="text-xs text-slate-600">
              Are you sure you want to permanently delete the custom role <strong>"{roleToDelete.name}"</strong>?
              Employees assigned to this role will automatically be safely adjusted.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRoleToDelete(null)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDeleteRoleConfirm}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold shadow-xs flex items-center gap-1.5"
              >
                {saving ? 'Deleting...' : 'Delete Role'}
              </button>
            </div>
          </div>
        </div>
      )}

      {employeeToDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-3 bg-rose-100 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete Staff Member</h3>
                <p className="text-xs text-slate-500">Permanent record removal</p>
              </div>
            </div>

            <p className="text-xs text-slate-600">
              Are you sure you want to delete the staff record for <strong>"{employeeToDelete.name}"</strong> ({employeeToDelete.email})?
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEmployeeToDelete(null)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDeleteEmployeeConfirm}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold shadow-xs flex items-center gap-1.5"
              >
                {saving ? 'Deleting...' : 'Delete Staff'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
