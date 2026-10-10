import React, { useState } from 'react';
import {
  X,
  Sliders,
  CheckCircle2,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Info,
  Layers,
  Building2,
  Save
} from 'lucide-react';
import { RefundPolicyConfig } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface RefundPolicyModalProps {
  policy: RefundPolicyConfig;
  onClose: () => void;
  onSuccess: (updatedPolicy: RefundPolicyConfig, message: string) => void;
}

export const RefundPolicyModal: React.FC<RefundPolicyModalProps> = ({
  policy,
  onClose,
  onSuccess,
}) => {
  const [autoApprovalThreshold, setAutoApprovalThreshold] = useState(policy?.autoApprovalThreshold || 500);
  const [claimWindowHours, setClaimWindowHours] = useState(policy?.claimWindowHours || 48);
  const [requireManagerApprovalAbove, setRequireManagerApprovalAbove] = useState(policy?.requireManagerApprovalAbove || 2500);
  const [instantUpiEnabled, setInstantUpiEnabled] = useState(policy?.instantUpiEnabled ?? true);
  const [allowPartialItemRefunds, setAllowPartialItemRefunds] = useState(policy?.allowPartialItemRefunds ?? true);
  const [sellerClawbackDefaultPercent, setSellerClawbackDefaultPercent] = useState(policy?.sellerClawbackDefaultPercent || 100);
  const [maxDailyRefundQuota, setMaxDailyRefundQuota] = useState(policy?.maxDailyRefundQuota || 50000);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      setStatusMessage(null);

      const res: any = await adminApi.post('/api/admin/refunds/policy/update', {
        autoApprovalThreshold: Number(autoApprovalThreshold),
        claimWindowHours: Number(claimWindowHours),
        requireManagerApprovalAbove: Number(requireManagerApprovalAbove),
        instantUpiEnabled,
        allowPartialItemRefunds,
        sellerClawbackDefaultPercent: Number(sellerClawbackDefaultPercent),
        maxDailyRefundQuota: Number(maxDailyRefundQuota),
      });

      if (res && res.success) {
        onSuccess(res.policy, res.message || 'Refund policy updated successfully.');
      }
    } catch (err: any) {
      setStatusMessage(err.message || 'Failed to update policy settings.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200/80 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="px-5 py-4 bg-slate-50/60 border-b border-slate-200/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-slate-100 text-slate-700 rounded-lg">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Refund Policy & Guardrails</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {statusMessage && (
            <div className="p-2.5 bg-rose-50 border border-rose-200/80 rounded-lg text-xs text-rose-700">
              {statusMessage}
            </div>
          )}

          <div className="space-y-3">
            
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Instant Auto-Approval Cap (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max="5000"
                  value={autoApprovalThreshold}
                  onChange={(e) => setAutoApprovalThreshold(Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200/80 rounded-lg text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
                />
                <p className="text-[10px] text-slate-500 mt-0.5">Auto-disbursed below threshold</p>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Customer Claim Window (Hours)
                </label>
                <input
                  type="number"
                  min="1"
                  max="168"
                  value={claimWindowHours}
                  onChange={(e) => setClaimWindowHours(Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200/80 rounded-lg text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
                />
                <p className="text-[10px] text-slate-500 mt-0.5">Post-delivery claim window</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Manager Sign-Off Threshold (₹)
                </label>
                <input
                  type="number"
                  min="500"
                  max="50000"
                  value={requireManagerApprovalAbove}
                  onChange={(e) => setRequireManagerApprovalAbove(Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200/80 rounded-lg text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
                />
                <p className="text-[10px] text-slate-500 mt-0.5">Requires senior approval</p>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Merchant Clawback Default %
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={sellerClawbackDefaultPercent}
                  onChange={(e) => setSellerClawbackDefaultPercent(Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200/80 rounded-lg text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
                />
                <p className="text-[10px] text-slate-500 mt-0.5">% deducted from seller payout</p>
              </div>
            </div>

            {/* Toggles */}
            <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-slate-800 block">Instant UPI VPA Rails</span>
                  <p className="text-[11px] text-slate-500">Allow instant direct payouts to contractor UPI VPAs</p>
                </div>
                <input
                  type="checkbox"
                  checked={instantUpiEnabled}
                  onChange={(e) => setInstantUpiEnabled(e.target.checked)}
                  className="h-4 w-4 rounded text-slate-900 focus:ring-slate-900 border-slate-300"
                />
              </div>

              <div className="flex items-center justify-between border-t border-slate-200/80 pt-2">
                <div>
                  <span className="font-medium text-slate-800 block">Item-Level Partial Refunds</span>
                  <p className="text-[11px] text-slate-500">Allow agents to refund specific SKUs without cancelling full order</p>
                </div>
                <input
                  type="checkbox"
                  checked={allowPartialItemRefunds}
                  onChange={(e) => setAllowPartialItemRefunds(e.target.checked)}
                  className="h-4 w-4 rounded text-slate-900 focus:ring-slate-900 border-slate-300"
                />
              </div>
            </div>

          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-slate-200/80 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded-lg text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-all shadow-xs flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Saving...' : 'Save Policy Settings'}</span>
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};
