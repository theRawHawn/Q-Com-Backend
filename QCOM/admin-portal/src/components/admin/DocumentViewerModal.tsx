import React, { useState } from 'react';
import {
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
  ShieldCheck,
  Smartphone,
  Eye,
  Building,
  User,
  Calendar,
  Hash,
  Sparkles,
  ExternalLink,
  MapPin,
  Check,
  RefreshCw,
} from 'lucide-react';
import { UploadedDocument } from '../../types/admin';

interface DocumentViewerModalProps {
  document: UploadedDocument;
  onClose: () => void;
  onVerify?: (docId: string) => void;
  onRequestReupload?: (docId: string, reason: string) => void;
  onReject?: (docId: string, reason: string) => void;
  canVerify?: boolean;
}

export const DocumentViewerModal: React.FC<DocumentViewerModalProps> = ({
  document,
  onClose,
  onVerify,
  onRequestReupload,
  onReject,
  canVerify = true,
}) => {
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [rotation, setRotation] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<'preview' | 'ocr' | 'audit'>('preview');
  const [showReuploadForm, setShowReuploadForm] = useState(false);
  const [reuploadReason, setReuploadReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const handleZoomIn = () => setZoomLevel((prev) => Math.min(prev + 25, 200));
  const handleZoomOut = () => setZoomLevel((prev) => Math.max(prev - 25, 50));
  const handleResetZoom = () => {
    setZoomLevel(100);
    setRotation(0);
  };
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);

  const handleConfirmReupload = () => {
    if (!reuploadReason.trim()) return;
    if (onRequestReupload) {
      onRequestReupload(document.id, reuploadReason);
    }
    setShowReuploadForm(false);
  };

  const handleConfirmReject = () => {
    if (!rejectReason.trim()) return;
    if (onReject) {
      onReject(document.id, rejectReason);
    }
    setShowRejectForm(false);
  };

  // Render simulated document visual based on docType
  const renderDocumentVisual = () => {
    switch (document.docType) {
      case 'AADHAAR':
        return (
          <div className="w-full max-w-lg mx-auto bg-gradient-to-b from-amber-50/80 via-white to-amber-50/50 border-2 border-amber-300/80 rounded-2xl p-6 shadow-md text-slate-800 relative overflow-hidden">
            {/* Header / National Emblem simulation */}
            <div className="flex items-center justify-between border-b-2 border-amber-500 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-full bg-amber-600 text-white flex items-center justify-center font-bold text-xs shadow-inner">
                  GOI
                </div>
                <div>
                  <div className="text-[11px] font-extrabold text-amber-950 uppercase tracking-wide">Government of India</div>
                  <div className="text-[9px] text-amber-800 font-semibold">Unique Identification Authority of India (UIDAI)</div>
                </div>
              </div>
              <div className="text-right">
                <span className="inline-block px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded text-[10px] font-bold">
                  e-Aadhaar Verified
                </span>
              </div>
            </div>

            {/* Body */}
            <div className="grid grid-cols-3 gap-4 items-center">
              {/* Photo placeholder */}
              <div className="col-span-1 flex flex-col items-center justify-center bg-slate-100 border border-slate-300 rounded-xl h-36 relative overflow-hidden">
                <User className="h-16 w-16 text-slate-400" />
                <span className="absolute bottom-1 bg-slate-800/80 text-white text-[8px] px-2 py-0.5 rounded font-mono">
                  BIOMETRIC
                </span>
              </div>

              {/* Data */}
              <div className="col-span-2 space-y-2 text-xs">
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Name / नाम:</span>
                  <span className="font-bold text-slate-900 text-sm">{document.ocrData?.name || 'Applicant'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">DOB / जन्म तिथि:</span>
                  <span className="font-medium text-slate-800">{document.ocrData?.dob || '14/08/1998'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Gender / लिंग:</span>
                  <span className="font-medium text-slate-800">{document.ocrData?.gender || 'Male / पुरूष'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Address:</span>
                  <span className="text-[11px] text-slate-600 line-clamp-2">{document.ocrData?.address || 'Karnataka, India'}</span>
                </div>
              </div>
            </div>

            {/* Aadhaar Number footer */}
            <div className="mt-5 pt-3 border-t border-slate-200 text-center">
              <div className="text-[10px] text-slate-500 font-semibold tracking-wider uppercase">Your Aadhaar No. / आधार संख्या</div>
              <div className="font-mono text-base font-extrabold tracking-widest text-slate-900 mt-0.5">
                {document.documentNumber || 'XXXX XXXX 4401'}
              </div>
            </div>

            {/* Watermark stamp */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-5 rotate-[-25deg] text-6xl font-bold uppercase text-slate-900">
              UIDAI VERIFIED
            </div>
          </div>
        );

      case 'DRIVING_LICENSE':
        return (
          <div className="w-full max-w-lg mx-auto bg-gradient-to-br from-sky-50 via-white to-blue-50 border-2 border-sky-300 rounded-2xl p-6 shadow-md text-slate-800 relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between border-b-2 border-sky-600 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-lg bg-sky-700 text-white flex items-center justify-center font-bold text-xs shadow-inner">
                  DL
                </div>
                <div>
                  <div className="text-[11px] font-extrabold text-sky-950 uppercase tracking-wide">Union of India · Transport Dept</div>
                  <div className="text-[9px] text-sky-800 font-semibold">Parivahan Driving License Smart Card</div>
                </div>
              </div>
              <span className="px-2 py-0.5 bg-sky-100 text-sky-800 border border-sky-300 rounded text-[10px] font-bold">
                Sarathi Validated
              </span>
            </div>

            {/* Body */}
            <div className="grid grid-cols-3 gap-4 items-center">
              <div className="col-span-1 flex flex-col items-center justify-center bg-sky-100/60 border border-sky-200 rounded-xl h-36">
                <User className="h-16 w-16 text-sky-600" />
                <span className="text-[8px] font-bold text-sky-800 mt-1 uppercase">Smart Chip</span>
              </div>

              <div className="col-span-2 space-y-2 text-xs">
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">License No:</span>
                  <span className="font-mono font-bold text-slate-900 text-sm">{document.documentNumber || 'KA032023009912'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Card Holder Name:</span>
                  <span className="font-bold text-slate-800">{document.ocrData?.name || 'Applicant'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Authorized Vehicle Classes:</span>
                  <span className="font-semibold text-sky-900 bg-sky-100 px-2 py-0.5 rounded text-[11px]">
                    {document.ocrData?.vehicleClass || 'MCWG (Motorcycle with Gear) + LMV'}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Valid Until:</span>
                  <span className="font-bold text-emerald-700">{document.ocrData?.expiry || '14-02-2039'}</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-4 pt-3 border-t border-sky-200 flex items-center justify-between text-[11px] text-slate-600">
              <span>Issuing Authority: <strong className="text-slate-800">{document.ocrData?.rto || 'RTO KA-03 Indiranagar'}</strong></span>
              <span className="font-mono text-emerald-700 font-bold">● ACTIVE</span>
            </div>
          </div>
        );

      case 'GST_CERTIFICATE':
        return (
          <div className="w-full max-w-lg mx-auto bg-white border-2 border-slate-300 rounded-2xl p-6 shadow-md text-slate-800 relative">
            {/* GST Header */}
            <div className="text-center border-b-2 border-slate-900 pb-3 mb-4">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Government of India</div>
              <div className="text-sm font-bold text-slate-900 uppercase tracking-wider">Goods and Services Tax Network</div>
              <div className="text-[11px] font-bold text-emerald-800 mt-0.5">Form GST REG-06 · Registration Certificate</div>
            </div>

            {/* Details */}
            <div className="space-y-3 text-xs">
              <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-200 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-emerald-700 font-bold uppercase block">Registration Number (GSTIN)</span>
                  <span className="font-mono font-bold text-slate-900 text-sm">{document.documentNumber || '29AABCS1429M1Z8'}</span>
                </div>
                <span className="px-2 py-0.5 bg-emerald-200 text-emerald-950 font-bold text-[10px] rounded">
                  Active Regular Taxpayer
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                <div>
                  <span className="text-[10px] text-slate-500 font-semibold block uppercase">Legal Name:</span>
                  <span className="font-bold text-slate-900">{document.ocrData?.legalName || 'Trading Enterprise'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 font-semibold block uppercase">Trade Name:</span>
                  <span className="font-bold text-slate-900">{document.ocrData?.tradeName || 'Q-Store Mart'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 font-semibold block uppercase">Constitution of Business:</span>
                  <span className="font-medium text-slate-800">{document.ocrData?.constitution || 'Sole Proprietorship'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 font-semibold block uppercase">Date of Validity:</span>
                  <span className="font-medium text-slate-800">{document.ocrData?.validFrom || 'From 01/07/2021 to Ongoing'}</span>
                </div>
              </div>

              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                <span className="text-[10px] text-slate-500 font-semibold block uppercase">Principal Place of Business:</span>
                <span className="text-slate-800 font-medium">{document.ocrData?.address || '100 Ft Road, Indiranagar, Bengaluru 560038'}</span>
              </div>
            </div>

            {/* Official Stamp */}
            <div className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
              <span>Digitally Signed by GST System</span>
              <span className="text-emerald-700 font-semibold flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                GST Portal API Verified
              </span>
            </div>
          </div>
        );

      case 'STORE_PHOTO':
        return (
          <div className="w-full max-w-lg mx-auto bg-slate-900 rounded-2xl overflow-hidden shadow-xl relative border border-slate-700">
            {/* Storefront Image */}
            <div className="h-64 bg-slate-800 flex flex-col items-center justify-center relative">
              <Building className="h-20 w-20 text-slate-600 mb-2" />
              <span className="text-xs font-semibold text-slate-400">Hyperlocal Partner Storefront Scan</span>

              {/* Geo-tagging overlay */}
              <div className="absolute bottom-3 left-3 right-3 bg-slate-950/80 backdrop-blur-xs text-white p-2.5 rounded-xl border border-slate-700 text-[11px] space-y-1">
                <div className="flex items-center justify-between font-mono font-bold text-emerald-400">
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-emerald-400" />
                    GPS: {document.ocrData?.lat || '12.9719° N'}, {document.ocrData?.lng || '77.6412° E'}
                  </span>
                  <span className="text-slate-300">Accuracy: ±3.2m</span>
                </div>
                <div className="text-slate-300 text-[10px] truncate">
                  {document.ocrData?.address || 'Indiranagar Main Blvd, Bengaluru, Karnataka 560038'}
                </div>
                <div className="text-slate-400 text-[9px] flex items-center justify-between pt-0.5 border-t border-slate-800">
                  <span>Device: Samsung Galaxy S23 (Exif Timestamp Verified)</span>
                  <span className="text-emerald-400 font-bold">10-Min SLA Geofenced ✓</span>
                </div>
              </div>
            </div>
          </div>
        );

      default:
        // Generic official certificate/document preview
        return (
          <div className="w-full max-w-lg mx-auto bg-white border-2 border-slate-200 rounded-2xl p-6 shadow-md text-slate-800 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="h-10 w-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">{document.title}</h4>
                  <span className="text-[10px] text-slate-500 font-mono">Ref: {document.documentNumber || document.fileName}</span>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  document.verificationStatus === 'VERIFIED'
                    ? 'bg-emerald-100 text-emerald-800'
                    : document.verificationStatus === 'REJECTED'
                    ? 'bg-rose-100 text-rose-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {document.verificationStatus}
              </span>
            </div>

            {/* Document OCR fields */}
            {document.ocrData && (
              <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-200 space-y-2 text-xs">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                  Extracted Document Attributes
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(document.ocrData).map(([key, val]) => (
                    <div key={key} className="bg-white p-2 rounded-lg border border-slate-200/80">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold block">{key}</span>
                      <span className="font-bold text-slate-800 truncate block">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs text-slate-600">
              <span>File: <strong className="text-slate-800 font-mono">{document.fileName}</strong></span>
              <span>Size: <strong className="text-slate-800 font-mono">{document.fileSize}</strong></span>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[94vh] animate-in fade-in zoom-in-95">
        {/* Top Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center font-bold">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">{document.title}</h3>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                    document.verificationStatus === 'VERIFIED'
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : document.verificationStatus === 'REJECTED'
                      ? 'bg-rose-100 text-rose-800 border border-rose-300'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  {document.verificationStatus === 'VERIFIED' ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      Verified
                    </>
                  ) : document.verificationStatus === 'REJECTED' ? (
                    <>
                      <XCircle className="h-3 w-3" />
                      Rejected
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3 w-3" />
                      Pending Audit
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                <span className="flex items-center gap-1 font-medium text-indigo-700 bg-indigo-50 px-2 py-0.2 rounded border border-indigo-100">
                  <Smartphone className="h-3 w-3" />
                  {document.uploadedVia}
                </span>
                <span>·</span>
                <span className="font-mono text-slate-600">{document.uploadedAt}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 rounded-full transition-colors"
            title="Close Viewer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action / Zoom Toolbar */}
        <div className="px-5 py-2.5 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          {/* Navigation Tabs inside modal */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1 rounded-md transition-all ${
                activeTab === 'preview' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Document Scan
            </button>
            <button
              onClick={() => setActiveTab('ocr')}
              className={`px-3 py-1 rounded-md transition-all ${
                activeTab === 'ocr' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Extracted OCR Metadata
            </button>
            <button
              onClick={() => setActiveTab('audit')}
              className={`px-3 py-1 rounded-md transition-all ${
                activeTab === 'audit' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Statutory API Match
            </button>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-2 py-1 rounded-lg">
            <button
              onClick={handleZoomOut}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200"
              title="Zoom Out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono text-[11px] font-semibold text-slate-700 w-10 text-center">
              {zoomLevel}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200"
              title="Zoom In"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <div className="h-3.5 w-px bg-slate-300 mx-0.5" />
            <button
              onClick={handleRotate}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200"
              title="Rotate 90deg"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleResetZoom}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200"
              title="Reset View"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Modal Body Area */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-100/70">
          {activeTab === 'preview' && (
            <div className="flex items-center justify-center min-h-[340px]">
              <div
                style={{
                  transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
                  transition: 'transform 0.15s ease-out',
                }}
                className="w-full"
              >
                {renderDocumentVisual()}
              </div>
            </div>
          )}

          {activeTab === 'ocr' && (
            <div className="max-w-2xl mx-auto space-y-4">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-600" />
                    Automated OCR Text Extraction
                  </h4>
                  <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Confidence: 99.4%
                  </span>
                </div>

                <p className="text-xs text-slate-500">
                  Extracted via the Q-Commerce Document OCR Engine upon partner upload from mobile app.
                </p>

                <div className="space-y-2 text-xs">
                  {document.ocrData && Object.keys(document.ocrData).length > 0 ? (
                    Object.entries(document.ocrData).map(([key, val]) => (
                      <div key={key} className="flex items-center justify-between p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
                        <span className="font-semibold text-slate-600 uppercase text-[10px]">{key}</span>
                        <span className="font-mono font-bold text-slate-900">{val}</span>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 text-center text-slate-400 text-xs">
                      No key-value attributes registered.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="max-w-2xl mx-auto space-y-3">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-3">
                <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Statutory Cross-Reference & API Checks
                </h4>
                <div className="space-y-2 text-xs">
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Identity / Entity Database Search</span>
                      <span className="text-slate-500 text-[11px]">Direct Govt Gateway API check</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-bold rounded text-[10px]">
                      PASSED (100% Match)
                    </span>
                  </div>

                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Exif & Mobile Device Telemetry</span>
                      <span className="text-slate-500 text-[11px]">Unmodified camera capture from native app</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-bold rounded text-[10px]">
                      GENUINE CAPTURE
                    </span>
                  </div>

                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Fraud & Blacklist Register</span>
                      <span className="text-slate-500 text-[11px]">QCOM National Fleet Fraud Network</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-bold rounded text-[10px]">
                      CLEAN (0 Flags)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer & Actions */}
        <div className="p-4 bg-white border-t border-slate-200">
          {showReuploadForm ? (
            <div className="space-y-3 bg-amber-50 p-3 rounded-xl border border-amber-200 animate-in fade-in">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-amber-900">
                  Request Document Re-upload via Mobile App:
                </span>
                <button
                  onClick={() => setShowReuploadForm(false)}
                  className="text-amber-700 text-xs font-semibold hover:underline"
                >
                  Cancel
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. Blurry photo, corner cut off, or expired certificate..."
                  value={reuploadReason}
                  onChange={(e) => setReuploadReason(e.target.value)}
                  className="flex-1 bg-white border border-amber-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <button
                  onClick={handleConfirmReupload}
                  disabled={!reuploadReason.trim()}
                  className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs disabled:opacity-50"
                >
                  Send Push to App
                </button>
              </div>
            </div>
          ) : showRejectForm ? (
            <div className="space-y-3 bg-rose-50 p-3 rounded-xl border border-rose-200 animate-in fade-in">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-rose-900">
                  Reject Document Reason:
                </span>
                <button
                  onClick={() => setShowRejectForm(false)}
                  className="text-rose-700 text-xs font-semibold hover:underline"
                >
                  Cancel
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. Fraudulent document, name mismatch with bank account..."
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="flex-1 bg-white border border-rose-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-rose-500"
                />
                <button
                  onClick={handleConfirmReject}
                  disabled={!rejectReason.trim()}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs disabled:opacity-50"
                >
                  Confirm Rejection
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowReuploadForm(true)}
                  disabled={!canVerify}
                  className="px-3.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  Request Re-upload via App
                </button>
                <button
                  onClick={() => setShowRejectForm(true)}
                  disabled={!canVerify}
                  className="px-3.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  Reject Document
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
                >
                  Close
                </button>
                {canVerify && document.verificationStatus !== 'VERIFIED' && onVerify && (
                  <button
                    onClick={() => {
                      onVerify(document.id);
                      onClose();
                    }}
                    className="px-5 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors shadow-xs"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Mark as Verified</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
