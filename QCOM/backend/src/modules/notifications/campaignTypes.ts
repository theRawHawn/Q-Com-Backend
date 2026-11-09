export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED';

export type AudienceType =
  | 'ALL_ACTIVE_CUSTOMERS'
  | 'LOCATION_OR_ZONE'
  | 'NEW_CUSTOMERS'
  | 'INACTIVE_CUSTOMERS'
  | 'CATEGORY_PURCHASERS'
  | 'PRODUCT_PURCHASERS'
  | 'CUSTOMER_SEGMENT'
  | 'FUTURE_ALGORITHM_AUDIENCE';

export interface CampaignRecord {
  id: string;
  createdBy: string;
  name: string;
  status: CampaignStatus;
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  audienceType: AudienceType;
  audienceDefinition: any;
  scheduledAt?: string;
  expiresAt?: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  frequencyPolicy: any;
  dedupeKey?: string;
  campaignType: 'ADMIN_CAMPAIGN' | 'ALGORITHM_CAMPAIGN';
  algorithmMetadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCampaignInput {
  name: string;
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  audienceType: AudienceType;
  audienceDefinition?: any;
  scheduledAt?: string;
  expiresAt?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  frequencyPolicy?: any;
  dedupeKey?: string;
  campaignType?: 'ADMIN_CAMPAIGN' | 'ALGORITHM_CAMPAIGN';
  algorithmMetadata?: any;
}

export interface CampaignAnalytics {
  campaignId: string;
  status: CampaignStatus;
  totalRecipientsTargeted: number;
  sentCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  failedCount: number;
  skippedPreferenceCount: number;
}
