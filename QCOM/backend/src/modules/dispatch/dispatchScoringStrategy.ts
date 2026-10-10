import { DispatchCandidateContext, DispatchScoringResult, RiderCandidate } from './dispatchTypes.js';

export interface ScoringStrategy {
  scoreCandidate(
    candidate: RiderCandidate,
    context: DispatchCandidateContext
  ): DispatchScoringResult;
}

export class DefaultDispatchScoringStrategy implements ScoringStrategy {
  public scoreCandidate(
    candidate: RiderCandidate,
    context: DispatchCandidateContext
  ): DispatchScoringResult {
    // 1. ETA Score (Max 40 pts) - Lower ETA = Higher Score
    const eta = candidate.etaToStoreMinutes;
    const etaScore = Math.max(0, 40 - eta * 2);

    // 2. Distance Score (Max 20 pts) - Closer to store = Higher Score
    const distKm = candidate.distanceToStoreMeters / 1000;
    const distanceScore = Math.max(0, 20 - distKm * 3);

    // 3. Rating Score (Max 20 pts) - Rating 1.0 - 5.0 scaled
    const ratingScore = candidate.rating * 4;

    // 4. Payload Capacity Score (Max 10 pts)
    const requiredWeight = context.totalWeightKg || 5.0;
    const capacityScore = candidate.payloadCapacityKg >= requiredWeight ? 10 : 0;

    // 5. Economic Score (Max 10 pts)
    const economicScore = candidate.isEconomicallyViable ? 10 : 0;

    const totalScore = +(etaScore + distanceScore + ratingScore + capacityScore + economicScore).toFixed(2);

    return {
      candidate: {
        ...candidate,
        score: totalScore,
      },
      score: totalScore,
      breakdown: {
        etaScore,
        distanceScore,
        ratingScore,
        capacityScore,
        economicScore,
      },
    };
  }
}

export const defaultScoringStrategy = new DefaultDispatchScoringStrategy();
