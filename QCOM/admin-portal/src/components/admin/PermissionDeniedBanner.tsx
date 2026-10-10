import React from 'react';
import { ShieldAlert, Lock, ArrowRight } from 'lucide-react';
import { AdminRole, AdminPermission, AdminUser } from '../../types/admin';

interface PermissionDeniedBannerProps {
  requiredPermission: AdminPermission;
  currentRole: AdminRole;
  roleTitle: string;
  onSwitchToSuperAdmin: () => void;
}

export const PermissionDeniedBanner: React.FC<PermissionDeniedBannerProps> = ({
  requiredPermission,
  currentRole,
  roleTitle,
  onSwitchToSuperAdmin,
}) => {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-2xl mx-auto my-12 text-center shadow-xs">
      <div className="inline-flex items-center justify-center p-4 bg-amber-50 text-amber-700 rounded-2xl mb-4 border border-amber-200">
        <ShieldAlert className="h-10 w-10" />
      </div>

      <h2 className="text-xl font-bold text-slate-900 tracking-tight">Access Restricted by RBAC Policy</h2>
      <p className="text-slate-500 text-xs mt-2 max-w-md mx-auto leading-relaxed">
        Your current active persona (<span className="text-slate-900 font-semibold">{roleTitle}</span>) does not have the{' '}
        <code className="text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded font-mono text-[11px] border border-amber-200 font-semibold">
          {requiredPermission}
        </code>{' '}
        permission required to inspect or mutate this module.
      </p>

      <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200 text-left text-xs text-slate-700 max-w-lg mx-auto space-y-2 font-mono">
        <div className="flex justify-between">
          <span className="text-slate-500">Target Action:</span>
          <span className="text-amber-700 font-semibold">{requiredPermission}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Current Role:</span>
          <span className="text-slate-900 font-semibold">{currentRole}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Enforcement:</span>
          <span className="text-emerald-700 font-bold">API + Frontend Guard Active</span>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          onClick={onSwitchToSuperAdmin}
          className="inline-flex items-center gap-2 bg-[#009DE0] hover:bg-[#0087c2] text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-xs"
        >
          <span>Switch to Super Admin Persona</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
