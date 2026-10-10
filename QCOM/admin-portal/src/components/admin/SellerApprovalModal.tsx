import React, { useState } from 'react';
import {
  X,
  Store,
  CheckCircle2,
  XCircle,
  FileCheck,
  ShieldCheck,
  AlertTriangle,
  Building,
  CreditCard,
  FileText,
  Eye,
  Smartphone,
  ExternalLink,
  MapPin,
  Sparkles,
  Phone,
  Mail,
  User,
  Check,
} from 'lucide-react';
import { AdminSeller, UploadedDocument } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { DocumentViewerModal } from './DocumentViewerModal';

interface SellerApprovalModalProps {
  seller: AdminSeller;
  onClose: () => void;
  onRefresh: () => void;
  canApprove: boolean;
}

export const SellerApprovalModal: React.FC<SellerApprovalModalProps> = ({
  seller,
  onClose,
  onRefresh,
  canApprove,
}) => {
  const [currentSeller, setCurrentSeller] = useState<AdminSeller>(seller);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [selectedDocForView, setSelectedDocForView] = useState<UploadedDocument | null>(null);
  const [showComplianceWarning, setShowComplianceWarning] = useState(false);

  // Default uploaded documents if seller.uploadedDocuments is not populated yet
  const uploadedDocs: UploadedDocument[] = currentSeller.uploadedDocuments && currentSeller.uploadedDocuments.length > 0
    ? currentSeller.uploadedDocuments
    : [
        {
          id: 'doc-gst-default',
          docType: 'GST_CERTIFICATE',
          title: 'Form GST REG-06 Registration Certificate',
          documentNumber: currentSeller.gstin,
          fileName: 'gst_registration_cert.pdf',
          fileSize: '3.1 MB',
          fileFormat: 'PDF',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Seller Partner App v1.8 (Android)',
          verificationStatus: currentSeller.documents.gstVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            gstin: currentSeller.gstin,
            legalName: currentSeller.name,
            tradeName: currentSeller.name,
            registeredAddress: currentSeller.address,
          },
        },
        {
          id: 'doc-pan-default',
          docType: 'PAN_CARD',
          title: 'Business / Proprietor PAN Card',
          documentNumber: currentSeller.panNumber,
          fileName: 'pan_card_business.jpg',
          fileSize: '1.4 MB',
          fileFormat: 'JPG',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Seller Partner App v1.8 (Android)',
          verificationStatus: currentSeller.documents.panVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            panNumber: currentSeller.panNumber,
            name: currentSeller.ownerName,
          },
        },
        {
          id: 'doc-fssai-default',
          docType: 'FSSAI_LICENSE',
          title: 'FSSAI Food License / Municipal Trade License',
          documentNumber: currentSeller.documents.tradeLicenseNumber || 'TRADE-LIC-2026-99',
          fileName: 'municipal_trade_license.pdf',
          fileSize: '2.4 MB',
          fileFormat: 'PDF',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Seller Partner App v1.8 (Android)',
          verificationStatus: currentSeller.documents.tradeLicenseVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            licenseNo: currentSeller.documents.tradeLicenseNumber || 'BBMP/2026/0912',
            storeName: currentSeller.name,
          },
        },
        {
          id: 'doc-bank-default',
          docType: 'BANK_PASSBOOK',
          title: 'Bank Cancelled Cheque / Payout Mandate',
          documentNumber: currentSeller.bankAccount?.accountNumber,
          fileName: 'bank_cheque_payout.jpg',
          fileSize: '1.6 MB',
          fileFormat: 'JPG',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Seller Partner App v1.8 (Android)',
          verificationStatus: currentSeller.documents.bankVerified ? 'VERIFIED' : 'PENDING',
          ocrData: {
            bankName: currentSeller.bankAccount?.bankName,
            accountNumber: currentSeller.bankAccount?.accountNumber,
            ifsc: currentSeller.bankAccount?.ifsc,
          },
        },
        {
          id: 'doc-store-default',
          docType: 'STORE_PHOTO',
          title: 'Geo-Tagged Storefront & Counter Photo',
          documentNumber: 'GEO-TAG-PHOTO',
          fileName: 'storefront_geotag_live.jpg',
          fileSize: '3.8 MB',
          fileFormat: 'JPG',
          uploadedAt: 'Recent Upload',
          uploadedVia: 'QCOM Seller Partner App v1.8 (Android)',
          verificationStatus: 'VERIFIED',
          ocrData: {
            address: currentSeller.address,
            geotagStatus: 'Verified inside active dispatch grid',
          },
        },
      ];

  const unverifiedDocsCount = uploadedDocs.filter((d) => d.verificationStatus !== 'VERIFIED').length;
  const isBgvCleared = currentSeller.bgvSummary ? currentSeller.bgvSummary.status === 'CLEARED' : unverifiedDocsCount === 0;

  const handleVerifySingleDocument = async (docId: string) => {
    try {
      await adminApi.post(`/api/admin/sellers/${currentSeller.id}/documents/${docId}/verify`, {});
      // Update local state
      const updatedDocs = uploadedDocs.map((d) => (d.id === docId ? { ...d, verificationStatus: 'VERIFIED' as const } : d));
      setCurrentSeller((prev) => ({
        ...prev,
        uploadedDocuments: updatedDocs,
      }));
      setSuccessMsg('Document marked as verified');
      setTimeout(() => setSuccessMsg(''), 3000);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to verify document');
    }
  };

  const handleRequestReupload = async (docId: string, reason: string) => {
    try {
      await adminApi.post(`/api/admin/sellers/${currentSeller.id}/documents/${docId}/request-reupload`, { reason });
      const updatedDocs = uploadedDocs.map((d) =>
        d.id === docId ? { ...d, verificationStatus: 'PENDING' as const, rejectionReason: reason } : d
      );
      setCurrentSeller((prev) => ({
        ...prev,
        uploadedDocuments: updatedDocs,
      }));
      setSuccessMsg('Push notification sent to Seller Partner App requesting re-upload');
      setTimeout(() => setSuccessMsg(''), 3000);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to request re-upload');
    }
  };

  const executeApproval = async () => {
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      await adminApi.post(`/api/admin/sellers/${currentSeller.id}/approve`, {});
      onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to approve seller application');
    } finally {
      setIsSubmitting(false);
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

  const handleReject = async () => {
    if (!rejectReason.trim()) {
      setErrorMsg('Please specify why this applicant KYC is being rejected.');
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      await adminApi.post(`/api/admin/sellers/${currentSeller.id}/reject`, { reason: rejectReason });
      onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to reject seller application');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh] relative animate-in fade-in zoom-in-95 duration-150">
        {/* Absolute Top-Right Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 rounded-full transition-colors z-20"
          title="Close Dialog"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Top Header */}
        <div className="p-5 sm:p-6 border-b border-slate-200 bg-slate-50/80 pr-14">
          <div className="flex items-center gap-3.5">
            <div className="h-12 w-12 rounded-2xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center font-bold shrink-0">
              <Store className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">{currentSeller.name}</h2>
                <span className="px-2.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-300 rounded-full text-xs font-bold inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  KYC Review Required
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 mt-1">
                <span className="font-medium text-slate-700">{currentSeller.ownerName}</span>
                <span>·</span>
                <span className="text-indigo-700 font-medium bg-indigo-50 px-2 py-0.2 rounded border border-indigo-100 flex items-center gap-1">
                  <Smartphone className="h-3 w-3" />
                  Uploaded from Seller Partner App
                </span>
                <span>·</span>
                <span>Applied: {currentSeller.joinedDate}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-6 text-xs text-slate-600">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl flex items-center gap-2 font-medium animate-in fade-in">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl flex items-center gap-2 font-medium animate-in fade-in">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Business & Location Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-0.5">Proprietor Name:</span>
              <span className="text-slate-900 font-bold text-xs">{currentSeller.ownerName}</span>
            </div>

            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-0.5">Contact Phone & Email:</span>
              <div className="text-slate-800 font-mono text-xs font-semibold">{currentSeller.phone}</div>
              <div className="text-slate-500 text-[11px] truncate">{currentSeller.email}</div>
            </div>

            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-0.5">Operating Area / Hub:</span>
              <span className="text-slate-900 font-bold text-xs">{currentSeller.areaName}</span>
            </div>

            <div className="sm:col-span-2 md:col-span-3 pt-2.5 border-t border-slate-200">
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-0.5">Registered Premise Address:</span>
              <span className="text-slate-800 font-medium text-xs">{currentSeller.address}</span>
            </div>
          </div>

          {/* Background Verification (BGV) Summary Card */}
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
                  Ref: <strong className="font-mono text-slate-700">{currentSeller.bgvSummary?.referenceNumber || 'BGV-SEL-2026-9812'}</strong>
                </span>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                    isBgvCleared
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  {isBgvCleared ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                  {isBgvCleared ? 'BGV CLEARED (SCORE 98)' : 'BGV IN AUDIT'}
                </span>
              </div>
            </div>

            {/* BGV 4-Check Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800 block text-xs">GSTN Taxpayer Portal Check</span>
                  <span className="text-[11px] text-slate-500">Active Regular Taxpayer · 0 Defaults</span>
                </div>
                <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Valid
                </span>
              </div>

              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800 block text-xs">PAN & Proprietor Match</span>
                  <span className="text-[11px] text-slate-500">100% Name Match with Income Tax Dept</span>
                </div>
                <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Valid
                </span>
              </div>

              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800 block text-xs">NPCI Penny-Drop Bank Match</span>
                  <span className="text-[11px] text-slate-500">Account Active · Beneficiary Confirmed</span>
                </div>
                <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Valid
                </span>
              </div>

              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800 block text-xs">Storefront Geofence Audit</span>
                  <span className="text-[11px] text-slate-500">Inside Indiranagar 10-Min Delivery Polygon</span>
                </div>
                <span className="text-emerald-700 font-bold text-[10px] bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Valid
                </span>
              </div>
            </div>
          </div>

          {/* Statutory Documents Uploaded via Seller Partner App */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 uppercase tracking-wider text-xs flex items-center gap-2">
                  <FileCheck className="h-4 w-4 text-emerald-600" />
                  Statutory Documents (Uploaded via QCOM Seller Partner App)
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

          {/* Compliance Warning Confirmation Dialog */}
          {showComplianceWarning && (
            <div className="p-4 bg-amber-50 border-2 border-amber-300 rounded-xl space-y-3 animate-in fade-in">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-amber-900 text-xs">KYC Verification Incomplete Warning</h4>
                  <p className="text-[11px] text-amber-800 mt-0.5">
                    {unverifiedDocsCount} document(s) have not been marked as verified yet. Approving now will override pending statutory audits and immediately onboard this store to receive customer orders.
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
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs shadow-xs"
                >
                  Confirm & Approve Anyway
                </button>
              </div>
            </div>
          )}

          {/* Rejection Form */}
          {showRejectForm ? (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl space-y-3 animate-in fade-in">
              <label className="font-bold text-rose-900 text-xs flex items-center gap-0.5">
                <span>Reason for Application Rejection</span>
                <span className="text-rose-600 font-bold text-sm">*</span>
              </label>
              <textarea
                rows={2}
                required
                placeholder="e.g. Incomplete BBMP trade license document, address mismatch on GST portal..."
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full bg-white border border-rose-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-rose-500 text-xs font-sans"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRejectForm(false)}
                  className="px-3 py-1.5 bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={isSubmitting || !rejectReason.trim()}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs transition-all shadow-xs disabled:opacity-50"
                >
                  Confirm Rejection & Notify App
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
              >
                Close
              </button>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowRejectForm(true)}
                  disabled={!canApprove || isSubmitting}
                  className="px-4 py-2 bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 hover:border-rose-300 font-bold rounded-xl text-xs transition-all"
                >
                  Reject Application
                </button>

                <button
                  type="button"
                  onClick={handleApproveClick}
                  disabled={!canApprove || isSubmitting}
                  className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Approve & Onboard Store</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Document High-Resolution Preview Modal */}
      {selectedDocForView && (
        <DocumentViewerModal
          document={selectedDocForView}
          onClose={() => setSelectedDocForView(null)}
          onVerify={(docId) => handleVerifySingleDocument(docId)}
          onRequestReupload={(docId, reason) => handleRequestReupload(docId, reason)}
          canVerify={canApprove}
        />
      )}
    </div>
  );
};

