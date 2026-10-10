import { env } from '../../config/env.js';

export interface PartFinderResult {
  partName: string;
  confidenceScore: number;
  estimatedSize: string;
  material: string;
  threadType: string;
  commonIssues: string[];
  matchedProductIds: string[];
  recommendedAccessories: string[];
  expertTip: string;
}

export interface EmergencyKitResult {
  kitName: string;
  estimatedFixTimeMinutes: number;
  suggestedItems: {
    name: string;
    quantity: number;
    reason: string;
  }[];
  advice: string;
}

export class AIService {
  /**
   * Part Finder: Identifies technical trade parts using multimodal AI or domain heuristics
   */
  public async findPart(params: {
    prompt?: string;
    tradeType?: string;
  }): Promise<PartFinderResult> {
    const text = (params.prompt || '').toLowerCase();
    const trade = (params.tradeType || 'General').toLowerCase();

    if (text.includes('mcb') || text.includes('breaker') || trade.includes('electr')) {
      return {
        partName: 'Havells 32A C-Curve Double Pole MCB',
        confidenceScore: 0.94,
        estimatedSize: '2 Module DIN Rail',
        material: 'Flame Retardant PBT',
        threadType: 'Bi-Connect Terminal Box Clamp',
        commonIssues: ['Overload tripping due to inductive motor load', 'Loose terminal lug causing heat'],
        matchedProductIds: ['elec-01', 'elec-02'],
        recommendedAccessories: ['10mm copper crimp lugs', '1 DIN rail channel strip', 'Insulated screw terminals'],
        expertTip: 'Always verify phase-neutral balance and tighten terminal screws to 2.5 Nm torque specification.',
      };
    }

    if (text.includes('pipe') || text.includes('valve') || text.includes('leak') || trade.includes('plumb')) {
      return {
        partName: 'Astral 1-inch CPVC Heavy Duty Ball Valve',
        confidenceScore: 0.91,
        estimatedSize: '1 inch (25mm ID)',
        material: 'Chlorinated Polyvinyl Chloride (SDR 11)',
        threadType: 'Solvent Weld Socket',
        commonIssues: ['Cracked body from thermal expansion without loops', 'Degraded PTFE gland seal'],
        matchedProductIds: ['plumb-01', 'plumb-02'],
        recommendedAccessories: ['CPVC Heavy Duty Solvent Cement (118ml)', 'Teflon PTFE Seal Tape', 'Pipe Deburring Reamer'],
        expertTip: 'Chamfer the pipe end at 15 degrees before applying solvent cement for 100% leak-proof hydrostatic weld.',
      };
    }

    return {
      partName: 'Anchor Fasteners Heavy Duty M10 Rawl Bolt',
      confidenceScore: 0.88,
      estimatedSize: 'M10 x 75mm',
      material: 'Zinc Plated High Tensile Steel (Grade 8.8)',
      threadType: 'Metric ISO M10 Coarse',
      commonIssues: ['Oversized hammer drill bit reducing expansion cone friction', 'Insufficient embedment depth'],
      matchedProductIds: ['fast-01'],
      recommendedAccessories: ['14mm SDS Plus Masonry Drill Bit', 'Torque Spanner 17mm', 'Dust Blower Pump'],
      expertTip: 'Blow out drilling dust thoroughly before inserting the expansion shield to achieve rated 12.5 kN pull-out resistance.',
    };
  }

  /**
   * Emergency Kit Planner: Formulates rapid hardware response kits
   */
  public async planEmergencyKit(emergencyDescription: string, trade?: string): Promise<EmergencyKitResult> {
    const text = (emergencyDescription || '').toLowerCase();

    if (text.includes('leak') || text.includes('burst') || text.includes('water')) {
      return {
        kitName: 'Rapid Pipe Burst & Hydrostatic Containment Kit',
        estimatedFixTimeMinutes: 15,
        suggestedItems: [
          { name: '1-inch CPVC Repair Coupling (Slip Collar)', quantity: 2, reason: 'Bridge cut section of burst pipe' },
          { name: 'Heavy Duty Fast-Cure Solvent Cement (50ml)', quantity: 1, reason: 'Pressure weld joint in 3 minutes' },
          { name: 'Emergency Rubber Repair Clamp M10', quantity: 1, reason: 'Instant temporary live line clamp' },
          { name: 'PTFE Thread Seal Tape (0.2mm)', quantity: 2, reason: 'Seal threaded junction threads' },
        ],
        advice: 'Isolate main overhead tank line immediately. Dry pipe exterior thoroughly before applying rapid solvent primer.',
      };
    }

    return {
      kitName: 'Phase Fault & Short Circuit Tripping Kit',
      estimatedFixTimeMinutes: 20,
      suggestedItems: [
        { name: '32A Double Pole C-Curve MCB', quantity: 1, reason: 'Replace burnt or seized breaker' },
        { name: 'Copper Ferrule Assortment 4-10 sq mm', quantity: 1, reason: 'Prevent loose wire stranding' },
        { name: 'High-Dielectric PVC Insulation Tape', quantity: 2, reason: 'Insulate exposed wire splices' },
        { name: 'Digital Non-Contact Voltage Tester Pen', quantity: 1, reason: 'Verify phase isolation before work' },
      ],
      advice: 'Verify circuit de-energization using calibrated tester before stripping busbar connections.',
    };
  }
}

export const aiService = new AIService();
