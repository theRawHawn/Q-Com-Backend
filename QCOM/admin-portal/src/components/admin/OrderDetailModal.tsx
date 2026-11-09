import React, { useState } from 'react';
import {
  X,
  Clock,
  MapPin,
  Store,
  Bike,
  User,
  ShieldCheck,
  CreditCard,
  AlertTriangle,
  Send,
  RotateCcw,
  CheckCircle2,
  Phone,
  FileText,
  Key,
  PauseCircle,
  PlayCircle,
  Tag,
  MessageSquare,
  Edit3,
  Flame,
  AlertCircle,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Plus,
  Eye,
  EyeOff,
  Package
} from 'lucide-react';
import { AdminOrder, AdminRider, AdminOrderItem } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface OrderDetailModalProps {
  order: AdminOrder;
  onClose: () => void;
  onRefresh: () => void;
  availableRiders: AdminRider[];
  canEditStatus: boolean;
  canCancel: boolean;
  canAssignRider: boolean;
}

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  order,
  onClose,
  onRefresh,
  availableRiders,
  canEditStatus,
  canCancel,
  canAssignRider,
}) => {
  const [selectedRiderId, setSelectedRiderId] = useState('');
  const [newStatus, setNewStatus] = useState<string>(order.status);
  const [statusNote, setStatusNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelPrompt, setShowCancelPrompt] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Tabbed view within the order
  const [activeTab, setActiveTab] = useState<'overview' | 'items' | 'dispatch' | 'notes' | 'actions'>('overview');

  // Address edit state
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [addressForm, setAddressForm] = useState({
    address: order.deliveryLocation?.address || '',
    landmark: order.deliveryLocation?.landmark || '',
    gateCode: order.deliveryLocation?.gateCode || '',
    contactPhone: order.deliveryLocation?.contactPhone || order.customer?.phone || '',
    areaName: order.deliveryLocation?.areaName || '',
  });

  // Hold state
  const [holdReasonInput, setHoldReasonInput] = useState('');
  const [showHoldPrompt, setShowHoldPrompt] = useState(false);

  // New Note state
  const [newNoteText, setNewNoteText] = useState('');

  // Item substitution state
  const [substitutingIndex, setSubstitutingIndex] = useState<number | null>(null);
  const [substituteForm, setSubstituteForm] = useState({
    name: '',
    price: 0,
    note: '',
  });

  const [showPlainOtp, setShowPlainOtp] = useState(false);
  const [copiedOtp, setCopiedOtp] = useState(false);

  const handleCopyOtp = () => {
    navigator.clipboard.writeText(order.deliveryOtp);
    setCopiedOtp(true);
    setTimeout(() => setCopiedOtp(false), 2000);
  };

  const handleAssignRider = async () => {
    if (!selectedRiderId) return;
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/assign-rider`, { riderId: selectedRiderId });
      setActionSuccess('Rider assigned successfully! Order marked out for delivery.');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to assign rider');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusChange = async () => {
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/update-status`, { status: newStatus, note: statusNote });
      setActionSuccess(`Order status transitioned to ${newStatus}`);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update order status');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!cancelReason) {
      setActionError('Please provide a mandatory cancellation reason for the audit trail.');
      return;
    }
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/cancel`, { reason: cancelReason });
      setActionSuccess('Order cancelled, stock restored, and refund initiated.');
      setShowCancelPrompt(false);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to cancel order');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveAddress = async () => {
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.put(`/api/admin/orders/${order.id}/delivery-address`, addressForm);
      setActionSuccess('Delivery destination and gate instructions updated successfully.');
      setIsEditingAddress(false);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update delivery address');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleHold = async (shouldHold: boolean) => {
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/toggle-hold`, {
        hold: shouldHold,
        reason: shouldHold ? holdReasonInput : undefined,
      });
      setActionSuccess(shouldHold ? 'Order placed on operational hold.' : 'Hold released successfully.');
      setShowHoldPrompt(false);
      setHoldReasonInput('');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update hold status');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetPriority = async (p: 'NORMAL' | 'HIGH' | 'CRITICAL_SITE') => {
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/priority`, { priority: p });
      setActionSuccess(`Urgency level set to ${p}`);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update priority');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNoteText.trim()) return;
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/notes`, { text: newNoteText.trim() });
      setActionSuccess('Internal audit note logged successfully.');
      setNewNoteText('');
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to add note');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleItemAction = async (idx: number, action: 'OUT_OF_STOCK' | 'SUBSTITUTE' | 'RESTORE') => {
    try {
      setIsSubmitting(true);
      setActionError('');
      await adminApi.post(`/api/admin/orders/${order.id}/items/${idx}/action`, {
        action,
        substituteName: action === 'SUBSTITUTE' ? substituteForm.name : undefined,
        substitutePrice: action === 'SUBSTITUTE' ? substituteForm.price : undefined,
        note: action === 'SUBSTITUTE' ? substituteForm.note : undefined,
      });
      setActionSuccess(`Item action [${action}] applied and order total recalculated.`);
      setSubstitutingIndex(null);
      setSubstituteForm({ name: '', price: 0, note: '' });
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to process item action');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegenerateOtp = async () => {
    try {
      setIsSubmitting(true);
      setActionError('');
      const res: any = await adminApi.post(`/api/admin/orders/${order.id}/regenerate-otp`, {});
      setActionSuccess(`New Delivery OTP generated and broadcasted to Customer app & SMS. Rider terminal updated to accept only the new OTP.`);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Failed to regenerate OTP');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200/90 rounded-xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-[0_20px_50px_rgba(0,0,0,0.12)] overflow-hidden animate-in fade-in zoom-in-95">
        
        {/* Modal Top Header Bar */}
        <div className="px-5 py-4 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3 bg-white sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-xs font-mono tracking-tight shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
              QC
            </div>
            <div>
              <div className="flex items-center flex-wrap gap-2">
                <h2 className="text-base font-bold text-slate-900 font-mono tracking-tight">
                  {order.orderNumber}
                </h2>
                
                {/* Hold Status Flag */}
                {order.isHold && (
                  <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 text-[10px] font-semibold px-2 py-0.5 rounded-md border border-amber-200/80 uppercase">
                    <PauseCircle className="h-3 w-3 text-amber-600" />
                    ON HOLD
                  </span>
                )}

                {/* Priority Flag */}
                {order.priority === 'CRITICAL_SITE' && (
                  <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-800 text-[10px] font-semibold px-2 py-0.5 rounded-md border border-rose-200/80 uppercase">
                    <Flame className="h-3 w-3 text-rose-600" />
                    CRITICAL SITE
                  </span>
                )}
                {order.priority === 'HIGH' && (
                  <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 text-[10px] font-semibold px-2 py-0.5 rounded-md border border-amber-200/80 uppercase">
                    HIGH PRIORITY
                  </span>
                )}

                <span className="bg-slate-100 text-slate-700 text-[10px] font-mono px-2 py-0.5 rounded-md uppercase border border-slate-200/80 font-semibold">
                  {order.status.replace(/_/g, ' ')}
                </span>
                
                {/* Secure OTP Status & Masked Token */}
                <div className="inline-flex items-center gap-1.5 bg-slate-50 text-slate-700 text-[10px] font-mono px-2 py-0.5 rounded-md border border-slate-200/80">
                  <Key className="h-2.5 w-2.5 text-slate-400" />
                  <span>OTP: {showPlainOtp ? order.deliveryOtp : '••••'}</span>
                  <button
                    onClick={() => setShowPlainOtp(!showPlainOtp)}
                    title={showPlainOtp ? "Hide OTP" : "Reveal OTP (Admin Support Override)"}
                    className="text-slate-400 hover:text-slate-700 ml-0.5 transition-colors cursor-pointer"
                  >
                    {showPlainOtp ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                  </button>
                  {showPlainOtp && (
                    <button
                      onClick={handleCopyOtp}
                      title="Copy OTP to clipboard"
                      className="text-emerald-700 hover:text-emerald-800 ml-0.5 transition-colors cursor-pointer"
                    >
                      {copiedOtp ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                    </button>
                  )}
                </div>
              </div>

              <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                <span>Placed at {order.placedAt}</span>
                <span>•</span>
                <span>Est. Arrival: {order.estimatedDeliveryAt}</span>
                {order.cityName && (
                  <>
                    <span>•</span>
                    <span className="font-medium text-slate-700">{order.cityName}</span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Action / Alert Banners */}
        {actionError && (
          <div className="mx-4 sm:mx-6 mt-3 p-3 bg-rose-50 border border-rose-200/80 text-rose-900 rounded-lg flex items-center justify-between text-xs font-medium">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-rose-600" />
              <span>{actionError}</span>
            </div>
            <button onClick={() => setActionError('')} className="text-rose-500 hover:text-rose-800 cursor-pointer">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {actionSuccess && (
          <div className="mx-4 sm:mx-6 mt-3 p-3 bg-emerald-50 border border-emerald-200/80 text-emerald-900 rounded-lg flex items-center justify-between text-xs font-medium">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />
              <span>{actionSuccess}</span>
            </div>
            <button onClick={() => setActionSuccess('')} className="text-emerald-500 hover:text-emerald-800 cursor-pointer">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Hold Alert Banner if Active */}
        {order.isHold && (
          <div className="mx-4 sm:mx-6 mt-3 p-3 bg-amber-50 border border-amber-200/80 rounded-lg flex items-center justify-between text-xs text-amber-900">
            <div className="flex items-center gap-2 font-medium">
              <PauseCircle className="h-4 w-4 text-amber-600 shrink-0" />
              <span>
                <strong>Order fulfillment is paused.</strong> Reason: {order.holdReason || 'Operational hold'}
              </span>
            </div>
            <button
              onClick={() => handleToggleHold(false)}
              disabled={isSubmitting}
              className="bg-amber-700 hover:bg-amber-800 text-white font-medium px-2.5 py-1 rounded-md text-xs inline-flex items-center gap-1 transition-colors cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              <span>Release Hold</span>
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="px-5 pt-2 border-b border-slate-200/80 bg-slate-50/60 flex items-center gap-3 overflow-x-auto text-xs">
          <button
            onClick={() => setActiveTab('overview')}
            className={`pb-2.5 pt-1.5 font-medium border-b-2 transition-all whitespace-nowrap cursor-pointer ${
              activeTab === 'overview'
                ? 'border-slate-900 text-slate-950 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Overview & Delivery Info
          </button>
          <button
            onClick={() => setActiveTab('items')}
            className={`pb-2.5 pt-1.5 font-medium border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'items'
                ? 'border-slate-900 text-slate-950 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <span>Items & Substitutions</span>
            <span className="bg-slate-200/80 text-slate-700 rounded-full px-1.5 py-0.2 text-[10px] font-semibold">
              {order.items.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('dispatch')}
            className={`pb-2.5 pt-1.5 font-medium border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'dispatch'
                ? 'border-slate-900 text-slate-950 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <span>Dispatch & Stepper</span>
            {order.rider ? (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('notes')}
            className={`pb-2.5 pt-1.5 font-medium border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'notes'
                ? 'border-slate-900 text-slate-950 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <span>Internal Notes</span>
            <span className="bg-slate-200 text-slate-700 rounded-full px-1.5 py-0.2 text-[10px]">
              {order.notes?.length || 0}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('actions')}
            className={`px-3 py-2 font-semibold border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'actions'
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            <span>Admin Interventions</span>
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-6 text-xs text-slate-700 flex-1">
          
          {/* TAB 1: OVERVIEW & DESTINATION */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              {/* Quick Action Bar for Urgency & Hold */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-700">Urgency Level:</span>
                  <div className="flex items-center gap-1">
                    {(['NORMAL', 'HIGH', 'CRITICAL_SITE'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() => handleSetPriority(lvl)}
                        disabled={isSubmitting}
                        className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                          (order.priority || 'NORMAL') === lvl
                            ? lvl === 'CRITICAL_SITE'
                              ? 'bg-rose-600 text-white'
                              : lvl === 'HIGH'
                              ? 'bg-amber-600 text-white'
                              : 'bg-slate-800 text-white'
                            : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {lvl.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {!order.isHold ? (
                    !showHoldPrompt ? (
                      <button
                        onClick={() => setShowHoldPrompt(true)}
                        className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2.5 py-1 rounded text-[11px] font-semibold inline-flex items-center gap-1 transition-colors"
                      >
                        <PauseCircle className="h-3 w-3 text-amber-600" />
                        <span>Place On Hold</span>
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          placeholder="Hold reason..."
                          value={holdReasonInput}
                          onChange={(e) => setHoldReasonInput(e.target.value)}
                          className="bg-white border border-slate-300 rounded px-2 py-1 text-[11px] text-slate-800 w-44 focus:outline-none"
                        />
                        <button
                          onClick={() => handleToggleHold(true)}
                          disabled={isSubmitting || !holdReasonInput.trim()}
                          className="bg-amber-600 text-white font-bold px-2 py-1 rounded text-[11px]"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setShowHoldPrompt(false)}
                          className="text-slate-500 hover:text-slate-800 px-1 text-[11px]"
                        >
                          Cancel
                        </button>
                      </div>
                    )
                  ) : (
                    <button
                      onClick={() => handleToggleHold(false)}
                      disabled={isSubmitting}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 rounded text-[11px] font-semibold inline-flex items-center gap-1 transition-colors"
                    >
                      <PlayCircle className="h-3 w-3" />
                      <span>Resume Fulfillment</span>
                    </button>
                  )}

                  <button
                    onClick={handleRegenerateOtp}
                    disabled={isSubmitting}
                    className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-2.5 py-1 rounded text-[11px] font-semibold inline-flex items-center gap-1 transition-colors"
                    title="Generate fresh OTP, push in real-time to Customer App & SMS, and update Rider app validation"
                  >
                    <RefreshCw className={`h-3 w-3 ${isSubmitting ? 'animate-spin' : 'text-slate-500'}`} />
                    <span>Re-issue OTP</span>
                  </button>
                </div>
              </div>

              {/* Grid: Customer & Destination vs Store & Rider */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Customer & Destination Card */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-slate-900 flex items-center gap-2">
                      <User className="h-4 w-4 text-sky-600" />
                      Customer & Delivery Destination
                    </h4>
                    {!isEditingAddress ? (
                      <button
                        onClick={() => setIsEditingAddress(true)}
                        className="text-slate-600 hover:text-slate-900 text-[11px] font-semibold inline-flex items-center gap-1 bg-slate-100 hover:bg-slate-200 px-2 py-0.5 rounded transition-colors"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit Destination</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => setIsEditingAddress(false)}
                        className="text-slate-500 hover:text-slate-800 text-[11px]"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {!isEditingAddress ? (
                    <div className="space-y-1.5 font-sans">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Name:</span>
                        <span className="font-semibold text-slate-900">{order.customer.name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Phone:</span>
                        <span className="font-mono text-slate-700">{order.customer.phone}</span>
                      </div>
                      {order.customer.businessName && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Business Name:</span>
                          <span className="font-semibold text-sky-700">{order.customer.businessName}</span>
                        </div>
                      )}
                      {order.customer.gstin && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">GSTIN:</span>
                          <span className="font-mono text-slate-700">{order.customer.gstin}</span>
                        </div>
                      )}
                      <div className="pt-2 border-t border-slate-100">
                        <span className="text-slate-500 block mb-0.5">Delivery Address:</span>
                        <p className="text-slate-800 font-medium leading-relaxed">{order.deliveryLocation?.address}</p>
                        {order.deliveryLocation?.landmark && (
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            <strong>Landmark:</strong> {order.deliveryLocation.landmark}
                          </p>
                        )}
                        {order.deliveryLocation?.gateCode && (
                          <span className="inline-block mt-1 bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5 rounded font-mono text-[10px] font-semibold">
                            Gate Pass: {order.deliveryLocation.gateCode}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2 pt-1">
                      <div>
                        <label className="text-[10px] font-bold text-slate-600 uppercase">Site / Flat / Street Address</label>
                        <textarea
                          rows={2}
                          value={addressForm.address}
                          onChange={(e) => setAddressForm({ ...addressForm, address: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-600 uppercase">Area / Sector</label>
                          <input
                            type="text"
                            value={addressForm.areaName}
                            onChange={(e) => setAddressForm({ ...addressForm, areaName: e.target.value })}
                            className="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:bg-white"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-600 uppercase">Gate Pass / Access Code</label>
                          <input
                            type="text"
                            value={addressForm.gateCode}
                            onChange={(e) => setAddressForm({ ...addressForm, gateCode: e.target.value })}
                            className="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:bg-white"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-600 uppercase">Landmark</label>
                        <input
                          type="text"
                          value={addressForm.landmark}
                          onChange={(e) => setAddressForm({ ...addressForm, landmark: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:bg-white"
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          onClick={() => setIsEditingAddress(false)}
                          className="px-2.5 py-1 bg-white border border-slate-300 rounded text-xs font-medium text-slate-700"
                        >
                          Abort
                        </button>
                        <button
                          onClick={handleSaveAddress}
                          disabled={isSubmitting}
                          className="px-3 py-1 bg-slate-900 text-white rounded text-xs font-bold hover:bg-slate-800"
                        >
                          Save Address
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Fulfillment Partner & Rider */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2">
                    <Store className="h-4 w-4 text-amber-600" />
                    Fulfillment Partner & Rider
                  </h4>
                  <div className="space-y-1.5 font-sans">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Store Hub:</span>
                      <span className="font-semibold text-slate-900">{order.seller.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Hub Type:</span>
                      <span className="text-slate-700">{order.seller.hubType}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Store Contact:</span>
                      <span className="font-mono text-slate-700">{order.seller.phone}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Seller GSTIN:</span>
                      <span className="font-mono text-slate-700">{order.seller.gstin}</span>
                    </div>

                    <div className="pt-2 border-t border-slate-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-slate-500">Assigned Delivery Fleet:</span>
                        {order.rider && (
                          <span className="text-[11px] font-mono text-emerald-700 font-semibold">
                            {order.rider.currentSpeedKmH || 24} km/h • {order.rider.distanceMeters || 400}m away
                          </span>
                        )}
                      </div>
                      {order.rider ? (
                        <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 flex items-center justify-between">
                          <div>
                            <div className="font-bold text-slate-900 flex items-center gap-1.5">
                              <Bike className="h-3.5 w-3.5 text-emerald-600" />
                              <span>{order.rider.name}</span>
                            </div>
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              {order.rider.vehicle} • {order.rider.phone}
                            </p>
                          </div>
                          <span className="text-emerald-700 font-mono font-bold text-[11px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200/60">
                            ★ {order.rider.rating}
                          </span>
                        </div>
                      ) : (
                        <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs font-semibold flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                            No Rider Assigned Yet
                          </span>
                          <button
                            onClick={() => setActiveTab('dispatch')}
                            className="text-[10px] uppercase font-bold bg-amber-600 text-white px-2 py-1 rounded"
                          >
                            Assign Now
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Order Line Items & Quantities Table for Rapid Support */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                <div className="p-3 bg-slate-50 font-bold text-slate-900 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-sky-600" />
                    <span>Order Items & Quantities ({order.items.length})</span>
                  </div>
                  <button
                    onClick={() => setActiveTab('items')}
                    className="text-[11px] font-semibold text-sky-600 hover:text-sky-800 transition-colors"
                  >
                    Manage Substitutions & Out of Stock →
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs min-w-[550px]">
                    <thead className="bg-slate-50/75 text-slate-500 text-[10px] uppercase font-mono border-b border-slate-200">
                      <tr>
                        <th className="p-3">Product Description</th>
                        <th className="p-3 text-center">Status</th>
                        <th className="p-3 text-right">Unit Price</th>
                        <th className="p-3 text-right">Qty</th>
                        <th className="p-3 text-right pr-4">Total Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {order.items.map((item, idx) => {
                        const isOutOfStock = item.itemStatus === 'OUT_OF_STOCK';
                        const isSubstituted = item.itemStatus === 'SUBSTITUTED';
                        return (
                          <tr key={idx} className={`hover:bg-slate-50/70 transition-colors ${isOutOfStock ? 'bg-rose-50/30' : ''}`}>
                            <td className="p-3">
                              <div className={`font-semibold ${isOutOfStock ? 'line-through text-slate-400' : 'text-slate-900'}`}>
                                {item.productName}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {item.brand} • HSN: {item.hsnCode || '8536'}
                              </div>
                              {isSubstituted && item.originalProductName && (
                                <div className="text-[10px] text-purple-600 mt-0.5 font-medium">
                                  ↳ Substituted from: {item.originalProductName}
                                </div>
                              )}
                              {item.substitutionNote && (
                                <div className="text-[10px] text-slate-500 italic mt-0.5">
                                  Note: {item.substitutionNote}
                                </div>
                              )}
                            </td>
                            <td className="p-3 text-center whitespace-nowrap">
                              {isOutOfStock ? (
                                <span className="bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold px-2 py-0.5 rounded">
                                  OUT OF STOCK
                                </span>
                              ) : isSubstituted ? (
                                <span className="bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold px-2 py-0.5 rounded">
                                  SUBSTITUTED
                                </span>
                              ) : (
                                <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium px-2 py-0.5 rounded">
                                  FULFILLED
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-right font-mono text-slate-700">
                              ₹{item.price.toLocaleString('en-IN')}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-slate-900">
                              {item.quantity} {item.unit}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-slate-900 pr-4">
                              {isOutOfStock ? (
                                <span className="line-through text-slate-400">₹{(item.price * item.quantity).toLocaleString('en-IN')}</span>
                              ) : (
                                <span>₹{(item.price * item.quantity).toLocaleString('en-IN')}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Payment & Invoice Breakdown */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-emerald-600" />
                    <span className="font-bold text-slate-900">Payment Breakdown</span>
                    <span className="bg-emerald-100 text-emerald-800 text-[10px] font-mono px-2 py-0.5 rounded font-bold">
                      {order.payment.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600">
                    Paid via <span className="font-semibold text-slate-900">{order.payment.method}</span> • Txn Ref:{' '}
                    <span className="font-mono text-slate-700">{order.payment.transactionId || 'TXN-DIRECT'}</span>
                  </div>
                </div>
                <div className="text-right font-mono space-y-0.5 text-xs">
                  <div className="text-slate-500">Subtotal: ₹{order.pricing.subtotal.toLocaleString('en-IN')}</div>
                  <div className="text-slate-500">18% GST: ₹{order.pricing.tax.toLocaleString('en-IN')}</div>
                  {order.pricing.deliveryFee > 0 && (
                    <div className="text-slate-500">Delivery Fee: ₹{order.pricing.deliveryFee.toLocaleString('en-IN')}</div>
                  )}
                  {order.pricing.discount > 0 && (
                    <div className="text-emerald-700">Discount: -₹{order.pricing.discount.toLocaleString('en-IN')}</div>
                  )}
                  <div className="text-sm font-bold font-mono text-slate-900 pt-1 border-t border-slate-300">
                    Net Total: ₹{order.pricing.total.toLocaleString('en-IN')}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: LINE ITEMS & SUBSTITUTION CONTROLS */}
          {activeTab === 'items' && (
            <div className="space-y-4">
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                <div className="p-3 bg-slate-50 font-bold text-slate-900 border-b border-slate-200 flex items-center justify-between">
                  <span>Order Line Items ({order.items.length})</span>
                  <span className="text-[11px] font-normal text-slate-500">
                    Store fulfillment actions: Out of stock reporting, unit replacement, & audit adjustments
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs min-w-[650px]">
                    <thead className="bg-slate-50/75 text-slate-500 text-[10px] uppercase font-mono border-b border-slate-200">
                      <tr>
                        <th className="p-3">Item Details</th>
                        <th className="p-3">Status</th>
                        <th className="p-3 text-right">Unit Price</th>
                        <th className="p-3 text-right">Qty</th>
                        <th className="p-3 text-right">Subtotal</th>
                        <th className="p-3 text-right pr-4">Fulfillment Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {order.items.map((it, idx) => {
                        const isOutOfStock = it.itemStatus === 'OUT_OF_STOCK';
                        const isSubstituted = it.itemStatus === 'SUBSTITUTED';
                        return (
                          <tr key={idx} className={`hover:bg-slate-50/70 transition-colors ${isOutOfStock ? 'bg-rose-50/30' : ''}`}>
                            <td className="p-3">
                              <div className={`font-medium ${isOutOfStock ? 'line-through text-slate-400' : 'text-slate-900'}`}>
                                {it.productName}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {it.brand} • HSN: {it.hsnCode || '8536'}
                              </div>
                              {isSubstituted && it.originalProductName && (
                                <div className="text-[10px] text-indigo-600 mt-0.5 font-medium">
                                  ↳ Replaced original: {it.originalProductName}
                                </div>
                              )}
                              {it.substitutionNote && (
                                <div className="text-[10px] text-slate-500 italic mt-0.5">
                                  Note: {it.substitutionNote}
                                </div>
                              )}
                            </td>

                            <td className="p-3 whitespace-nowrap">
                              {isOutOfStock ? (
                                <span className="bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold px-2 py-0.5 rounded">
                                  OUT OF STOCK
                                </span>
                              ) : isSubstituted ? (
                                <span className="bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold px-2 py-0.5 rounded">
                                  SUBSTITUTED
                                </span>
                              ) : (
                                <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium px-2 py-0.5 rounded">
                                  FULFILLED
                                </span>
                              )}
                            </td>

                            <td className="p-3 text-right font-mono">
                              ₹{it.price}
                            </td>

                            <td className="p-3 text-right font-mono font-bold text-slate-900">
                              {it.quantity} {it.unit}
                            </td>

                            <td className="p-3 text-right font-mono font-bold">
                              {isOutOfStock ? (
                                <span className="line-through text-slate-400">₹{it.price * it.quantity}</span>
                              ) : (
                                <span className="text-emerald-700">₹{it.price * it.quantity}</span>
                              )}
                            </td>

                            <td className="p-3 text-right whitespace-nowrap pr-4">
                              {!isOutOfStock && !isSubstituted ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => {
                                      setSubstitutingIndex(idx);
                                      setSubstituteForm({
                                        name: `${it.productName} (Alt Grade)`,
                                        price: it.price,
                                        note: 'Brand substitute agreed with contractor',
                                      });
                                    }}
                                    className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded text-[11px] font-medium transition-colors"
                                  >
                                    Substitute
                                  </button>
                                  <button
                                    onClick={() => handleItemAction(idx, 'OUT_OF_STOCK')}
                                    disabled={isSubmitting}
                                    className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-2 py-1 rounded text-[11px] font-medium transition-colors"
                                  >
                                    OOS
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => handleItemAction(idx, 'RESTORE')}
                                  disabled={isSubmitting}
                                  className="text-sky-600 hover:text-sky-800 font-semibold text-[11px] underline"
                                >
                                  Restore Original
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Substitute Modal Inline Drawer */}
                {substitutingIndex !== null && (
                  <div className="p-4 bg-purple-50/50 border-t border-purple-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-purple-900 text-xs">
                        Substitute Item #{substitutingIndex + 1}: {order.items[substitutingIndex]?.productName}
                      </span>
                      <button
                        onClick={() => setSubstitutingIndex(null)}
                        className="text-purple-600 hover:text-purple-900 text-xs"
                      >
                        Cancel
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="sm:col-span-2">
                        <label className="text-[10px] font-bold text-purple-800 uppercase">Replacement Item Name</label>
                        <input
                          type="text"
                          value={substituteForm.name}
                          onChange={(e) => setSubstituteForm({ ...substituteForm, name: e.target.value })}
                          className="w-full bg-white border border-purple-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-purple-800 uppercase">Unit Price (₹)</label>
                        <input
                          type="number"
                          value={substituteForm.price}
                          onChange={(e) => setSubstituteForm({ ...substituteForm, price: Number(e.target.value) })}
                          className="w-full bg-white border border-purple-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-purple-800 uppercase">Substitution Audit Note</label>
                      <input
                        type="text"
                        value={substituteForm.note}
                        onChange={(e) => setSubstituteForm({ ...substituteForm, note: e.target.value })}
                        className="w-full bg-white border border-purple-300 rounded p-1.5 text-xs text-slate-900 mt-0.5 focus:outline-none"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setSubstitutingIndex(null)}
                        className="px-3 py-1 bg-white border border-purple-200 text-purple-800 rounded text-xs font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleItemAction(substitutingIndex, 'SUBSTITUTE')}
                        disabled={isSubmitting || !substituteForm.name.trim()}
                        className="px-3 py-1 bg-purple-700 hover:bg-purple-800 text-white rounded text-xs font-bold transition-all shadow-xs"
                      >
                        Confirm Replacement
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: DISPATCH & LIVE FULFILLMENT STEPPER */}
          {activeTab === 'dispatch' && (
            <div className="space-y-4">
              {/* Assign / Change Rider Box */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
                <h4 className="font-bold text-slate-900 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Bike className="h-4 w-4 text-emerald-600" />
                    Rider Dispatch & Assignment
                  </span>
                  <span className="text-[11px] font-normal text-slate-500">
                    {availableRiders.length} active riders available in zone
                  </span>
                </h4>

                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={selectedRiderId}
                    onChange={(e) => setSelectedRiderId(e.target.value)}
                    disabled={!canAssignRider || isSubmitting}
                    className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Choose rider to dispatch...</option>
                    {availableRiders.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.vehicleType.replace('_', ' ')}) — Rating: {r.rating} ★ — {r.todayDeliveries} completed today
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleAssignRider}
                    disabled={!canAssignRider || !selectedRiderId || isSubmitting}
                    className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-4 py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-all shadow-xs"
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span>Dispatch Rider</span>
                  </button>
                </div>
              </div>

              {/* Live Timeline Stepper */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-emerald-600" />
                  Live Order Fulfillment Timeline ({order.timeline.length} events logged)
                </h3>
                <div className="space-y-3.5">
                  {order.timeline.map((step, idx) => (
                    <div key={idx} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div
                          className={`h-4 w-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            step.completed ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          {step.completed ? '✓' : idx + 1}
                        </div>
                        {idx < order.timeline.length - 1 && (
                          <div className={`w-0.5 h-7 ${step.completed ? 'bg-emerald-500' : 'bg-slate-200'}`}></div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={`font-semibold ${step.completed ? 'text-slate-900' : 'text-slate-500'}`}>
                            {step.stage}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400">{step.timestamp}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{step.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: INTERNAL AUDIT NOTES */}
          {activeTab === 'notes' && (
            <div className="space-y-4">
              {/* Add Note Form */}
              <form onSubmit={handleAddNote} className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
                <label className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-slate-600" />
                  Log Internal Administrative Note
                </label>
                <textarea
                  rows={2}
                  value={newNoteText}
                  onChange={(e) => setNewNoteText(e.target.value)}
                  placeholder="e.g. Contractor called regarding gate code entry, confirmed pipe substitute with site supervisor..."
                  className="w-full bg-white border border-slate-300 rounded-lg p-2 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isSubmitting || !newNoteText.trim()}
                    className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-medium px-3.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Append Note</span>
                  </button>
                </div>
              </form>

              {/* Notes Stream */}
              <div className="space-y-2.5">
                {order.notes && order.notes.length > 0 ? (
                  order.notes.map((n) => (
                    <div key={n.id} className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-bold text-slate-900">{n.author} ({n.role})</span>
                        <span className="text-slate-400 font-mono text-[10px]">{n.createdAt}</span>
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed">{n.text}</p>
                    </div>
                  ))
                ) : (
                  <div className="p-6 text-center text-slate-400 bg-slate-50 border border-slate-200 rounded-xl">
                    No internal notes logged yet for this order.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: ADVANCED ADMINISTRATIVE INTERVENTIONS */}
          {activeTab === 'actions' && (
            <div className="space-y-4">
              {/* Force Finite State Machine Transition */}
              <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-2xs">
                <h4 className="font-bold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-sky-600" />
                  Manual Lifecycle State Override
                </h4>
                <p className="text-[11px] text-slate-500">
                  Override the automatic fulfillment finite state machine. Transitions are recorded in the security audit logs.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value)}
                    disabled={!canEditStatus || isSubmitting}
                    className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-sky-500 uppercase font-mono"
                  >
                    <option value="placed">placed</option>
                    <option value="picking">picking</option>
                    <option value="packed">packed</option>
                    <option value="out_for_delivery">out_for_delivery</option>
                    <option value="arriving">arriving</option>
                    <option value="delivered">delivered</option>
                  </select>
                  <button
                    onClick={handleStatusChange}
                    disabled={!canEditStatus || isSubmitting || newStatus === order.status}
                    className="bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white font-bold px-4 py-2 rounded-lg text-xs transition-all shadow-xs"
                  >
                    Commit State Transition
                  </button>
                </div>
              </div>

              {/* Emergency Cancellation & Instant Refund */}
              {canCancel && order.status !== 'cancelled' && order.status !== 'delivered' && (
                <div className="p-4 bg-rose-50/50 border border-rose-200 rounded-xl space-y-3">
                  <h4 className="font-bold text-rose-900 flex items-center gap-2">
                    <RotateCcw className="h-4 w-4 text-rose-600" />
                    Emergency Order Cancellation & Stock Rollback
                  </h4>
                  <p className="text-[11px] text-rose-700">
                    Cancelling restores allocated partner store inventory immediately and automatically initiates a refund voucher for paid prepaid orders.
                  </p>
                  {!showCancelPrompt ? (
                    <button
                      onClick={() => setShowCancelPrompt(true)}
                      className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors shadow-xs"
                    >
                      <AlertCircle className="h-3.5 w-3.5" />
                      <span>Initiate Cancellation Process</span>
                    </button>
                  ) : (
                    <div className="space-y-2 bg-white p-3 border border-rose-200 rounded-lg">
                      <label className="text-[10px] font-bold text-rose-900 uppercase">
                        Mandatory Cancellation Reason (Audit Log Requirement)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Contractor requested cancellation, delivery pipe specs altered..."
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-rose-500"
                      />
                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          onClick={() => setShowCancelPrompt(false)}
                          className="px-3 py-1 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium"
                        >
                          Abort
                        </button>
                        <button
                          onClick={handleCancelOrder}
                          disabled={isSubmitting || !cancelReason.trim()}
                          className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs transition-all shadow-xs"
                        >
                          Confirm & Issue Refund
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
