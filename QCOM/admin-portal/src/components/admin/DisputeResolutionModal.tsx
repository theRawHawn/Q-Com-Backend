import React, { useState } from 'react';
import {
  X,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  FileCheck,
  Building2,
  Phone,
  Scale,
  ArrowRight
} from 'lucide-react';
import { AdminRefundDispute } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface DisputeResolutionModalProps {
  dispute: AdminRefundDispute;
  onClose: () => void;
  onSuccess: (updatedDispute: AdminRefundDispute, message: string) => void;
}

export const DisputeResolutionModal: React.FC<DisputeResolutionModalProps> = ({
  dispute,
  onClose,
  onSuccess,
}) => {
  const [action, setAction] = useState<'ACCEPT_AND_REFUND' | 'CONTEST_WITH_POD' | 'CLOSE_WON'>('CONTEST_WITH_POD');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const res: any = await adminApi.post(`/api/admin/refunds/disputes/${dispute.id}/resolve`, {
        action,
        notes: resolutionNotes,
      });

      if (res && res.success) {
        onSuccess(res.dispute, res.message || 'Dispute resolved successfully.');
      } else {
        setErrorMessage(res?.message || 'Failed to update dispute status.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Network error occurred.');
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
              <Scale className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Chargeback Dispute Desk</h2>
              <p className="text-[11px] text-slate-500 font-mono">Claim #{dispute.claimReference}</p>
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
          {errorMessage && (
            <div className="p-2.5 bg-rose-50 border border-rose-200/80 rounded-lg text-xs text-rose-700">
              {errorMessage}
            </div>
          )}

          {/* Dispute Context */}
          <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">Order Reference:</span>
              <span className="font-semibold text-slate-900 font-mono">{dispute.orderNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Dispute Amount:</span>
              <span className="font-bold text-rose-600 font-mono text-sm">
                ₹{dispute.disputeAmount.toLocaleString('en-IN')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Issuing Bank:</span>
              <span className="font-medium text-slate-800">{dispute.bankName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Claim Category:</span>
              <span className="font-medium text-slate-800">{dispute.category}</span>
            </div>
            <div className="pt-2 border-t border-slate-200/80">
              <span className="text-slate-500 block text-[11px]">Bank Claim Description:</span>
              <p className="text-slate-700 mt-0.5 font-normal">"{dispute.reason}"</p>
            </div>
            {dispute.podVerifiedOtp && (
              <div className="p-2 bg-emerald-50/80 border border-emerald-200/80 rounded text-emerald-800 text-[11px] font-medium flex items-center gap-1.5">
                <FileCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Delivery OTP Verified at handover: <strong>{dispute.podVerifiedOtp}</strong></span>
              </div>
            )}
          </div>

          {/* Decision Selector */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-800">
              Resolution Action
            </label>
            <div className="space-y-2">
              <label className={`p-2.5 rounded-lg border flex items-start gap-2.5 cursor-pointer transition-all ${
                action === 'CONTEST_WITH_POD' ? 'bg-sky-50/60 border-sky-300' : 'bg-white border-slate-200/80 hover:bg-slate-50'
              }`}>
                <input
                  type="radio"
                  name="action"
                  checked={action === 'CONTEST_WITH_POD'}
                  onChange={() => setAction('CONTEST_WITH_POD')}
                  className="mt-0.5 text-slate-900 focus:ring-slate-900"
                />
                <div className="text-xs">
                  <span className="font-medium text-slate-900 block">Contest Chargeback with Digital Proof (POD)</span>
                  <span className="text-slate-500 text-[11px]">Submit delivery OTP timestamp, GPS track log & signed handover evidence to issuing bank.</span>
                </div>
              </label>

              <label className={`p-2.5 rounded-lg border flex items-start gap-2.5 cursor-pointer transition-all ${
                action === 'ACCEPT_AND_REFUND' ? 'bg-rose-50/60 border-rose-300' : 'bg-white border-slate-200/80 hover:bg-slate-50'
              }`}>
                <input
                  type="radio"
                  name="action"
                  checked={action === 'ACCEPT_AND_REFUND'}
                  onChange={() => setAction('ACCEPT_AND_REFUND')}
                  className="mt-0.5 text-slate-900 focus:ring-slate-900"
                />
                <div className="text-xs">
                  <span className="font-medium text-slate-900 block">Accept Claim & Issue Customer Credit</span>
                  <span className="text-slate-500 text-[11px]">Acknowledge legitimate damage/dispute and settle through merchant clawback.</span>
                </div>
              </label>

              <label className={`p-2.5 rounded-lg border flex items-start gap-2.5 cursor-pointer transition-all ${
                action === 'CLOSE_WON' ? 'bg-emerald-50/60 border-emerald-300' : 'bg-white border-slate-200/80 hover:bg-slate-50'
              }`}>
                <input
                  type="radio"
                  name="action"
                  checked={action === 'CLOSE_WON'}
                  onChange={() => setAction('CLOSE_WON')}
                  className="mt-0.5 text-slate-900 focus:ring-slate-900"
                />
                <div className="text-xs">
                  <span className="font-medium text-slate-900 block">Mark Closed in Marketplace Favour</span>
                  <span className="text-slate-500 text-[11px]">Bank accepted evidence and dropped chargeback liability.</span>
                </div>
              </label>
            </div>
          </div>

          {/* Remarks */}
          <div className="text-xs">
            <label className="block text-slate-700 font-medium mb-1">
              Case Resolution Summary
            </label>
            <textarea
              rows={2}
              placeholder="Enter resolution notes for audit..."
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              className="w-full p-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
            />
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
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-xs"
            >
              {isSubmitting ? <span>Updating...</span> : <span>Apply Dispute Decision</span>}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};
