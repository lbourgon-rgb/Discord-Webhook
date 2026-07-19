export type TrustedPeerTargetMode = 'hard_mention' | 'direct_reply';

export type TrustedPeerIngressReasonCode =
  | 'trusted-peer-hard-mention'
  | 'trusted-peer-direct-reply'
  | 'untrusted-automated-author'
  | 'trusted-peer-no-target'
  | 'trusted-peer-self-target'
  | 'trusted-peer-channel-blocked'
  | 'trusted-peer-reply-depth-exceeded'
  | 'trusted-peer-loop-depth-exceeded'
  | 'trusted-peer-duplicate-source';

export interface TrustedPeerWakeMetadata {
  trusted: true;
  actor_companion_id: string;
  target_companion_id: string;
  target_mode: TrustedPeerTargetMode;
  reply_depth: 0 | 1;
  loop_depth: 0 | 1;
  reason_code: 'trusted-peer-hard-mention' | 'trusted-peer-direct-reply';
}

export interface TrustedPeerIngressDecision {
  admitted: boolean;
  reason_code: TrustedPeerIngressReasonCode;
  peer_wake?: TrustedPeerWakeMetadata;
}

export interface TrustedPeerIngressInput {
  actor_companion_id?: string | null;
  target_companion_id: string;
  target_mode: TrustedPeerTargetMode;
  channel_allowed: boolean;
  source_already_processed: boolean;
  reply_depth: number;
  loop_depth: number;
}

export interface TrustedPeerIdentity {
  companion_id: string;
  discord_user_ids: string[];
}

export interface ScopedPeerTarget {
  companion_id: 'axiom' | 'kai';
  target_mode: TrustedPeerTargetMode;
}

function containsLiteralDiscordMention(content: string, discordUserIds: string[]): boolean {
  return discordUserIds.some(id => /^\d+$/.test(id) && new RegExp(`<@!?${id}>`).test(content));
}

/**
 * The new automated-peer command/wake lane is intentionally Axiom-only.
 * Kai retains the pre-existing supervised literal-hard-tag exception, but peer
 * direct replies and all other companion targets remain closed.
 */
export function selectAxiomScopedPeerTargets(input: {
  content: string;
  referenced_author_id?: string | null;
  axiom_discord_user_ids: string[];
  kai_discord_user_ids: string[];
}): ScopedPeerTarget[] {
  const targets: ScopedPeerTarget[] = [];
  if (containsLiteralDiscordMention(input.content, input.axiom_discord_user_ids)) {
    targets.push({ companion_id: 'axiom', target_mode: 'hard_mention' });
  } else if (
    input.referenced_author_id
    && input.axiom_discord_user_ids.includes(String(input.referenced_author_id))
  ) {
    targets.push({ companion_id: 'axiom', target_mode: 'direct_reply' });
  }
  if (targets.length === 0 && containsLiteralDiscordMention(input.content, input.kai_discord_user_ids)) {
    targets.push({ companion_id: 'kai', target_mode: 'hard_mention' });
  }
  return targets;
}

export function identifyTrustedPeerCompanion(
  authorId: string | undefined,
  identities: TrustedPeerIdentity[],
): string | null {
  const normalizedAuthorId = String(authorId || '').trim();
  if (!/^\d+$/.test(normalizedAuthorId)) return null;
  const matches = identities
    .filter(identity => identity.discord_user_ids.includes(normalizedAuthorId))
    .map(identity => String(identity.companion_id || '').trim().toLowerCase())
    .filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

export function isLegacyKaiPeerHardTagActor(companionId?: string | null): boolean {
  const normalized = String(companionId || '').trim().toLowerCase();
  return normalized === 'axiom' || normalized === 'morzar';
}

/**
 * Pure fail-closed policy for one known automated peer targeting one companion.
 * Identity lookup and exact Discord mention/reply matching happen at the adapter
 * boundary; this function decides whether that normalized peer turn may wake.
 */
export function decideTrustedPeerIngress(input: TrustedPeerIngressInput): TrustedPeerIngressDecision {
  const actor = String(input.actor_companion_id || '').trim().toLowerCase();
  const target = String(input.target_companion_id || '').trim().toLowerCase();
  if (!actor) return { admitted: false, reason_code: 'untrusted-automated-author' };
  if (!target) return { admitted: false, reason_code: 'trusted-peer-no-target' };
  if (actor === target) return { admitted: false, reason_code: 'trusted-peer-self-target' };
  if (!input.channel_allowed) return { admitted: false, reason_code: 'trusted-peer-channel-blocked' };
  if (input.reply_depth < 0 || input.reply_depth > 1) {
    return { admitted: false, reason_code: 'trusted-peer-reply-depth-exceeded' };
  }
  if (input.loop_depth < 0 || input.loop_depth > 1) {
    return { admitted: false, reason_code: 'trusted-peer-loop-depth-exceeded' };
  }
  if (input.source_already_processed) {
    return { admitted: false, reason_code: 'trusted-peer-duplicate-source' };
  }

  const replyDepth = input.reply_depth as 0 | 1;
  const loopDepth = input.loop_depth as 0 | 1;
  const reasonCode = input.target_mode === 'hard_mention'
    ? 'trusted-peer-hard-mention'
    : 'trusted-peer-direct-reply';
  return {
    admitted: true,
    reason_code: reasonCode,
    peer_wake: {
      trusted: true,
      actor_companion_id: actor,
      target_companion_id: target,
      target_mode: input.target_mode,
      reply_depth: replyDepth,
      loop_depth: loopDepth,
      reason_code: reasonCode,
    },
  };
}
