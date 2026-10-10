import { HardwareProduct } from '../types';
import { CustomerPricingService, SellerEligibilityCheckResult } from './customerPricingService';
import { 
  DeliveryEconomicsService, 
  OrderContributionResult, 
  DeliveryCostBreakdown 
} from './deliveryEconomicsService';

// =============================================================================
// FULFILMENT SELECTION INTERFACES
// =============================================================================

export interface FulfilmentCandidateEvaluation {
  sellerId: string;
  sellerName: string;
  locality: string;
  isEligible: boolean;
  rejectionReason?: string;
  
  // Route & ETA
  actualRouteDistanceMeters: number;
  roundedRouteDistanceMeters: number;
  estimatedEtaMinutes: number;
  
  // Commercials & Economics
  itemsSubtotal: number;
  applicableCommissionRate: number;
  commissionAmount: number;
  handlingCharge: number;
  customerDeliveryCharge: number;
  isFreeDelivery: boolean;
  
  // Internal Delivery Economics (NOT exposed to customer)
  actualDeliveryCost: number;
  deliveryCostDetails: DeliveryCostBreakdown;
  deliverySubsidy: number;
  qcomRevenue: number;
  variableCosts: number;
  orderContribution: number;
  contributionMarginPct: number;
  isContributionPositive: boolean;
  isViable: boolean;
  viabilityStatus: OrderContributionResult['viabilityStatus'];
  
  // Multi-Attribute Fulfilment Scoring
  contributionScore: number; // 0-100 normalized
  etaScore: number; // 0-100 normalized
  reliabilityScore: number; // 0-100
  totalFulfilmentScore: number; // Weighted composite score
  selectionJustification: string;
}

export interface FulfilmentPlanResult {
  success: boolean;
  selectedSellerId?: string;
  selectedSellerName?: string;
  selectedCandidate?: FulfilmentCandidateEvaluation;
  allCandidates: FulfilmentCandidateEvaluation[];
  isBatched: boolean;
  isMultiSellerCart: boolean;
  overallViability: 'viable' | 'promotional_subsidized' | 'uneconomical_unserviceable';
  error?: string;
  auditExplanation: string;
}

// =============================================================================
// CENTRALIZED FULFILMENT SELECTION SERVICE
// =============================================================================

class CentralizedFulfilmentSelectionService {
  /**
   * Evaluates all candidate sellers and selects the optimal fulfilment option
   * based on positive order contribution, customer SLA, and delivery economics.
   */
  public selectOptimalFulfilment(params: {
    customerCoordinates: { lat: number; lng: number };
    cartItems: { productId: string; quantity: number; sellerId?: string }[];
    couponCode?: string | null;
    riderTip?: number;
    sellerFundedDiscounts?: number;
    isBatched?: boolean;
  }): FulfilmentPlanResult {
    // 1. Get base seller eligibility from Part 1 service
    const eligibilityResults = CustomerPricingService.determineEligibleSellers(
      params.customerCoordinates,
      params.cartItems
    );

    const eligibleSellers = eligibilityResults.filter(s => s.isEligible);
    if (eligibleSellers.length === 0) {
      const topRejection = eligibilityResults[0]?.rejectionReason || 'No service partner available in your delivery zone.';
      return {
        success: false,
        allCandidates: [],
        isBatched: Boolean(params.isBatched),
        isMultiSellerCart: false,
        overallViability: 'uneconomical_unserviceable',
        error: `Serviceability Check Failed: ${topRejection}`,
        auditExplanation: 'All candidate sellers were rejected during Part 1 eligibility checks (status, geofence, stock, road distance, or SLA).'
      };
    }

    const adminConfig = CustomerPricingService.getAdminConfig();
    const econConfig = DeliveryEconomicsService.getConfig();

    // 2. Evaluate commercials & delivery economics for each eligible candidate
    const evaluatedCandidates: FulfilmentCandidateEvaluation[] = [];

    for (const seller of eligibleSellers) {
      // Calculate cart item total for this seller
      let itemsSubtotal = 0;
      const verifiedItems: { product: HardwareProduct; quantity: number; sellerId: string }[] = [];

      for (const item of params.cartItems) {
        const prod = CustomerPricingService.getProductFromCatalog(item.productId);
        if (prod) {
          const qty = Math.max(1, Number(item.quantity) || 1);
          itemsSubtotal += prod.price * qty;
          verifiedItems.push({
            product: prod,
            quantity: qty,
            sellerId: seller.sellerId
          });
        }
      }

      // Calculate commission specific to this seller
      const commissionResult = CustomerPricingService.calculateCommission(verifiedItems, params.couponCode);
      const commissionAmount = commissionResult.totalCommissionAmount;
      const applicableCommissionRate = commissionResult.weightedCommissionRate;

      // Handling charge
      const handlingCharge = CustomerPricingService.calculateHandlingCharge(itemsSubtotal);

      // Customer Delivery Charge (Dynamic with Free-Delivery & Cap)
      const eligibleCartValue = Math.max(0, itemsSubtotal - (params.sellerFundedDiscounts || 0));
      const deliveryPricing = CustomerPricingService.calculateCustomerDeliveryCharge(
        eligibleCartValue,
        seller.actualRouteDistanceMeters
      );

      // Enforce Admin Maximum Customer Delivery Charge cap
      const cappedDeliveryCharge = Math.min(
        econConfig.contribution_targets.maximum_customer_delivery_charge,
        deliveryPricing.deliveryCharge
      );

      // Calculate Internal Actual Delivery Cost (Rider Payout)
      const deliveryCostDetails = DeliveryEconomicsService.calculateActualDeliveryCost({
        actualRouteDistanceMeters: seller.actualRouteDistanceMeters,
        estimatedTransitMinutes: seller.estimatedEtaMinutes,
        sellerPickupCount: 1,
        isBatched: params.isBatched
      });
      const actualDeliveryCost = deliveryCostDetails.actualDeliveryCost;

      // Delivery Subsidy
      const deliverySubsidy = DeliveryEconomicsService.calculateDeliverySubsidy(
        actualDeliveryCost,
        cappedDeliveryCharge
      );

      // Calculate Coupon Discount if applicable
      let couponDiscount = 0;
      if (params.couponCode?.toUpperCase() === 'PROBUILD' && itemsSubtotal >= 499) {
        couponDiscount = Math.min(Math.round(itemsSubtotal * 0.15), 250);
      } else if (params.couponCode?.toUpperCase() === 'SPEEDSITE' && itemsSubtotal >= 299) {
        couponDiscount = 50;
      }

      const finalPayable = Math.max(
        0,
        itemsSubtotal + handlingCharge + cappedDeliveryCharge + (params.riderTip || 0) - couponDiscount
      );

      // Evaluate internal order contribution
      const contributionResult = DeliveryEconomicsService.evaluateOrderContribution({
        sellerPrice: itemsSubtotal,
        commissionAmount,
        handlingRevenue: handlingCharge,
        customerDeliveryRevenue: cappedDeliveryCharge,
        actualDeliveryCost,
        finalCustomerPayable: finalPayable,
        platformFundedCouponDiscount: couponDiscount
      });

      // Compute Multi-Attribute Fulfilment Scores (0-100 scale)
      // Contribution score: higher contribution => higher score
      const contributionScore = Math.max(0, Math.min(100, 50 + contributionResult.orderContribution * 1.5));
      // ETA score: faster ETA => higher score (e.g. 15 mins = 85, 30 mins = 50)
      const etaScore = Math.max(0, Math.min(100, 100 - seller.estimatedEtaMinutes * 1.8));
      // Reliability score: based on seller active status
      const reliabilityScore = 95;

      // Weighted Composite Score (50% Economics + 35% ETA/Distance + 15% Reliability)
      const totalFulfilmentScore = Math.round(
        (contributionScore * 0.50 + etaScore * 0.35 + reliabilityScore * 0.15) * 100
      ) / 100;

      const justification = contributionResult.isContributionPositive
        ? `Contribution-Positive: Yields ₹${contributionResult.orderContribution} net margin (${contributionResult.contributionMarginPct}%) with ${seller.estimatedEtaMinutes} min ETA.`
        : (contributionResult.viabilityStatus === 'promotional_subsidized'
            ? `Promotional Subsidized: Within allowable subsidy limit (₹${Math.abs(contributionResult.orderContribution)} subsidy <= ₹${econConfig.contribution_targets.max_delivery_subsidy_amount}).`
            : `Uneconomical: Negative contribution of -₹${Math.abs(contributionResult.orderContribution)} exceeds allowable limits.`);

      evaluatedCandidates.push({
        sellerId: seller.sellerId,
        sellerName: seller.sellerName,
        locality: seller.locality,
        isEligible: true,
        actualRouteDistanceMeters: seller.actualRouteDistanceMeters,
        roundedRouteDistanceMeters: seller.roundedRouteDistanceMeters,
        estimatedEtaMinutes: seller.estimatedEtaMinutes,
        itemsSubtotal,
        applicableCommissionRate,
        commissionAmount,
        handlingCharge,
        customerDeliveryCharge: cappedDeliveryCharge,
        isFreeDelivery: deliveryPricing.isFreeDelivery,
        actualDeliveryCost,
        deliveryCostDetails,
        deliverySubsidy,
        qcomRevenue: contributionResult.qcomRevenue.totalQcomRevenue,
        variableCosts: contributionResult.variableCosts.totalVariableCosts,
        orderContribution: contributionResult.orderContribution,
        contributionMarginPct: contributionResult.contributionMarginPct,
        isContributionPositive: contributionResult.isContributionPositive,
        isViable: contributionResult.isViable,
        viabilityStatus: contributionResult.viabilityStatus,
        contributionScore,
        etaScore,
        reliabilityScore,
        totalFulfilmentScore,
        selectionJustification: justification
      });
    }

    // 3. Filter viable candidates
    const viableCandidates = evaluatedCandidates.filter(c => c.isViable);

    if (viableCandidates.length === 0) {
      // No economically viable seller satisfies contribution or subsidy rules
      return {
        success: false,
        allCandidates: evaluatedCandidates,
        isBatched: Boolean(params.isBatched),
        isMultiSellerCart: false,
        overallViability: 'uneconomical_unserviceable',
        error: 'Order could not be economically fulfilled within configured delivery thresholds. Please add more items or select another location.',
        auditExplanation: 'All candidate sellers produced negative order contribution exceeding the configured promotional subsidy limit.'
      };
    }

    // 4. Rank candidates by Total Fulfilment Score (Balance of Contribution, ETA, and Reliability)
    viableCandidates.sort((a, b) => b.totalFulfilmentScore - a.totalFulfilmentScore);

    const winningCandidate = viableCandidates[0];

    const overallViability = winningCandidate.isContributionPositive 
      ? 'viable' 
      : 'promotional_subsidized';

    const auditExplanation = `Selected '${winningCandidate.sellerName}' (${winningCandidate.locality}) with score ${winningCandidate.totalFulfilmentScore}. Order Contribution: ₹${winningCandidate.orderContribution}, Delivery Cost: ₹${winningCandidate.actualDeliveryCost}, Customer Delivery Charge: ₹${winningCandidate.customerDeliveryCharge}, Subsidy: ₹${winningCandidate.deliverySubsidy}, ETA: ${winningCandidate.estimatedEtaMinutes} mins.`;

    return {
      success: true,
      selectedSellerId: winningCandidate.sellerId,
      selectedSellerName: winningCandidate.sellerName,
      selectedCandidate: winningCandidate,
      allCandidates: evaluatedCandidates,
      isBatched: Boolean(params.isBatched),
      isMultiSellerCart: false,
      overallViability,
      auditExplanation
    };
  }
}

export const FulfilmentSelectionService = new CentralizedFulfilmentSelectionService();
