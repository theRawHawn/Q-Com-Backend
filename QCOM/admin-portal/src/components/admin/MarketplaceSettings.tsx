import React, { useState } from 'react';
import {
  Settings,
  ShieldCheck,
  Bell,
  Database,
  Lock,
  Key,
  CheckCircle2,
  AlertTriangle,
  Save,
  Server
} from 'lucide-react';
import { AdminPermission } from '../../types/admin';

interface MarketplaceSettingsProps {
  userPermissions: AdminPermission[];
}

export const MarketplaceSettings: React.FC<MarketplaceSettingsProps> = ({ userPermissions }) => {
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [smsGatewayActive, setSmsGatewayActive] = useState(true);
  const [whatsappAlerts, setWhatsappAlerts] = useState(true);
  const [saved, setSaved] = useState(false);

  const canManageSettings = userPermissions.includes('settings.manage');

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            System Settings
          </h1>
        </div>
      </div>

      {saved && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-medium flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />
          <span>Marketplace infrastructure configuration saved successfully.</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Emergency Kill Switches */}
        <div className="bg-white border border-slate-200/90 rounded-lg p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-4">
          <h3 className="font-semibold text-slate-900 text-sm border-b border-slate-100 pb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-600" />
            Operational Kill Switches & Safety Limits
          </h3>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 bg-slate-50/80 rounded-md border border-slate-200/80">
              <div>
                <span className="font-semibold text-slate-900 block">Emergency Maintenance Mode</span>
                <span className="text-slate-500 text-[11px]">Pauses incoming customer checkout while in progress</span>
              </div>
              <button
                onClick={() => setMaintenanceMode(!maintenanceMode)}
                disabled={!canManageSettings}
                className={`px-3 py-1.5 rounded-md font-mono text-xs font-semibold transition-all cursor-pointer ${
                  maintenanceMode
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'bg-slate-200/80 text-slate-700 hover:bg-slate-300'
                }`}
              >
                {maintenanceMode ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            <div className="p-3 bg-slate-50/80 rounded-md border border-slate-200/80 space-y-2">
              <span className="font-semibold text-slate-900 block">Default Delivery Buffer SLA</span>
              <div className="flex items-center gap-2 font-mono">
                <input
                  type="number"
                  defaultValue={15}
                  disabled={!canManageSettings}
                  className="w-16 bg-white border border-slate-200 rounded-md px-2.5 py-1 text-slate-900 font-bold text-xs"
                />
                <span className="text-slate-600 text-xs">minutes from placement to contractor handover</span>
              </div>
            </div>
          </div>
        </div>

        {/* Notification Gateways */}
        <div className="bg-white border border-slate-200/90 rounded-lg p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-4">
          <h3 className="font-semibold text-slate-900 text-sm border-b border-slate-100 pb-3 flex items-center gap-2">
            <Bell className="h-4 w-4 text-slate-600" />
            Communication & Dispatch Gateways
          </h3>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 bg-slate-50/80 rounded-md border border-slate-200/80">
              <div>
                <span className="font-semibold text-slate-900 block">SMS OTP Gateway (DLT Compliant)</span>
                <span className="text-slate-500 text-[11px]">Delivery handover OTPs & contractor sign-in</span>
              </div>
              <button
                onClick={() => setSmsGatewayActive(!smsGatewayActive)}
                disabled={!canManageSettings}
                className={`px-3 py-1.5 rounded-md font-mono text-xs font-semibold transition-all cursor-pointer ${
                  smsGatewayActive
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'bg-slate-200/80 text-slate-700 hover:bg-slate-300'
                }`}
              >
                {smsGatewayActive ? 'ONLINE' : 'OFFLINE'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-50/80 rounded-md border border-slate-200/80">
              <div>
                <span className="font-semibold text-slate-900 block">WhatsApp Business API Webhooks</span>
                <span className="text-slate-500 text-[11px]">Real-time map tracking links sent to electricians</span>
              </div>
              <button
                onClick={() => setWhatsappAlerts(!whatsappAlerts)}
                disabled={!canManageSettings}
                className={`px-3 py-1.5 rounded-md font-mono text-xs font-semibold transition-all cursor-pointer ${
                  whatsappAlerts
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'bg-slate-200/80 text-slate-700 hover:bg-slate-300'
                }`}
              >
                {whatsappAlerts ? 'ONLINE' : 'OFFLINE'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {canManageSettings && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            className="bg-slate-900 hover:bg-slate-800 text-white font-medium px-4 py-2 rounded-md text-xs flex items-center gap-2 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.06)] cursor-pointer"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Save System Parameters</span>
          </button>
        </div>
      )}
    </div>
  );
};
