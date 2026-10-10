import React, { useState } from 'react';
import {
  X,
  Bike,
  User,
  ShieldCheck,
  ShieldAlert,
  Building,
  CreditCard,
  Truck,
  Battery,
  MapPin,
  Clock,
  Phone,
  Mail,
  HeartPulse,
  Star,
  Edit3,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileCheck,
  Zap,
  TrendingUp,
  PackageCheck,
  Ban,
  RotateCcw,
  Check,
  Trash2,
  Navigation,
  Send,
  ArrowDownLeft,
  ArrowUpRight,
  Eye,
  Smartphone,
  FileText,
} from 'lucide-react';
import { AdminRider, AdminPermission, AdminRiderLedgerEntry, UploadedDocument } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { DocumentViewerModal } from './DocumentViewerModal';
import { RiderEarningsBreakdown } from './RiderEarningsBreakdown';

interface RiderProfileModalProps {
  rider: AdminRider;
  onClose: () => void;
  onEdit: (rider: AdminRider) => void;
  onRiderUpdated: (updatedRider: AdminRider) => void;
  onRiderDeleted?: (riderId: string) => void;
  userPermissions: AdminPermission[];
}

export const RiderProfileModal: React.FC<RiderProfileModalProps> = ({
  rider,
  onClose,
  onEdit,
  onRiderUpdated,
  onRiderDeleted,
  userPermissions,
}) => {
  const [currentRider, setCurrentRider] = useState<AdminRider>(rider);
  const [activeTab, setActiveTab] = useState<'overview' | 'vehicle' | 'documents' | 'bank' | 'ledger'>(
    rider.status === 'PENDING_APPROVAL' ? 'documents' : 'overview'
  );
  const [isUpdating, setIsUpdating] = useState(false);
  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isReleasingPayout, setIsReleasingPayout] = useState(false);
  const [payoutSuccessMsg, setPayoutSuccessMsg] = useState<string | null>(null);
  const [selectedDocForView, setSelectedDocForView] = useState<UploadedDocument | null>(null);
  const [showComplianceWarning, setShowComplianceWarning] = useState(false);

  const canEdit = userPermissions.includes('riders.edit');
  const canApprove = userPermissions.includes('riders.approve');
  const canSuspend = userPermissions.includes('riders.suspend');
  const canPayout = userPermissions.includes('settlements.process') || canEdit || canApprove;

  const flashMessage = (msg: string) => {
    setActionSuccess(msg);
    setTimeout(() => setActionSuccess(null), 4000);
  };

  const uploadedDocs: UploadedDocument[] = currentRider.uploadedDocuments && currentRider.uploadedDocuments.length > 0
    ? currentRider.uploadedDocuments
    : [
        {
          id: 'doc-dl-default',
          docType: 'DRIVING_LICENSE',
          title: 'Commercial Driving License (MCWG / LMV)',
          documentNumber: currentRider.documents.drivingLicenseNumber || 'KA-04-2021-0091823',
          fileName: 'driving_license_front.jpg',
          fileSize: '2.4 MB',
          fileFormat: 'JPG',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Rider App v2.4 (Android)',
          verificationStatus: currentRider.documents.drivingLicenseVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            licenseNumber: currentRider.documents.drivingLicenseNumber || 'KA-04-2021-0091823',
            name: currentRider.name,
            validUntil: currentRider.documents.drivingLicenseExpiry || '2031-10-14',
            vehicleClass: 'MCWG / LMV-NT',
          },
        },
        {
          id: 'doc-rc-default',
          docType: 'VEHICLE_RC',
          title: 'Vehicle Registration Certificate (RC)',
          documentNumber: currentRider.documents.rcNumber || currentRider.vehicleNumber,
          fileName: 'vehicle_rc_smart_card.pdf',
          fileSize: '1.9 MB',
          fileFormat: 'PDF',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Rider App v2.4 (Android)',
          verificationStatus: currentRider.documents.rcVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            registrationNumber: currentRider.documents.rcNumber || currentRider.vehicleNumber,
            ownerName: currentRider.name,
            vehicleModel: currentRider.vehicleModel,
          },
        },
        {
          id: 'doc-aadhaar-default',
          docType: 'AADHAAR',
          title: 'UIDAI Aadhaar Identity Card',
          documentNumber: currentRider.documents.aadharNumber || 'XXXX-XXXX-9102',
          fileName: 'aadhaar_card_masked.pdf',
          fileSize: '1.2 MB',
          fileFormat: 'PDF',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Rider App v2.4 (Android)',
          verificationStatus: currentRider.documents.aadharVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            aadhaarNumber: currentRider.documents.aadharNumber || 'XXXX-XXXX-9102',
            name: currentRider.name,
            gender: 'MALE',
            verificationType: 'UIDAI OTP e-KYC',
          },
        },
        {
          id: 'doc-pan-default',
          docType: 'PAN_CARD',
          title: 'Income Tax PAN Card',
          documentNumber: currentRider.documents.panNumber || 'ABCDE1234F',
          fileName: 'pan_card_rider.jpg',
          fileSize: '1.1 MB',
          fileFormat: 'JPG',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Rider App v2.4 (Android)',
          verificationStatus: currentRider.documents.panVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            panNumber: currentRider.documents.panNumber || 'ABCDE1234F',
            name: currentRider.name,
          },
        },
        {
          id: 'doc-ins-default',
          docType: 'INSURANCE',
          title: 'Comprehensive Commercial Vehicle Insurance',
          documentNumber: currentRider.documents.insurancePolicyNumber || 'POL-99210-ICICI',
          fileName: 'insurance_policy_schedule.pdf',
          fileSize: '2.8 MB',
          fileFormat: 'PDF',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Rider App v2.4 (Android)',
          verificationStatus: currentRider.documents.insuranceVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            policyNumber: currentRider.documents.insurancePolicyNumber || 'POL-99210-ICICI',
            insuredName: currentRider.name,
            validUntil: '2027-03-31',
          },
        },
      ];

  const unverifiedDocsCount = uploadedDocs.filter((d) => d.verificationStatus !== 'VERIFIED').length;
  const isBgvCleared = currentRider.bgvSummary ? currentRider.bgvSummary.status === 'CLEARED' : currentRider.documents.backgroundCheckPassed;

  const handleVerifySingleDocument = async (docId: string) => {
    if (!canApprove && !canEdit) return;
    try {
      await adminApi.post(`/api/admin/riders/${currentRider.id}/documents/${docId}/verify`, {});
      const updatedDocs = uploadedDocs.map((d) => (d.id === docId ? { ...d, verificationStatus: 'VERIFIED' as const } : d));
      const updatedRider = {
        ...currentRider,
        uploadedDocuments: updatedDocs,
      };
      setCurrentRider(updatedRider);
      onRiderUpdated(updatedRider);
      flashMessage('Document marked as verified');
    } catch (err: any) {
      alert(err.message || 'Failed to verify document');
    }
  };

  const handleRequestReupload = async (docId: string, reason: string) => {
    if (!canApprove && !canEdit) return;
    try {
      await adminApi.post(`/api/admin/riders/${currentRider.id}/documents/${docId}/request-reupload`, { reason });
      const updatedDocs = uploadedDocs.map((d) =>
        d.id === docId ? { ...d, verificationStatus: 'PENDING' as const, rejectionReason: reason } : d
      );
      const updatedRider = {
        ...currentRider,
        uploadedDocuments: updatedDocs,
      };
      setCurrentRider(updatedRider);
      onRiderUpdated(updatedRider);
      flashMessage('Push notification sent to Rider App requesting re-upload');
    } catch (err: any) {
      alert(err.message || 'Failed to request re-upload');
    }
  };

  const executeApproval = async () => {
    if (!canApprove) return;
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/approve`, {});
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        flashMessage('Fleet partner approved! Activated for live dispatch orders.');
      }
    } catch (err: any) {
      alert(err.message || 'Approval failed');
    } finally {
      setIsUpdating(false);
      setShowComplianceWarning(false);
    }
  };

  const handleApproveClick = () => {
    if (unverifiedDocsCount > 0 || !isBgvCleared) {
      setShowComplianceWarning(true);
    } else {
      executeApproval();
    }
  };

  const handleRejectApplicant = async () => {
    if (!canApprove) return;
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/reject`, {
        reason: rejectReason || 'KYC / BGV documents failed statutory criteria',
      });
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        setShowRejectModal(false);
        setRejectReason('');
        flashMessage('Rider applicant rejected.');
      }
    } catch (err: any) {
      alert(err.message || 'Rejection failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleReleasePayout = async () => {
    if (!canPayout) return;
    try {
      setIsReleasingPayout(true);
      const pendingBal = currentRider.pendingPayableBalance ?? (currentRider.todayEarnings || 0);
      if (pendingBal <= 0) {
        alert('Pending payable due amount is ₹0.');
        return;
      }

      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/release-payout`, {
        payoutType: 'FULL',
        amount: pendingBal,
        paymentMode: 'UPI',
        upiId: currentRider.bankDetails?.upiId,
      });

      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        setPayoutSuccessMsg(`Released ₹${pendingBal.toLocaleString('en-IN')} (UTR: ${res.utrNumber || 'UPI-OK'})`);
        setTimeout(() => setPayoutSuccessMsg(null), 5000);
      }
    } catch (err: any) {
      alert(err.message || 'Payout failed');
    } finally {
      setIsReleasingPayout(false);
    }
  };

  const handleApprove = async () => {
    if (!canApprove) return;
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/approve`, {});
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        flashMessage('Rider approved successfully! Profile activated for dispatch.');
      }
    } catch (err: any) {
      alert(err.message || 'Approval failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleReject = async () => {
    if (!canApprove) return;
    if (!rejectReason.trim()) {
      alert('Please enter a reason for rejecting this application.');
      return;
    }
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/reject`, {
        reason: rejectReason.trim(),
      });
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        setShowRejectModal(false);
        setRejectReason('');
        flashMessage('Rider onboarding application rejected and notification dispatched to Rider App.');
      }
    } catch (err: any) {
      alert(err.message || 'Rejection failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSuspend = async () => {
    if (!canSuspend) return;
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/suspend`, {
        reason: suspendReason || 'Operational policy violation',
      });
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        setShowSuspendModal(false);
        setSuspendReason('');
        flashMessage('Rider suspended and locked out of active fleet.');
      }
    } catch (err: any) {
      alert(err.message || 'Suspension failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleReactivate = async () => {
    if (!canSuspend) return;
    try {
      setIsUpdating(true);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/reactivate`, {});
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        flashMessage('Rider profile restored and reactivated to ONLINE status.');
      }
    } catch (err: any) {
      alert(err.message || 'Reactivation failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleVerifyDocument = async (docKey: keyof AdminRider['documents']) => {
    if (!canApprove && !canEdit) return;
    try {
      setIsUpdating(true);
      const updatedDocs = {
        ...currentRider.documents,
        [docKey]: !currentRider.documents[docKey],
      };
      const res: any = await adminApi.put(`/api/admin/riders/${currentRider.id}`, {
        documents: updatedDocs,
      });
      if (res.success) {
        setCurrentRider(res.rider);
        onRiderUpdated(res.rider);
        flashMessage('Document verification updated.');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to update document verification');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    if (!canSuspend) return;
    if (!window.confirm(`Are you sure you want to permanently remove delivery partner ${currentRider.name}?`)) {
      return;
    }
    try {
      setIsUpdating(true);
      const res: any = await adminApi.delete(`/api/admin/riders/${currentRider.id}`);
      if (res.success) {
        if (onRiderDeleted) onRiderDeleted(currentRider.id);
        onClose();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to delete rider');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden relative animate-in fade-in zoom-in-95 duration-150">
        {/* Dedicated Top-Right Modal Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-30 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/80 rounded-full transition-colors"
          title="Close Profile"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Top Header Card */}
        <div className="p-5 sm:p-6 bg-slate-50 border-b border-slate-200 pr-14 sm:pr-16">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="relative shrink-0">
                <img
                  src={currentRider.avatar}
                  alt={currentRider.name}
                  className="h-16 w-16 rounded-2xl object-cover border border-slate-200 shadow-xs"
                />
                <span
                  className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full ring-2 ring-white ${
                    currentRider.status === 'ONLINE'
                      ? 'bg-emerald-500'
                      : currentRider.status === 'ON_DELIVERY'
                      ? 'bg-sky-500'
                      : currentRider.status === 'PENDING_APPROVAL'
                      ? 'bg-indigo-500'
                      : currentRider.status === 'SUSPENDED'
                      ? 'bg-rose-500'
                      : 'bg-slate-400'
                  }`}
                />
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">{currentRider.name}</h2>
                  {/* Live Telemetry Badge from Mobile App */}
                  <span
                    className={`text-xs font-semibold px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 uppercase ${
                      currentRider.status === 'ONLINE'
                        ? 'bg-emerald-100 text-emerald-800'
                        : currentRider.status === 'ON_DELIVERY'
                        ? 'bg-sky-100 text-sky-800'
                        : currentRider.status === 'PENDING_APPROVAL'
                        ? 'bg-indigo-100 text-indigo-800'
                        : currentRider.status === 'SUSPENDED'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        currentRider.status === 'ONLINE'
                          ? 'bg-emerald-600 animate-pulse'
                          : currentRider.status === 'ON_DELIVERY'
                          ? 'bg-sky-600 animate-pulse'
                          : currentRider.status === 'PENDING_APPROVAL'
                          ? 'bg-indigo-600'
                          : currentRider.status === 'SUSPENDED'
                          ? 'bg-rose-600'
                          : 'bg-slate-400'
                      }`}
                    />
                    <span>{currentRider.status === 'ONLINE' ? 'Online on Duty' : currentRider.status.replace(/_/g, ' ')}</span>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1.5">
                  <span className="flex items-center gap-1 text-slate-700 font-medium">
                    <Phone className="h-3.5 w-3.5 text-slate-400" />
                    {currentRider.phone}
                  </span>
                  <span className="text-indigo-700 font-medium bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 flex items-center gap-1 text-[11px]">
                    <Smartphone className="h-3 w-3" />
                    Rider Mobile App Connected
                  </span>
                  <span className="text-slate-500">
                    Vehicle: <strong className="text-slate-700">{currentRider.vehicleNumber}</strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Header Action Buttons */}
            <div className="flex items-center gap-2 self-start lg:self-center flex-wrap">
              {currentRider.status === 'PENDING_APPROVAL' ? (
                <>
                  {canApprove && (
                    <button
                      type="button"
                      onClick={handleApproveClick}
                      disabled={isUpdating}
                      className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-bold shadow-xs transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Verify & Approve</span>
                    </button>
                  )}

                  {canApprove && (
                    <button
                      type="button"
                      onClick={() => setShowRejectModal(true)}
                      className="flex items-center gap-1 bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
                    >
                      <span>Reject Application</span>
                    </button>
                  )}

                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(currentRider)}
                      className="flex items-center gap-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 px-3 py-2 rounded-xl text-xs font-semibold shadow-2xs transition-colors"
                    >
                      <Edit3 className="h-3.5 w-3.5 text-slate-500" />
                      <span>Edit</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setActiveTab('ledger')}
                    className="flex items-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white px-3.5 py-2 rounded-xl text-xs font-semibold shadow-2xs transition-colors"
                  >
                    <CreditCard className="h-3.5 w-3.5" />
                    <span>Earnings & Ledger</span>
                  </button>

                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(currentRider)}
                      className="flex items-center gap-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 px-3.5 py-2 rounded-xl text-xs font-semibold shadow-2xs transition-colors"
                    >
                      <Edit3 className="h-3.5 w-3.5 text-slate-500" />
                      <span>Edit</span>
                    </button>
                  )}

                  {currentRider.status === 'SUSPENDED' && canSuspend && (
                    <button
                      type="button"
                      onClick={handleReactivate}
                      disabled={isUpdating}
                      className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-semibold shadow-xs transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Reactivate</span>
                    </button>
                  )}

                  {currentRider.status !== 'SUSPENDED' && canSuspend && (
                    <button
                      type="button"
                      onClick={() => setShowSuspendModal(true)}
                      className="flex items-center gap-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors shadow-2xs"
                    >
                      <Ban className="h-3.5 w-3.5 text-rose-600" />
                      <span>Suspend</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Flash Notification */}
          {actionSuccess && (
            <div className="mt-3 p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-medium flex items-center gap-2 animate-in fade-in">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{actionSuccess}</span>
            </div>
          )}

          {/* Suspension Alert banner if suspended */}
          {currentRider.status === 'SUSPENDED' && (
            <div className="mt-3 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-2.5">
              <ShieldAlert className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">Account Suspended</span>
                <p className="text-rose-700 mt-0.5">
                  Reason: {currentRider.suspensionReason || 'Operational policy violation'} (Suspended at {currentRider.suspendedAt || 'Recent'})
                </p>
              </div>
            </div>
          )}

          {/* Key Metrics Quick Ribbon */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4 pt-4 border-t border-slate-200/80">
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Cluster Zone</div>
              <div className="text-xs font-bold text-slate-900 truncate mt-0.5">
                {currentRider.assignedZoneName || currentRider.cityName || currentRider.currentLocation?.areaName || 'Koramangala 4th-6th Block'}
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Vehicle / Spec</div>
              <div className="text-xs font-bold text-slate-900 truncate mt-0.5">
                {currentRider.vehicleType} · {currentRider.vehicleMakeModel || 'Ather 450X EV'}
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Delivery Rating</div>
              <div className="text-xs font-bold text-amber-600 flex items-center gap-1 mt-0.5">
                <span>★ {currentRider.rating.toFixed(1)}</span>
                <span className="text-[10px] text-slate-400 font-normal">({currentRider.totalDeliveries} orders)</span>
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">BGV Audit Status</div>
              <div className="text-xs font-bold text-slate-900 mt-0.5 flex items-center gap-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    isBgvCleared ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                <span className={isBgvCleared ? 'text-emerald-700' : 'text-amber-700'}>
                  {isBgvCleared ? 'Cleared (99/100)' : 'In Review'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Tab Navigation - Clean, High-Contrast Modern Tabs */}
        <div className="flex border-b border-slate-200 bg-white px-4 sm:px-6 gap-2 text-xs font-semibold overflow-x-auto scrollbar-none shrink-0">
          {[
            { id: 'overview', label: 'Delivery Zone', icon: MapPin },
            { id: 'vehicle', label: 'Vehicle & Gear', icon: Truck },
            {
              id: 'documents',
              label: 'KYC Documents & BGV',
              icon: ShieldCheck,
              badge: currentRider.status === 'PENDING_APPROVAL' ? 'Pending Review' : `${uploadedDocs.filter(d => d.verificationStatus === 'VERIFIED').length}/${uploadedDocs.length}`
            },
            { id: 'ledger', label: 'Earnings & Ledger', icon: CreditCard },
            { id: 'bank', label: 'Bank Info', icon: CreditCard },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-3.5 px-3.5 border-b-2 flex items-center gap-2 whitespace-nowrap transition-all shrink-0 ${
                  isActive
                    ? 'border-[#009DE0] text-[#009DE0] font-bold bg-sky-50/50'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-[#009DE0]' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      isActive
                        ? 'bg-sky-100 text-[#00608a]'
                        : currentRider.status === 'PENDING_APPROVAL'
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'bg-slate-100 text-slate-700 border border-slate-200'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Profile Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: Delivery Zone & Operations */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-emerald-600" />
                    <span>Assigned Delivery Zone (3-4 km)</span>
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Operating City:</span>
                      <span className="text-slate-900 font-semibold">{currentRider.cityName || currentRider.cityId || 'Bengaluru'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Assigned Area / Locality:</span>
                      <span className="text-slate-900 font-bold">{currentRider.assignedZoneName || 'Koramangala 4th-6th Block'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Coverage Radius:</span>
                      <span className="text-slate-800 font-medium">3 - 4 km Local Delivery Radius</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Last GPS Area:</span>
                      <span className="text-slate-800 font-medium">{currentRider.currentLocation?.areaName || 'Koramangala 4th Block'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Telemetry Status:</span>
                      <span className="text-emerald-700 font-medium">GPS Signal Active (Delivery Partner App)</span>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                    <Clock className="h-4 w-4 text-emerald-600" />
                    <span>Duty Shift & Contract Schedule</span>
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Contract Model:</span>
                      <span className="text-slate-900 font-semibold">{currentRider.dutyType?.replace(/_/g, ' ') || 'FULL TIME'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Active Shift Hours:</span>
                      <span className="text-slate-900 font-semibold">{currentRider.shiftHours || '07:00 AM - 04:00 PM'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Onboarding Date:</span>
                      <span className="text-slate-800">{currentRider.activeSince}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Active Order:</span>
                      <span className="text-sky-700 font-bold">
                        {currentRider.currentOrderId ? `#${currentRider.currentOrderId}` : 'Idle (Available for dispatch)'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Emergency Contact */}
              {currentRider.emergencyContact && (
                <div className="p-4 bg-amber-50/60 border border-amber-200 rounded-xl">
                  <h3 className="text-xs font-bold text-amber-900 flex items-center gap-2 mb-2">
                    <HeartPulse className="h-4 w-4 text-amber-600" />
                    <span>Emergency SOS Contact</span>
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <span className="text-slate-500 block text-[11px]">Contact Person:</span>
                      <span className="font-semibold text-slate-900">{currentRider.emergencyContact.name || 'Not specified'}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[11px]">Relationship:</span>
                      <span className="font-semibold text-slate-900">{currentRider.emergencyContact.relationship || 'Family'}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[11px]">Emergency Phone:</span>
                      <a
                        href={`tel:${currentRider.emergencyContact.phone}`}
                        className="font-bold text-amber-800 hover:underline"
                      >
                        {currentRider.emergencyContact.phone || 'N/A'}
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Vehicle & Equipment */}
          {activeTab === 'vehicle' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                    <Truck className="h-4 w-4 text-emerald-600" />
                    <span>Fleet Vehicle Specification</span>
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Vehicle Type:</span>
                      <span className="font-bold text-slate-900 bg-slate-200/60 px-2 py-0.5 rounded">
                        {currentRider.vehicleType.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Make & Model:</span>
                      <span className="text-slate-900 font-semibold">{currentRider.vehicleMakeModel || 'EV Commercial'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Registration Plate:</span>
                      <span className="text-slate-900 font-bold text-sm">{currentRider.vehicleNumber}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Fuel / Powertrain:</span>
                      <span className="text-emerald-700 font-semibold">{currentRider.fuelType || 'ELECTRIC (Zero-Emission)'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Max Payload Limit:</span>
                      <span className="text-slate-900 font-bold">{currentRider.maxPayloadKg || 60} Kg</span>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                    <Battery className="h-4 w-4 text-emerald-600" />
                    <span>Battery & Equipment Readiness</span>
                  </h3>
                  {currentRider.batteryPercent !== undefined && (
                    <div className="p-3 bg-white border border-slate-200 rounded-lg space-y-1.5">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-600">EV Battery Charge:</span>
                        <span className="text-emerald-700 font-bold">{currentRider.batteryPercent}%</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            currentRider.batteryPercent > 40
                              ? 'bg-emerald-500'
                              : currentRider.batteryPercent > 20
                              ? 'bg-amber-500'
                              : 'bg-rose-500'
                          }`}
                          style={{ width: `${currentRider.batteryPercent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 pt-1 text-xs">
                    <div className="flex items-center justify-between p-2 bg-white border border-slate-200 rounded-lg">
                      <span className="text-slate-700">Heavy-Duty Insulated Bag</span>
                      <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px]">
                        <Check className="h-3.5 w-3.5" /> Issued
                      </span>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-white border border-slate-200 rounded-lg">
                      <span className="text-slate-700">ISI Safety Helmet & Hi-Vis Vest</span>
                      <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px]">
                        <Check className="h-3.5 w-3.5" /> Compliant
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Complete KYC & BGV Verification Suite */}
          {activeTab === 'documents' && (
            <div className="space-y-5">
              {/* Compliance Warning Dialog if Triggered */}
              {showComplianceWarning && (
                <div className="p-4 bg-amber-50 border-2 border-amber-300 rounded-xl space-y-3 animate-in fade-in">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-bold text-amber-900 text-xs">KYC Verification Incomplete Warning</h4>
                      <p className="text-[11px] text-amber-800 mt-0.5">
                        {unverifiedDocsCount} document(s) are pending audit or BGV is not cleared. Approving now will bypass pending statutory checks and immediately activate this rider for customer deliveries.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowComplianceWarning(false)}
                      className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 font-semibold rounded-lg text-xs"
                    >
                      Review Documents First
                    </button>
                    <button
                      type="button"
                      onClick={executeApproval}
                      disabled={isUpdating}
                      className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs shadow-xs"
                    >
                      Confirm & Approve Anyway
                    </button>
                  </div>
                </div>
              )}

              {/* Background Verification (BGV) Clearance Card */}
              <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-2xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider">
                      Automated Background Verification (BGV) Audit
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500">
                      Ref: <strong className="font-mono text-slate-700">{currentRider.bgvSummary?.referenceNumber || 'BGV-RID-2026-8910'}</strong>
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                        isBgvCleared
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-amber-100 text-amber-800 border border-amber-300'
                      }`}
                    >
                      {isBgvCleared ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                      {isBgvCleared ? 'BGV CLEARED (SCORE 99)' : 'BGV IN AUDIT'}
                    </span>
                  </div>
                </div>

                {/* BGV 4-Check Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-800 block text-xs">UIDAI Aadhaar OTP e-KYC</span>
                      <span className="text-[11px] text-slate-500">Identity & Demographic Match Validated</span>
                    </div>
                    <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Valid
                    </span>
                  </div>

                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-800 block text-xs">MoRTH Parivahan DL Validity</span>
                      <span className="text-[11px] text-slate-500">Active License · Valid until 2031</span>
                    </div>
                    <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Valid
                    </span>
                  </div>

                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-800 block text-xs">CCTNS Police Criminal Records</span>
                      <span className="text-[11px] text-slate-500">Clear Records · No Adverse Filings</span>
                    </div>
                    <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Cleared
                    </span>
                  </div>

                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-800 block text-xs">NPCI Penny-Drop Bank Match</span>
                      <span className="text-[11px] text-slate-500">Account Active · Name Match 100%</span>
                    </div>
                    <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Verified
                    </span>
                  </div>
                </div>
              </div>

              {/* Uploaded Documents from Rider App */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900 uppercase tracking-wider text-xs flex items-center gap-2">
                      <FileCheck className="h-4 w-4 text-emerald-600" />
                      Statutory Fleet Documents (Uploaded via QCOM Rider App)
                    </h3>
                    <span className="text-[11px] text-slate-500">
                      Click <strong>View Document</strong> to inspect certificates, OCR metadata, and audit records.
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-lg">
                    {uploadedDocs.filter((d) => d.verificationStatus === 'VERIFIED').length} / {uploadedDocs.length} Verified
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {uploadedDocs.map((doc) => {
                    const isVerified = doc.verificationStatus === 'VERIFIED';
                    return (
                      <div
                        key={doc.id}
                        className="p-3.5 bg-white border border-slate-200 rounded-xl space-y-2.5 shadow-2xs hover:border-slate-300 transition-all"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2.5">
                            <div className="h-9 w-9 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold shrink-0 mt-0.5">
                              <FileText className="h-4 w-4" />
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-900 text-xs line-clamp-1">{doc.title}</h4>
                              <span className="text-[11px] font-mono text-slate-600 block">
                                {doc.documentNumber || doc.fileName}
                              </span>
                            </div>
                          </div>

                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                              isVerified
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {isVerified ? (
                              <>
                                <CheckCircle2 className="h-3 w-3" />
                                Verified
                              </>
                            ) : (
                              <>
                                <AlertTriangle className="h-3 w-3" />
                                Pending Audit
                              </>
                            )}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100">
                          <span className="flex items-center gap-1 text-indigo-700 font-medium">
                            <Smartphone className="h-3 w-3" />
                            App Upload
                          </span>
                          <span>{doc.fileFormat} · {doc.fileSize}</span>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setSelectedDocForView(doc)}
                            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold py-1.5 px-3 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <Eye className="h-3.5 w-3.5 text-slate-600" />
                            <span>View Document</span>
                          </button>

                          {!isVerified && canApprove && (
                            <button
                              type="button"
                              onClick={() => handleVerifySingleDocument(doc.id)}
                              className="bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold py-1.5 px-3 rounded-lg text-xs flex items-center justify-center gap-1 transition-colors"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>Verify</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Bottom Quick Approval Bar if Pending */}
              {currentRider.status === 'PENDING_APPROVAL' && canApprove && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                  <div>
                    <span className="font-bold text-indigo-950 text-xs block">Delivery Partner KYC Decision</span>
                    <span className="text-[11px] text-indigo-700">
                      All partner documents and BGV can be verified before activating rider on live orders.
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowRejectModal(true)}
                      className="px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 font-bold rounded-lg text-xs"
                    >
                      Reject Application
                    </button>
                    <button
                      type="button"
                      onClick={handleApproveClick}
                      disabled={isUpdating}
                      className="px-4 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-xs"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Approve & Activate Fleet Rider</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: Bank & Payout Info */}
          {activeTab === 'bank' && (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-[#009DE0]" />
                  <span>Direct Bank Payout Settlement Info</span>
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-slate-500 block text-[11px]">Beneficiary Account Holder:</span>
                    <span className="text-slate-900 font-bold">{currentRider.bankDetails?.accountHolderName || currentRider.name}</span>
                  </div>

                  <div>
                    <span className="text-slate-500 block text-[11px]">Bank Account Number:</span>
                    <span className="text-slate-900 font-bold">{currentRider.bankDetails?.accountNumber || '••••••••••••'}</span>
                  </div>

                  <div>
                    <span className="text-slate-500 block text-[11px]">IFSC Code:</span>
                    <span className="text-slate-900 font-bold">{currentRider.bankDetails?.ifscCode || 'HDFC0001234'}</span>
                  </div>

                  <div>
                    <span className="text-slate-500 block text-[11px]">Bank Name & Branch:</span>
                    <span className="text-slate-900 font-semibold">{currentRider.bankDetails?.bankName || 'HDFC Bank'}</span>
                  </div>

                  <div>
                    <span className="text-slate-500 block text-[11px]">UPI ID / VPA:</span>
                    <span className="text-[#00608a] font-bold">{currentRider.bankDetails?.upiId || `${currentRider.phone.replace(/[^0-9]/g, '')}@upi`}</span>
                  </div>

                  <div>
                    <span className="text-slate-500 block text-[11px]">Disbursement Cycle:</span>
                    <span className="text-slate-900 font-bold">{currentRider.bankDetails?.payoutFrequency || 'DAILY'} (Automatic 11:30 PM)</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: Earnings Ledger & Payment Release Controls */}
          {activeTab === 'ledger' && (
            <div className="space-y-5">
              {/* Payment Release Control Card */}
              <div className="p-4 bg-sky-50/70 border border-sky-200 rounded-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-bold text-[#00608a] flex items-center gap-1.5">
                      <CreditCard className="h-4 w-4 text-[#009DE0]" />
                      <span>Payment Release & Settlement Gateway</span>
                    </h3>
                    <p className="text-[11px] text-[#00608a] mt-0.5">
                      Payable balance: <strong>₹{(currentRider.pendingPayableBalance ?? currentRider.todayEarnings ?? 0).toLocaleString('en-IN')}</strong> • Target: {currentRider.bankDetails?.upiId || `${currentRider.bankDetails?.bankName} A/C`}
                    </p>
                  </div>

                  {/* Release button for pending due balance */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleReleasePayout}
                      disabled={isReleasingPayout || (currentRider.pendingPayableBalance ?? (currentRider.todayEarnings || 0)) <= 0 || !canPayout}
                      className="bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-40 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-2xs transition-colors flex items-center gap-1.5"
                    >
                      {isReleasingPayout ? <Clock className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      <span>Release Pending Due (₹{(currentRider.pendingPayableBalance ?? (currentRider.todayEarnings || 0)).toLocaleString('en-IN')})</span>
                    </button>
                  </div>
                </div>

                {payoutSuccessMsg && (
                  <div className="p-2 bg-emerald-100 text-emerald-900 rounded-lg text-xs font-semibold flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                    <span>{payoutSuccessMsg}</span>
                  </div>
                )}
              </div>

              {/* Complete Performance & Earnings Breakdown Component */}
              <RiderEarningsBreakdown rider={currentRider} />

              {/* Transactions Ledger Table */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                <div className="p-3 bg-slate-50 border-b border-slate-200 font-bold text-xs text-slate-800">
                  Itemized Financial Ledger & Payout History
                </div>
                <div className="divide-y divide-slate-100 text-xs">
                  {(currentRider.ledgerEntries || [
                    {
                      id: 'led-1',
                      date: 'Today, 02:45 PM',
                      title: `Completed ${currentRider.todayDeliveries || 0} deliveries`,
                      type: 'TRIP_EARNING',
                      category: 'CREDIT',
                      amount: currentRider.todayEarnings || 380,
                      status: 'CLEARED',
                    },
                    {
                      id: 'led-2',
                      date: 'Yesterday, 09:30 PM',
                      title: 'Daily Auto-Payout Released via UPI',
                      type: 'PAYOUT_RELEASE',
                      category: 'DEBIT',
                      amount: 640,
                      status: 'RELEASED',
                      utrNumber: 'UPI/489201948120/ICIC',
                    }
                  ]).map((item: any) => (
                    <div key={item.id} className="p-3 flex items-center justify-between hover:bg-slate-50/70">
                      <div>
                        <div className="font-bold text-slate-900">{item.title}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {item.date} • {item.utrNumber ? `UTR: ${item.utrNumber}` : 'Internal Accrual'}
                        </div>
                      </div>
                      <div className={`font-extrabold text-right ${item.category === 'CREDIT' ? 'text-emerald-700' : 'text-slate-900'}`}>
                        {item.category === 'CREDIT' ? '+' : '-'}₹{item.amount.toLocaleString('en-IN')}
                        <span className="block text-[10px] text-slate-400 font-normal">{item.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Bottom Delete Action */}
          {canSuspend && (
            <div className="pt-4 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
              <span>Permanently remove this delivery partner profile from database:</span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isUpdating}
                className="flex items-center gap-1.5 text-rose-600 hover:text-rose-700 font-semibold hover:bg-rose-50 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete Partner Profile</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Suspend Confirmation Modal */}
      {showSuspendModal && (
        <div className="fixed inset-0 z-60 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2.5 bg-rose-50 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Suspend Delivery Partner</h3>
                <p className="text-xs text-slate-500">Temporarily lock out {currentRider.name} from receiving orders.</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                Reason for Suspension <span className="text-rose-500">*</span>
              </label>
              <textarea
                rows={3}
                required
                value={suspendReason}
                onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="e.g. Unexplained order cancellation, customer dispute, or missing security inspection..."
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowSuspendModal(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSuspend}
                disabled={isUpdating || !suspendReason.trim()}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-4 py-1.5 rounded-lg text-xs disabled:opacity-50"
              >
                Confirm Suspension
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Application Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-60 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2.5 bg-rose-50 rounded-xl">
                <Ban className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Reject Delivery Partner Application</h3>
                <p className="text-xs text-slate-500">This notification will be dispatched to {currentRider.name}'s Rider Mobile App.</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                Reason for Rejection <span className="text-rose-500">*</span>
              </label>
              <textarea
                rows={3}
                required
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Ineligible driving license validity, unclear RC document scan, background verification mismatch..."
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowRejectModal(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={isUpdating || !rejectReason.trim()}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-4 py-1.5 rounded-lg text-xs disabled:opacity-50 shadow-xs"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document Inspector & BGV Viewer Modal */}
      {selectedDocForView && (
        <DocumentViewerModal
          document={selectedDocForView}
          entityName={currentRider.name}
          entityRole="RIDER"
          entityId={currentRider.id}
          bgvSummary={currentRider.bgvSummary}
          onClose={() => setSelectedDocForView(null)}
          onVerifyDocument={handleVerifySingleDocument}
          onRequestReupload={handleRequestReupload}
        />
      )}
    </div>
  );
};
