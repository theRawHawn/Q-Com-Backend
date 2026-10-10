export interface DeliveryEconomicsConfig {
  riderBasePayout: number;
  riderPerKmRate: number;
  maxDeliverySubsidy: number;
  pgCostPercent: number;
  packagingCostInr: number;
  opsCostInr: number;
}

export interface CandidateSellerEvaluation {
  sellerId: string;
  sellerName: string;
  distanceMeters: number;
  distanceKm: number;
  roadDistanceMeters: number;
  etaMinutes: number;
  isEligible: boolean;
  ineligibilityReason?: string;
  customerDeliveryFee: number;
  handlingFee: number;
  qcomCommission: number;
  riderPayout: number;
  totalVariableCost: number;
  netContributionMargin: number;
  isEconomicallyViable: boolean;
  score: number;
}

export interface OptimalFulfilmentResult {
  recommendedSeller: CandidateSellerEvaluation | null;
  candidates: CandidateSellerEvaluation[];
  isViable: boolean;
  overallEconomics: {
    totalRevenue: number;
    totalCost: number;
    netMargin: number;
  };
}
