import { UserAuthContext } from '../rbac/rbacService.js';

export interface AuthenticatedSocketContext extends UserAuthContext {
  sessionId: string;
  connectedAt: number;
  lastPingAt: number;
}

export type RealtimeClientAction =
  | 'subscribe'
  | 'unsubscribe'
  | 'ping'
  | 'location:update';

export interface RealtimeClientMessage {
  action: RealtimeClientAction;
  channel?: string;
  latitude?: number;
  longitude?: number;
  heading?: number;
  speed?: number;
  timestamp?: number;
}

export interface RealtimeServerMessage {
  type: 'connected' | 'subscribed' | 'unsubscribed' | 'pong' | 'event' | 'error' | 'revoked';
  channel?: string;
  eventType?: string;
  payload?: any;
  code?: string;
  message?: string;
  timestamp?: string;
}
