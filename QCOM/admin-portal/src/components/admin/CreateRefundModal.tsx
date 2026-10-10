import React, { useState } from 'react';
import {
  X,
  RotateCcw,
  Search,
  CheckCircle2,
  AlertTriangle,
  Info,
  Building2,
  User,
  Phone,
  FileText,
  CreditCard,
  Zap,
  ShieldAlert,
  Layers,
  ArrowRight
} from 'lucide-react';
import { AdminOrder, AdminRefund } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface CreateRefundModalProps {
  orders: AdminOrder[];
  onClose: () => void;
  onSuccess: (refund: AdminRefund, msg: string) => void;
}

const COMMON_REFUND_REASONS = [
  'Order cancelled prior to store dispatch',
  'Incorrect specification or diameter selected by customer',
  'Damaged packaging detected during unboxing upon delivery',
  'Partial quantity returned directly to delivery partner',
  'Duplicate payment or gateway swipe mismatch',
  'Item out of stock at merchant cluster',
  'Defective batch or manufacturer warranty replacement',
  'Delivery SLA breached / emergency material sourced elsewhere',
];

export const CreateRefundModal: React.FC<CreateRefundModalProps> = ({ orders, onClose, onSuccess }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<AdminOrder | null>(null);
  const [refundType, setRefundType] = useState<'FULL' | 'PARTIAL' | 'GOODWILL' | 'DELIVERY_FEE'>('FULL');
  const [amount, setAmount] = useState<string>('');
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [channel, setChannel] = useState<'UPI_INSTANT' | 'SOURCE_ACCOUNT' | 'TRADE_CREDIT' | 'BANK_NEFT_IMPS'>('UPI_INSTANT');
  const [sellerClawback, setSellerClawback] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [internalNotes, setInternalNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filter orders for quick lookup
  const filteredOrders = orders.filter((o) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      o.orderNumber.toLowerCase().includes(q) ||
      o.customer.name.toLowerCase().includes(q) ||
      o.customer.phone.includes(q) ||
      (o.seller?.name || '').toLowerCase().includes(q)
    );
  }).slice(0, 5);

  const handleSelectOrder = (order: AdminOrder) => {
    setSelectedOrder(order);
    const orderTotal = order.pricing?.total || 0;
    setAmount(orderTotal.toString());
    setRefundType('FULL');
    setErrorMessage(null);
  };

  const handleTypeChange = (type: 'FULL' | 'PARTIAL' | 'GOODWILL' | 'DELIVERY_FEE') => {
    setRefundType(type);
    if (!selectedOrder) return;
    const total = selectedOrder.pricing?.total || 0;
    if (type === 'FULL') {
      setAmount(total.toString());
    } else if (type === 'DELIVERY_FEE') {
      setAmount((selectedOrder.pricing?.deliveryFee || 25).toString());
    } else if (type === 'PARTIAL') {
      setAmount(Math.round(total * 0.5).toString());
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) {
      setErrorMessage('Please search and select an active marketplace order.');
      return;
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setErrorMessage('Please enter a valid refund amount greater than ₹0.');
      return;
    }

    const maxCap = selectedOrder.pricing?.total || 0;
    if (numAmount > maxCap) {
      setErrorMessage(`Amount exceeds total order invoice cap of ₹${maxCap.toLocaleString('en-IN')}.`);
      return;
    }

    const finalReason = reason === 'Other' || !reason ? customReason : reason;
    if (!finalReason.trim()) {
      setErrorMessage('Please specify a clear reason for the customer refund.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const res: any = await adminApi.post('/api/admin/refunds/create', {
        orderId: selectedOrder.id,
        amount: numAmount,
        refundType,
        channel,
        reason: finalReason,
        sellerClawback,
        internalNotes,
        autoApprove,
      });

      if (res.success && res.refund) {
        onSuccess(res.refund, res.message || 'Refund successfully created.');
      } else {
        setErrorMessage(res.message || 'Failed to create refund request.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Server error occurred while creating refund.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200/80 w-full max-w-2xl overflow-hidden my-6 animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="px-5 py-4 bg-slate-50/60 border-b border-slate-200/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-slate-100 text-slate-700 rounded-lg">
              <RotateCcw className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Initiate Customer Refund</h2>
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
            <div className="p-3 bg-rose-50 border border-rose-200/80 rounded-lg text-xs text-rose-700 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* STEP 1: Select Order */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-800">
              1. Select Marketplace Order
            </label>
            {!selectedOrder ? (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search by Order ID (e.g. QC-BLR-1029), Customer name, phone..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 transition-all font-medium"
                  />
                </div>

                <div className="max-h-44 overflow-y-auto divide-y divide-slate-100 border border-slate-200/80 rounded-lg bg-white">
                  {filteredOrders.length > 0 ? (
                    filteredOrders.map((ord) => (
                      <div
                        key={ord.id}
                        onClick={() => handleSelectOrder(ord)}
                        className="p-2.5 hover:bg-slate-50 cursor-pointer flex items-center justify-between transition-colors text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900 font-mono">{ord.orderNumber}</span>
                            <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                              {ord.cityName || 'Bengaluru'}
                            </span>
                            <span className="text-slate-500 text-[11px]">• {ord.customer.name}</span>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            Merchant: <span className="text-slate-700 font-medium">{ord.seller.name}</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold text-slate-900 font-mono">₹{ord.pricing?.total?.toLocaleString('en-IN')}</span>
                          <p className="text-[10px] text-emerald-600 font-medium">{ord.payment.status}</p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-3 text-center text-xs text-slate-400">
                      No matching orders found. Try a different search term.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg flex items-center justify-between text-xs">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 font-mono">{selectedOrder.orderNumber}</span>
                    <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[10px] font-medium">
                      {selectedOrder.status}
                    </span>
                    <span className="text-slate-600 text-[11px]">{selectedOrder.customer.name} ({selectedOrder.customer.phone})</span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Merchant: <span className="text-slate-800 font-medium">{selectedOrder.seller.name}</span> | Paid via:{' '}
                    <span className="text-slate-800 font-medium">{selectedOrder.payment.method}</span>
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Total</span>
                    <span className="font-bold text-slate-900 font-mono">
                      ₹{selectedOrder.pricing?.total?.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedOrder(null)}
                    className="text-xs text-rose-600 hover:text-rose-800 font-medium px-2 py-1 rounded hover:bg-rose-50"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* STEP 2: Refund Amount & Scope */}
          <div className="space-y-2.5">
            <label className="block text-xs font-semibold text-slate-800">
              2. Refund Amount & Type
            </label>

            <div className="grid grid-cols-4 gap-2">
              {[
                { id: 'FULL', label: '100% Full' },
                { id: 'PARTIAL', label: 'Partial' },
                { id: 'DELIVERY_FEE', label: 'Delivery Fee' },
                { id: 'GOODWILL', label: 'Goodwill' },
              ].map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => handleTypeChange(t.id as any)}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-medium text-center transition-all ${
                    refundType === t.id
                      ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200/80 hover:bg-slate-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-600 font-medium mb-1">
                  Disbursement Amount (₹)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-slate-500 font-medium text-xs">₹</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    max={selectedOrder?.pricing?.total || 100000}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter amount"
                    className="w-full pl-6 pr-3 py-1.5 bg-white border border-slate-200/80 rounded-lg text-xs font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
                  />
                </div>
                {selectedOrder && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    Order cap: ₹{selectedOrder.pricing?.total?.toLocaleString('en-IN')}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">
                  Disbursement Channel
                </label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as any)}
                  className="w-full px-3 py-1.5 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
                >
                  <option value="UPI_INSTANT">Instant UPI VPA (SLA: 3 mins)</option>
                  <option value="SOURCE_ACCOUNT">Original Payment Method (Card Reversal)</option>
                  <option value="TRADE_CREDIT">Contractor Trade Credit Ledger</option>
                  <option value="BANK_NEFT_IMPS">Direct Bank Account (NEFT / IMPS)</option>
                </select>
              </div>
            </div>
          </div>

          {/* STEP 3: Refund Reason */}
          <div className="space-y-2 text-xs">
            <label className="block text-xs font-semibold text-slate-800">
              3. Reason for Refund
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-1.5 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
            >
              <option value="">-- Select standard compliance reason --</option>
              {COMMON_REFUND_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
              <option value="Other">Other / Custom Remarks</option>
            </select>

            {(reason === 'Other' || reason === '') && (
              <textarea
                rows={2}
                placeholder="Enter detailed refund reason for compliance and audit trail..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                className="w-full p-2 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            )}
          </div>

          {/* STEP 4: Financial Controls & Clawback */}
          <div className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-slate-800 block">Merchant Settlement Clawback</span>
                <p className="text-[11px] text-slate-500">
                  Deduct ₹{amount || '0'} from seller's next payout batch
                </p>
              </div>
              <input
                type="checkbox"
                checked={sellerClawback}
                onChange={(e) => setSellerClawback(e.target.checked)}
                className="h-4 w-4 rounded text-slate-900 focus:ring-slate-900 border-slate-300"
              />
            </div>

            <div className="flex items-center justify-between border-t border-slate-200/80 pt-2">
              <div>
                <span className="font-medium text-slate-800 block">Instant Auto-Approve & Disburse</span>
                <p className="text-[11px] text-slate-500">
                  Bypass pending queue if amount is ≤ ₹500 standard limit
                </p>
              </div>
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                className="h-4 w-4 rounded text-slate-900 focus:ring-slate-900 border-slate-300"
              />
            </div>
          </div>

          {/* Internal Notes */}
          <div className="text-xs">
            <label className="block text-slate-600 font-medium mb-1">
              Internal Audit Notes (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. Approved per ticket #SUP-8821 with warehouse confirmation"
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              className="w-full px-3 py-1.5 bg-white border border-slate-200/80 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-900"
            />
          </div>

          {/* Actions */}
          <div className="pt-3 border-t border-slate-200/80 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded-lg text-xs font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !selectedOrder}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-all shadow-xs flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <span>Submitting...</span>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Submit Refund Request (₹{amount || '0'})</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
