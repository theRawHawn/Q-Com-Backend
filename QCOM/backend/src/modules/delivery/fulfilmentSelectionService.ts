import { sellerService } from '../sellers/sellerService.js';
import { routingService } from '../routing/routingService.js';
import { deliveryEconomicsService } from './deliveryEconomicsService.js';
import { CandidateSellerEvaluation, OptimalFulfilmentResult } from './deliveryTypes.js';

export class FulfilmentSelectionService {
  /**
   * Evaluates all candidate stores for a delivery coordinate and cart payload
   */
  public async evaluateFulfilment(params: {
    customerLocation: { latitude: number; longitude: number };
    cartItems: { productId: string; quantity: number }[];
    cartTotal: number;
    platformCouponDiscount?: number;
  }): Promise<OptimalFulfilmentResult> {
    const sellers = await sellerService.getSellerGeofences();
    const config = await deliveryEconomicsService.getConfig();

    const candidates: CandidateSellerEvaluation[] = [];

    for (const s of sellers) {
      const straightM = routingService.calculateHaversineDistanceMeters(
        { latitude: s.latitude, longitude: s.longitude },
        params.customerLocation
      );

      // Step 1: Open status
      if (!s.isOpen) {
        candidates.push({
          sellerId: s.id,
          sellerName: s.name,
          distanceMeters: straightM,
          distanceKm: +(straightM / 1000).toFixed(2),
          roadDistanceMeters: straightM,
          etaMinutes: 999,
          isEligible: false,
          ineligibilityReason: 'Store is currently closed.',
          customerDeliveryFee: 0,
          handlingFee: 0,
          qcomCommission: 0,
          riderPayout: 0,
          totalVariableCost: 0,
          netContributionMargin: 0,
          isEconomicallyViable: false,
          score: 0,
        });
        continue;
      }

      // Step 2: Geofence radius check
      if (straightM > s.geofenceRadiusMeters) {
        candidates.push({
          sellerId: s.id,
          sellerName: s.name,
          distanceMeters: straightM,
          distanceKm: +(straightM / 1000).toFixed(2),
          roadDistanceMeters: straightM,
          etaMinutes: 999,
          isEligible: false,
          ineligibilityReason: `Customer is outside geofence radius (${straightM}m > ${s.geofenceRadiusMeters}m).`,
          customerDeliveryFee: 0,
          handlingFee: 0,
          qcomCommission: 0,
          riderPayout: 0,
          totalVariableCost: 0,
          netContributionMargin: 0,
          isEconomicallyViable: false,
          score: 0,
        });
        continue;
      }

      // Step 3 & 4: Road distance & 100m rounding
      const roadM = routingService.roundTo100Meters(Math.round(straightM * 1.25));
      const roadKm = +(roadM / 1000).toFixed(2);
      const etaMinutes = Math.ceil((roadKm / 24) * 60) + (s.preparationTimeMinutes || 8);

      // Commercial calculation
      const customerDeliveryFee = params.cartTotal >= 499 ? 0 : 29.00;
      const handlingFee = 10.00;
      const commissionAmount = +(params.cartTotal * 0.10).toFixed(2);

      const economics = deliveryEconomicsService.calculateUnitEconomics({
        cartTotal: params.cartTotal,
        customerDeliveryFee,
        handlingFee,
        commissionAmount,
        distanceKm: roadKm,
        platformCouponDiscount: params.platformCouponDiscount,
        config,
      });

      // Composite multi-attribute score: SLA (40%), Distance (30%), Contribution Margin (30%)
      const score = +(100 - (etaMinutes * 1.5) - (roadKm * 2) + (economics.netContributionMargin * 0.5)).toFixed(2);

      candidates.push({
        sellerId: s.id,
        sellerName: s.name,
        distanceMeters: straightM,
        distanceKm: roadKm,
        roadDistanceMeters: roadM,
        etaMinutes,
        isEligible: economics.isEconomicallyViable,
        ineligibilityReason: economics.isEconomicallyViable ? undefined : 'Unviable unit economics (subsidy limit exceeded).',
        customerDeliveryFee,
        handlingFee,
        qcomCommission: commissionAmount,
        riderPayout: economics.riderPayout,
        totalVariableCost: economics.totalVariableCost,
        netContributionMargin: economics.netContributionMargin,
        isEconomicallyViable: economics.isEconomicallyViable,
        score: Math.max(0, score),
      });
    }

    const eligibleCandidates = candidates
      .filter(c => c.isEligible)
      .sort((a, b) => b.score - a.score);

    const recommended = eligibleCandidates.length > 0 ? eligibleCandidates[0] : null;

    return {
      recommendedSeller: recommended,
      candidates,
      isViable: eligibleCandidates.length > 0,
      overallEconomics: {
        totalRevenue: recommended?.customerDeliveryFee || 0 + (recommended?.handlingFee || 0) + (recommended?.qcomCommission || 0),
        totalCost: recommended?.totalVariableCost || 0,
        netMargin: recommended?.netContributionMargin || 0,
      },
    };
  }
}

export const fulfilmentSelectionService = new FulfilmentSelectionService();
