import { NotificationType } from './notificationTypes.js';

/**
 * ARCHITECT_NOW_IMPLEMENT_LATER:
 * Extension interfaces and contracts for future ML/algorithmic notification engines.
 * Separates intelligence decision-making from delivery and transport infrastructure.
 */

export interface NotificationDecisionInput {
  userId: string;
  candidateContext?: {
    location?: { latitude: number; longitude: number };
    preferredCategories?: string[];
    recentCartItems?: string[];
    daysSinceLastOrder?: number;
  };
  availableProductsOrCategories?: string[];
  recentNotificationHistory?: {
    lastPromotionalSentAt?: string;
    totalSentThisWeek?: number;
    lastClickedCategory?: string;
  };
  eligibilityContext?: {
    isPromotionalOptedIn: boolean;
    isAccountActive: boolean;
  };
}

export interface NotificationDecisionOutput {
  eligible: boolean;
  notificationType: NotificationType;
  templateId?: string;
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  sendAt?: string;
  dedupeKey: string;
  algorithmName: string;
  algorithmVersion: string;
  decisionReasonCode: string;
}

export interface INotificationDecisionEngine {
  readonly name: string;
  readonly version: string;
  evaluateDecision(input: NotificationDecisionInput): Promise<NotificationDecisionOutput>;
}

export interface IAudienceProvider {
  resolveAudience(audienceDefinition: any): Promise<string[]>;
}

export interface ITemplateProvider {
  renderTemplate(templateId: string, parameters: Record<string, any>): { title: string; body: string };
}

export interface IFrequencyPolicyEngine {
  isCoolDownSatisfied(userId: string, category?: string): Promise<boolean>;
}

/**
 * Deterministic Baseline Rule Engine used prior to ML model introduction.
 * Demonstrates that the delivery pipeline accepts external algorithmic decisions seamlessly.
 */
export class BaselineRuleDecisionEngine implements INotificationDecisionEngine {
  public readonly name = 'BASELINE_RULE_ENGINE';
  public readonly version = '1.0.0';

  public async evaluateDecision(
    input: NotificationDecisionInput
  ): Promise<NotificationDecisionOutput> {
    if (!input.eligibilityContext?.isPromotionalOptedIn) {
      return {
        eligible: false,
        notificationType: 'PROMOTIONAL',
        title: '',
        body: '',
        priority: 'LOW',
        dedupeKey: `algo_${input.userId}_rejected`,
        algorithmName: this.name,
        algorithmVersion: this.version,
        decisionReasonCode: 'INELIGIBLE_PROMOTIONAL_OPT_OUT',
      };
    }

    const preferredCategory = input.candidateContext?.preferredCategories?.[0] || 'Hardware Tools';

    return {
      eligible: true,
      notificationType: 'PROMOTIONAL',
      templateId: 'tmpl_personalized_category_deals',
      title: `Special Contractor Deals on ${preferredCategory}`,
      body: `Explore exclusive contractor pricing and 15-minute delivery on top ${preferredCategory}.`,
      deepLink: `/category/${encodeURIComponent(preferredCategory.toLowerCase())}`,
      priority: 'NORMAL',
      dedupeKey: `algo_cat_${input.userId}_${Date.now()}`,
      algorithmName: this.name,
      algorithmVersion: this.version,
      decisionReasonCode: 'CATEGORY_AFFINITY_MATCH',
    };
  }
}
