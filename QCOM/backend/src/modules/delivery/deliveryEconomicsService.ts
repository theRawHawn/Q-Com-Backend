import { getPool } from '../../database/connection.js';
import { DeliveryEconomicsConfig } from './deliveryTypes.js';

export class DeliveryEconomicsService {
  /**
   * Retrieves active delivery economics configuration
   */
  public async getConfig(): Promise<DeliveryEconomicsConfig> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT rider_base_payout, rider_per_km_rate, max_delivery_subsidy, pg_cost_percent, packaging_cost_inr, ops_cost_inr
      FROM delivery_economics_configs
      WHERE is_active = TRUE
      LIMIT 1
    `);

    const row = res.rows[0] || {
      rider_base_payout: 45.00,
      rider_per_km_rate: 8.00,
      max_delivery_subsidy: 35.00,
      pg_cost_percent: 1.80,
      packaging_cost_inr: 8.00,
      ops_cost_inr: 5.00,
    };

    return {
      riderBasePayout: parseFloat(row.rider_base_payout),
      riderPerKmRate: parseFloat(row.rider_per_km_rate),
      maxDeliverySubsidy: parseFloat(row.max_delivery_subsidy),
      pgCostPercent: parseFloat(row.pg_cost_percent),
      packagingCostInr: parseFloat(row.packaging_cost_inr),
      opsCostInr: parseFloat(row.ops_cost_inr),
    };
  }

  /**
   * Computes dynamic rider payout based on distance
   */
  public calculateRiderPayout(distanceKm: number, config: DeliveryEconomicsConfig): number {
    const rawPayout = config.riderBasePayout + Math.max(0, distanceKm - 1.5) * config.riderPerKmRate;
    return +rawPayout.toFixed(2);
  }

  /**
   * Evaluates complete unit economics and contribution margin for a candidate delivery
   */
  public calculateUnitEconomics(params: {
    cartTotal: number;
    customerDeliveryFee: number;
    handlingFee: number;
    commissionAmount: number;
    distanceKm: number;
    platformCouponDiscount?: number;
    config: DeliveryEconomicsConfig;
  }): {
    riderPayout: number;
    pgCost: number;
    packagingCost: number;
    opsCost: number;
    totalVariableCost: number;
    revenue: number;
    netContributionMargin: number;
    isEconomicallyViable: boolean;
  } {
    const { cartTotal, customerDeliveryFee, handlingFee, commissionAmount, distanceKm, platformCouponDiscount = 0, config } = params;

    const riderPayout = this.calculateRiderPayout(distanceKm, config);
    const pgCost = +(cartTotal * (config.pgCostPercent / 100)).toFixed(2);
    const packagingCost = config.packagingCostInr;
    const opsCost = config.opsCostInr;

    const totalVariableCost = +(riderPayout + pgCost + packagingCost + opsCost + platformCouponDiscount).toFixed(2);
    const revenue = +(customerDeliveryFee + handlingFee + commissionAmount).toFixed(2);
    const netContributionMargin = +(revenue - totalVariableCost).toFixed(2);

    const isEconomicallyViable = netContributionMargin >= -config.maxDeliverySubsidy;

    return {
      riderPayout,
      pgCost,
      packagingCost,
      opsCost,
      totalVariableCost,
      revenue,
      netContributionMargin,
      isEconomicallyViable,
    };
  }
}

export const deliveryEconomicsService = new DeliveryEconomicsService();
