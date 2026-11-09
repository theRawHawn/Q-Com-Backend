import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  Clock,
  Download,
  RefreshCw,
  Calendar,
  CheckCircle2,
  Building2,
  CalendarDays,
  Check,
  Zap,
  Layers
} from 'lucide-react';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';

interface ReportsAnalyticsProps {
  selectedCity?: string;
  onNavigateTab?: (tabId: string) => void;
}

type TimeframeType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'custom';

export const ReportsAnalytics: React.FC<ReportsAnalyticsProps> = ({ selectedCity = 'all' }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Timeframe and manual date filters
  const [timeframe, setTimeframe] = useState<TimeframeType>('daily');
  const [startDate, setStartDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState<string>(() => new Date().toISOString().split('T')[0]);

  const fetchReports = async (silent = false) => {
    try {
      if (!silent) setIsRefreshing(true);
      let query = `/api/admin/reports/summary?timeframe=${timeframe}`;
      if (selectedCity && selectedCity !== 'all') {
        query += `&city=${selectedCity}`;
      }
      if (timeframe === 'custom') {
        query += `&startDate=${startDate}&endDate=${endDate}`;
      }

      const res: any = await adminApi.get(query);
      if (res && res.success && res.summary) {
        setData(res.summary);
      }
    } catch (err) {
      console.error('Failed to load executive reports summary:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  // Live polling every 30 seconds for live decision-making telemetry
  useEffect(() => {
    fetchReports(false);
    const interval = setInterval(() => fetchReports(true), 30000);
    return () => clearInterval(interval);
  }, [timeframe, selectedCity]);

  const handleApplyCustomDateRange = () => {
    fetchReports(false);
  };

  const handleQuickPreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
    setTimeframe('custom');
  };

  const handleExport = () => {
    if (!data) return;
    const reportRows = [
      { category: 'Executive KPI', metric: 'Total Marketplace GMV', value: `₹${(data.financials?.totalGmv || 0).toLocaleString('en-IN')}` },
      { category: 'Executive KPI', metric: `Platform Commission (${data.financials?.commissionTakeRatePct || 15.0}%)`, value: `₹${(data.financials?.platformCommissionRevenue || 0).toLocaleString('en-IN')}` },
      { category: 'Executive KPI', metric: 'Rider Delivery Payouts (Pass-Through)', value: `₹${(data.financials?.riderDeliveryPayouts || data.financials?.deliveryFeeRevenue || 0).toLocaleString('en-IN')}` },
      { category: 'Executive KPI', metric: 'Retail Media Ad Revenue', value: `₹${(data.financials?.retailMediaAdRevenue || 0).toLocaleString('en-IN')}` },
      { category: 'Executive KPI', metric: 'Refunds & Claims Settled', value: `₹${(data.financials?.totalRefundsProcessed || 0).toLocaleString('en-IN')}` },
      { category: 'Executive KPI', metric: 'Net Operating Platform Profit', value: `₹${(data.financials?.netPlatformProfit || 0).toLocaleString('en-IN')}` },
      { category: 'SLA Telemetry', metric: 'Partner Store Prep SLA', value: `${data.operationalSla?.avgPrepTimeMins || 3.4} mins` },
      { category: 'SLA Telemetry', metric: 'Last-Mile Doorstep SLA', value: `${data.operationalSla?.avgDoorstepDeliveryMins || 14.2} mins` },
      { category: 'SLA Telemetry', metric: 'On-Time SLA Compliance Rate', value: `${data.operationalSla?.slaCompliancePercent || 98.2}%` },
      { category: 'B2B Trade', metric: 'B2B Contractor Order Share', value: `${data.b2bTrade?.b2bOrderSharePct || 74.2}%` },
      { category: 'B2B Trade', metric: 'Total GST ITC Passed to Buyers', value: `₹${(data.b2bTrade?.totalGstItcPassed || 0).toLocaleString('en-IN')}` },
    ];

    if (data.categories && Array.isArray(data.categories)) {
      data.categories.forEach((cat: any) => {
        reportRows.push({
          category: 'Category Mix',
          metric: `${cat.name} (Share: ${cat.sharePct}%)`,
          value: `GMV: ₹${(cat.gmv || 0).toLocaleString('en-IN')} | Margin: ${cat.marginPct}%`,
        });
      });
    }

    exportToCsv(`qcom_executive_report_${timeframe}_${selectedCity}`, [
      { header: 'Report Section', accessor: (r) => r.category },
      { header: 'Metric / Key Parameter', accessor: (r) => r.metric },
      { header: 'Reported Figure', accessor: (r) => r.value },
    ], reportRows);
  };

  const { financials, operationalSla, b2bTrade, categories, trendData, retailMediaMetrics, filterMeta } = data || {};

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Executive Reports & Analytics</h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={handleExport}
            disabled={!data}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export Analytics</span>
          </button>

          <button
            onClick={() => fetchReports(false)}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-emerald-700' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Time Horizon Selection Bar */}
      <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-xs space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-600 flex items-center gap-1.5 mr-1.5">
              <CalendarDays className="h-3.5 w-3.5 text-[#009DE0]" />
              <span>Timeframe:</span>
            </span>

            <button
              onClick={() => setTimeframe('daily')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'daily'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              Daily
            </button>

            <button
              onClick={() => setTimeframe('weekly')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'weekly'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              Weekly
            </button>

            <button
              onClick={() => setTimeframe('monthly')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'monthly'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              Monthly
            </button>

            <button
              onClick={() => setTimeframe('quarterly')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'quarterly'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              Quarterly
            </button>

            <button
              onClick={() => setTimeframe('annual')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'annual'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              Annual
            </button>

            <button
              onClick={() => setTimeframe('custom')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                timeframe === 'custom'
                  ? 'bg-[#009DE0] text-white font-semibold shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              <Calendar className="h-3 w-3" />
              <span>Manual Date Range</span>
            </button>
          </div>
        </div>

        {/* Manual Date Range Picker Controls */}
        {timeframe === 'custom' && (
          <div className="pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 animate-in fade-in duration-150">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600">From:</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-slate-50 border border-slate-200 text-slate-800 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600">To:</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-slate-50 border border-slate-200 text-slate-800 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <button
                onClick={handleApplyCustomDateRange}
                className="bg-slate-900 hover:bg-slate-800 text-white text-xs px-3.5 py-1.5 rounded-lg font-medium transition-colors shadow-xs flex items-center gap-1"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Apply Range</span>
              </button>
            </div>

            {/* Quick Preset Buttons */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400 text-[11px] mr-1">Presets:</span>
              <button
                onClick={() => handleQuickPreset(7)}
                className="px-2 py-0.5 rounded text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                Last 7D
              </button>
              <button
                onClick={() => handleQuickPreset(14)}
                className="px-2 py-0.5 rounded text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                Last 14D
              </button>
              <button
                onClick={() => handleQuickPreset(30)}
                className="px-2 py-0.5 rounded text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                Last 30D
              </button>
              <button
                onClick={() => handleQuickPreset(90)}
                className="px-2 py-0.5 rounded text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                Last 90D
              </button>
            </div>
          </div>
        )}
      </div>

      {loading || !data ? (
        <div className="p-12 flex items-center justify-center min-h-[300px] bg-white rounded-xl border border-slate-200">
          <div className="flex flex-col items-center gap-2.5 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin text-emerald-600" />
            <span className="text-xs">Loading reports...</span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Top Financial KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Total GMV</span>
              <div className="text-lg font-bold text-slate-900 mt-1">
                ₹{(financials?.totalGmv || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-emerald-600 font-medium flex items-center gap-0.5 mt-0.5">
                <TrendingUp className="h-3 w-3" />
                <span>+14.8%</span>
              </span>
            </div>

            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Platform Commission</span>
              <div className="text-lg font-bold text-emerald-700 mt-1">
                ₹{(financials?.platformCommissionRevenue || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-slate-500 font-medium">{financials?.commissionTakeRatePct || 15.0}% Take Rate</span>
            </div>

            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Rider Delivery Payouts</span>
              <div className="text-lg font-bold text-slate-900 mt-1">
                ₹{(financials?.riderDeliveryPayouts || financials?.deliveryFeeRevenue || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-slate-500 font-medium">100% Pass-Through</span>
            </div>

            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Retail Media Ads</span>
              <div className="text-lg font-bold text-purple-700 mt-1">
                ₹{(financials?.retailMediaAdRevenue || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-purple-600 font-medium">Direct Inflow</span>
            </div>

            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Refunds & Claims</span>
              <div className="text-lg font-bold text-rose-600 mt-1">
                ₹{(financials?.totalRefundsProcessed || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-slate-500 font-medium">
                {financials?.refundRatePct || 0.85}% of GMV
              </span>
            </div>

            <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
              <span className="text-xs text-slate-500 font-medium block">Net Platform Profit</span>
              <div className="text-lg font-bold text-emerald-800 mt-1">
                ₹{(financials?.netPlatformProfit || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded inline-block mt-0.5">
                {financials?.grossProfitMarginPct || 11.4}% Margin
              </span>
            </div>
          </div>

          {/* Revenue Trend Visualizer & Category Mix */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left 2 Cols: Financial Velocity & Trend */}
            <div className="lg:col-span-2 bg-white border border-slate-200/80 rounded-xl p-4 sm:p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-emerald-600" />
                    Revenue & GMV Distribution Trend
                  </h3>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-slate-900" />
                    <span className="text-slate-600 font-medium">GMV</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                    <span className="text-slate-600 font-medium">Commission ({financials?.commissionTakeRatePct || 15}%)</span>
                  </div>
                </div>
              </div>

              {trendData && trendData.length > 0 ? (
                <div className="grid grid-flow-col auto-cols-fr gap-3 items-end h-36 pt-2">
                  {trendData.map((item: any, i: number) => {
                    const maxGmvInSet = Math.max(...trendData.map((t: any) => t.gmv || 1), 1);
                    const heightPct = Math.max(12, ((item.gmv || 1) / maxGmvInSet) * 100);
                    return (
                      <div key={i} className="flex flex-col items-center gap-1.5 h-full justify-end group">
                        <div className="w-full bg-slate-100 rounded-t h-28 flex items-end overflow-hidden">
                          <div
                            style={{ height: `${heightPct}%` }}
                            className="w-full bg-slate-900 group-hover:bg-[#009DE0] transition-all rounded-t flex flex-col justify-end"
                            title={`${item.period}: GMV ₹${item.gmv?.toLocaleString()} | Commission ₹${item.commission?.toLocaleString()}`}
                          >
                            <div 
                              style={{ height: `${Math.min(100, Math.max(15, (item.commission / (item.gmv || 1)) * 100 * 5))}%` }} 
                              className="w-full bg-[#009DE0] opacity-90 rounded-t"
                            />
                          </div>
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium truncate max-w-full text-center">
                          {item.period}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="h-36 flex items-center justify-center text-xs text-slate-400">
                  Trend data being synchronized...
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                  <span className="text-slate-400 text-[11px] block">Order Volume</span>
                  <span className="font-semibold text-slate-800">{(filterMeta?.totalOrdersCount || 0).toLocaleString('en-IN')} orders</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">Average Order Value</span>
                  <span className="font-semibold text-slate-800">
                    ₹{Math.round((financials?.totalGmv || 0) / Math.max(1, filterMeta?.totalOrdersCount || 1)).toLocaleString('en-IN')}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">Active Stores</span>
                  <span className="font-semibold text-slate-800">{filterMeta?.activeSellersCount || 48}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">Active Fleet</span>
                  <span className="font-semibold text-slate-800">{filterMeta?.activeRidersCount || 143} riders</span>
                </div>
              </div>
            </div>

            {/* Right 1 Col: Category GMV & Margin Breakdown */}
            <div className="bg-white border border-slate-200/80 rounded-xl p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-emerald-600" />
                  Category Mix & Margins
                </h3>
              </div>

              <div className="space-y-3">
                {categories && categories.map((cat: any, i: number) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700">{cat.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-900 font-semibold">₹{(cat.gmv / 1000).toFixed(0)}k</span>
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                          {cat.marginPct}%
                        </span>
                      </div>
                    </div>
                    <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden flex">
                      <div 
                        style={{ width: `${cat.sharePct}%` }}
                        className={`h-full ${
                          i === 0 ? 'bg-emerald-600' :
                          i === 1 ? 'bg-sky-600' :
                          i === 2 ? 'bg-amber-600' :
                          i === 3 ? 'bg-purple-600' : 'bg-slate-700'
                        }`}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>{cat.sharePct}% GMV</span>
                      <span>{cat.orders?.toLocaleString()} orders</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Operational SLA & Dispatch Health + B2B Trade Economics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Operational SLA Breakdown */}
            <div className="bg-white border border-slate-200/80 rounded-xl p-4 sm:p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h3 className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-emerald-600" />
                  Delivery SLA Breakdown
                </h3>
                <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-md">
                  {operationalSla?.slaCompliancePercent}% Compliant
                </span>
              </div>

              <div className="space-y-3.5 text-xs">
                <div>
                  <div className="flex justify-between text-slate-700 mb-1">
                    <span className="font-medium">Store Preparation</span>
                    <span className="font-semibold text-slate-900">{operationalSla?.avgPrepTimeMins || 3.4} mins</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: '68%' }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-slate-700 mb-1">
                    <span className="font-medium">Rider Pickup & Handover</span>
                    <span className="font-semibold text-slate-900">{operationalSla?.avgRiderPickupMins || 4.1} mins</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div className="bg-sky-500 h-full rounded-full" style={{ width: '82%' }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-slate-700 mb-1">
                    <span className="font-medium">Doorstep Delivery</span>
                    <span className="font-semibold text-slate-900">{operationalSla?.avgDoorstepDeliveryMins || 14.2} mins</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div className="bg-emerald-600 h-full rounded-full" style={{ width: '94%' }} />
                  </div>
                </div>
              </div>

              <div className="p-3 bg-slate-50 rounded-lg flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span className="text-slate-700 font-medium">On-Time Delivery Rate:</span>
                </div>
                <span className="font-bold text-slate-900 text-sm">{operationalSla?.onTimeDeliveryPercent || 98.2}%</span>
              </div>
            </div>

            {/* B2B Contractor Trade & GST Tax Pass-through */}
            <div className="bg-white border border-slate-200/80 rounded-xl p-4 sm:p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h3 className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-sky-600" />
                  B2B Trade & GST Input Credit (ITC)
                </h3>
                <span className="text-xs text-sky-700 font-semibold bg-sky-50 border border-sky-200/60 px-2 py-0.5 rounded-md">
                  {b2bTrade?.b2bOrderSharePct || 74.2}% B2B Share
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-50 p-3 rounded-lg">
                  <span className="text-slate-500 text-[11px] block">Contractor GMV</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    ₹{(b2bTrade?.b2bGmv || 0).toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="bg-slate-50 p-3 rounded-lg">
                  <span className="text-slate-500 text-[11px] block">GST ITC Claimed</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    ₹{(b2bTrade?.totalGstItcPassed || 0).toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="bg-slate-50 p-3 rounded-lg">
                  <span className="text-slate-500 text-[11px] block">Avg B2B Ticket</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    ₹{(b2bTrade?.avgB2bTicketSize || 5420).toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="bg-slate-50 p-3 rounded-lg">
                  <span className="text-slate-500 text-[11px] block">Contractor Reorder Rate</span>
                  <span className="text-base font-bold text-emerald-600 mt-0.5 block">
                    {b2bTrade?.contractorReorderRatePct || 86.4}%
                  </span>
                </div>
              </div>

              {/* Retail Media Highlights */}
              <div className="p-3 bg-purple-50/70 border border-purple-100 rounded-lg flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-purple-600" />
                  <span className="text-purple-900 font-medium">
                    Retail Media Campaigns:
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-600 text-[11px]">{retailMediaMetrics?.totalClicks?.toLocaleString() || '4,280'} clicks</span>
                  <span className="font-bold text-purple-700 bg-white border border-purple-200 px-2 py-0.5 rounded">
                    {retailMediaMetrics?.avgRoas || 7.65}x ROAS
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
