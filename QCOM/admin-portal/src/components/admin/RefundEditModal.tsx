import React, { useState } from 'react';
import {
  X,
  CreditCard,
  Building2,
  Phone,
  User,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  CheckCircle2,
  Trash2,
  Save,
  Clock,
  Zap,
  ArrowRight,
  FileText
} from 'lucide-react';
import { AdminRefund } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface RefundEditModalProps {
  refund: AdminRefund;
  onClose: () => void;
  onSuccess: (updatedRefund: AdminRefund, message: string) => void;
  onDelete?: (refundId: string, message: string) => void;
}

export const RefundEditModal: React.FC<RefundEditModalProps> = ({
  refund,
  onClose,
  onSuccess,
  onDelete,
}) => {
  const [activeTab, setActiveTab] = useState<'financials' | 'beneficiary' | 'settlement' | 'notes'>('financials');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form states
  const [amount, setAmount] = useState<number>(refund.amount);
  const [channel, setChannel] = useState<string>(refund.channel || 'UPI_INSTANT');
  const [customerName, setCustomerName] = useState<string>(refund.customerName || '');
  const [customerPhone, setCustomerPhone] = useState<string>(refund.customerPhone || '');
  const [reason, setReason] = useState<string>(refund.reason || '');
  const [bankUtr, setBankUtr] = useState<string>(refund.bankUtr || '');
  const [sellerClawback, setSellerClawback] = useState<boolean>(refund.sellerClawback ?? true);
  const [adminNotes, setAdminNotes] = useState<string>(refund.adminNotes || '');
  const [status, setStatus] = useState<string>(refund.status || 'PENDING');

  // Manual settlement sub-state
  const [showManualSettlePrompt, setShowManualSettlePrompt] = useState(false);
  const [settlementMode, setSettlementMode] = useState<'CASH_HANDOVER' | 'DIRECT_NEFT' | 'IMPS_OVERRIDE'>('CASH_HANDOVER');
  const [settleRef, setSettleRef] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (amount <= 0) {
      setErrorMessage('Refund amount must be greater than zero.');
      return;
    }

    try {
      setIsSubmitting(true);
      const res: any = await adminApi.put(`/api/admin/refunds/${refund.id}`, {
        amount,
        channel,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        reason: reason.trim(),
        bankUtr: bankUtr.trim(),
        sellerClawback,
        adminNotes: adminNotes.trim(),
        status,
      });

      if (res && res.success) {
        onSuccess(res.refund, res.message || 'Refund parameters updated.');
      } else {
        setErrorMessage(res?.message || 'Failed to update refund record.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Server communication error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualSettle = async () => {
    try {
      setIsSubmitting(true);
      const res: any = await adminApi.post(`/api/admin/refunds/${refund.id}/manual-settle`, {
        settlementMode,
        referenceNumber: settleRef.trim(),
        notes: adminNotes || `Manually settled via ${settlementMode}`,
      });

      if (res && res.success) {
        onSuccess(res.refund, res.message || 'Refund marked as completed.');
      } else {
        setErrorMessage(res?.message || 'Manual settlement failed.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Server communication error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to void and remove refund record for order ${refund.orderNumber}?`)) {
      return;
    }

    try {
      setIsSubmitting(true);
      const res: any = await adminApi.delete(`/api/admin/refunds/${refund.id}`);
      if (res && res.success) {
        if (onDelete) {
          onDelete(refund.id, res.message || 'Refund record voided.');
        } else {
          onSuccess({ ...refund, status: 'REJECTED' }, 'Refund removed.');
        }
      } else {
        setErrorMessage(res?.message || 'Failed to delete refund record.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Server error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200/80 w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-6">
        
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200/80 flex items-center justify-between bg-slate-50/50">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900 font-mono text-sm">
                Edit Refund • {refund.orderNumber}
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' :
                status === 'ON_HOLD' ? 'bg-purple-50 text-purple-700' :
                status === 'REJECTED' ? 'bg-rose-50 text-rose-700' :
                'bg-amber-50 text-amber-700'
              }`}>
                {status}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Full administrative control over disbursement values, payout rails, and audit trails
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200/80 px-5 gap-4 bg-slate-50/20 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('financials')}
            className={`py-2.5 font-medium border-b-2 transition-colors ${
              activeTab === 'financials'
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Financial Parameters
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('beneficiary')}
            className={`py-2.5 font-medium border-b-2 transition-colors ${
              activeTab === 'beneficiary'
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Beneficiary & Reason
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settlement')}
            className={`py-2.5 font-medium border-b-2 transition-colors ${
              activeTab === 'settlement'
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Gateway & Offline Settlement
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            className={`py-2.5 font-medium border-b-2 transition-colors ${
              activeTab === 'notes'
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Audit & Status
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 bg-rose-50 border border-rose-200/80 rounded-lg text-xs text-rose-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* TAB 1: FINANCIALS */}
          {activeTab === 'financials' && (
            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">
                    Refund Amount (₹)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={refund.maxRefundable || 100000}
                    value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-900 font-mono text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-slate-900"
                    required
                  />
                  <span className="text-[11px] text-slate-500 mt-1 block">
                    Order cap: ₹{refund.maxRefundable.toLocaleString('en-IN')}
                  </span>
                </div>

                <div>
                  <label className="block text-slate-700 font-medium mb-1">
                    Disbursement Channel
                  </label>
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                  >
                    <option value="UPI_INSTANT">Instant UPI VPA Direct Disburse</option>
                    <option value="SOURCE_ACCOUNT">Original Payment Method (Card / Netbanking)</option>
                    <option value="TRADE_CREDIT">Contractor Trade Credit Wallet</option>
                    <option value="BANK_NEFT_IMPS">Direct IMPS / NEFT Settlement</option>
                    <option value="OFFLINE_CASH">Offline Cash Handover</option>
                  </select>
                </div>
              </div>

              <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-medium text-slate-800 block">Merchant Clawback Active</span>
                  <p className="text-[11px] text-slate-500">
                    Recover ₹{amount.toLocaleString('en-IN')} from {refund.sellerName || 'Merchant Depot'} in next billing cycle
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={sellerClawback}
                  onChange={(e) => setSellerClawback(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
              </div>

              <div className="text-[11px] text-slate-500 flex justify-between pt-1">
                <span>Order Reference: <strong className="font-mono text-slate-800">{refund.orderNumber}</strong></span>
                <span>City: <strong className="text-slate-800">{refund.cityName || 'Bengaluru'}</strong></span>
              </div>
            </div>
          )}

          {/* TAB 2: BENEFICIARY & REASON */}
          {activeTab === 'beneficiary' && (
            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">
                    Beneficiary Customer Name
                  </label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-medium mb-1">
                    Contact Phone
                  </label>
                  <input
                    type="text"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Refund Stated Reason
                </label>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                  placeholder="Reason for refund..."
                  required
                />
              </div>
            </div>
          )}

          {/* TAB 3: SETTLEMENT & GATEWAY */}
          {activeTab === 'settlement' && (
            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Bank Reference / Gateway UTR Number
                </label>
                <input
                  type="text"
                  value={bankUtr}
                  onChange={(e) => setBankUtr(e.target.value)}
                  placeholder="e.g. UPI-2026-99210294 or Bank IMPS Ref"
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
                <span className="text-[11px] text-slate-400 mt-1 block">
                  Leave empty if awaiting automated gateway callback webhook.
                </span>
              </div>

              <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-slate-900 block">Offline / Manual Settlement Override</span>
                    <p className="text-[11px] text-slate-500">
                      Instantly complete disbursement without banking API calls (cash or pre-settled wire)
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowManualSettlePrompt(!showManualSettlePrompt)}
                    className="px-2.5 py-1 bg-slate-900 text-white rounded-md text-[11px] font-medium hover:bg-slate-800 transition-colors"
                  >
                    {showManualSettlePrompt ? 'Hide' : 'Manual Settle'}
                  </button>
                </div>

                {showManualSettlePrompt && (
                  <div className="pt-2 border-t border-slate-200/80 space-y-2 mt-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">Settlement Rail</label>
                        <select
                          value={settlementMode}
                          onChange={(e) => setSettlementMode(e.target.value as any)}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs"
                        >
                          <option value="CASH_HANDOVER">Cash Handover on Delivery</option>
                          <option value="DIRECT_NEFT">Corporate NEFT Direct Transfer</option>
                          <option value="IMPS_OVERRIDE">IMPS Reference Override</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">Receipt / Voucher Number</label>
                        <input
                          type="text"
                          value={settleRef}
                          onChange={(e) => setSettleRef(e.target.value)}
                          placeholder="e.g. RCP-CASH-991"
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs font-mono"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={handleManualSettle}
                      className="w-full py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded font-medium text-xs transition-colors flex items-center justify-center gap-1 shadow-xs"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Confirm Offline Settlement (₹{amount.toLocaleString('en-IN')})</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: AUDIT & STATUS */}
          {activeTab === 'notes' && (
            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Manual Status Override
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                >
                  <option value="PENDING">PENDING - Awaiting Finance Authorization</option>
                  <option value="APPROVED">APPROVED - Cleared for Disbursal</option>
                  <option value="COMPLETED">COMPLETED - Funds Fully Disbursed</option>
                  <option value="ON_HOLD">ON_HOLD - Under Operations Audit</option>
                  <option value="REJECTED">REJECTED - Request Declined</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  Internal Administrative & Audit Notes
                </label>
                <textarea
                  rows={3}
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  placeholder="Record verification signatures, customer call summaries, or dispute logs..."
                  className="w-full px-3 py-2 bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between">
                <div>
                  <span className="text-slate-400 text-[11px] block">Danger Zone</span>
                  <span className="text-slate-600 text-xs">Permanently void this refund entry</span>
                </div>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Void & Delete</span>
                </button>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-slate-200/80 flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded-lg text-xs font-medium transition-colors"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Saving...' : 'Save Changes'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
