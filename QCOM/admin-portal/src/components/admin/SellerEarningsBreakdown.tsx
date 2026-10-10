import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  CreditCard,
  ShoppingBag,
  Percent,
  Receipt,
  Download,
  Calendar,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Building,
  ShieldCheck,
  Package,
  Layers,
  ArrowUpRight,
  Filter,
  Info
} from 'lucide-react';
import { AdminSeller } from '../../types/admin';
import { exportToCsv } from '../../utils/exportToSheet';

export type SellerBreakdownPeriod = 'CURRENT_WEEK' | 'PREVIOUS_WEEK' | 'MONTHLY' | 'LIFETIME';

export interface SellerEarningsBreakdownProps {
  seller: AdminSeller;
  initialPeriod?: SellerBreakdownPeriod;
  onPeriodChange?: (period: SellerBreakdownPeriod) => void;
  showExportButton?: boolean;
}

export interface SellerOrderItem {
  id: string;
  orderNumber: string;
  placedAt: string;
  deliveryArea: string;
  itemSummary: string;
  itemCount: number;
  grossAmount: number;
  commissionPercent: number;
  commissionAmount: number;
  taxDeduction: number; // 1% TCS + 0.1% TDS
  packagingSubsidy: number;
  netPayable: number;
  settlementStatus: 'SETTLED' | 'PENDING' | 'PROCESSING';
  settlementUtr?: string;
  weeklyBatch: string;
}

export const SellerEarningsBreakdown: React.FC<SellerEarningsBreakdownProps> = ({
  seller,
  initialPeriod = 'CURRENT_WEEK',
  onPeriodChange,
  showExportButton = true,
}) => {
  const [period, setPeriod] = useState<SellerBreakdownPeriod>(initialPeriod);
  const [isExpandedList, setIsExpandedList] = useState(true);
  const [orderFilter, setOrderFilter] = useState<'all' | 'settled' | 'pending' | 'high_value'>('all');

  const handlePeriodChange = (newPeriod: SellerBreakdownPeriod) => {
    setPeriod(newPeriod);
    if (onPeriodChange) {
      onPeriodChange(newPeriod);
    }
  };

  // Base seller profile metrics with fallbacks (15% min take rate)
  const commissionRate = Math.max(15.0, seller.commissionRatePercent ?? 15.0);
  const dailyOrders = seller.todayOrders || seller.activeOrdersCount || Math.max(8, Math.round((seller.totalOrders || 140) / 18));
  const dailySales = seller.todaySales || Math.round(dailyOrders * 680);

  const weeklyOrders = seller.weeklyOrders || Math.round(dailyOrders * 6.8);
  const weeklySales = seller.weeklySales || Math.round(dailySales * 6.5);

  const monthlyOrders = seller.monthlyOrders || Math.round(dailyOrders * 28);
  const monthlySales = seller.monthlySales || Math.round(dailySales * 27.5);

  const lifetimeOrders = seller.lifetimeOrders || seller.totalOrders || 1240;
  const lifetimeSales = seller.lifetimeSales || Math.round(lifetimeOrders * 650);

  // Compute metrics for the selected period
  const breakdown = useMemo(() => {
    let grossSales = 0;
    let totalOrdersCount = 0;
    let periodTitle = '';
    let timeframeLabel = '';
    let dateRange = '';
    let payoutScheduleNote = '';

    switch (period) {
      case 'CURRENT_WEEK':
        grossSales = weeklySales;
        totalOrdersCount = weeklyOrders;
        periodTitle = 'Current Weekly Payout Cycle';
        timeframeLabel = 'Weekly Cycle (Mon 08 Sep – Sun 14 Sep)';
        dateRange = 'Live Active Cycle';
        payoutScheduleNote = 'Payout Scheduled: Next Monday at 06:00 AM';
        break;
      case 'PREVIOUS_WEEK':
        grossSales = Math.round(weeklySales * 0.94);
        totalOrdersCount = Math.round(weeklyOrders * 0.92);
        periodTitle = 'Previous Week Settlement (Settled)';
        timeframeLabel = 'Weekly Cycle (Mon 01 Sep – Sun 07 Sep)';
        dateRange = 'Completed & Disbursed';
        payoutScheduleNote = 'Disbursed via Bank Transfer on Mon, 08 Sep';
        break;
      case 'MONTHLY':
        grossSales = monthlySales;
        totalOrdersCount = monthlyOrders;
        periodTitle = 'Past 4 Weekly Cycles (Monthly)';
        timeframeLabel = '4 Weekly Cycles (01 Sep – 30 Sep 2026)';
        dateRange = 'Monthly Aggregation';
        payoutScheduleNote = '4 Weekly Payout Batches Combined';
        break;
      case 'LIFETIME':
        grossSales = lifetimeSales;
        totalOrdersCount = lifetimeOrders;
        periodTitle = 'All-Time Partner Economics';
        timeframeLabel = 'Store Lifetime History';
        dateRange = `Since ${seller.joinedDate || 'Nov 2025'}`;
        payoutScheduleNote = 'Cumulative Historical Performance';
        break;
    }

    const commissionDeducted = Math.round((grossSales * commissionRate) / 100);
    // GST TCS 1% + TDS 0.1% under Section 194-O
    const statutoryTaxes = Math.round((grossSales * 1.1) / 100);
    const netPayout = Math.max(0, grossSales - commissionDeducted - statutoryTaxes);
    const averageOrderValue = totalOrdersCount > 0 ? Math.round(grossSales / totalOrdersCount) : 0;
    const avgNetPerOrder = totalOrdersCount > 0 ? Math.round(netPayout / totalOrdersCount) : 0;

    // Generate realistic itemized order log
    const orderLogs: SellerOrderItem[] = [];
    const countToGenerate = period === 'CURRENT_WEEK' ? 14 : period === 'PREVIOUS_WEEK' ? 12 : 18;
    
    const categories = (seller.categories && seller.categories.length > 0)
      ? seller.categories
      : ['Electricals', 'Power Tools', 'Hardware & Fasteners', 'Plumbing & Fittings'];

    const areas = ['Koramangala 4th Block', 'HSR Layout Sector 1', 'BTM 2nd Stage', 'Indiranagar 100ft Rd', 'Bellandur EcoSpace', 'Jayanagar 4th T Block'];

    for (let i = 0; i < countToGenerate; i++) {
      const orderNum = 9840 - i;
      const cat = categories[i % categories.length];
      const itemCount = 1 + (i % 4);
      
      const baseCart = 280 + ((i * 137) % 1100);
      const grossAmt = Math.round(baseCart);
      const commAmt = Math.round((grossAmt * commissionRate) / 100);
      const taxAmt = Math.round((grossAmt * 1.1) / 100);
      const netPay = grossAmt - commAmt - taxAmt;

      let placedTime = 'Today, 03:15 PM';
      let status: 'SETTLED' | 'PENDING' | 'PROCESSING' = 'SETTLED';
      let utr: string | undefined = `NEFT/RBI2026${seller.id.slice(-4)}98${i}`;
      let batch = 'Week 37 (08-14 Sep)';

      if (period === 'CURRENT_WEEK') {
        const daysAgo = (i % 7);
        placedTime = daysAgo === 0 ? 'Today, 02:40 PM' : `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;
        status = i < 6 ? 'PENDING' : 'PROCESSING';
        utr = undefined; // Pending weekly batch payout
        batch = 'Week 37 (Current Live Cycle)';
      } else if (period === 'PREVIOUS_WEEK') {
        placedTime = `${(i % 7) + 8} days ago`;
        status = 'SETTLED';
        batch = 'Week 36 (Disbursed Mon, 08 Sep)';
      } else {
        placedTime = `${(i % 28) + 1} Sep 2026`;
        status = i < 3 ? 'PENDING' : 'SETTLED';
        if (status !== 'SETTLED') utr = undefined;
        batch = `Week ${34 + (i % 4)}`;
      }

      const itemSummary = itemCount === 1 
        ? `${cat} Item`
        : `${itemCount}x Items (${cat})`;

      orderLogs.push({
        id: `ord-log-${orderNum}`,
        orderNumber: `#ORD-${orderNum}`,
        placedAt: placedTime,
        deliveryArea: areas[i % areas.length],
        itemSummary,
        itemCount,
        grossAmount: grossAmt,
        commissionPercent: commissionRate,
        commissionAmount: commAmt,
        taxDeduction: taxAmt,
        packagingSubsidy: 0,
        netPayable: netPay,
        settlementStatus: status,
        settlementUtr: utr,
        weeklyBatch: batch,
      });
    }

    return {
      grossSales,
      totalOrdersCount,
      commissionDeducted,
      statutoryTaxes,
      netPayout,
      averageOrderValue,
      avgNetPerOrder,
      periodTitle,
      timeframeLabel,
      dateRange,
      payoutScheduleNote,
      orders: orderLogs,
    };
  }, [period, weeklySales, weeklyOrders, monthlySales, monthlyOrders, lifetimeSales, lifetimeOrders, seller, commissionRate]);

  // Dynamic filter counts
  const settledCount = useMemo(() => breakdown.orders.filter((o) => o.settlementStatus === 'SETTLED').length, [breakdown.orders]);
  const pendingCount = useMemo(() => breakdown.orders.filter((o) => o.settlementStatus === 'PENDING' || o.settlementStatus === 'PROCESSING').length, [breakdown.orders]);
  const highValueCount = useMemo(() => breakdown.orders.filter((o) => o.grossAmount >= 500).length, [breakdown.orders]);

  const filteredOrders = useMemo(() => {
    if (orderFilter === 'settled') return breakdown.orders.filter((o) => o.settlementStatus === 'SETTLED');
    if (orderFilter === 'pending') return breakdown.orders.filter((o) => o.settlementStatus === 'PENDING' || o.settlementStatus === 'PROCESSING');
    if (orderFilter === 'high_value') return breakdown.orders.filter((o) => o.grossAmount >= 500);
    return breakdown.orders;
  }, [breakdown.orders, orderFilter]);

  const handleExportOrdersCsv = () => {
    exportToCsv<SellerOrderItem>(
      `Seller_Weekly_Sales_${seller.name.replace(/\s+/g, '_')}_${period}`,
      [
        { header: 'Store Name', accessor: () => seller.name },
        { header: 'Weekly Batch', accessor: (o) => o.weeklyBatch },
        { header: 'Order ID', accessor: (o) => o.orderNumber },
        { header: 'Date & Time', accessor: (o) => o.placedAt },
        { header: 'Delivery Zone', accessor: (o) => o.deliveryArea },
        { header: 'Cart Items', accessor: (o) => o.itemSummary },
        { header: 'Gross Sales (INR)', accessor: (o) => o.grossAmount },
        { header: 'Commission Deducted (INR)', accessor: (o) => o.commissionAmount },
        { header: 'Commission Rate (%)', accessor: (o) => `${o.commissionPercent}%` },
        { header: 'TCS & TDS Tax (INR)', accessor: (o) => o.taxDeduction },
        { header: 'Net Store Payout (INR)', accessor: (o) => o.netPayable },
        { header: 'Settlement Status', accessor: (o) => o.settlementStatus },
        { header: 'Bank UTR', accessor: (o) => o.settlementUtr || 'Pending Weekly Clearance' },
      ],
      filteredOrders
    );
  };

  return (
    <div className="space-y-4">
      {/* Informative Weekly Payout Policy Banner */}
      <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200/80 rounded-2xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs shadow-2xs">
        <div className="flex items-center gap-2.5 text-indigo-950">
          <div className="h-8 w-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shrink-0 shadow-2xs">
            <Calendar className="h-4 w-4" />
          </div>
          <div>
            <span className="font-bold text-slate-900 block text-xs">
              Weekly Merchant Payout Policy (Monday Settlement Cycle)
            </span>
            <span className="text-slate-600 text-[11px]">
              Seller earnings accumulate Monday to Sunday and are automatically disbursed every Monday morning to the registered bank account.
            </span>
          </div>
        </div>

        <div className="bg-white px-3 py-1.5 rounded-xl border border-indigo-100 shadow-2xs shrink-0">
          <span className="text-[10px] text-slate-500 font-semibold uppercase block">Payout Frequency</span>
          <span className="text-xs font-extrabold text-indigo-700 font-mono">Weekly Every Monday</span>
        </div>
      </div>

      {/* Top Header & Weekly Cycle Selector Bar */}
      <div className="bg-slate-100/80 p-1.5 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3 border border-slate-200">
        {/* Period Selector Tabs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 w-full sm:w-auto bg-slate-200/80 p-1 rounded-xl gap-1">
          {[
            { id: 'CURRENT_WEEK', label: 'Current Week (Live)' },
            { id: 'PREVIOUS_WEEK', label: 'Previous Week' },
            { id: 'MONTHLY', label: 'Past 4 Weeks' },
            { id: 'LIFETIME', label: 'All-Time' },
          ].map((p) => {
            const isSelected = period === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePeriodChange(p.id as SellerBreakdownPeriod)}
                className={`py-1.5 px-3 rounded-lg text-xs font-bold transition-all whitespace-nowrap text-center ${
                  isSelected
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Date & Context Label + CSV Export */}
        <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-2 px-1 text-xs">
          <div className="flex items-center gap-1.5 text-slate-600 font-medium">
            <Clock className="h-3.5 w-3.5 text-indigo-600" />
            <span>{breakdown.timeframeLabel}</span>
          </div>

          {showExportButton && (
            <button
              type="button"
              onClick={handleExportOrdersCsv}
              className="flex items-center gap-1 bg-white hover:bg-slate-50 text-slate-700 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-300 shadow-2xs transition-colors shrink-0"
              title="Export statement to CSV"
            >
              <Download className="h-3 w-3 text-slate-500" />
              <span>Export CSV</span>
            </button>
          )}
        </div>
      </div>

      {/* Main KPI Summary Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* 1. Gross Merchandise Value */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Gross Store GMV</span>
            <div className="h-7 w-7 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
              <ShoppingBag className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
              ₹{breakdown.grossSales.toLocaleString('en-IN')}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-1 font-medium truncate">
            <span>Customer billings before fees</span>
          </div>
        </div>

        {/* 2. Net Disbursable Payout */}
        <div className="bg-emerald-50/50 border border-emerald-200/80 rounded-2xl p-4 shadow-2xs relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs text-emerald-800 font-semibold">Net Weekly Payout</span>
            <div className="h-7 w-7 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-700">
              <CreditCard className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-emerald-700 tracking-tight">
              ₹{breakdown.netPayout.toLocaleString('en-IN')}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-emerald-700/80 font-medium truncate">
            {breakdown.payoutScheduleNote}
          </div>
        </div>

        {/* 3. Total Fulfilled Orders */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Fulfilled Orders</span>
            <div className="h-7 w-7 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
              <Package className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
              {breakdown.totalOrdersCount}
            </span>
            <span className="text-xs text-slate-500 font-medium">orders</span>
          </div>
          <div className="mt-1 text-[11px] text-emerald-700 font-semibold flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            <span>{seller.slaAdherencePercent ?? 98.5}% SLA Adherence</span>
          </div>
        </div>

        {/* 4. Average Order Value & Prep */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Avg Order Value (AOV)</span>
            <div className="h-7 w-7 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
              <TrendingUp className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
              ₹{breakdown.averageOrderValue.toLocaleString('en-IN')}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500 font-medium flex items-center gap-1">
            <Clock className="h-3 w-3 text-slate-400" />
            <span>Avg prep: {seller.avgPrepTimeMins ?? 4.2} mins (≤ 5m SLA)</span>
          </div>
        </div>
      </div>

      {/* Crystal Clear Visual Mathematical Equation */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2">
          <div>
            <h4 className="text-xs font-bold text-slate-900">
              Weekly Payout Calculation Formula
            </h4>
            <p className="text-[11px] text-slate-500">
              How the net payout is derived from gross customer billing
            </p>
          </div>
          <div className="text-xs font-bold text-slate-700">
            Store Retention Rate: <span className="text-emerald-700 font-extrabold">{((breakdown.netPayout / (breakdown.grossSales || 1)) * 100).toFixed(1)}%</span>
          </div>
        </div>

        {/* Clear Math Equation Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div className="text-[10px] text-slate-500 font-semibold uppercase">1. Gross GMV Sales</div>
            <div className="text-sm font-extrabold text-slate-900 mt-0.5">
              +₹{breakdown.grossSales.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Customer cart total</div>
          </div>

          <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100">
            <div className="text-[10px] text-indigo-700 font-semibold uppercase">2. Platform Commission ({commissionRate}%)</div>
            <div className="text-sm font-extrabold text-indigo-900 mt-0.5">
              -₹{breakdown.commissionDeducted.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] text-indigo-600/80 mt-1">Marketplace service fee</div>
          </div>

          <div className="p-3 rounded-xl bg-amber-50/60 border border-amber-100">
            <div className="text-[10px] text-amber-800 font-semibold uppercase">3. Statutory Taxes (TCS/TDS 1.1%)</div>
            <div className="text-sm font-extrabold text-amber-900 mt-0.5">
              -₹{breakdown.statutoryTaxes.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] text-amber-700/80 mt-1">GST TCS 1% + TDS 0.1%</div>
          </div>

          <div className="p-3 rounded-xl bg-emerald-600 text-white shadow-2xs">
            <div className="text-[10px] text-emerald-100 font-semibold uppercase">= Net Weekly Payout</div>
            <div className="text-sm font-extrabold text-white mt-0.5">
              ₹{breakdown.netPayout.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] text-emerald-100/90 mt-1">Disbursed to Bank A/C</div>
          </div>
        </div>
      </div>

      {/* Itemized Order Fulfillment List */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/80">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-indigo-600" />
            <h4 className="text-xs font-bold text-slate-900">
              Orders Completed in this Weekly Cycle ({breakdown.orders.length} items logged)
            </h4>
          </div>

          {/* Quick Filters */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="flex items-center bg-white border border-slate-200 p-0.5 rounded-lg text-xs">
              {[
                { id: 'all', label: 'All Orders', count: breakdown.orders.length },
                { id: 'settled', label: 'Settled', count: settledCount },
                { id: 'pending', label: 'Pending Weekly Batch', count: pendingCount },
                { id: 'high_value', label: 'High Value (₹500+)', count: highValueCount },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setOrderFilter(f.id as any)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    orderFilter === f.id
                      ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label} ({f.count})
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setIsExpandedList(!isExpandedList)}
              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-white rounded-lg border border-slate-200 transition-colors"
              title={isExpandedList ? 'Collapse order table' : 'Expand order table'}
            >
              {isExpandedList ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {isExpandedList && (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  <th className="py-2.5 px-3">Order ID & Date</th>
                  <th className="py-2.5 px-3">Items & Customer Area</th>
                  <th className="py-2.5 px-3 text-right">Gross GMV</th>
                  <th className="py-2.5 px-3 text-right">Commission ({commissionRate}%)</th>
                  <th className="py-2.5 px-3 text-right">Taxes (1.1%)</th>
                  <th className="py-2.5 px-3 text-right">Net Store Credited</th>
                  <th className="py-2.5 px-3 text-center">Settlement Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredOrders.map((ord) => (
                  <tr key={ord.id} className="hover:bg-slate-50/75 transition-colors">
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <div className="font-mono font-bold text-slate-900">{ord.orderNumber}</div>
                      <div className="text-[10px] text-slate-500">{ord.placedAt}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-slate-800">{ord.itemSummary}</div>
                      <div className="text-[10px] text-slate-500">{ord.deliveryArea}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                      ₹{ord.grossAmount}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-indigo-700">
                      -₹{ord.commissionAmount}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-amber-700 text-[11px]">
                      -₹{ord.taxDeduction}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">
                      +₹{ord.netPayable}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                          ord.settlementStatus === 'SETTLED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {ord.settlementStatus === 'SETTLED' ? 'SETTLED (WEEKLY)' : 'ACCRUING (WEEKLY)'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
