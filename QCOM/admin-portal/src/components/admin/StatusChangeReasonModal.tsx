import React, { useState } from 'react';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';

interface StatusChangeReasonModalProps {
  sellerName: string;
  currentStatus: string;
  targetStatus: string;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

export const StatusChangeReasonModal: React.FC<StatusChangeReasonModalProps> = ({
  sellerName,
  currentStatus,
  targetStatus,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSuspending = targetStatus === 'SUSPENDED';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    setIsSubmitting(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err: any) {
      alert(err.message || 'Action failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            {isSuspending ? (
              <AlertTriangle className="w-5 h-5 text-rose-500" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
            )}
            <h3 className="text-base font-bold text-slate-800">
              {isSuspending ? 'Suspend Merchant Hub' : 'Reactivate Merchant Hub'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="text-sm text-slate-600">
            You are about to change the operating status of{' '}
            <strong className="text-slate-900">{sellerName}</strong> from{' '}
            <span className="font-semibold text-slate-700">{currentStatus}</span> to{' '}
            <span
              className={`font-bold ${
                isSuspending ? 'text-rose-600' : 'text-emerald-600'
              }`}
            >
              {targetStatus}
            </span>
            .
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Audit Reason & Justification *
            </label>
            <textarea
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isSuspending
                  ? 'E.g., Repeated SLA violations, counterfeit report, or requested pause...'
                  : 'E.g., KYC verified, dispute settled, or seasonal resumption...'
              }
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !reason.trim()}
              className={`px-4 py-2 text-xs font-bold text-white rounded-lg transition-colors ${
                isSuspending
                  ? 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300'
                  : 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300'
              }`}
            >
              {isSubmitting
                ? 'Updating...'
                : isSuspending
                ? 'Confirm Suspension'
                : 'Confirm Reactivation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
