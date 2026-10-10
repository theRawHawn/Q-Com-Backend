import React, { useState, useEffect } from 'react';
import { 
  X, 
  Download, 
  Printer, 
  FileText, 
  Share2,
  Check,
  Building2,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  ShieldCheck
} from 'lucide-react';
import QRCode from 'qrcode';
import { Order } from '../types';
import { 
  generateInvoicePDF, 
  computeOrderInvoices, 
  DetailedGstInvoiceData,
  OrderInvoiceBundle 
} from '../utils/invoiceGenerator';

interface InvoiceModalProps {
  order: Order | null;
  isOpen: boolean;
  onClose: () => void;
  initialPageIndex?: number;
}

export const InvoiceModal: React.FC<InvoiceModalProps> = ({
  order,
  isOpen,
  onClose,
  initialPageIndex = 0,
}) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [activePageIndex, setActivePageIndex] = useState<number>(initialPageIndex);
  const [qrCodeDataUrls, setQrCodeDataUrls] = useState<Record<number, string>>({});

  const bundle: OrderInvoiceBundle | null = order ? computeOrderInvoices(order) : null;
  const currentDoc: DetailedGstInvoiceData | null = bundle?.documents[activePageIndex] || bundle?.summaryDoc || null;
  const totalPages = bundle?.documents.length || 1;

  // Reset or update page when order or initialPageIndex changes
  useEffect(() => {
    setActivePageIndex(Math.min(initialPageIndex, (bundle?.documents.length || 1) - 1));
  }, [order?.id, initialPageIndex]);

  // Pre-generate QR Code data URLs only for documents that have qrCodePayload
  useEffect(() => {
    if (!bundle) return;
    let isCancelled = false;

    Promise.all(
      bundle.documents.map(async (doc) => {
        if (!doc.qrCodePayload) return '';
        try {
          return await QRCode.toDataURL(doc.qrCodePayload, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 140,
          });
        } catch {
          return '';
        }
      })
    ).then((urls) => {
      if (!isCancelled) {
        const map: Record<number, string> = {};
        urls.forEach((url, i) => {
          map[i] = url;
        });
        setQrCodeDataUrls(map);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [bundle?.orderId]);

  if (!isOpen || !order || !bundle || !currentDoc) return null;

  const handleDownloadPDF = async () => {
    setIsDownloading(true);
    try {
      await generateInvoicePDF(order, { autoDownload: true });
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3000);
    } catch (err) {
      console.error('Error downloading PDF:', err);
    } finally {
      setIsDownloading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleCopyLink = () => {
    navigator.clipboard?.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl sm:rounded-3xl w-full max-w-4xl max-h-[94vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Clean, Uncluttered Modal Header */}
        <div className="bg-slate-900 text-white px-4 sm:px-6 py-3 flex items-center justify-between shrink-0 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-400">
              <FileText className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-sm text-white tracking-tight">
              Tax Invoice • {order.id.startsWith('#') ? order.id : `#${order.id}`}
            </h3>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              onClick={handlePrint}
              title="Print Invoice"
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer hidden sm:flex items-center gap-1.5 text-xs font-semibold"
            >
              <Printer className="w-4 h-4" />
              <span>Print</span>
            </button>

            <button
              onClick={handleCopyLink}
              title="Share Invoice Link"
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            >
              {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4" />}
              <span className="hidden sm:inline">{copiedLink ? 'Copied' : 'Share'}</span>
            </button>

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-300 hover:text-white transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Page Switcher Navigation (If multi-document bundle) */}
        {totalPages > 1 && (
          <div className="bg-slate-50 border-b border-slate-200/80 px-4 py-2 flex items-center justify-between gap-3 overflow-x-auto shrink-0">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {bundle.documents.map((doc, idx) => {
                const isActive = idx === activePageIndex;
                const pageLabel = doc.docType === 'summary'
                  ? 'Overview Summary'
                  : doc.docType === 'qcom'
                  ? 'Delivery & Platform'
                  : doc.seller.name;

                return (
                  <button
                    key={doc.invoiceNumber}
                    onClick={() => setActivePageIndex(idx)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                      isActive
                        ? 'bg-slate-900 text-white shadow-xs'
                        : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-slate-300'}`} />
                    <span>{pageLabel}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 shrink-0 bg-white px-2 py-1 rounded-xl border border-slate-200/80 text-xs text-slate-500 font-medium">
              <button
                onClick={() => setActivePageIndex((p) => Math.max(0, p - 1))}
                disabled={activePageIndex === 0}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-700 disabled:opacity-20 transition cursor-pointer"
                title="Previous Page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-semibold text-slate-800">
                {activePageIndex + 1} / {totalPages}
              </span>
              <button
                onClick={() => setActivePageIndex((p) => Math.min(totalPages - 1, p + 1))}
                disabled={activePageIndex === totalPages - 1}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-700 disabled:opacity-20 transition cursor-pointer"
                title="Next Page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Invoice Paper Document Viewer */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-8 bg-slate-100/60">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 p-6 sm:p-8 space-y-6 max-w-3xl mx-auto text-slate-800 font-sans text-xs">
            
            {/* Header: Brand & Document Title */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-5 border-b border-slate-200/80">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-black text-slate-900 text-lg tracking-tight">RUSHQ</span>
                  <span className="bg-slate-900 text-white text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide">OFFICIAL</span>
                </div>
                <p className="text-xs text-slate-500 font-medium">Hyperlocal Address Delivery & Trade Procurement</p>
                <p className="text-[10px] text-slate-400">
                  CIN: U72900KA2026PTC192841 • GST E-Commerce Operator
                </p>
              </div>

              <div className="sm:text-right space-y-1">
                <div className="text-xl font-black text-slate-900 tracking-tight">
                  {currentDoc.docTitle}
                </div>
                <div className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-800 font-bold text-[10px] tracking-wide uppercase px-2.5 py-0.5 rounded-full border border-emerald-200/80">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>{currentDoc.recipientPill}</span>
                </div>
              </div>
            </div>

            {/* Key Metadata Strip */}
            <div className="bg-slate-50/80 rounded-xl p-3.5 border border-slate-200/60 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Invoice No</span>
                <span className="font-mono font-bold text-slate-900 text-xs mt-0.5 block">{currentDoc.invoiceNumber}</span>
              </div>
              <div>
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Date & Time</span>
                <span className="text-slate-800 font-medium text-xs mt-0.5 block">{currentDoc.invoiceDate}, {currentDoc.invoiceTime}</span>
              </div>
              <div>
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Place of Supply</span>
                <span className="font-bold text-slate-800 text-xs mt-0.5 block">{currentDoc.placeOfSupply}</span>
              </div>
              <div>
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Supply Type</span>
                <span className="font-bold text-slate-800 text-xs mt-0.5 block">{currentDoc.isInterState ? 'IGST (Inter-State)' : 'CGST + SGST'}</span>
              </div>
            </div>

            {/* IRN & e-Invoice Strip (if applicable) */}
            {currentDoc.isEInvoice && (currentDoc.irn || currentDoc.signedQRCode || currentDoc.ackNo) ? (
              <div className="bg-slate-900 text-white rounded-xl p-3.5 flex items-center justify-between gap-3 shadow-2xs">
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span className="font-bold text-xs tracking-wide">GST e-Invoice Verified</span>
                  </div>
                  {currentDoc.irn && (
                    <div className="text-slate-300 font-mono text-[10px] truncate bg-slate-800/80 px-2 py-1 rounded border border-slate-700/50">
                      <span className="text-slate-400 font-sans">IRN: </span>{currentDoc.irn}
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-[10px] text-slate-400 font-medium">
                    {currentDoc.ackNo && <span>Ack: {currentDoc.ackNo}</span>}
                    {currentDoc.ackDate && <span>Date: {currentDoc.ackDate}</span>}
                  </div>
                </div>

                {qrCodeDataUrls[activePageIndex] ? (
                  <div className="shrink-0 bg-white p-1.5 rounded-lg">
                    <img 
                      src={qrCodeDataUrls[activePageIndex]} 
                      alt="e-Invoice QR" 
                      className="w-14 h-14" 
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Seller & Buyer Grid (Clean, minimalist split layout) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-1">
              
              {/* Supplier Details */}
              <div className="space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 pb-1 border-b border-slate-200/80">
                  <Building2 className="w-3.5 h-3.5 text-slate-500" />
                  <span>
                    {currentDoc.docType === 'qcom' 
                      ? 'Logistics Operator'
                      : currentDoc.docType === 'summary'
                      ? 'Supplier Hub'
                      : 'Issued By (Seller)'}
                  </span>
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">{currentDoc.seller.name}</h4>
                  <p className="text-slate-600 text-xs mt-1 leading-relaxed">{currentDoc.seller.address}</p>
                </div>
                <div className="pt-2 flex items-center gap-4 text-xs font-medium text-slate-600">
                  <div>
                    <span className="text-slate-400 text-[10px] uppercase font-semibold block">GSTIN</span>
                    <span className="font-mono font-bold text-slate-900">{currentDoc.seller.gstin}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[10px] uppercase font-semibold block">State</span>
                    <span className="text-slate-800">{currentDoc.seller.stateName} ({currentDoc.seller.stateCode})</span>
                  </div>
                </div>
              </div>

              {/* Buyer / Recipient Details */}
              <div className="space-y-2">
                <div className="flex items-center justify-between pb-1 border-b border-slate-200/80">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />
                    <span>Recipient Details</span>
                  </div>
                  {currentDoc.buyer.isB2B ? (
                    <span className="bg-emerald-50 text-emerald-800 font-bold text-[9px] uppercase px-2 py-0.5 rounded-full border border-emerald-200/80">
                      B2B GST
                    </span>
                  ) : (
                    <span className="bg-slate-100 text-slate-600 font-medium text-[9px] uppercase px-2 py-0.5 rounded-full border border-slate-200">
                      Consumer
                    </span>
                  )}
                </div>

                <div className="space-y-2.5">
                  {/* Bill To */}
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Bill To</span>
                    <div className="font-bold text-slate-900 text-xs mt-0.5">{currentDoc.buyer.legalName}</div>
                    <p className="text-slate-600 text-xs mt-0.5 leading-relaxed">{currentDoc.buyer.billingAddress}</p>
                  </div>

                  {/* Ship To */}
                  {currentDoc.buyer.billingAddress !== currentDoc.buyer.shippingAddress && (
                    <div className="pt-2 border-t border-slate-100">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Ship To</span>
                      <p className="text-slate-600 text-xs mt-0.5 leading-relaxed">{currentDoc.buyer.shippingAddress}</p>
                      {currentDoc.buyer.contactName && (
                        <p className="text-[11px] text-slate-500 mt-1 font-medium">
                          Contact: {currentDoc.buyer.contactName} {currentDoc.buyer.phone ? `(${currentDoc.buyer.phone})` : ''}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="pt-2 flex items-center gap-4 text-xs font-medium text-slate-600 border-t border-slate-100">
                    <div>
                      <span className="text-slate-400 text-[10px] uppercase font-semibold block">Buyer GSTIN</span>
                      <span className="font-mono font-bold text-slate-900">{currentDoc.buyer.gstin}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] uppercase font-semibold block">State</span>
                      <span className="text-slate-800">{currentDoc.buyer.stateName} ({currentDoc.buyer.stateCode})</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>

            {/* Clean Modern Itemized Table */}
            <div className="border border-slate-200/80 rounded-xl overflow-hidden pt-1">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 font-bold uppercase text-[9px] tracking-wider border-b border-slate-200/80">
                    <tr>
                      <th className="py-2.5 px-3 text-center w-8">#</th>
                      <th className="py-2.5 px-3">Item Description</th>
                      <th className="py-2.5 px-3 text-center">HSN</th>
                      <th className="py-2.5 px-3 text-center">Qty</th>
                      <th className="py-2.5 px-3 text-right">Taxable</th>
                      {currentDoc.isInterState ? (
                        <th className="py-2.5 px-3 text-right">IGST</th>
                      ) : (
                        <>
                          <th className="py-2.5 px-3 text-right">CGST</th>
                          <th className="py-2.5 px-3 text-right">SGST</th>
                        </>
                      )}
                      <th className="py-2.5 px-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {currentDoc.items.map((it) => (
                      <tr key={it.slNo} className="hover:bg-slate-50/50 transition">
                        <td className="py-2.5 px-3 text-center text-slate-400 font-mono text-xs">{it.slNo}</td>
                        <td className="py-2.5 px-3">
                          <div className="font-bold text-slate-900">{it.description}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {it.brand && (
                              <span className="text-[10px] text-slate-400 font-medium">Brand: {it.brand}</span>
                            )}
                            {currentDoc.docType === 'summary' && it.sellerName && (
                              <span className="text-[10px] text-emerald-700 font-semibold">• Seller: {it.sellerName}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono text-slate-500 text-xs">{it.hsnCode}</td>
                        <td className="py-2.5 px-3 text-center font-bold text-slate-800 text-xs">{it.quantity} {it.uqc}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-slate-700 text-xs">₹{it.taxableValue.toFixed(2)}</td>
                        
                        {currentDoc.isInterState ? (
                          <td className="py-2.5 px-3 text-right text-slate-600 text-xs">
                            <div>₹{it.igstAmount.toFixed(2)}</div>
                            <div className="text-[9px] text-slate-400">({it.igstRate}%)</div>
                          </td>
                        ) : (
                          <>
                            <td className="py-2.5 px-3 text-right text-slate-600 text-xs">
                              <div>₹{it.cgstAmount.toFixed(2)}</div>
                              <div className="text-[9px] text-slate-400">({it.cgstRate}%)</div>
                            </td>
                            <td className="py-2.5 px-3 text-right text-slate-600 text-xs">
                              <div>₹{(it.sgstAmount || it.utgstAmount).toFixed(2)}</div>
                              <div className="text-[9px] text-slate-400">({it.sgstRate || it.utgstRate}%)</div>
                            </td>
                          </>
                        )}

                        <td className="py-2.5 px-3 text-right font-bold text-slate-900 text-xs">₹{it.totalAmount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Summary & Totals Section */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-6 pt-2">
              <div className="sm:col-span-6 space-y-3 flex flex-col justify-between">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Total Amount in Words</span>
                  <p className="font-medium text-slate-800 text-xs leading-relaxed capitalize bg-slate-50/80 p-2.5 rounded-xl border border-slate-200/60">
                    {currentDoc.amountInWords}
                  </p>
                </div>

                {currentDoc.buyer.isB2B && (
                  <div className="bg-emerald-50/60 rounded-xl p-3 border border-emerald-200/80 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-800 uppercase tracking-wide">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Input Tax Credit (ITC)</span>
                    </div>
                    <p className="text-[11px] text-emerald-950 font-medium leading-relaxed">
                      Eligible for 100% ITC under CGST Act. <strong className="text-emerald-800">₹{currentDoc.totalGst.toFixed(2)}</strong> will auto-reflect in GSTR-2B.
                    </p>
                  </div>
                )}
              </div>

              {/* Calculations Box */}
              <div className="sm:col-span-6 space-y-2 text-xs">
                <div className="flex justify-between text-slate-600 py-1 border-b border-slate-100">
                  <span>Taxable Amount</span>
                  <span className="font-mono font-medium text-slate-900">₹{currentDoc.totalTaxableValue.toFixed(2)}</span>
                </div>

                {currentDoc.isInterState ? (
                  <div className="flex justify-between text-slate-600 py-1 border-b border-slate-100">
                    <span>IGST</span>
                    <span className="font-mono font-medium text-slate-900">₹{currentDoc.totalIgst.toFixed(2)}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between text-slate-600 py-1 border-b border-slate-100">
                      <span>CGST</span>
                      <span className="font-mono font-medium text-slate-900">₹{currentDoc.totalCgst.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-slate-600 py-1 border-b border-slate-100">
                      <span>{currentDoc.isUnionTerritory ? 'UTGST' : 'SGST'}</span>
                      <span className="font-mono font-medium text-slate-900">₹{(currentDoc.totalSgst || currentDoc.totalUtgst).toFixed(2)}</span>
                    </div>
                  </>
                )}

                <div className="flex justify-between text-slate-400 py-1 border-b border-slate-100 text-[11px]">
                  <span>Rounding Off</span>
                  <span className="font-mono text-slate-600">
                    {currentDoc.roundOff >= 0 ? `+₹${currentDoc.roundOff.toFixed(2)}` : `-₹${Math.abs(currentDoc.roundOff).toFixed(2)}`}
                  </span>
                </div>

                <div className="flex justify-between items-center text-sm font-bold text-slate-900 bg-slate-900 text-white p-3 rounded-xl mt-2 shadow-xs">
                  <span>Total Payable</span>
                  <span className="font-mono text-base font-black text-emerald-400">₹{currentDoc.grandTotal.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Footer Digital Signature */}
            <div className="pt-4 border-t border-slate-200/80 flex items-center justify-between text-[10px] text-slate-400 font-medium">
              <p>System-generated digitally authenticated Tax Invoice under Section 31 CGST Act.</p>
              <p className="font-semibold text-slate-600">Page {activePageIndex + 1} of {totalPages}</p>
            </div>

          </div>
        </div>

        {/* Clean Bottom Modal Actions */}
        <div className="bg-slate-50 border-t border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-end gap-2.5 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold text-xs transition cursor-pointer"
          >
            Close
          </button>
          <button
            onClick={handleDownloadPDF}
            disabled={isDownloading}
            className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs transition flex items-center justify-center gap-2 shadow-md cursor-pointer disabled:opacity-50"
          >
            {downloadSuccess ? (
              <>
                <Check className="w-4 h-4 stroke-[3]" />
                <span>PDF Downloaded!</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>{isDownloading ? 'Generating PDF...' : 'Download PDF'}</span>
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  );
};
