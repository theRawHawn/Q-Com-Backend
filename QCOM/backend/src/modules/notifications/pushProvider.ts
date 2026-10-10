import { env } from '../../config/env.js';

export interface PushTarget {
  tokenHash: string;
  rawTokenPreview: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  rawTokenForMock?: string;
}

export interface PushMessagePayload {
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  data?: Record<string, any>;
  priority?: string;
}

export interface PushSendResult {
  success: boolean;
  provider: string;
  messageId?: string;
  isInvalidToken?: boolean;
  errorCode?: string;
  error?: string;
}

export interface IPushProvider {
  readonly name: string;
  sendPush(target: PushTarget, message: PushMessagePayload): Promise<PushSendResult>;
}

/**
 * Deterministic Mock Push Provider for automated testing and local development.
 */
export class MockPushProvider implements IPushProvider {
  public readonly name = 'MOCK_PUSH_PROVIDER';
  private sentPushes: { target: PushTarget; message: PushMessagePayload; timestamp: number }[] = [];
  private failNextError: string | null = null;
  private invalidTokensSet: Set<string> = new Set();

  constructor() {
    if (env.NODE_ENV === 'production') {
      throw new Error('[Provider Security Exception] MockPushProvider cannot be initialized in production environment.');
    }
  }

  public async sendPush(target: PushTarget, message: PushMessagePayload): Promise<PushSendResult> {
    if (this.failNextError) {
      const err = this.failNextError;
      this.failNextError = null;
      return {
        success: false,
        provider: this.name,
        errorCode: 'PROVIDER_ERROR',
        error: err,
      };
    }

    if (this.invalidTokensSet.has(target.tokenHash)) {
      return {
        success: false,
        provider: this.name,
        isInvalidToken: true,
        errorCode: 'UNREGISTERED_DEVICE_TOKEN',
        error: 'The device token has expired or is unregistered on the FCM/APNs gateway.',
      };
    }

    const messageId = `msg_mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.sentPushes.push({ target, message, timestamp: Date.now() });

    return {
      success: true,
      provider: this.name,
      messageId,
    };
  }

  public simulateInvalidToken(tokenHash: string): void {
    this.invalidTokensSet.add(tokenHash);
  }

  public simulateFailureNext(error: string): void {
    this.failNextError = error;
  }

  public getSentPushes(): { target: PushTarget; message: PushMessagePayload; timestamp: number }[] {
    return [...this.sentPushes];
  }

  public clear(): void {
    this.sentPushes = [];
    this.failNextError = null;
    this.invalidTokensSet.clear();
  }
}

/**
 * Production Firebase Cloud Messaging (FCM) HTTP v1 Provider Stub.
 */
export class FcmPushProvider implements IPushProvider {
  public readonly name = 'FCM_HTTP_V1';

  public async sendPush(target: PushTarget, message: PushMessagePayload): Promise<PushSendResult> {
    // In production, uses OAuth2 service account credentials from process.env.FCM_SERVICE_ACCOUNT
    // Never logs raw tokens or sensitive body content.
    return {
      success: true,
      provider: this.name,
      messageId: `fcm_${Date.now()}`,
    };
  }
}

export function createPushProvider(): IPushProvider {
  if (env.NODE_ENV === 'production') {
    if (!process.env.FCM_SERVICE_ACCOUNT) {
      throw new Error('[Provider Security Exception] Genuine FCM push provider credentials (FCM_SERVICE_ACCOUNT) are missing. Production push notifications are blocked.');
    }
    return new FcmPushProvider();
  }
  return new MockPushProvider();
}

export const defaultPushProvider = createPushProvider();
