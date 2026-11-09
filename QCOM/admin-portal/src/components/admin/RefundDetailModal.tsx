import React from 'react';
import {
  X,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ShieldCheck,
  Building2,
  User,
  Phone,
  Mail,
  CreditCard,
  Zap,
  ArrowDownLeft,
  ArrowUpRight,
  Printer,
  Copy,
  Check,
  History,
  FileText
} from 'lucide-react';
import { AdminRefund, AdminOrder } from '../../types/admin';

interface RefundDetailModalProps {
  refund: AdminRefund;
  order?: AdminOrder;
  onClose: () => void;
  onApprove: (refund: AdminRefund) => void;
  onReject: (refund: AdminRefund) => void;
  onHold: (refund: AdminRefund) => void;
  onRetry: (refund: AdminRefund) => void;
  onEdit?: (refund: AdminRefund) => void;
  canApprove: boolean;
}

export const RefundDetailModal: React.FC<RefundDetailModalProps> = ({
  refund,
  order,
  onClose,
  onApprove,
  onReject,
  onHold,
  onRetry,
  onEdit,
  canApprove,
}) => {
  const [copiedUtr, setCopiedUtr] = React.useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUtr(true);
    setTimeout(() => setCopiedUtr(false), 2000);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="w-3 h-3" />
            Disbursed & Completed
          </span>
        );
      case 'APPROVED':
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-sky-50 text-sky-700">
            <Clock className="w-3 h-3" />
            Approved • Processing Payout
          </span>
        );
      case 'ON_HOLD':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700">
            <AlertTriangle className="w-3 h-3" />
            On Hold • Under Investigation
          </span>
        );
      case 'REJECTED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-rose-50 text-rose-700">
            <X className="w-3 h-3" />
            Declined & Closed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700">
            <Clock className="w-3 h-3" />
            Pending Finance Authorization
          </span>
        );
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
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">Refund Record</h2>
                <span className="text-xs font-mono text-slate-500">#{refund.id}</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Marketplace Order <span className="font-medium text-slate-800 font-mono">{refund.orderNumber}</span> • {refund.cityName || 'Pan-India'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {onEdit && (
              <button
                onClick={() => onEdit(refund)}
                className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200/80 rounded-md hover:bg-slate-50 transition-colors flex items-center gap-1"
              >
                <span>Edit Parameters</span>
              </button>
            )}
            <button
              onClick={() => window.print()}
              title="Print Credit Note"
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
            >
              <Printer className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[72vh] overflow-y-auto">
          
          {/* Top Status & Amount Banner */}
          <div className="p-4 bg-slate-50/75 rounded-lg border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="text-[11px] text-slate-500 block mb-1 font-medium">Disbursement Status</span>
              {getStatusBadge(refund.status)}
              {refund.status === 'ON_HOLD' && refund.holdReason && (
                <p className="text-xs text-purple-700 mt-2 font-medium bg-purple-50/80 p-2 rounded border border-purple-200/80">
                  Hold Reason: {refund.holdReason}
                </p>
              )}
              {refund.status === 'REJECTED' && refund.rejectionReason && (
                <p className="text-xs text-rose-700 mt-2 font-medium bg-rose-50/80 p-2 rounded border border-rose-200/80">
                  Rejection Reason: {refund.rejectionReason}
                </p>
              )}
            </div>

            <div className="text-left sm:text-right sm:border-l sm:border-slate-200/80 sm:pl-5">
              <span className="text-[11px] text-slate-500 block font-medium">Refund Amount</span>
              <span className="text-xl font-bold text-rose-600 font-mono">
                ₹{refund.amount.toLocaleString('en-IN')}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">
                Max Invoice Cap: ₹{refund.maxRefundable.toLocaleString('en-IN')}
              </span>
            </div>
          </div>

          {/* Grid: Order & Customer Information */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            
            {/* Customer Details */}
            <div className="p-3.5 border border-slate-200/80 rounded-lg space-y-2">
              <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-slate-500" />
                Customer & Contractor
              </h3>
              <div className="space-y-1 text-xs">
                <p className="font-medium text-slate-900">{refund.customerName}</p>
                {refund.customerPhone && (
                  <p className="text-slate-600 flex items-center gap-1.5">
                    <Phone className="w-3 h-3 text-slate-400" />
                    {refund.customerPhone}
                  </p>
                )}
                {refund.customerEmail && (
                  <p className="text-slate-600 flex items-center gap-1.5">
                    <Mail className="w-3 h-3 text-slate-400" />
                    {refund.customerEmail}
                  </p>
                )}
                <p className="text-slate-500 text-[11px] pt-0.5">
                  Requested by: <span className="text-slate-700 font-medium">{refund.requestedBy}</span>
                </p>
              </div>
            </div>

            {/* Merchant & Channel Details */}
            <div className="p-3.5 border border-slate-200/80 rounded-lg space-y-2">
              <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-slate-500" />
                Merchant & Payout Channel
              </h3>
              <div className="space-y-1 text-xs">
                <p className="font-medium text-slate-900">{refund.sellerName || 'Authorised Partner Store'}</p>
                <p className="text-slate-600">
                  Channel: <span className="font-medium text-slate-800">{refund.channel || 'Instant UPI VPA'}</span>
                </p>
                <div className="pt-1">
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                    refund.sellerClawback ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {refund.sellerClawback ? `Seller Clawback: ₹${(refund.sellerClawbackAmount ?? refund.amount).toLocaleString('en-IN')}` : 'Platform Absorbed (No Clawback)'}
                  </span>
                </div>
              </div>
            </div>

          </div>

          {/* Refund Reason & Notes */}
          <div className="p-3.5 bg-slate-50/75 border border-slate-200/80 rounded-lg space-y-1.5">
            <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-slate-500" />
              Reason & Operational Notes
            </h3>
            <p className="text-xs text-slate-700 leading-relaxed">
              "{refund.reason}"
            </p>
            {refund.internalNotes && (
              <p className="text-[11px] text-slate-500 border-t border-slate-200/80 pt-1.5 mt-1">
                <span className="font-medium text-slate-700">Internal Audit Note:</span> {refund.internalNotes}
              </p>
            )}
          </div>

          {/* Item Breakdown (if available) */}
          {refund.items && refund.items.length > 0 && (
            <div className="border border-slate-200/80 rounded-lg overflow-hidden">
              <div className="px-3.5 py-2 bg-slate-50/75 border-b border-slate-200/80 text-xs font-semibold text-slate-900">
                Item-level Refund Breakdown
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {refund.items.map((item, idx) => (
                  <div key={idx} className="p-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-900">{item.productName}</p>
                      <p className="text-[11px] text-slate-500">
                        Qty: {item.quantity} • Unit Price: ₹{item.price.toLocaleString('en-IN')}
                        {item.reason && ` • (${item.reason})`}
                      </p>
                    </div>
                    <span className="font-bold text-rose-600 font-mono">
                      ₹{item.refundAmount.toLocaleString('en-IN')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Banking Telemetry & UTR */}
          {(refund.bankUtr || refund.transactionId) && (
            <div className="p-3 bg-emerald-50/75 border border-emerald-200/80 rounded-lg flex items-center justify-between text-xs">
              <div className="space-y-0.5">
                <span className="text-[10px] uppercase font-medium text-emerald-800 tracking-wide">
                  Bank UTR Reference / Payout ID
                </span>
                <p className="font-bold text-emerald-900 font-mono text-sm">
                  {refund.bankUtr || refund.transactionId}
                </p>
                <p className="text-[11px] text-emerald-700">
                  Settled on {refund.approvedAt || 'Today'} • Verified by {refund.approvedBy || 'System Gateway'}
                </p>
              </div>
              <button
                onClick={() => copyToClipboard(refund.bankUtr || refund.transactionId || '')}
                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-medium flex items-center gap-1 transition-colors shadow-2xs"
              >
                {copiedUtr ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedUtr ? 'Copied' : 'Copy UTR'}</span>
              </button>
            </div>
          )}

          {/* Timeline */}
          {refund.timeline && refund.timeline.length > 0 && (
            <div className="space-y-2 pt-1">
              <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-500" />
                Audit Lifecycle Trail
              </h3>
              <div className="space-y-2 border-l border-slate-200 pl-3 ml-2">
                {refund.timeline.map((step, idx) => (
                  <div key={idx} className="relative text-xs">
                    <div className="absolute -left-[17px] top-1.5 w-2 h-2 rounded-full bg-slate-400" />
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{step.stage}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{step.timestamp}</span>
                      <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                        {step.actor}
                      </span>
                    </div>
                    <p className="text-slate-600 text-[11px] mt-0.5">{step.note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Action Footer */}
        <div className="px-5 py-3.5 bg-slate-50/60 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            Created on <span className="font-medium text-slate-700">{refund.createdAt}</span>
          </div>

          <div className="flex items-center gap-1.5">
            {canApprove && refund.status === 'PENDING' && (
              <>
                <button
                  onClick={() => onReject(refund)}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-medium transition-colors"
                >
                  Reject
                </button>
                <button
                  onClick={() => onHold(refund)}
                  className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-lg text-xs font-medium transition-colors"
                >
                  Place On Hold
                </button>
                <button
                  onClick={() => onApprove(refund)}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors shadow-xs flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve & Disburse (₹{refund.amount})</span>
                </button>
              </>
            )}

            {canApprove && refund.status === 'ON_HOLD' && (
              <button
                onClick={() => onHold(refund)}
                className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-colors"
              >
                Release Hold & Resume Review
              </button>
            )}

            {canApprove && refund.status === 'COMPLETED' && (
              <button
                onClick={() => onRetry(refund)}
                className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Re-issue Gateway Payout</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 rounded-lg text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
