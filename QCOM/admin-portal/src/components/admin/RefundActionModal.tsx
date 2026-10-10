import React, { useState } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Zap,
  Building2,
  ShieldCheck,
  CreditCard,
  Ban,
  ArrowRight
} from 'lucide-react';
import { AdminRefund } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface RefundActionModalProps {
  refund: AdminRefund;
  actionType: 'APPROVE' | 'REJECT' | 'HOLD' | 'RETRY';
  onClose: () => void;
  onSuccess: (updatedRefund: AdminRefund, message: string) => void;
}

export const RefundActionModal: React.FC<RefundActionModalProps> = ({
  refund,
  actionType,
  onClose,
  onSuccess,
}) => {
  const [gatewayChannel, setGatewayChannel] = useState(refund.channel || 'UPI_INSTANT');
  const [customUtr, setCustomUtr] = useState('');
  const [clawbackSeller, setClawbackSeller] = useState(refund.sellerClawback ?? true);
  const [rejectionReason, setRejectionReason] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    try {
      setIsSubmitting(true);
      let res: any;

      if (actionType === 'APPROVE') {
        res = await adminApi.post(`/api/admin/refunds/${refund.id}/approve`, {
          gatewayChannel: gatewayChannel === 'UPI_INSTANT' ? 'Instant UPI VPA' : gatewayChannel === 'TRADE_CREDIT' ? 'Trade Credit Ledger' : 'Original Payment Method',
          customUtr: customUtr.trim() || undefined,
          clawbackSeller,
          adminNotes,
        });
      } else if (actionType === 'REJECT') {
        if (!rejectionReason.trim()) {
          setErrorMessage('Please provide a mandatory reason for rejecting this refund request.');
          setIsSubmitting(false);
          return;
        }
        res = await adminApi.post(`/api/admin/refunds/${refund.id}/reject`, {
          reason: rejectionReason,
        });
      } else if (actionType === 'HOLD') {
        res = await adminApi.post(`/api/admin/refunds/${refund.id}/hold`, {
          reason: holdReason || 'Investigation in progress by Operations Desk',
        });
      } else if (actionType === 'RETRY') {
        res = await adminApi.post(`/api/admin/refunds/${refund.id}/retry`, {});
      }

      if (res && res.success) {
        onSuccess(res.refund, res.message || 'Action executed successfully.');
      } else {
        setErrorMessage(res?.message || 'Action failed on server.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Server communication error.');
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
            <div className={`p-2 rounded-lg ${
              actionType === 'APPROVE' ? 'bg-emerald-50 text-emerald-700' :
              actionType === 'REJECT' ? 'bg-rose-50 text-rose-700' :
              actionType === 'HOLD' ? 'bg-purple-50 text-purple-700' :
              'bg-sky-50 text-sky-700'
            }`}>
              {actionType === 'APPROVE' && <CheckCircle2 className="w-4 h-4" />}
              {actionType === 'REJECT' && <Ban className="w-4 h-4" />}
              {actionType === 'HOLD' && <AlertTriangle className="w-4 h-4" />}
              {actionType === 'RETRY' && <RotateCcw className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {actionType === 'APPROVE' && 'Authorize Refund Disbursement'}
                {actionType === 'REJECT' && 'Decline Refund Request'}
                {actionType === 'HOLD' && (refund.status === 'ON_HOLD' ? 'Release Refund Hold' : 'Place Refund On Hold')}
                {actionType === 'RETRY' && 'Retry Gateway Disbursement'}
              </h2>
              <p className="text-[11px] text-slate-500">
                Order <span className="font-semibold text-slate-800 font-mono">{refund.orderNumber}</span> • ₹{refund.amount.toLocaleString('en-IN')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
          {errorMessage && (
            <div className="p-3 bg-rose-50 border border-rose-200/80 rounded-lg text-xs text-rose-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Details Card */}
          <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">Beneficiary:</span>
              <span className="font-semibold text-slate-900">{refund.customerName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Disbursement Amount:</span>
              <span className="font-bold text-rose-600 font-mono text-sm">₹{refund.amount.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Stated Reason:</span>
              <span className="text-slate-800 text-right max-w-[240px] truncate">{refund.reason}</span>
            </div>
          </div>

          {/* APPROVE VIEW */}
          {actionType === 'APPROVE' && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Payout Rail / Gateway Channel
                </label>
                <select
                  value={gatewayChannel}
                  onChange={(e) => setGatewayChannel(e.target.value as any)}
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                >
                  <option value="UPI_INSTANT">Instant UPI VPA Direct Disburse (Recommended)</option>
                  <option value="SOURCE_ACCOUNT">Original Payment Method (Card / Netbanking)</option>
                  <option value="TRADE_CREDIT">Credit to Contractor Trade Wallet</option>
                  <option value="BANK_NEFT_IMPS">Direct IMPS / NEFT Settlement</option>
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Custom Bank UTR / Transaction Ref (Optional)
                </label>
                <input
                  type="text"
                  placeholder="Leave empty to auto-generate banking UTR"
                  value={customUtr}
                  onChange={(e) => setCustomUtr(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-medium text-slate-800 block">Deduct from Seller Payout</span>
                  <p className="text-[11px] text-slate-500">Clawback ₹{refund.amount} from {refund.sellerName || 'Merchant'}</p>
                </div>
                <input
                  type="checkbox"
                  checked={clawbackSeller}
                  onChange={(e) => setClawbackSeller(e.target.checked)}
                  className="h-4 w-4 rounded text-slate-900 focus:ring-slate-900 border-slate-300"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Admin Authorization Note
                </label>
                <input
                  type="text"
                  placeholder="e.g. Approved per operations lead sign-off"
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>
          )}

          {/* REJECT VIEW */}
          {actionType === 'REJECT' && (
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Decline Reason (Required for Customer & Audit Record)
                </label>
                <textarea
                  rows={3}
                  placeholder="Enter specific grounds for rejection (e.g. Delivery signature confirmed, damaged package claim unsubstantiated, outside return window)..."
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-rose-500"
                  required
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Customer will receive a formal notification citing this reason. The refund will be marked as REJECTED.
              </p>
            </div>
          )}

          {/* HOLD VIEW */}
          {actionType === 'HOLD' && (
            <div className="space-y-2.5 text-xs">
              {refund.status === 'ON_HOLD' ? (
                <p className="text-xs text-slate-600 leading-relaxed">
                  This refund is currently ON HOLD. Releasing the hold will restore it to the pending review queue so finance officers can proceed with approval.
                </p>
              ) : (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Reason for Hold / Investigation
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Awaiting reverse pickup inspection at DLF Cyber City store"
                    value={holdReason}
                    onChange={(e) => setHoldReason(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Payout will be temporarily blocked until released by an authorized manager.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* RETRY VIEW */}
          {actionType === 'RETRY' && (
            <div className="space-y-2 text-xs text-slate-600 leading-relaxed">
              <p>
                This will trigger a fresh bank payout attempt with a new UTR reference for <span className="font-semibold text-slate-800">₹{refund.amount}</span>.
              </p>
              <div className="p-3 bg-amber-50/80 border border-amber-200/80 rounded-lg text-amber-800 text-xs">
                Ensure previous gateway webhook failure was resolved before retrying disbursement.
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="pt-3.5 border-t border-slate-200/80 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded-lg text-xs font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium text-white transition-all shadow-xs flex items-center gap-1.5 ${
                actionType === 'APPROVE' ? 'bg-emerald-600 hover:bg-emerald-700' :
                actionType === 'REJECT' ? 'bg-rose-600 hover:bg-rose-700' :
                actionType === 'HOLD' ? 'bg-purple-600 hover:bg-purple-700' :
                'bg-sky-600 hover:bg-sky-700'
              }`}
            >
              {isSubmitting ? (
                <span>Executing...</span>
              ) : (
                <>
                  <span>
                    {actionType === 'APPROVE' && `Confirm & Disburse ₹${refund.amount}`}
                    {actionType === 'REJECT' && 'Confirm Rejection'}
                    {actionType === 'HOLD' && (refund.status === 'ON_HOLD' ? 'Release Hold' : 'Place on Hold')}
                    {actionType === 'RETRY' && 'Disburse Fresh Payout'}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};
