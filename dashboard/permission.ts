import { DISPLAY_ONLY_ATTENTION, type ObserverAttention } from '../observer/observer-protocol.js';

export interface PermissionDecision { attentionId: string; decision: 'approve' | 'deny' }
export type ActionableAttention = ObserverAttention & { actionable?: boolean; command?: string };

export function actionableAttention(attention: ActionableAttention | undefined): boolean {
  return attention?.actionable === true && attention.pending >= 1 &&
    !DISPLAY_ONLY_ATTENTION.includes(attention.kind);
}

// Stable across heartbeats, but changes whenever reviewable content or ownership changes.
export function attentionSignature(attention: ActionableAttention | undefined): string {
  return JSON.stringify(attention ? [attention.id, attention.kind, attention.actionable,
    attention.command, attention.reason, attention.preview, attention.pending] : null);
}

export function permissionTarget(session: any): string {
  return JSON.stringify([session?.source, session?.sessionId, session?.observerInstanceId,
    session?.observerStartedAt, session?.state, !!session?.closed, attentionSignature(session?.attention)]);
}