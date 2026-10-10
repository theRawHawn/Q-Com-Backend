export type NotificationType =
  | 'TRANSACTIONAL'
  | 'DELIVERY_UPDATE'
  | 'PROMOTIONAL'
  | 'DISPATCH_OFFER'
  | 'SYSTEM_ALERT';

export type DeliveryStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'SKIPPED_PREFERENCE'
  | 'SKIPPED_COOLDOWN';

export type MetricEventType =
  | 'SENT'
  | 'DELIVERED'
  | 'OPENED'
  | 'CLICKED'
  | 'DISMISSED'
  | 'FAILED';

export interface NotificationPreferences {
  userId: string;
  pushEnabled: boolean;
  transactionalEnabled: boolean;
  deliveryUpdatesEnabled: boolean;
  promotionalEnabled: boolean;
  updatedAt: string;
}

export interface DeviceTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  rawTokenPreview: string;
  provider: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  appVersion?: string;
  deviceMetadataMinimal?: any;
  isActive: boolean;
  lastSeenAt: string;
  createdAt: string;
}

export interface SendNotificationInput {
  userId: string;
  notificationType: NotificationType;
  title: string;
  body: string;
  dedupeKey: string;
  imageUrl?: string;
  deepLink?: string;
  campaignId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  data?: Record<string, any>;
  skipPreferenceCheck?: boolean; // Only for urgent security/system alerts
}

export interface NotificationDeliveryResult {
  notificationId: string;
  status: DeliveryStatus;
  sentCount: number;
  deduped: boolean;
  reason?: string;
}
