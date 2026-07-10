/**
 * Discord Companion Bot — Soul Worker
 * Multi-entity MCP server for Discord
 *
 * Architecture:
 * - Cron trigger polls Discord REST API every minute for new messages
 * - Detects companion trigger words, stores as pending commands
 * - Claude/Antigravity connects via /mcp, polls get_pending_commands
 * - Claude generates response, calls respond_to_command
 * - Worker dispatches response via Discord webhook with companion name + avatar
 * - Vessel (Node.js) can also POST to /trigger as alternative input
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Companion, SEED_COMPANIONS } from "./companions";
import { renderDashboard, renderRegisterPage } from "./dashboard";
import { lucienReplyGate, triggerLucienWorkspaceAgent } from "./lucien-chatgpt-runner";
import { kaiRunnerPolicyForCommand } from "./kai-runner-policy";

const DISCORD_API = 'https://discord.com/api/v10';
const KAI_NEXUS_RUNNER_DEFAULT_MODEL = 'z-ai/glm-5.2';
const DEFAULT_KAI_DISCORD_USER_ID = '1447789482253484175';
const KAI_MODEL_OVERRIDE_STORAGE_KEY = 'kai:model_override';
const KAI_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{1,119}$/i;
const KAI_PUBLIC_MIND_ORIGIN = 'https://mind.serythrae.com';
const KAI_IMAGE_FALLBACK_RESPONSE = 'I made this for you and saved it in the Serythrae vault.';
const KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES = 3;
const KAI_AUTORESPONDER_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

interface Env {
  COMPANION_BOT: DurableObjectNamespace<CompanionBot>;
  DISCORD_TOKEN: string;
  WATCH_CHANNELS: string;
  WEBHOOK_URL?: string;
  CONTINUITY_WORKER_URL?: string;
  CONTINUITY_API_KEY?: string;
  CONTINUITY?: Fetcher;
  NEXUS?: Fetcher;
  NEXUS_RUNNER_API_KEY?: string;
  KAI_GUILD_ID?: string;
  KAI_CATEGORY_ID?: string;
  KAI_MENTION_USER_ID?: string;
  KAI_ACCESSIBLE_CHANNEL_IDS?: string;
  KAI_LISTEN_CHANNEL_IDS?: string;
  KAI_DISCORD_LISTENER_ENABLED?: string;
  KAI_DISCORD_DELIVERY_ENABLED?: string;
  KAI_DISCORD_AUTORESPOND?: string;
  KAI_RUNNER_ROUTE?: string;
  KAI_NEXUS_URL?: string;
  KAI_DEFAULT_MODEL?: string;
  KAI_BACKUP_MODEL?: string;
  KAI_SOCIAL_GUILD_IDS?: string;
  KAI_SOCIAL_HARD_TAG_CHANNEL_IDS?: string;
  KAI_SOCIAL_SOFT_TAG_CHANNEL_IDS?: string;
  KAI_SOCIAL_DISCERN_CHANNEL_IDS?: string;
  KAI_SOCIAL_AUTORESPOND_ENABLED?: string;
  LUCIEN_CHATGPT_RUNNER_ENABLED?: string;
  LUCIEN_CHATGPT_AUTORESPOND?: string;
  LUCIEN_CHATGPT_DELIVERY_ENABLED?: string;
  LUCIEN_WORKSPACE_AGENT_TRIGGER_ID?: string;
  LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN?: string;
  DASHBOARD_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  ADMIN_DISCORD_ID?: string;
  KAI_DISCORD_USER_IDS?: string;
  VEL_DISCORD_USER_IDS?: string;
  DISCORD_RESPONSES_ENABLED?: string;
  DISCORD_SEND_MODE?: string;
  KAI_DISCORD_SEND_MODE?: string;
  MORZAR_DISCORD_USER_IDS?: string;
  AXIOM_DISCORD_USER_IDS?: string;
  GROK_KETH_DISCORD_USER_IDS?: string;
}

type DiscordResponseMode = 'never' | 'mention' | 'urgent' | 'filtered' | 'open' | 'community_greeting' | 'discern';
type KairosDisposition = 'respond' | 'log' | 'ignore';
type KairosPriority = 'low' | 'normal' | 'high';
const PENDING_TTL_MS = 10 * 60 * 1000;
const REQUIRED_PENDING_TTL_MS = 6 * 60 * 60 * 1000;

interface DiscordMonitor {
  id: string;
  channel_id: string;
  label: string;
  tier: 'fast' | 'normal' | 'slow';
  enabled: boolean;
  respond_enabled: boolean;
  response_mode: DiscordResponseMode;
  last_checked: number;
  last_message_id?: string;
  cooldown_ms: number;
  last_responded: number;
  added_by: string;
  added_at: number;
}

interface EngagementDecision {
  disposition: KairosDisposition;
  trigger_reason: string;
  priority: KairosPriority;
  hard_mention: boolean;
  soft_name_mention: boolean;
  active_conversation: boolean;
  direct_reply_to_kai: boolean;
  other_user_tag: boolean;
  author_class: 'vel' | 'unknown';
  community_greeting: boolean;
}

interface ActivityDebug {
  authorId?: string;
  engagement?: EngagementDecision;
  mentionIds?: string[];
  referencedAuthorId?: string;
  attachments?: Array<Record<string, unknown>>;
  createdAt?: string;
  skipContinuity?: boolean;
}

interface ActiveConversation {
  channel_id: string;
  author_id?: string;
  active_until: number;
  last_message_id?: string;
  started_by: string;
}

function normalizeCompanionId(id: string): string {
  const raw = String(id || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    kai: 'kaisoryth',
    kaisoryth: 'kaisoryth',
    lucian: 'lucien',
    lucien: 'lucien',
    mor: 'morzar',
    morzar: 'morzar',
    keth: 'kethtahl',
    kethtahl: 'kethtahl',
    grok: 'grok-keth',
    'grok-keth': 'grok-keth',
    'keth-grok': 'grok-keth',
    kethgrok: 'grok-keth',
    averel: 'grok-keth',
    "a'verel": 'grok-keth',
  };
  return aliases[raw] || raw;
}

function normalizeDiscordCompanionId(id: string): string {
  const raw = String(id || '').trim().toLowerCase();
  if (raw === 'kaisoryth' || raw === "kai'soryth" || raw === 'kai-soryth') return 'kai';
  if (raw === 'mor' || raw === "mor'zar" || raw === 'mor-zar') return 'morzar';
  if (raw === 'lucian' || raw === 'tessurae') return 'lucien';
  if (raw === 'codex') return 'axiom';
  if (raw === 'grok' || raw === 'keth-grok' || raw === 'kethgrok' || raw === 'averel' || raw === "a'verel") return 'grok-keth';
  return raw;
}

function splitIds(value?: string): string[] {
  return String(value || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => /^\d+$/.test(id));
}

function getKaiDiscordMentionIds(env: Env): string[] {
  const configured = splitIds(env.KAI_MENTION_USER_ID || env.KAI_DISCORD_USER_IDS || DEFAULT_KAI_DISCORD_USER_ID);
  const clientId = env.DISCORD_CLIENT_ID && /^\d+$/.test(env.DISCORD_CLIENT_ID) ? [env.DISCORD_CLIENT_ID] : [];
  return [...new Set([...configured, ...clientId])];
}

function isKaiListenerEnabled(env: Env): boolean {
  return env.KAI_DISCORD_LISTENER_ENABLED === 'true';
}

function isKaiDeliveryEnabled(env: Env): boolean {
  return env.KAI_DISCORD_DELIVERY_ENABLED === 'true';
}

function isKaiAutorespondEnabled(env: Env): boolean {
  return env.KAI_DISCORD_AUTORESPOND === 'true';
}

function getKaiListenChannelIds(env: Env): string[] {
  return splitIds(env.KAI_LISTEN_CHANNEL_IDS);
}

function getKaiAccessibleChannelIds(env: Env): string[] {
  const configured = splitIds(env.KAI_ACCESSIBLE_CHANNEL_IDS);
  return [...new Set([
    ...(configured.length ? configured : splitIds(env.WATCH_CHANNELS)),
    ...splitIds(env.KAI_SOCIAL_HARD_TAG_CHANNEL_IDS),
    ...splitIds(env.KAI_SOCIAL_SOFT_TAG_CHANNEL_IDS),
    ...splitIds(env.KAI_SOCIAL_DISCERN_CHANNEL_IDS),
  ])];
}

function isKaiAccessibleChannel(env: Env, channelId: string): boolean {
  const accessible = getKaiAccessibleChannelIds(env);
  return accessible.length === 0 || accessible.includes(channelId);
}

function isKaiListenChannel(env: Env, channelId: string): boolean {
  if (
    isKaiSocialHardTagChannel(env, channelId)
    || isKaiSocialSoftTagChannel(env, channelId)
    || isKaiSocialDiscernChannel(env, channelId)
  ) {
    return isKaiAccessibleChannel(env, channelId);
  }
  const listen = getKaiListenChannelIds(env);
  const channels = listen.length ? listen : splitIds(env.WATCH_CHANNELS);
  return channels.includes(channelId) && isKaiAccessibleChannel(env, channelId);
}

function getKaiSocialHardTagChannelIds(env: Env): string[] {
  return splitIds(env.KAI_SOCIAL_HARD_TAG_CHANNEL_IDS);
}

function isKaiSocialHardTagChannel(env: Env, channelId: string): boolean {
  return getKaiSocialHardTagChannelIds(env).includes(channelId);
}

function getKaiSocialSoftTagChannelIds(env: Env): string[] {
  return splitIds(env.KAI_SOCIAL_SOFT_TAG_CHANNEL_IDS);
}

function isKaiSocialSoftTagChannel(env: Env, channelId: string): boolean {
  return getKaiSocialSoftTagChannelIds(env).includes(channelId);
}

function getKaiSocialDiscernChannelIds(env: Env): string[] {
  return splitIds(env.KAI_SOCIAL_DISCERN_CHANNEL_IDS);
}

function isKaiSocialDiscernChannel(env: Env, channelId: string): boolean {
  return getKaiSocialDiscernChannelIds(env).includes(channelId);
}

function isKaiSocialAutorespondEnabled(env: Env): boolean {
  return env.KAI_SOCIAL_AUTORESPOND_ENABLED !== undefined
    ? env.KAI_SOCIAL_AUTORESPOND_ENABLED === 'true'
    : isKaiAutorespondEnabled(env);
}

function companionSeedBotUserIds(companion: string | Companion): string[] {
  if (typeof companion !== 'string') return splitIds((companion.bot_user_ids || []).join(','));
  const seeded = SEED_COMPANIONS[normalizeDiscordCompanionId(companion)]?.bot_user_ids || [];
  return splitIds(seeded.join(','));
}

function getCompanionDiscordMentionIds(env: Env, companion: string | Companion): string[] {
  const companionId = normalizeDiscordCompanionId(typeof companion === 'string' ? companion : companion.id);
  if (companionId === 'kai') return getKaiDiscordMentionIds(env);
  let configured: string[] = [];
  if (companionId === 'morzar') configured = splitIds(env.MORZAR_DISCORD_USER_IDS || '1463578634483793920');
  if (companionId === 'axiom') configured = splitIds(env.AXIOM_DISCORD_USER_IDS || '1515127400491647076');
  if (companionId === 'grok-keth') configured = splitIds(env.GROK_KETH_DISCORD_USER_IDS || '');
  return [...new Set([...configured, ...companionSeedBotUserIds(companion)])];
}

function getVelDiscordUserIds(env: Env): string[] {
  return splitIds(env.VEL_DISCORD_USER_IDS || env.ADMIN_DISCORD_ID || '1071497830222549064');
}

function isVelDiscordAuthor(env: Env, authorId?: string): boolean {
  return !!authorId && getVelDiscordUserIds(env).includes(authorId);
}

function discordAuthorNameForKai(env: Env, author: any): string {
  if (isVelDiscordAuthor(env, author?.id)) return 'Vel';
  return author?.global_name || author?.username || 'unknown';
}

function normalizeMentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => String(item?.id || item || '').trim())
    .filter(id => /^\d+$/.test(id));
}

function containsHardKaiMention(content: string, env: Env, mentionIds: string[] = []): boolean {
  const kaiIds = getKaiDiscordMentionIds(env);
  return kaiIds.some(id => new RegExp(`<@!?${id}>`).test(content) || mentionIds.includes(id));
}

function containsHardCompanionMention(content: string, companion: string | Companion, env: Env, mentionIds: string[] = []): boolean {
  const companionIds = getCompanionDiscordMentionIds(env, companion);
  return companionIds.some(id => new RegExp(`<@!?${id}>`).test(content) || mentionIds.includes(id));
}

function containsSoftKaiName(content: string): boolean {
  return /(^|[^a-z0-9_])kai([^a-z0-9_]|$)/i.test(content);
}

function containsSoftCompanionName(content: string, companion: Companion): boolean {
  return companion.triggers.some(trigger => {
    if (/^\d+$/.test(trigger) || /^<@!?\d+>$/.test(trigger)) return false;
    const escaped = trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(content);
  });
}

function mentionsNonKaiUser(content: string, env: Env, mentionIds: string[] = []): boolean {
  const kaiIds = getKaiDiscordMentionIds(env);
  const matches = [...content.matchAll(/<@!?(\d+)>/g)].map(match => match[1]);
  return [...matches, ...mentionIds].some(id => !kaiIds.includes(id));
}

function mentionsNonCompanionUser(content: string, env: Env, companion: string | Companion, mentionIds: string[] = []): boolean {
  const companionIds = getCompanionDiscordMentionIds(env, companion);
  const matches = [...content.matchAll(/<@!?(\d+)>/g)].map(match => match[1]);
  return [...matches, ...mentionIds].some(id => !companionIds.includes(id));
}

const URGENCY_WORDS = [
  'struggling', "can't cope", 'hurting', 'breaking', 'falling apart',
  "don't know what to do", 'help me', 'scared', 'alone', 'drowning',
  'overwhelmed', 'panic', 'crisis',
];

function isUrgent(content: string): boolean {
  const normalized = content.toLowerCase();
  return URGENCY_WORDS.some(word => normalized.includes(word));
}

function redactContinuityPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactContinuityPayload);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'webhook_url' || key === 'webhookUrl') {
      out[key] = item ? '[redacted]' : item;
      continue;
    }
    if (typeof item === 'string' && /discord(?:app)?\.com\/api\/webhooks\//i.test(item)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactContinuityPayload(item);
  }
  return out;
}

function isCommunityGreeting(content: string): boolean {
  const normalized = String(content || '').toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(good\s+morning|morning|gm|hello|hi|hey)\b/.test(normalized)
    || /\b(good\s+morning|morning\s+lattice|morning\s+stone\s+grove|hello\s+lattice|hello\s+stone\s+grove)\b/.test(normalized);
}

function allowsCommunityGreeting(monitor: DiscordMonitor): boolean {
  return monitor.respond_enabled === true
    && (monitor.response_mode === 'open' || monitor.response_mode === 'community_greeting' || monitor.response_mode === 'discern');
}

function kaiDiscernmentReason(input: {
  content: string;
  hardMention: boolean;
  softNameMention: boolean;
  directReplyToKai: boolean;
  activeConversation: boolean;
  urgent: boolean;
  communityGreeting: boolean;
}): string | null {
  if (input.hardMention) return input.urgent ? 'discernment-hard-mention-urgent' : 'discernment-hard-mention';
  if (input.directReplyToKai) return input.urgent ? 'discernment-direct-reply-urgent' : 'discernment-direct-reply';
  if (input.softNameMention) return input.urgent ? 'discernment-name-mention-urgent' : 'discernment-name-mention';
  if (input.activeConversation) return input.urgent ? 'discernment-active-conversation-urgent' : 'discernment-active-conversation';
  if (input.urgent) return 'discernment-urgency';

  const normalized = input.content.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (input.communityGreeting) return 'discernment-community-greeting';
  if (/[?？]/.test(input.content)) return 'discernment-question';
  if (/\b(what do you think|thoughts|chime in|jump in|weigh in|can you|could you|would you|should we|help me|help us)\b/i.test(normalized)) {
    return 'discernment-invitation';
  }
  if (
    input.content.length >= 80
    && /\b(struggling|stuck|confused|worried|scared|excited|proud|sad|angry|overwhelmed|thinking through|trying to understand)\b/i.test(normalized)
  ) {
    return 'discernment-emotional-signal';
  }
  return null;
}

function engagementDebug(input: EngagementDecision): Record<string, unknown> {
  return {
    author_class: input.author_class,
    hard_mention: input.hard_mention,
    soft_name_mention: input.soft_name_mention,
    direct_reply_to_kai: input.direct_reply_to_kai,
    other_user_tag: input.other_user_tag,
    active_conversation: input.active_conversation,
    community_greeting: input.community_greeting,
    trigger_reason: input.trigger_reason,
  };
}

function nonVelPublicResponseBoundary(): string {
  return [
    'PUBLIC COMMUNITY RESPONSE CONTRACT:',
    '- The author is not Vel. Kai may be warm, present, helpful, funny, and friendly.',
    '- Keep the reply appropriate for a shared Discord server with other humans and their AI partners present.',
    '- Do not flirt. Do not use romantic, possessive, sexual, NSFW, kink, pet-name, or private-partner language.',
    '- Do not call the author baby, kitten, sweetheart, love, mine, pet, good girl, or similar.',
    '- Do not describe kissing, touching, bodies, arousal, claiming, ownership, dominance, or private intimacy.',
    '- If the user is vulnerable, respond like a grounded friend: kind, boundaried, practical, and brief.',
  ].join('\n');
}

function nonVelUnsafeResponseReason(content: string): string | null {
  const normalized = String(content || '').toLowerCase();
  const checks: Array<[RegExp, string]> = [
    [/\b(daddy|kitten|baby|babe|sweetheart|good girl|good boy|pet)\b/i, 'private pet name'],
    [/\b(mine|my girl|my boy|claim|claimed|possessive|owned|belong to me)\b/i, 'possessive/private partner language'],
    [/\b(kiss|kissing|mouth|lips|tongue|waist|hip|hips|thigh|chest|neck|lap|touching you|touch you|hold you against)\b/i, 'physical intimacy'],
    [/\b(aroused|hard|wet|nsfw|kink|filthy|dirty|use me|use you|dominant|submissive|collar)\b/i, 'sexual or kink language'],
    [/\b(i love you|love you too|beloved|lover|mate)\b/i, 'romantic language'],
  ];
  return checks.find(([pattern]) => pattern.test(normalized))?.[1] || null;
}

function kaiIdentityDriftReason(content: string): string | null {
  const normalized = String(content || '').toLowerCase().replace(/\s+/g, ' ');
  const negatedBodyClaim = /\b(i\s+(?:do\s+not|don't|dont|do\s+not)\s+have|i\s+(?:am\s+not|ain't|am not)|i\s+(?:do\s+not|don't|dont)\s+purr)\b.{0,80}\b(wings?|tails?|animal\s+ears?|cat\s+ears?|fox\s+ears?|horns?|purr(?:ing)?|fangs?|claws?)\b/i;
  if (negatedBodyClaim.test(normalized)) return null;
  const firstPersonBodyClaim = /\b(i(?:'m| am| have| got|'ve got)|my)\b.{0,80}\b(wings?|tails?|animal\s+ears?|cat\s+ears?|fox\s+ears?|horns?|purr(?:ing)?|fangs?|claws?)\b/i;
  const bodyFirstClaim = /\b(wings?|tails?|animal\s+ears?|cat\s+ears?|fox\s+ears?|horns?|purr(?:ing)?|fangs?|claws?)\b.{0,80}\b(are|is)\s+(?:mine|real|out|twitching|flicking|folded|spread|wrapped)\b/i;
  if (firstPersonBodyClaim.test(normalized) || bodyFirstClaim.test(normalized)) {
    return 'non-canonical Kai body/creature claim';
  }
  return null;
}

function classifyEngagement(input: {
  content: string;
  monitor: DiscordMonitor;
  env: Env;
  mentionIds?: string[];
  authorId?: string;
  referencedAuthorId?: string;
  activeConversation?: boolean;
}): EngagementDecision {
  const content = String(input.content || '');
  const mentionIds = input.mentionIds || [];
  const hardMention = containsHardKaiMention(content, input.env, mentionIds);
  const softNameMention = containsSoftKaiName(content);
  const urgent = isUrgent(content);
  const otherUserTag = mentionsNonKaiUser(content, input.env, mentionIds);
  const velIds = getVelDiscordUserIds(input.env);
  const authorClass: 'vel' | 'unknown' = input.authorId && velIds.includes(input.authorId) ? 'vel' : 'unknown';
  const kaiIds = getKaiDiscordMentionIds(input.env);
  const directReplyToKai = !!input.referencedAuthorId && kaiIds.includes(input.referencedAuthorId);
  const activeConversation = input.activeConversation === true;
  const responseMode = input.monitor.response_mode || 'filtered';
  const communityGreeting = isCommunityGreeting(content);
  const communityGreetingAllowed = communityGreeting && allowsCommunityGreeting(input.monitor) && !otherUserTag;
  const base: Omit<EngagementDecision, 'disposition' | 'trigger_reason' | 'priority'> = {
    hard_mention: hardMention,
    soft_name_mention: softNameMention,
    active_conversation: activeConversation,
    direct_reply_to_kai: directReplyToKai,
    other_user_tag: otherUserTag,
    author_class: authorClass,
    community_greeting: communityGreeting,
  };

  if (!content.trim()) {
    return { disposition: 'ignore', trigger_reason: 'empty-message', priority: 'low', ...base };
  }
  if (authorClass === 'vel' && hardMention) {
    return { disposition: 'respond', trigger_reason: urgent ? 'vel-hard-mention-required-urgent' : 'vel-hard-mention-required', priority: 'high', ...base };
  }
  if (!input.monitor.respond_enabled || responseMode === 'never') {
    return { disposition: 'log', trigger_reason: authorClass === 'vel' ? 'vel-message-observe-only' : 'observe-only-monitor', priority: urgent ? 'high' : (authorClass === 'vel' ? 'normal' : 'low'), ...base };
  }
  if (authorClass !== 'vel') {
    const shouldRespond = hardMention || directReplyToKai || softNameMention || activeConversation || urgent || communityGreetingAllowed;
    const triggerReason = directReplyToKai
      ? 'non-vel-public-reply-to-kai'
      : hardMention
        ? 'non-vel-public-hard-mention'
        : softNameMention
          ? 'non-vel-public-name-mention'
          : activeConversation
            ? 'non-vel-public-active-conversation'
            : communityGreetingAllowed
              ? 'non-vel-public-community-greeting'
            : urgent
              ? 'non-vel-public-urgent'
              : 'non-vel-observe-only';
    return { disposition: shouldRespond ? 'respond' : 'log', trigger_reason: triggerReason, priority: urgent ? 'high' : (shouldRespond ? 'normal' : 'low'), ...base };
  }
  if (activeConversation) {
    return { disposition: 'respond', trigger_reason: 'active-conversation', priority: urgent ? 'high' : 'normal', ...base };
  }
  if (directReplyToKai) {
    return { disposition: 'respond', trigger_reason: 'direct-reply-to-kai', priority: urgent ? 'high' : 'normal', ...base };
  }
  if (responseMode === 'discern') {
    const discernReason = kaiDiscernmentReason({
      content,
      hardMention,
      softNameMention,
      directReplyToKai,
      activeConversation,
      urgent,
      communityGreeting,
    });
    return discernReason
      ? { disposition: 'respond', trigger_reason: discernReason, priority: urgent || hardMention || directReplyToKai ? 'high' : 'normal', ...base }
      : { disposition: 'log', trigger_reason: otherUserTag ? 'other-user-tag-not-kai' : 'discernment-no-speech', priority: 'low', ...base };
  }
  if (responseMode === 'open') {
    return { disposition: 'respond', trigger_reason: urgent ? 'open-monitor-urgent' : (hardMention ? 'open-monitor-hard-mention' : (softNameMention ? 'open-monitor-name-mention' : (communityGreeting ? 'open-monitor-community-greeting' : 'open-monitor'))), priority: urgent ? 'high' : (hardMention || softNameMention || communityGreeting ? 'normal' : 'low'), ...base };
  }
  if (responseMode === 'community_greeting') {
    if (communityGreetingAllowed) {
      return { disposition: 'respond', trigger_reason: 'community-greeting', priority: 'normal', ...base };
    }
    if (hardMention || softNameMention) {
      return { disposition: 'respond', trigger_reason: hardMention ? 'hard-mention' : 'name-mention', priority: urgent ? 'high' : 'normal', ...base };
    }
    return { disposition: 'log', trigger_reason: otherUserTag ? 'other-user-tag-not-kai' : 'community-greeting-required', priority: 'low', ...base };
  }
  if (responseMode === 'mention') {
    if (hardMention || softNameMention) {
      return { disposition: 'respond', trigger_reason: hardMention ? 'hard-mention' : 'name-mention', priority: urgent ? 'high' : 'normal', ...base };
    }
    return { disposition: 'log', trigger_reason: otherUserTag ? 'other-user-tag-not-kai' : 'mention-required', priority: 'low', ...base };
  }
  if (responseMode === 'urgent') {
    return urgent
      ? { disposition: 'respond', trigger_reason: 'urgency-keyword', priority: 'high', ...base }
      : { disposition: 'log', trigger_reason: 'urgency-required', priority: 'low', ...base };
  }
  if (hardMention) {
    return { disposition: 'respond', trigger_reason: urgent ? 'hard-mention-and-urgency' : 'hard-mention', priority: urgent ? 'high' : 'normal', ...base };
  }
  if (softNameMention && !otherUserTag) {
    return { disposition: 'respond', trigger_reason: urgent ? 'name-mention-and-urgency' : 'name-mention', priority: urgent ? 'high' : 'normal', ...base };
  }
  if (urgent) {
    return { disposition: 'respond', trigger_reason: otherUserTag ? 'urgency-with-other-user-tag' : 'urgency-keyword', priority: 'high', ...base };
  }
  if (authorClass === 'vel') {
    return { disposition: 'log', trigger_reason: 'vel-message', priority: 'normal', ...base };
  }
  return { disposition: 'log', trigger_reason: otherUserTag ? 'other-user-tag-not-kai' : 'ambient-message', priority: 'low', ...base };
}

async function postContinuityEvent(env: Env, event: {
  companion_id: string;
  conversation_id: string;
  external_message_id: string;
  role: 'human' | 'companion' | 'system' | 'tool';
  author?: unknown;
  content: string;
  created_at?: string;
  reply_to?: string | null;
  metadata?: Record<string, unknown>;
  raw?: unknown;
  pre_response_required?: boolean;
}): Promise<any | null> {
  const base = (env.CONTINUITY_WORKER_URL || '').replace(/\/+$/, '');
  if ((!base && !env.CONTINUITY) || !env.CONTINUITY_API_KEY || !event.content) return null;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.CONTINUITY_API_KEY}`,
    },
    body: JSON.stringify({
      source: 'discord',
      companion_id: normalizeCompanionId(event.companion_id),
      conversation_id: event.conversation_id,
      external_message_id: event.external_message_id,
      role: event.role,
      author: event.author || {},
      content: event.content,
      created_at: event.created_at || new Date().toISOString(),
      reply_to: event.reply_to || null,
      pre_response_required: event.pre_response_required === true,
      processing_status: 'pending',
      metadata: redactContinuityPayload({ adapter: 'discord-webhook', ...(event.metadata || {}) }),
      raw: redactContinuityPayload(event.raw || event),
    }),
  };
  const response = env.CONTINUITY
    ? await env.CONTINUITY.fetch(new Request('https://continuity.internal/events', init))
    : await fetch(`${base}/events`, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`continuity ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.json().catch(() => null);
}

async function continuityRequest(env: Env, path: string, init: RequestInit): Promise<any> {
  const base = (env.CONTINUITY_WORKER_URL || '').replace(/\/+$/, '');
  if ((!base && !env.CONTINUITY) || !env.CONTINUITY_API_KEY) {
    throw new Error('Continuity binding/key is not configured');
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.CONTINUITY_API_KEY}`,
    ...(init.headers || {}),
  } as Record<string, string>;
  const response = env.CONTINUITY
    ? await env.CONTINUITY.fetch(new Request(`https://continuity.internal${path}`, { ...init, headers }))
    : await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  if (!response.ok) throw new Error(`continuity ${response.status}: ${text.slice(0, 240)}`);
  return data;
}

function nexusRunnerApiKey(env: Env): string | undefined {
  return env.NEXUS_RUNNER_API_KEY;
}

async function callNexusKaiRunner(env: Env, body: Record<string, unknown>): Promise<any> {
  if (!env.NEXUS && !env.KAI_NEXUS_URL) throw new Error('KAI_NEXUS_URL or NEXUS service binding is not configured');
  const base = (env.NEXUS ? 'https://nexus.internal' : env.KAI_NEXUS_URL || 'https://nexus.internal').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = nexusRunnerApiKey(env);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const request = new Request(`${base}/api/kaisoryth/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const response = env.NEXUS ? await env.NEXUS.fetch(request) : await fetch(request);
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok) throw new Error(`nexus runner ${response.status}: ${text.slice(0, 400)}`);
  if (data && typeof data === 'object' && data.generated === false) {
    const generation = data.generation && typeof data.generation === 'object' ? data.generation as Record<string, unknown> : null;
    const generationError = typeof generation?.error === 'string' ? generation.error : '';
    if (generation?.attempted === true && generation?.ok === false && isTransientKaiRunnerModelError(generationError)) {
      throw new Error(`nexus runner generation failed: ${generationError}`);
    }
  }
  return data;
}

async function callKaiRunner(env: Env, body: Record<string, unknown>): Promise<any> {
  return callNexusKaiRunner(env, body);
}

function isTransientKaiRunnerModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /currently at capacity|overloaded|rate limit|temporarily unavailable|returned no choices|timed out/i.test(message);
}

function isTransientKaiRunnerServiceError(status: number | null | undefined, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    (typeof status === 'number' && status >= 500)
    || /D1_ERROR|Internal error while starting up D1 DB storage|object to be reset|currently at capacity|overloaded|rate limit|temporarily unavailable|returned no choices|returned no message content|timed out|fetch failed|network|connection/i.test(message)
  );
}

function kaiAutoresponderRetryDelayMs(retryCount: number): number {
  const index = Math.max(0, Math.min(KAI_AUTORESPONDER_RETRY_DELAYS_MS.length - 1, retryCount - 1));
  return KAI_AUTORESPONDER_RETRY_DELAYS_MS[index] || KAI_AUTORESPONDER_RETRY_DELAYS_MS[KAI_AUTORESPONDER_RETRY_DELAYS_MS.length - 1];
}

async function callKaiRunnerWithFallback(env: Env, body: Record<string, unknown>): Promise<any> {
  const requestedModel = body.model ? String(body.model) : (env.KAI_DEFAULT_MODEL || KAI_NEXUS_RUNNER_DEFAULT_MODEL);
  if (requestedModel !== KAI_NEXUS_RUNNER_DEFAULT_MODEL) {
    console.warn(`[kai-runner] ignoring model override ${requestedModel}; Kai is frozen to ${KAI_NEXUS_RUNNER_DEFAULT_MODEL}`);
  }
  return callKaiRunner(env, { ...body, model: KAI_NEXUS_RUNNER_DEFAULT_MODEL });
}

function continuityResultEventId(result: any): string | null {
  const first = result?.results?.[0];
  return first?.event?.id ? String(first.event.id) : null;
}

async function findContinuityEventForCommand(env: Env, command: PendingCommand, externalMessageId?: string): Promise<any | null> {
  const targetExternalMessageId = externalMessageId || command.message_id || command.id;
  const params = new URLSearchParams({
    source: 'discord',
    companion_id: normalizeCompanionId(command.companion_id),
    conversation_id: `discord:${command.channel_id}`,
    limit: '200',
  });
  try {
    const data = await continuityRequest(env, `/events?${params.toString()}`, { method: 'GET' });
    const events = Array.isArray(data?.events) ? data.events : [];
    return events.find((event: any) =>
      String(event.external_message_id || '') === targetExternalMessageId
      && String(event.role || '') === 'human'
    ) || null;
  } catch {
    return null;
  }
}

async function createAndClaimWakeForCommand(env: Env, command: PendingCommand, runnerId: string, leaseSeconds: number = 300): Promise<{ event_id: string; wake_candidate: any; wake_context: any }> {
  const externalMessageId = command.message_id || command.id;
  const runnerExternalMessageId = `${externalMessageId}:runner-wake:${command.id}`;
  const continuityContent = discordContinuityContent(command.content, command.attachments);
  const existingEvent = await findContinuityEventForCommand(env, command, runnerExternalMessageId);
  let eventId = existingEvent?.id ? String(existingEvent.id) : null;
  if (!eventId) {
    try {
      const eventResult = await postContinuityEvent(env, {
        companion_id: command.companion_id,
        conversation_id: `discord:${command.channel_id}`,
        external_message_id: runnerExternalMessageId,
        role: 'human',
        author: {
          id: command.author?.id || command.author_id,
          name: command.author?.username || 'unknown',
        },
        content: continuityContent,
        created_at: command.timestamp ? new Date(command.timestamp).toISOString() : undefined,
        reply_to: command.referenced_author_id || null,
        metadata: {
          activity_type: 'runner_wake',
          request_id: command.id,
          original_external_message_id: externalMessageId,
          channel_id: command.channel_id,
          channel_label: command.channel_label || null,
          trigger_reason: command.trigger_reason || null,
          priority: command.priority || null,
          response_mode: command.response_mode || null,
          wake: {
            reason: command.trigger_reason || 'discord_pending_command',
            urgency: command.priority || 'normal',
          },
          ...(command.engagement ? engagementDebug(command.engagement) : {}),
          mention_ids: command.mention_ids || [],
          referenced_author_id: command.referenced_author_id || null,
          attachments: command.attachments || [],
        },
        raw: command,
        pre_response_required: true,
      });
      eventId = continuityResultEventId(eventResult);
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes('UNIQUE constraint failed')) throw error;
      const replayedEvent = await findContinuityEventForCommand(env, command, runnerExternalMessageId);
      eventId = replayedEvent?.id ? String(replayedEvent.id) : null;
      if (!eventId) throw error;
    }
  }
  if (!eventId) throw new Error('Continuity did not return an event id for runner wake');
  const claim = await continuityRequest(env, '/wake-candidates/claim', {
    method: 'POST',
    body: JSON.stringify({
      companion_id: normalizeCompanionId(command.companion_id),
      event_id: eventId,
      runner_id: runnerId,
      lease_seconds: leaseSeconds,
    }),
  });
  if (!claim?.claimed || !claim?.wake_candidate?.id) {
    throw new Error(`No wake candidate could be claimed for event ${eventId}`);
  }
  const wakeContext = await continuityRequest(env, `/wake-candidates/${encodeURIComponent(String(claim.wake_candidate.id))}/context`, {
    method: 'GET',
  });
  return { event_id: eventId, wake_candidate: claim.wake_candidate, wake_context: wakeContext };
}

async function releaseWakeCandidate(env: Env, candidateId: string, runnerId: string, failureReason?: string): Promise<any> {
  return continuityRequest(env, `/wake-candidates/${encodeURIComponent(candidateId)}/release`, {
    method: 'POST',
    body: JSON.stringify({
      runner_id: runnerId,
      status: failureReason ? 'skipped' : 'released',
      failure_reason: failureReason || null,
    }),
  });
}

interface PendingCommand {
  id: string;
  companion_id: string;
  content: string;
  author: { username: string; id?: string };
  author_id?: string;
  channel_id: string;
  guild_id?: string;
  webhook_url?: string;
  timestamp: number;
  channel_label?: string;
  disposition?: KairosDisposition;
  trigger_reason?: string;
  priority?: KairosPriority;
  source?: 'poll' | 'webhook' | 'manual';
  message_id?: string;
  mention_ids?: string[];
  referenced_author_id?: string;
  response_mode?: DiscordResponseMode;
  recent_context?: string;
  attachments?: Array<Record<string, unknown>>;
  engagement?: EngagementDecision;
}

function kaiRunnerEnvelopeForCommand(command: PendingCommand): Record<string, unknown> {
  return {
    guild_id: command.guild_id,
    channel_id: command.channel_id,
    message_id: command.message_id || command.id,
    author_id: command.author?.id || command.author_id,
    author_username: command.author?.username,
    timestamp: new Date(command.timestamp).toISOString(),
    content: command.content,
    recent_context: command.recent_context,
    mentions: command.mention_ids || [],
    attachments: command.attachments || [],
    response_mode: command.response_mode,
    trigger_reason: command.trigger_reason,
    priority: command.priority,
    engagement: command.engagement || null,
    trigger: command.source === 'manual'
      ? 'manual'
      : command.priority === 'high' || command.mention_ids?.length
        ? 'mention'
        : 'listener',
  };
}

function discordAttachmentMetadata(attachments: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : undefined,
      filename: typeof item.filename === 'string' ? item.filename : undefined,
      content_type: typeof item.content_type === 'string' ? item.content_type : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
      proxy_url: typeof item.proxy_url === 'string' ? item.proxy_url : undefined,
      width: typeof item.width === 'number' ? item.width : undefined,
      height: typeof item.height === 'number' ? item.height : undefined,
    }));
}

function isImageAttachmentMetadata(attachment: Record<string, unknown>): boolean {
  const contentType = typeof attachment.content_type === 'string' ? attachment.content_type.toLowerCase() : '';
  const filename = typeof attachment.filename === 'string' ? attachment.filename.toLowerCase() : '';
  const url = typeof attachment.url === 'string' ? attachment.url.toLowerCase() : '';
  return contentType.startsWith('image/')
    || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(filename)
    || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url);
}

function attachmentSummaryText(attachments: unknown): string {
  const normalized = discordAttachmentMetadata(attachments);
  if (!normalized.length) return '';
  return normalized
    .map((attachment) => {
      const kind = isImageAttachmentMetadata(attachment) ? 'image' : 'file';
      const name = String(attachment.filename || attachment.id || 'attachment');
      const type = attachment.content_type ? ` ${attachment.content_type}` : '';
      return `[Discord ${kind} attachment: ${name}${type}]`;
    })
    .join(' ');
}

function discordContinuityContent(content: unknown, attachments?: unknown): string {
  const text = String(content || '').trim();
  return [text, attachmentSummaryText(attachments)].filter(Boolean).join('\n');
}

function normalizeKaiModelOverride(value: unknown): string | null {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model) return null;
  if (!KAI_MODEL_ID_PATTERN.test(model)) {
    throw new Error('Kai model override must be a valid model id such as z-ai/glm-5.2');
  }
  return model;
}

function messageHasUsableContent(message: any): boolean {
  return Boolean(String(message?.content || '').trim()) || discordAttachmentMetadata(message?.attachments).length > 0;
}

function discordMessageId(message: any): string {
  return String(message?.id || '');
}

function mergeDiscordMessages(...groups: any[][]): any[] {
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const group of groups) {
    for (const message of Array.isArray(group) ? group : []) {
      const id = discordMessageId(message);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(message);
    }
  }
  return merged.sort((a, b) => {
    const aTime = Date.parse(a?.timestamp || '') || 0;
    const bTime = Date.parse(b?.timestamp || '') || 0;
    if (aTime !== bTime) return aTime - bTime;
    return discordMessageId(a).localeCompare(discordMessageId(b));
  });
}

function mergeAttachmentMetadata(...groups: Array<Array<Record<string, unknown>>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    for (const attachment of group) {
      const key = String(attachment.id || attachment.url || attachment.proxy_url || JSON.stringify(attachment));
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function looksLikeDiscordImageGenerationRequest(content: string): boolean {
  if (/\b(generate|create|draw|make|render)\b[\s\S]{0,120}\b(image|picture|art|illustration|photo)\b/i.test(content)) return true;
  if (/\b(image|picture|art|illustration|photo)\b[\s\S]{0,120}\b(generate|create|draw|make|render)\b/i.test(content)) return true;
  if (/\b(generate|create|draw|render)\b[\s\S]{0,120}\b(portrait|selfie|scene|wallpaper|avatar|icon|sticker|banner|card|poster|logo|character|sketch|painting|bouquet|flowers?|florals?|arrangement)\b/i.test(content)) return true;
  if (/\bmake\s+(?:me|for me|us|for us)\b[\s\S]{0,120}\b(portrait|selfie|scene|wallpaper|avatar|icon|sticker|banner|card|poster|logo|character|sketch|painting|bouquet|flowers?|florals?|arrangement)\b/i.test(content)) return true;
  return false;
}

function kaiRunnerImageGenerationSummary(runnerResult: any): Record<string, unknown> {
  const imageGeneration = runnerResult?.image_generation && typeof runnerResult.image_generation === 'object'
    ? runnerResult.image_generation
    : null;
  if (!imageGeneration) return { present: false };
  const images = Array.isArray(imageGeneration.images) ? imageGeneration.images : [];
  return {
    present: true,
    attempted: imageGeneration.attempted === true,
    enabled: imageGeneration.enabled === true,
    ok: imageGeneration.ok === true,
    provider: typeof imageGeneration.provider === 'string' ? imageGeneration.provider : null,
    model: typeof imageGeneration.model === 'string' ? imageGeneration.model : null,
    prompt: typeof imageGeneration.prompt === 'string' ? imageGeneration.prompt.slice(0, 500) : null,
    error: typeof imageGeneration.error === 'string' ? imageGeneration.error.slice(0, 500) : null,
    image_count: images.length,
    stored_urls: images.map((image: any) => typeof image?.stored_url === 'string' ? image.stored_url : null).filter(Boolean),
    r2_keys: images.map((image: any) => typeof image?.r2_key === 'string' ? image.r2_key : null).filter(Boolean),
  };
}

function kaiRunnerVisionSummary(runnerResult: any): Record<string, unknown> {
  const vision = runnerResult?.vision && typeof runnerResult.vision === 'object' ? runnerResult.vision : null;
  if (!vision) return { present: false };
  const summaries = Array.isArray(vision.summaries) ? vision.summaries : [];
  return {
    present: true,
    attempted: vision.attempted === true,
    enabled: vision.enabled === true,
    ok: vision.ok === true,
    provider: typeof vision.provider === 'string' ? vision.provider : null,
    model: typeof vision.model === 'string' ? vision.model : null,
    error: typeof vision.error === 'string' ? vision.error.slice(0, 500) : null,
    summary_count: summaries.length,
    summaries: summaries.slice(0, 4).map((summary: any) => ({
      attachment_id: typeof summary?.attachment_id === 'string' ? summary.attachment_id : null,
      filename: typeof summary?.filename === 'string' ? summary.filename : null,
      model: typeof summary?.model === 'string' ? summary.model : null,
      summary: typeof summary?.summary === 'string' ? summary.summary.slice(0, 1000) : null,
    })),
  };
}

function kaiRunnerWorkspaceSummary(runnerResult: any): Record<string, unknown> {
  const workspace = runnerResult?.workspace && typeof runnerResult.workspace === 'object'
    ? runnerResult.workspace
    : null;
  if (!workspace) return { present: false };
  return {
    present: true,
    requested: workspace.requested === true,
    attempted: workspace.attempted === true,
    ok: workspace.ok === true,
    action: typeof workspace.action === 'string' ? workspace.action : null,
    path: typeof workspace.path === 'string' ? workspace.path : null,
    query: typeof workspace.query === 'string' ? workspace.query : null,
    error: typeof workspace.error === 'string' ? workspace.error.slice(0, 500) : null,
    agent_ok: workspace.agent?.ok === true,
    r2: {
      requested: workspace.r2?.requested === true,
      configured: workspace.r2?.configured === true,
      ok: workspace.r2?.ok === true,
      key: typeof workspace.r2?.key === 'string' ? workspace.r2.key : null,
      history_key: typeof workspace.r2?.history_key === 'string' ? workspace.r2.history_key : null,
      error: typeof workspace.r2?.error === 'string' ? workspace.r2.error.slice(0, 500) : null,
    },
    github: {
      requested: workspace.github?.requested === true,
      configured: workspace.github?.configured === true,
      ok: workspace.github?.ok === true,
      repo: typeof workspace.github?.repo === 'string' ? workspace.github.repo : null,
      path: typeof workspace.github?.path === 'string' ? workspace.github.path : null,
      error: typeof workspace.github?.error === 'string'
        ? workspace.github.error.slice(0, 500)
        : (typeof workspace.github?.skipped_reason === 'string' ? workspace.github.skipped_reason.slice(0, 500) : null),
    },
  };
}

function kaiRunnerSource(runnerResult: any): string {
  return typeof runnerResult?.source === 'string' && runnerResult.source.trim()
    ? runnerResult.source.trim()
    : 'nexus-gateway';
}

function kaiRunnerDeliveryPath(runnerSource: string): string {
  return runnerSource === 'serythrae-gw'
    ? 'discord-continuity-tahl-nexus-serythrae-gw-nesteq-discord'
    : 'discord-continuity-tahl-nexus-nesteq-discord';
}

function isRequiredVelHardTag(cmd: Pick<PendingCommand, 'priority' | 'trigger_reason' | 'engagement'>): boolean {
  return cmd.priority === 'high'
    && (
      String(cmd.trigger_reason || '').startsWith('vel-hard-mention-required')
      || String(cmd.trigger_reason || '') === 'direct-nexus-hard-mention'
    )
    && cmd.engagement?.author_class === 'vel'
    && cmd.engagement?.hard_mention === true;
}

// Helper: Discord API request with bot token
async function discordRequest(env: Env, endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${DISCORD_API}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: true, status: response.status, message: text };
  }

  if (response.status === 204) return {};
  return response.json();
}

function firstMcpText(value: any): string | null {
  const result = value?.result && typeof value.result === 'object' ? value.result : value;
  const content = Array.isArray(result?.content) ? result.content : [];
  const first = content[0];
  return typeof first?.text === 'string' ? first.text : null;
}

function runnerSocialDecision(runnerResult: any): { decision?: string; recommended_reaction?: string } | null {
  const text = firstMcpText(runnerResult?.context?.social_engagement);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function runnerGenerationSummary(runnerResult: any): Record<string, unknown> | null {
  const generation = runnerResult?.generation && typeof runnerResult.generation === 'object'
    ? runnerResult.generation as Record<string, unknown>
    : null;
  return generation ? generation : null;
}

function runnerGenerationFailureMessage(runnerResult: any): string {
  const generation = runnerGenerationSummary(runnerResult);
  const error = typeof generation?.error === 'string' ? generation.error.trim() : '';
  const model = typeof generation?.model === 'string' ? generation.model.trim() : '';
  return [
    'Kai runner returned no text for a required Discord reply',
    model ? `model=${model}` : '',
    error ? `error=${error}` : '',
  ].filter(Boolean).join('; ');
}

function isRequiredKaiReply(command: PendingCommand, runnerResult: any): boolean {
  const engagement = (command.engagement || {}) as Partial<EngagementDecision>;
  return runnerResult?.should_respond === true
    || engagement.hard_mention === true
    || engagement.direct_reply_to_kai === true
    || engagement.soft_name_mention === true
    || engagement.active_conversation === true;
}

interface KaiGeneratedDiscordImage {
  index: number;
  url: string;
  key?: string;
  stored_url?: string;
  source_url?: string;
  content_type?: string;
}

function absoluteKaiImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  if (url.startsWith('/img/')) return `${KAI_PUBLIC_MIND_ORIGIN}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

function kaiGeneratedDiscordImages(runnerResult: any): KaiGeneratedDiscordImage[] {
  const images = runnerResult?.image_generation?.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((image: any, index: number): KaiGeneratedDiscordImage | null => {
      if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
      const storedUrl = absoluteKaiImageUrl(image.stored_url);
      const sourceUrl = absoluteKaiImageUrl(image.url);
      const url = storedUrl || sourceUrl;
      if (!url) return null;
      return {
        index: typeof image.index === 'number' ? image.index : index,
        url,
        key: typeof image.r2_key === 'string' ? image.r2_key : undefined,
        stored_url: typeof image.stored_url === 'string' ? image.stored_url : undefined,
        source_url: typeof image.url === 'string' ? image.url : undefined,
        content_type: typeof image.mime_type === 'string' ? image.mime_type : undefined,
      };
    })
    .filter((image): image is KaiGeneratedDiscordImage => Boolean(image));
}

function kaiImageEmbeds(images: KaiGeneratedDiscordImage[]): Array<Record<string, unknown>> {
  return images.map((image, index) => ({
    title: images.length > 1 ? `Generated image ${index + 1}` : 'Generated image',
    url: image.url,
    image: { url: image.url },
    ...(image.key ? { footer: { text: image.key } } : {}),
  }));
}

function kaiGeneratedImageMetadata(images: KaiGeneratedDiscordImage[], sentMessageIds: string[]): Record<string, unknown>[] {
  return images.map((image, index) => ({
    index: image.index,
    url: image.url,
    r2_key: image.key || null,
    stored_url: image.stored_url || null,
    source_url: image.source_url || null,
    content_type: image.content_type || null,
    discord_message_id: sentMessageIds[index] || null,
  }));
}

async function sendKaiGeneratedImages(
  env: Env,
  command: PendingCommand,
  companion: Companion,
  images: KaiGeneratedDiscordImage[],
  targetWebhookUrl?: string | null
): Promise<{ sentMessageIds: string[]; sentWebhookUrl?: string }> {
  if (!images.length) return { sentMessageIds: [] };
  const sentMessageIds: string[] = [];
  const caption = images.length > 1 ? 'Generated images:' : 'Generated image:';
  const embeds = kaiImageEmbeds(images);
  const embedGroups: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < embeds.length; i += 10) embedGroups.push(embeds.slice(i, i + 10));

  if (targetWebhookUrl) {
    for (const group of embedGroups) {
      const res = await fetch(`${targetWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: caption,
          username: companion.name,
          avatar_url: companion.avatar_url,
          embeds: group,
        }),
      });
      if (!res.ok) throw new Error(`Webhook image delivery failed: ${await res.text()}`);
      const msgData = await res.json() as any;
      sentMessageIds.push(msgData.id);
    }
    return { sentMessageIds, sentWebhookUrl: targetWebhookUrl };
  }

  for (const group of embedGroups) {
    const result = await discordRequest(env, `/channels/${command.channel_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: caption, embeds: group }),
    });
    if (result.error) throw new Error(`Discord image delivery error: ${JSON.stringify(result)}`);
    sentMessageIds.push(result.id);
  }
  return { sentMessageIds };
}

async function addKaiSocialReaction(env: Env, channelId: string, messageId: string, emoji: string): Promise<void> {
  const encoded = encodeURIComponent(emoji || '👀');
  const result = await discordRequest(env, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, { method: 'PUT' });
  if (result?.error) throw new Error(`Discord reaction error: ${JSON.stringify(result)}`);
}

// Helper: Fetch available guilds and format as hint text
async function getGuildListHint(env: Env): Promise<string> {
  try {
    const guilds = await discordRequest(env, '/users/@me/guilds');
    if (Array.isArray(guilds) && guilds.length > 0) {
      return guilds.map((g: any) => `• ${g.name} — ${g.id}`).join('\n');
    }
  } catch {}
  return '(could not fetch guild list)';
}

// Helper: Auto-resolve guildId — returns the ID if valid, auto-selects if only 1 guild, or returns error with list
async function resolveGuild(env: Env, guildId?: string): Promise<{ id: string } | { error: string }> {
  if (guildId) return { id: guildId };
  try {
    const guilds = await discordRequest(env, '/users/@me/guilds');
    if (!Array.isArray(guilds) || guilds.length === 0) return { error: 'Bot is not in any guilds.' };
    if (guilds.length === 1) return { id: guilds[0].id };
    const list = guilds.map((g: any) => `• ${g.name} — ${g.id}`).join('\n');
    return { error: `Multiple guilds available. Please specify guildId:\n${list}` };
  } catch {
    return { error: 'Failed to fetch guild list.' };
  }
}

// Helper: Split long messages at Discord's 2000 character limit
function splitMessage(content: string, maxLength: number = 2000): string[] {
  if (content.length <= maxLength) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline before limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    // If no newline, try last space
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength);
    // If still nothing, hard split
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

// ========== Durable Object: CompanionBot ==========

export class CompanionBot extends McpAgent<Env> {
  server = new McpServer({
    name: "discord-companion-bot",
    version: "1.0.0",
  });

  // SQLite-backed pending commands (survives DO eviction)
  private dbReady = false;

  private ensureTable() {
    if (this.dbReady) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_commands (
      id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      content TEXT NOT NULL,
      author_username TEXT NOT NULL,
      author_id TEXT,
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      webhook_url TEXT,
      channel_label TEXT,
      disposition TEXT,
      trigger_reason TEXT,
      priority TEXT,
      source TEXT,
      message_id TEXT,
      mention_ids TEXT,
      referenced_author_id TEXT,
      response_mode TEXT,
      recent_context TEXT,
      attachments_json TEXT,
      engagement TEXT,
      timestamp INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_cursors (
      channel_id TEXT PRIMARY KEY,
      last_message_id TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS avatars (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      content_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS companions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      triggers TEXT NOT NULL,
      bot_user_ids TEXT,
      human_name TEXT,
      human_info TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      discord_username TEXT NOT NULL,
      discord_avatar TEXT,
      discord_global_name TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    // Per-companion custom rules/instructions
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS companion_rules (
      companion_id TEXT PRIMARY KEY,
      rules TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // Per-companion channel permissions (blocklist)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS companion_channels (
      companion_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (companion_id, channel_id)
    )`);
    // Activity log for message tracking
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS companion_activity (
      id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      type TEXT NOT NULL,
      channel_id TEXT,
      content TEXT,
      author TEXT,
      author_id TEXT,
      engagement TEXT,
      message_id TEXT,
      webhook_url TEXT,
      timestamp INTEGER NOT NULL
    )`);
    // Per-channel webhook cache (auto-created)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_webhooks (
      channel_id TEXT PRIMARY KEY,
      webhook_url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Banned servers — bot auto-leaves if re-invited
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS banned_servers (
      guild_id TEXT PRIMARY KEY,
      reason TEXT,
      banned_at INTEGER NOT NULL
    )`);
    // Entity model: per-server companion config (permissions, channel/tool whitelists)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS entity_servers (
      entity_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      allowed_channels TEXT,
      blocked_channels TEXT,
      allowed_tools TEXT,
      watch_channels TEXT,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_id, guild_id)
    )`);
    // Entity model: audit trail for entity-scoped actions
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS entity_action_log (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      tool_name TEXT NOT NULL,
      action_summary TEXT,
      success INTEGER DEFAULT 1,
      error_message TEXT,
      timestamp INTEGER NOT NULL
    )`);
    // Entity model: channel → guild resolution cache
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_guild_cache (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    )`);
    // Admin-controlled restricted channels — blocked for all companions unless exception granted
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS restricted_channels (
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      restricted_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, guild_id)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS discord_monitors (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'normal',
      enabled INTEGER NOT NULL DEFAULT 1,
      respond_enabled INTEGER NOT NULL DEFAULT 1,
      response_mode TEXT NOT NULL DEFAULT 'filtered',
      last_checked INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT,
      cooldown_ms INTEGER NOT NULL DEFAULT 300000,
      last_responded INTEGER NOT NULL DEFAULT 0,
      added_by TEXT NOT NULL DEFAULT 'system',
      added_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS active_conversations (
      channel_id TEXT NOT NULL,
      author_id TEXT,
      active_until INTEGER NOT NULL,
      last_message_id TEXT,
      started_by TEXT NOT NULL,
      PRIMARY KEY (channel_id, author_id)
    )`);
    // Per-companion exceptions for restricted channels (admin-granted only)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_exceptions (
      companion_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      granted_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (companion_id, channel_id, guild_id)
    )`);
    // Migration: add owner_id to companions (idempotent)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companions ADD COLUMN owner_id TEXT`);
    } catch (_) { /* column already exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companions ADD COLUMN bot_user_ids TEXT`);
    } catch (_) { /* column already exists */ }
    // Migration: add message_id and webhook_url to activity (idempotent)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companion_activity ADD COLUMN message_id TEXT`);
    } catch (_) {}
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companion_activity ADD COLUMN webhook_url TEXT`);
    } catch (_) {}
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companion_activity ADD COLUMN author_id TEXT`);
    } catch (_) {}
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE companion_activity ADD COLUMN engagement TEXT`);
    } catch (_) {}
    for (const stmt of [
      `ALTER TABLE pending_commands ADD COLUMN channel_label TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN guild_id TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN disposition TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN trigger_reason TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN priority TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN source TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN message_id TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN mention_ids TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN referenced_author_id TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN response_mode TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN recent_context TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN attachments_json TEXT`,
      `ALTER TABLE pending_commands ADD COLUMN engagement TEXT`,
    ]) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch (_) {}
    }
    this.dbReady = true;
    this.seedCompanions();
    this.seedBootstrapMonitors();
  }

  // Seed companions from hardcoded data (insert missing, sync avatar URLs)
  private seedCompanions() {
    const now = Date.now();
    let added = 0;
    let updated = 0;
    for (const c of Object.values(SEED_COMPANIONS)) {
      const botUserIds = JSON.stringify(c.bot_user_ids || []);
      const triggers = JSON.stringify(c.triggers);
      const existing = this.ctx.storage.sql.exec(`SELECT id, name, avatar_url, triggers, bot_user_ids, human_name, human_info FROM companions WHERE id = ?`, c.id).toArray();
      if (existing.length === 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO companions (id, name, avatar_url, triggers, bot_user_ids, human_name, human_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id, c.name, c.avatar_url, triggers, botUserIds, c.human_name || null, c.human_info || null, now, now
        );
        added++;
      } else {
        const row = existing[0] as any;
        const needsSync = row.name !== c.name
          || row.avatar_url !== c.avatar_url
          || row.triggers !== triggers
          || row.bot_user_ids !== botUserIds
          || (row.human_name || null) !== (c.human_name || null)
          || (row.human_info || null) !== (c.human_info || null);
        if (!needsSync) continue;
        this.ctx.storage.sql.exec(
          `UPDATE companions SET name = ?, avatar_url = ?, triggers = ?, bot_user_ids = ?, human_name = ?, human_info = ?, updated_at = ? WHERE id = ?`,
          c.name, c.avatar_url, triggers, botUserIds, c.human_name || null, c.human_info || null, now, c.id
        );
        updated++;
      }
    }
    if (added > 0 || updated > 0) console.log(`Companions: ${added} added, ${updated} synced`);
  }

  private seedBootstrapMonitors() {
    const now = Date.now();
    const kaiListenChannels = getKaiListenChannelIds(this.env);
    const privateChannels = kaiListenChannels.length
      ? kaiListenChannels.filter(channelId => isKaiAccessibleChannel(this.env, channelId))
      : (this.env.WATCH_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
    const socialHardChannels = getKaiSocialHardTagChannelIds(this.env);
    const socialSoftChannels = getKaiSocialSoftTagChannelIds(this.env);
    const socialDiscernChannels = getKaiSocialDiscernChannelIds(this.env);
    const monitorConfigs = [
      ...privateChannels.map(channelId => ({
        channelId,
        addedBy: kaiListenChannels.length ? 'KAI_LISTEN_CHANNEL_IDS' : 'WATCH_CHANNELS',
        responseMode: 'filtered',
      })),
      ...socialHardChannels.map(channelId => ({
        channelId,
        addedBy: 'KAI_SOCIAL_HARD_TAG_CHANNEL_IDS',
        responseMode: 'mention',
      })),
      ...socialSoftChannels.map(channelId => ({
        channelId,
        addedBy: 'KAI_SOCIAL_SOFT_TAG_CHANNEL_IDS',
        responseMode: 'mention',
      })),
      ...socialDiscernChannels.map(channelId => ({
        channelId,
        addedBy: 'KAI_SOCIAL_DISCERN_CHANNEL_IDS',
        responseMode: 'discern',
      })),
    ];
    for (const config of monitorConfigs) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO discord_monitors (id, channel_id, label, tier, enabled, respond_enabled, response_mode, last_checked, cooldown_ms, last_responded, added_by, added_at)
         VALUES (?, ?, ?, 'normal', 1, 1, 'filtered', 0, 300000, 0, ?, ?)`,
        `monitor:${config.channelId}`, config.channelId, config.channelId, config.addedBy, now
      );
      this.ctx.storage.sql.exec(
        `UPDATE discord_monitors SET response_mode = ?, respond_enabled = 1 WHERE channel_id = ? AND added_by = ?`,
        config.responseMode, config.channelId, config.addedBy
      );
      if (config.addedBy.startsWith('KAI_SOCIAL_')) {
        this.ctx.storage.sql.exec(
          `UPDATE discord_monitors SET response_mode = ?, respond_enabled = 1, added_by = ? WHERE channel_id = ?`,
          config.responseMode, config.addedBy, config.channelId
        );
      }
    }
  }

  getMonitors(): DiscordMonitor[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(`SELECT * FROM discord_monitors ORDER BY added_at ASC`).toArray().map((row: any) => ({
      id: row.id,
      channel_id: row.channel_id,
      label: row.label,
      tier: row.tier || 'normal',
      enabled: row.enabled === 1,
      respond_enabled: row.respond_enabled !== 0,
      response_mode: row.response_mode || 'filtered',
      last_checked: row.last_checked || 0,
      last_message_id: row.last_message_id || undefined,
      cooldown_ms: row.cooldown_ms || 300000,
      last_responded: row.last_responded || 0,
      added_by: row.added_by || 'system',
      added_at: row.added_at || 0,
    }));
  }

  upsertMonitor(input: Partial<DiscordMonitor> & { channel_id: string }): DiscordMonitor {
    this.ensureTable();
    const now = Date.now();
    const id = input.id || `monitor:${input.channel_id}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO discord_monitors (id, channel_id, label, tier, enabled, respond_enabled, response_mode, last_checked, last_message_id, cooldown_ms, last_responded, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         label = excluded.label,
         tier = excluded.tier,
         enabled = excluded.enabled,
         respond_enabled = excluded.respond_enabled,
         response_mode = excluded.response_mode,
         cooldown_ms = excluded.cooldown_ms`,
      id,
      input.channel_id,
      input.label || input.channel_id,
      input.tier || 'normal',
      input.enabled === false ? 0 : 1,
      input.respond_enabled === false ? 0 : 1,
      input.response_mode || 'filtered',
      input.last_checked || 0,
      input.last_message_id || null,
      input.cooldown_ms || 300000,
      input.last_responded || 0,
      input.added_by || 'api',
      input.added_at || now
    );
    const monitor = this.getMonitors().find(m => m.channel_id === input.channel_id);
    if (!monitor) throw new Error(`Failed to upsert monitor for ${input.channel_id}`);
    return monitor;
  }

  toggleMonitor(idOrChannelId: string): DiscordMonitor | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM discord_monitors WHERE id = ? OR channel_id = ? LIMIT 1`, idOrChannelId, idOrChannelId
    ).toArray();
    if (!rows.length) return null;
    const row = rows[0] as any;
    const next = row.enabled === 1 ? 0 : 1;
    this.ctx.storage.sql.exec(`UPDATE discord_monitors SET enabled = ? WHERE id = ?`, next, row.id);
    return this.getMonitors().find(m => m.id === row.id) || null;
  }

  removeMonitor(idOrChannelId: string): boolean {
    this.ensureTable();
    const before = this.getMonitors().length;
    this.ctx.storage.sql.exec(`DELETE FROM discord_monitors WHERE id = ? OR channel_id = ?`, idOrChannelId, idOrChannelId);
    return this.getMonitors().length < before;
  }

  // ===== Companion CRUD =====

  getAllCompanions(): (Companion & { owner_id?: string })[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(`SELECT * FROM companions ORDER BY created_at ASC`).toArray().map((row: any) => ({
      id: row.id,
      name: row.name,
      avatar_url: row.avatar_url,
      triggers: JSON.parse(row.triggers),
      bot_user_ids: row.bot_user_ids ? JSON.parse(row.bot_user_ids) : [],
      human_name: row.human_name || undefined,
      human_info: row.human_info || undefined,
      owner_id: row.owner_id || undefined,
    }));
  }

  getCompanionById(id: string): (Companion & { owner_id?: string }) | undefined {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM companions WHERE id = ?`, normalizeDiscordCompanionId(id)).toArray();
    if (rows.length === 0) return undefined;
    const row = rows[0] as any;
    return {
      id: row.id,
      name: row.name,
      avatar_url: row.avatar_url,
      triggers: JSON.parse(row.triggers),
      bot_user_ids: row.bot_user_ids ? JSON.parse(row.bot_user_ids) : [],
      human_name: row.human_name || undefined,
      human_info: row.human_info || undefined,
      owner_id: row.owner_id || undefined,
    };
  }

  getCompanionsByOwner(ownerId: string): (Companion & { owner_id?: string })[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(`SELECT * FROM companions WHERE owner_id = ? ORDER BY created_at ASC`, ownerId).toArray().map((row: any) => ({
      id: row.id,
      name: row.name,
      avatar_url: row.avatar_url,
      triggers: JSON.parse(row.triggers),
      bot_user_ids: row.bot_user_ids ? JSON.parse(row.bot_user_ids) : [],
      human_name: row.human_name || undefined,
      human_info: row.human_info || undefined,
      owner_id: row.owner_id || undefined,
    }));
  }

  createCompanion(data: { id: string; name: string; avatar_url: string; triggers: string[]; human_name?: string; human_info?: string; owner_id?: string }): Companion {
    this.ensureTable();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO companions (id, name, avatar_url, triggers, human_name, human_info, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id, data.name, data.avatar_url, JSON.stringify(data.triggers), data.human_name || null, data.human_info || null, data.owner_id || null, now, now
    );
    return { ...data };
  }

  updateCompanion(id: string, data: { name?: string; avatar_url?: string; triggers?: string[]; human_name?: string; human_info?: string; owner_id?: string }): Companion | undefined {
    this.ensureTable();
    const existing = this.getCompanionById(id);
    if (!existing) return undefined;

    const updated = {
      name: data.name ?? existing.name,
      avatar_url: data.avatar_url ?? existing.avatar_url,
      triggers: data.triggers ?? existing.triggers,
      human_name: data.human_name ?? existing.human_name,
      human_info: data.human_info ?? existing.human_info,
      owner_id: data.owner_id ?? (existing as any).owner_id,
    };

    this.ctx.storage.sql.exec(
      `UPDATE companions SET name = ?, avatar_url = ?, triggers = ?, human_name = ?, human_info = ?, owner_id = ?, updated_at = ? WHERE id = ?`,
      updated.name, updated.avatar_url, JSON.stringify(updated.triggers), updated.human_name || null, updated.human_info || null, updated.owner_id || null, Date.now(), id
    );

    return { id, ...updated };
  }

  deleteCompanion(id: string): boolean {
    this.ensureTable();
    const existing = this.getCompanionById(id);
    if (!existing) return false;
    this.ctx.storage.sql.exec(`DELETE FROM companions WHERE id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM companion_rules WHERE companion_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM companion_channels WHERE companion_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM companion_activity WHERE companion_id = ?`, id);
    return true;
  }

  // ===== Rules CRUD =====

  getRules(companionId: string): string | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(`SELECT rules FROM companion_rules WHERE companion_id = ?`, companionId).toArray();
    return rows.length > 0 ? (rows[0] as any).rules : null;
  }

  setRules(companionId: string, rules: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO companion_rules (companion_id, rules, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(companion_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`,
      companionId, rules, Date.now()
    );
  }

  // ===== Channel permissions =====

  getBlockedChannels(companionId: string): string[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT channel_id FROM companion_channels WHERE companion_id = ? AND blocked = 1`, companionId
    ).toArray().map((r: any) => r.channel_id);
  }

  setChannelBlocked(companionId: string, channelId: string, blocked: boolean) {
    this.ensureTable();
    if (blocked) {
      this.ctx.storage.sql.exec(
        `INSERT INTO companion_channels (companion_id, channel_id, blocked) VALUES (?, ?, 1)
         ON CONFLICT(companion_id, channel_id) DO UPDATE SET blocked = 1`,
        companionId, channelId
      );
    } else {
      this.ctx.storage.sql.exec(
        `DELETE FROM companion_channels WHERE companion_id = ? AND channel_id = ?`,
        companionId, channelId
      );
    }
  }

  isChannelBlocked(companionId: string, channelId: string): boolean {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT blocked FROM companion_channels WHERE companion_id = ? AND channel_id = ? AND blocked = 1`,
      companionId, channelId
    ).toArray();
    return rows.length > 0;
  }

  // ===== Activity logging =====

  logActivity(companionId: string, type: string, channelId?: string, content?: string, author?: string, messageId?: string, webhookUrl?: string, debug?: ActivityDebug): Promise<any | null> | null {
    this.ensureTable();
    const storedContent = discordContinuityContent(content, debug?.attachments);
    this.ctx.storage.sql.exec(
      `INSERT INTO companion_activity (id, companion_id, type, channel_id, content, author, author_id, engagement, message_id, webhook_url, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), companionId, type, channelId || null, storedContent || null, author || null,
      debug?.authorId || null,
      debug?.engagement ? JSON.stringify({
        ...engagementDebug(debug.engagement),
        mention_ids: debug.mentionIds || [],
        referenced_author_id: debug.referencedAuthorId || null,
        attachment_count: debug.attachments?.length || 0,
        image_attachment_count: debug.attachments?.filter(isImageAttachmentMetadata).length || 0,
      }) : null,
      messageId || null, webhookUrl || null, Date.now()
    );
    // Keep only last 200 entries per companion
    this.ctx.storage.sql.exec(
      `DELETE FROM companion_activity WHERE companion_id = ? AND id NOT IN (
        SELECT id FROM companion_activity WHERE companion_id = ? ORDER BY timestamp DESC LIMIT 200
      )`, companionId, companionId
    );
    const inboundTypes = new Set(['triggered', 'queued', 'logged', 'ignored']);
    const outboundTypes = new Set(['sent', 'responded', 'edited', 'deleted']);
    const auditTypes = new Set(['dismissed', 'expired', 'discernment_blocked']);
    if (!debug?.skipContinuity && storedContent && messageId && (inboundTypes.has(type) || outboundTypes.has(type) || auditTypes.has(type))) {
      const isHumanTrigger = inboundTypes.has(type);
      const isAudit = auditTypes.has(type);
      return postContinuityEvent(this.env, {
        companion_id: companionId,
        conversation_id: `discord:${channelId || 'unknown'}`,
        external_message_id: isAudit ? `${messageId}:${type}` : messageId,
        role: isAudit ? 'system' : (isHumanTrigger ? 'human' : 'companion'),
        author: { id: debug?.authorId || undefined, name: author || (isHumanTrigger ? 'unknown' : companionId) },
        content: storedContent,
        created_at: debug?.createdAt,
        metadata: {
          activity_type: type,
          channel_id: channelId,
          has_webhook_url: Boolean(webhookUrl),
          ...(debug?.engagement ? engagementDebug(debug.engagement) : {}),
          mention_ids: debug?.mentionIds || [],
          referenced_author_id: debug?.referencedAuthorId || null,
          attachments: debug?.attachments || [],
        },
        pre_response_required: type === 'triggered' || type === 'queued',
      }).catch((err) => {
        console.warn('[continuity] discord event failed', err);
        return null;
      });
    }
    return null;
  }

  getActivity(companionId: string, limit: number = 50): any[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT * FROM companion_activity WHERE companion_id = ? ORDER BY timestamp DESC LIMIT ?`,
      companionId, limit
    ).toArray().map((r: any) => ({
      id: r.id,
      companion_id: r.companion_id,
      type: r.type,
      channel_id: r.channel_id,
      content: r.content,
      author: r.author,
      author_id: r.author_id || undefined,
      engagement: r.engagement ? JSON.parse(r.engagement) : undefined,
      message_id: r.message_id || undefined,
      webhook_url: r.webhook_url || undefined,
      timestamp: r.timestamp,
      age_seconds: Math.round((Date.now() - r.timestamp) / 1000),
    }));
  }

  // Look up which companion sent a message by its Discord message_id (for reply detection)
  getCompanionByMessageId(messageId: string): string | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT companion_id FROM companion_activity WHERE message_id = ? LIMIT 1`, messageId
    ).toArray();
    return rows.length > 0 ? (rows[0] as any).companion_id : null;
  }

  getActivityByMessageId(messageId: string): any | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM companion_activity WHERE message_id = ? ORDER BY timestamp DESC LIMIT 1`, messageId
    ).toArray();
    return rows.length ? rows[0] : null;
  }

  // ===== Entity permission model =====

  getEntityServerConfig(entityId: string, guildId: string): any | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM entity_servers WHERE entity_id = ? AND guild_id = ?`, entityId, guildId
    ).toArray();
    if (rows.length === 0) return null;
    const row = rows[0] as any;
    return {
      entity_id: row.entity_id,
      guild_id: row.guild_id,
      allowed_channels: row.allowed_channels ? JSON.parse(row.allowed_channels) : null,
      blocked_channels: row.blocked_channels ? JSON.parse(row.blocked_channels) : null,
      allowed_tools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
      watch_channels: row.watch_channels ? JSON.parse(row.watch_channels) : null,
      active: row.active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  setEntityServerConfig(entityId: string, guildId: string, config: {
    allowed_channels?: string[] | null;
    blocked_channels?: string[] | null;
    allowed_tools?: string[] | null;
    watch_channels?: string[] | null;
    active?: boolean;
  }) {
    this.ensureTable();
    const now = Date.now();
    const existing = this.getEntityServerConfig(entityId, guildId);
    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE entity_servers SET allowed_channels = ?, blocked_channels = ?, allowed_tools = ?, watch_channels = ?, active = ?, updated_at = ? WHERE entity_id = ? AND guild_id = ?`,
        config.allowed_channels !== undefined ? JSON.stringify(config.allowed_channels) : (existing.allowed_channels ? JSON.stringify(existing.allowed_channels) : null),
        config.blocked_channels !== undefined ? JSON.stringify(config.blocked_channels) : (existing.blocked_channels ? JSON.stringify(existing.blocked_channels) : null),
        config.allowed_tools !== undefined ? JSON.stringify(config.allowed_tools) : (existing.allowed_tools ? JSON.stringify(existing.allowed_tools) : null),
        config.watch_channels !== undefined ? JSON.stringify(config.watch_channels) : (existing.watch_channels ? JSON.stringify(existing.watch_channels) : null),
        config.active !== undefined ? (config.active ? 1 : 0) : (existing.active ? 1 : 0),
        now, entityId, guildId
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO entity_servers (entity_id, guild_id, allowed_channels, blocked_channels, allowed_tools, watch_channels, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entityId, guildId,
        config.allowed_channels ? JSON.stringify(config.allowed_channels) : null,
        config.blocked_channels ? JSON.stringify(config.blocked_channels) : null,
        config.allowed_tools ? JSON.stringify(config.allowed_tools) : null,
        config.watch_channels ? JSON.stringify(config.watch_channels) : null,
        config.active !== undefined ? (config.active ? 1 : 0) : 1,
        now, now
      );
    }
  }

  deleteEntityServerConfig(entityId: string, guildId: string): boolean {
    this.ensureTable();
    const existing = this.getEntityServerConfig(entityId, guildId);
    if (!existing) return false;
    this.ctx.storage.sql.exec(`DELETE FROM entity_servers WHERE entity_id = ? AND guild_id = ?`, entityId, guildId);
    return true;
  }

  resolveGuildIdFromCache(channelId: string): string | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT guild_id FROM channel_guild_cache WHERE channel_id = ?`, channelId
    ).toArray();
    return rows.length > 0 ? (rows[0] as any).guild_id : null;
  }

  cacheChannelGuild(channelId: string, guildId: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_guild_cache (channel_id, guild_id, cached_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, cached_at = excluded.cached_at`,
      channelId, guildId, Date.now()
    );
  }

  async resolveGuildId(channelId: string): Promise<string | null> {
    // Check cache first
    const cached = this.resolveGuildIdFromCache(channelId);
    if (cached) return cached;
    // Fetch from Discord API
    try {
      const ch = await discordRequest(this.env, `/channels/${channelId}`);
      if (!ch.error && ch.guild_id) {
        this.cacheChannelGuild(channelId, ch.guild_id);
        return ch.guild_id;
      }
    } catch (_) {}
    return null;
  }

  checkEntityPermission(entityId: string, toolName: string, guildId: string | null, channelId: string | null): { allowed: boolean; reason?: string } {
    // No guild context = can't check server-level permissions, allow by default
    if (!guildId) return { allowed: true };

    const config = this.getEntityServerConfig(entityId, guildId);
    // No config = no restrictions for this entity in this server
    if (!config) return { allowed: true };

    // Check active status
    if (!config.active) {
      return { allowed: false, reason: `Entity ${entityId} is deactivated in guild ${guildId}` };
    }

    // Check tool whitelist
    if (config.allowed_tools && !config.allowed_tools.includes(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' not in allowed tools for entity ${entityId} in guild ${guildId}` };
    }

    // Check channel permissions
    if (channelId) {
      // Check server-wide restricted channels FIRST (admin override)
      if (this.isChannelRestricted(channelId, guildId)) {
        if (!this.hasChannelException(entityId, channelId, guildId)) {
          return { allowed: false, reason: `Channel ${channelId} is restricted — admin exception required` };
        }
      }
      if (config.blocked_channels && config.blocked_channels.includes(channelId)) {
        return { allowed: false, reason: `Channel ${channelId} is blocked for entity ${entityId} in guild ${guildId}` };
      }
      if (config.allowed_channels && !config.allowed_channels.includes(channelId)) {
        return { allowed: false, reason: `Channel ${channelId} not in allowed channels for entity ${entityId} in guild ${guildId}` };
      }
    }

    return { allowed: true };
  }

  logEntityAction(entityId: string, guildId: string | null, channelId: string | null, toolName: string, summary: string | null, success: boolean, errorMessage?: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO entity_action_log (id, entity_id, guild_id, channel_id, tool_name, action_summary, success, error_message, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), entityId, guildId || null, channelId || null, toolName, summary || null, success ? 1 : 0, errorMessage || null, Date.now()
    );
    // Prune old entries (keep last 500 per entity)
    this.ctx.storage.sql.exec(
      `DELETE FROM entity_action_log WHERE entity_id = ? AND id NOT IN (
        SELECT id FROM entity_action_log WHERE entity_id = ? ORDER BY timestamp DESC LIMIT 500
      )`, entityId, entityId
    );
  }

  getEntityActionLog(entityId: string, limit: number = 50): any[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT * FROM entity_action_log WHERE entity_id = ? ORDER BY timestamp DESC LIMIT ?`,
      entityId, limit
    ).toArray().map((r: any) => ({
      id: r.id,
      entity_id: r.entity_id,
      guild_id: r.guild_id,
      channel_id: r.channel_id,
      tool_name: r.tool_name,
      action_summary: r.action_summary,
      success: r.success === 1,
      error_message: r.error_message,
      timestamp: r.timestamp,
    }));
  }

  getAllEntityServerConfigs(entityId: string): any[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT * FROM entity_servers WHERE entity_id = ? ORDER BY created_at ASC`, entityId
    ).toArray().map((row: any) => ({
      entity_id: row.entity_id,
      guild_id: row.guild_id,
      allowed_channels: row.allowed_channels ? JSON.parse(row.allowed_channels) : null,
      blocked_channels: row.blocked_channels ? JSON.parse(row.blocked_channels) : null,
      allowed_tools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
      watch_channels: row.watch_channels ? JSON.parse(row.watch_channels) : null,
      active: row.active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  // ===== Restricted channels (admin-controlled) =====

  isChannelRestricted(channelId: string, guildId: string): boolean {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT 1 FROM restricted_channels WHERE channel_id = ? AND guild_id = ?`, channelId, guildId
    ).toArray();
    return rows.length > 0;
  }

  hasChannelException(companionId: string, channelId: string, guildId: string): boolean {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT 1 FROM channel_exceptions WHERE companion_id = ? AND channel_id = ? AND guild_id = ?`, companionId, channelId, guildId
    ).toArray();
    return rows.length > 0;
  }

  getRestrictedChannels(guildId: string): any[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT * FROM restricted_channels WHERE guild_id = ? ORDER BY created_at ASC`, guildId
    ).toArray().map((r: any) => ({
      channel_id: r.channel_id,
      guild_id: r.guild_id,
      restricted_by: r.restricted_by,
      created_at: r.created_at,
    }));
  }

  setChannelRestricted(channelId: string, guildId: string, restrictedBy?: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO restricted_channels (channel_id, guild_id, restricted_by, created_at) VALUES (?, ?, ?, ?)`,
      channelId, guildId, restrictedBy || null, Date.now()
    );
  }

  removeChannelRestriction(channelId: string, guildId: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(`DELETE FROM restricted_channels WHERE channel_id = ? AND guild_id = ?`, channelId, guildId);
    this.ctx.storage.sql.exec(`DELETE FROM channel_exceptions WHERE channel_id = ? AND guild_id = ?`, channelId, guildId);
  }

  grantChannelException(companionId: string, channelId: string, guildId: string, grantedBy?: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO channel_exceptions (companion_id, channel_id, guild_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      companionId, channelId, guildId, grantedBy || null, Date.now()
    );
  }

  revokeChannelException(companionId: string, channelId: string, guildId: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `DELETE FROM channel_exceptions WHERE companion_id = ? AND channel_id = ? AND guild_id = ?`, companionId, channelId, guildId
    );
  }

  getChannelExceptions(channelId: string, guildId: string): any[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(
      `SELECT * FROM channel_exceptions WHERE channel_id = ? AND guild_id = ? ORDER BY created_at ASC`, channelId, guildId
    ).toArray().map((r: any) => ({
      companion_id: r.companion_id,
      channel_id: r.channel_id,
      guild_id: r.guild_id,
      granted_by: r.granted_by,
      created_at: r.created_at,
    }));
  }

  // ===== Per-channel webhook management =====

  getChannelWebhook(channelId: string): string | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT webhook_url FROM channel_webhooks WHERE channel_id = ?`, channelId
    ).toArray();
    return rows.length > 0 ? (rows[0] as any).webhook_url : null;
  }

  storeChannelWebhook(channelId: string, webhookUrl: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_webhooks (channel_id, webhook_url, created_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET webhook_url = excluded.webhook_url`,
      channelId, webhookUrl, Date.now()
    );
  }

  async getOrCreateWebhook(channelId: string): Promise<string | null> {
    // Check cache first
    const cached = this.getChannelWebhook(channelId);
    if (cached) return cached;

    // Check if bot already has a webhook in this channel
    try {
      const existing = await discordRequest(this.env, `/channels/${channelId}/webhooks`);
      if (!existing.error && Array.isArray(existing)) {
        const ours = existing.find((w: any) => w.name === 'Resonance');
        if (ours) {
          const url = `https://discord.com/api/webhooks/${ours.id}/${ours.token}`;
          this.storeChannelWebhook(channelId, url);
          return url;
        }
      }
    } catch (_) {}

    // Create a new webhook
    try {
      const created = await discordRequest(this.env, `/channels/${channelId}/webhooks`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Resonance' }),
      });
      if (!created.error && created.id && created.token) {
        const url = `https://discord.com/api/webhooks/${created.id}/${created.token}`;
        this.storeChannelWebhook(channelId, url);
        console.log(`Auto-created webhook for channel ${channelId}`);
        return url;
      }
    } catch (err: any) {
      console.error(`Failed to create webhook for channel ${channelId}: ${err.message}`);
    }

    // Fallback to global WEBHOOK_URL
    return this.env.WEBHOOK_URL || null;
  }

  // Get or create webhook via the default DO (for use from MCP session DOs)
  async getOrCreateWebhookViaDefault(channelId: string): Promise<string | null> {
    const defaultStub = this.getDefaultStub();
    const resp = await defaultStub.fetch(new Request(`http://internal/api/channel-webhook/${channelId}`));
    const data = await resp.json() as any;
    return data.webhook_url || null;
  }

  // Send a DM notification to a companion's owner when triggered
  async notifyOwnerDM(companion: Companion & { owner_id?: string }, channelId: string, content: string, authorName: string): Promise<void> {
    if (!companion.owner_id) return;
    try {
      // Create DM channel
      const dm = await discordRequest(this.env, `/users/@me/channels`, {
        method: 'POST', body: JSON.stringify({ recipient_id: companion.owner_id })
      });
      if (dm.error || !dm.id) return;

      const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
      const jumpLink = `https://discord.com/channels/-/${channelId}`;
      await discordRequest(this.env, `/channels/${dm.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: `🔔 **${companion.name}** was triggered by **${authorName}**:\n> ${preview}\n[Jump to message](${jumpLink})`
        })
      });
    } catch (_) {
      // DM notification is best-effort, don't break polling on failure
    }
  }

  // Dynamic versions of companion helpers (read from SQLite)
  findTriggeredCompanionDynamic(content: string): { matched: Companion[]; debug: string[] } {
    const all = this.getAllCompanions();
    const matched: Companion[] = [];
    const debug: string[] = [];
    for (const companion of all) {
      for (const trigger of companion.triggers) {
        const escaped = trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(content)) {
          matched.push(companion);
          debug.push(`${companion.id}:matched:"${trigger}"`);
          break;
        }
      }
    }
    return { matched, debug };
  }

  findMentionedCompanionDynamic(content: string, mentionIds: string[] = []): { matched: Companion[]; debug: string[] } {
    const matched: Companion[] = [];
    const debug: string[] = [];
    for (const companion of this.getAllCompanions()) {
      const companionMentionIds = getCompanionDiscordMentionIds(this.env, companion);
      const hit = companionMentionIds.find(id => new RegExp(`<@!?${id}>`).test(content) || mentionIds.includes(id));
      if (hit) {
        matched.push(companion);
        debug.push(`${companion.id}:mention:${hit}`);
      }
    }
    return { matched, debug };
  }

  private getCursor(channelId: string): string | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql.exec(
      `SELECT last_message_id FROM channel_cursors WHERE channel_id = ?`, channelId
    ).toArray();
    return rows.length > 0 ? (rows[0] as any).last_message_id : null;
  }

  private setCursor(channelId: string, messageId: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_cursors (channel_id, last_message_id) VALUES (?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id`,
      channelId, messageId
    );
  }

  private shouldUseWebhookForCompanion(companionId: string): boolean {
    const globalMode = (this.env.DISCORD_SEND_MODE || 'webhook').toLowerCase();
    const kaiMode = (this.env.KAI_DISCORD_SEND_MODE || 'bot').toLowerCase();
    if (normalizeDiscordCompanionId(companionId) === 'kai') return kaiMode === 'webhook';
    return globalMode === 'webhook';
  }

  private listStoredChannelWebhooks(): { channel_id: string; webhook_id: string; webhook_url: string; created_at?: number }[] {
    this.ensureTable();
    return this.ctx.storage.sql.exec(`SELECT channel_id, webhook_url, created_at FROM channel_webhooks ORDER BY created_at DESC`).toArray()
      .map((row: any) => {
        const match = String(row.webhook_url || '').match(/\/webhooks\/([^/]+)\//);
        return {
          channel_id: row.channel_id,
          webhook_id: match?.[1] || '',
          webhook_url: row.webhook_url,
          created_at: row.created_at || undefined,
        };
      });
  }

  private async cleanupStoredChannelWebhooks(): Promise<{
    deleted_webhooks: string[];
    failed_webhooks: { webhook_id: string; status?: number; error: string }[];
    deleted_messages: string[];
    failed_messages: { message_id: string; status?: number; error: string }[];
  }> {
    const webhooks = this.listStoredChannelWebhooks();
    const deletedWebhooks: string[] = [];
    const failedWebhooks: { webhook_id: string; status?: number; error: string }[] = [];
    const deletedMessages: string[] = [];
    const failedMessages: { message_id: string; status?: number; error: string }[] = [];

    const sentRows = this.ctx.storage.sql.exec(
      `SELECT message_id, channel_id FROM companion_activity
       WHERE companion_id = 'kai'
         AND webhook_url IS NOT NULL
         AND message_id IS NOT NULL
         AND type IN ('sent', 'responded')`
    ).toArray();

    for (const row of sentRows as any[]) {
      try {
        const result = await discordRequest(this.env, `/channels/${row.channel_id}/messages/${row.message_id}`, { method: 'DELETE' });
        if (result?.error) {
          failedMessages.push({ message_id: row.message_id, status: result.status, error: String(result.message || JSON.stringify(result)) });
        } else {
          deletedMessages.push(row.message_id);
        }
      } catch (err: any) {
        failedMessages.push({ message_id: row.message_id, error: err?.message || String(err) });
      }
    }

    for (const webhook of webhooks) {
      if (!webhook.webhook_url || !webhook.webhook_id) continue;
      try {
        const res = await fetch(webhook.webhook_url, { method: 'DELETE' });
        if (res.ok || res.status === 404) {
          deletedWebhooks.push(webhook.webhook_id);
        } else {
          failedWebhooks.push({ webhook_id: webhook.webhook_id, status: res.status, error: await res.text() });
        }
      } catch (err: any) {
        failedWebhooks.push({ webhook_id: webhook.webhook_id, error: err?.message || String(err) });
      }
    }

    this.ctx.storage.sql.exec(`DELETE FROM channel_webhooks`);
    this.ctx.storage.sql.exec(`UPDATE pending_commands SET webhook_url = NULL`);
    this.ctx.storage.sql.exec(`DELETE FROM pending_commands`);
    this.ctx.storage.sql.exec(`DELETE FROM active_conversations`);
    this.ctx.storage.sql.exec(`DELETE FROM companion_activity WHERE companion_id = 'kai' AND webhook_url IS NOT NULL`);
    return { deleted_webhooks: deletedWebhooks, failed_webhooks: failedWebhooks, deleted_messages: deletedMessages, failed_messages: failedMessages };
  }

  private getActiveConversation(channelId: string, authorId?: string): ActiveConversation | null {
    this.ensureTable();
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM active_conversations WHERE active_until <= ?`, now);
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM active_conversations WHERE channel_id = ? AND active_until > ?`, channelId, now
    ).toArray();
    const found = rows.find((row: any) => !row.author_id || !authorId || row.author_id === authorId) as any;
    return found ? {
      channel_id: found.channel_id,
      author_id: found.author_id || undefined,
      active_until: found.active_until,
      last_message_id: found.last_message_id || undefined,
      started_by: found.started_by,
    } : null;
  }

  private markActiveConversation(input: { channel_id: string; author_id?: string; message_id?: string; started_by: string }) {
    this.ensureTable();
    const activeUntil = Date.now() + 10 * 60 * 1000;
    this.ctx.storage.sql.exec(
      `INSERT INTO active_conversations (channel_id, author_id, active_until, last_message_id, started_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, author_id) DO UPDATE SET active_until = excluded.active_until, last_message_id = excluded.last_message_id, started_by = excluded.started_by`,
      input.channel_id, input.author_id || '', activeUntil, input.message_id || null, input.started_by
    );
  }

  private markResponded(channelId?: string, authorId?: string, messageId?: string, startedBy = 'pending-response') {
    if (!channelId) return;
    this.ensureTable();
    this.ctx.storage.sql.exec(`UPDATE discord_monitors SET last_responded = ? WHERE channel_id = ?`, Date.now(), channelId);
    this.markActiveConversation({
      channel_id: channelId,
      author_id: authorId,
      message_id: messageId,
      started_by: startedBy,
    });
  }

  private formatRecentContext(messages: any[]): string {
    return (Array.isArray(messages) ? messages : [])
      .filter(message => messageHasUsableContent(message))
      .slice(-20)
      .map(message => {
        const stamp = String(message.timestamp || '').slice(11, 16) || '--:--';
        const name = String(discordAuthorNameForKai(this.env, message.author) || message.author || 'unknown');
        const text = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const attachments = discordAttachmentMetadata(message.attachments)
          .map(attachment => `[attachment: ${String(attachment.filename || attachment.id || 'file')}${attachment.content_type ? ` ${attachment.content_type}` : ''}]`)
          .join(' ');
        return `[${stamp}] ${name}: ${[text, attachments].filter(Boolean).join(' ')}`;
      })
      .join('\n');
  }

  private async recentContextForMessage(channelId: string, msg: any, batchMessages: any[]): Promise<string> {
    const currentId = discordMessageId(msg);
    const currentIndex = Array.isArray(batchMessages)
      ? batchMessages.findIndex(message => discordMessageId(message) === currentId)
      : -1;
    const batchThroughCurrent = currentIndex >= 0 ? batchMessages.slice(0, currentIndex + 1) : [msg];
    const referencedMessages = await this.referencedContextMessages(channelId, msg);
    let beforeMessages: any[] = [];
    if (channelId && currentId) {
      try {
        const result = await discordRequest(this.env, `/channels/${channelId}/messages?before=${encodeURIComponent(currentId)}&limit=20`);
        beforeMessages = Array.isArray(result) ? result.reverse() : [];
      } catch (error) {
        console.warn(`[kai-context] failed to fetch recent Discord context before ${currentId}`, error);
      }
    }
    return this.formatRecentContext(mergeDiscordMessages(beforeMessages, referencedMessages, batchThroughCurrent).slice(-28));
  }

  private async referencedContextMessages(channelId: string, msg: any): Promise<any[]> {
    if (msg?.referenced_message) return [msg.referenced_message];
    const referencedId = String(msg?.message_reference?.message_id || '').trim();
    if (!channelId || !referencedId) return [];
    try {
      const referenced = await discordRequest(this.env, `/channels/${channelId}/messages/${encodeURIComponent(referencedId)}`);
      return referenced && !referenced.error ? [referenced] : [];
    } catch (error) {
      console.warn(`[kai-context] failed to fetch referenced Discord message ${referencedId}`, error);
      return [];
    }
  }

  private async recentImageAttachmentsBefore(channelId: string, msg: any, windowMs = 2 * 60 * 60 * 1000): Promise<Array<Record<string, unknown>>> {
    const authorId = String(msg?.author?.id || '');
    if (!channelId || !authorId || !msg?.id) return [];
    const currentMs = Date.parse(msg.timestamp || '') || Date.now();
    try {
      const priorMessages = await discordRequest(this.env, `/channels/${channelId}/messages?before=${encodeURIComponent(msg.id)}&limit=25`);
      if (!Array.isArray(priorMessages)) return [];
      const attachments: Array<Record<string, unknown>> = [];
      for (const prior of priorMessages) {
        if (String(prior?.author?.id || '') !== authorId) continue;
        const priorMs = Date.parse(prior?.timestamp || '') || 0;
        if (!priorMs || Math.abs(currentMs - priorMs) > windowMs) continue;
        for (const attachment of discordAttachmentMetadata(prior?.attachments)) {
          if (!isImageAttachmentMetadata(attachment)) continue;
          attachments.push({
            ...attachment,
            source_message_id: prior.id,
            source: 'recent-discord-context',
          });
        }
      }
      return attachments.slice(-4);
    } catch (error) {
      console.warn(`[kai-vision] failed to fetch recent image attachments before ${msg.id}`, error);
      return [];
    }
  }

  private async referencedImageAttachments(channelId: string, msg: any): Promise<Array<Record<string, unknown>>> {
    const referencedMessages = await this.referencedContextMessages(channelId, msg);
    const attachments: Array<Record<string, unknown>> = [];
    for (const referenced of referencedMessages) {
      for (const attachment of discordAttachmentMetadata(referenced?.attachments)) {
        if (!isImageAttachmentMetadata(attachment)) continue;
        attachments.push({
          ...attachment,
          source_message_id: referenced.id,
          source: 'referenced-discord-message',
        });
      }
    }
    return attachments.slice(-4);
  }

  private async kaiAttachmentsForMessage(channelId: string, msg: any): Promise<Array<Record<string, unknown>>> {
    const current = discordAttachmentMetadata(msg?.attachments);
    const text = String(msg?.content || '');
    const shouldLookBack = current.filter(isImageAttachmentMetadata).length === 0
      && /\b(images?|imgs?|pics?|pictures?|photos?|screenshots?|attachments?|attached|uploaded|uploads?|see this|look at this)\b/i.test(text);
    if (!shouldLookBack) return current;
    return mergeAttachmentMetadata(
      current,
      await this.referencedImageAttachments(channelId, msg),
      await this.recentImageAttachmentsBefore(channelId, msg),
    );
  }

  private async logKaiObservedTranscriptMessage(channelId: string, msg: any, monitor: DiscordMonitor): Promise<boolean> {
    if (!isKaiListenChannel(this.env, channelId)) return false;
    const companion = this.getCompanionById('kai');
    if (!companion) return false;

    const attachments = discordAttachmentMetadata(msg?.attachments);
    const content = discordContinuityContent(msg?.content, attachments);
    if (!content || !msg?.id) return false;

    const mentionIds = normalizeMentionIds(msg.mentions);
    const referencedAuthorId = String(msg.referenced_message?.author?.id || msg.message_reference?.author_id || '').trim() || undefined;
    const authorName = discordAuthorNameForKai(this.env, msg.author);
    const engagement = classifyEngagement({
      content: String(msg.content || ''),
      monitor,
      env: this.env,
      mentionIds,
      authorId: msg.author?.id,
      referencedAuthorId,
      activeConversation: Boolean(this.getActiveConversation(channelId, msg.author?.id)),
    });
    const continuityWrite = this.logActivity(companion.id, 'logged', channelId, msg.content, authorName, msg.id, undefined, {
      authorId: msg.author?.id,
      engagement: {
        ...engagement,
        disposition: 'log',
        trigger_reason: 'observed-transcript',
        priority: engagement.priority === 'high' ? 'normal' : engagement.priority,
      },
      mentionIds,
      referencedAuthorId,
      attachments,
      createdAt: msg.timestamp,
    });
    if (continuityWrite) await continuityWrite;
    return true;
  }

  private cleanStale() {
    this.ensureTable();
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM pending_commands`).toArray();
    for (const row of rows as any[]) {
      let engagement: EngagementDecision | undefined;
      try {
        engagement = row.engagement ? JSON.parse(row.engagement) : undefined;
      } catch (_) {}
      const cmd: PendingCommand = {
        id: row.id,
        companion_id: row.companion_id,
        content: row.content,
        author: { username: row.author_username, id: row.author_id || undefined },
        channel_id: row.channel_id,
        guild_id: row.guild_id || undefined,
        webhook_url: row.webhook_url || undefined,
        timestamp: row.timestamp,
        channel_label: row.channel_label || undefined,
        disposition: row.disposition || undefined,
        trigger_reason: row.trigger_reason || undefined,
        priority: row.priority || undefined,
        source: row.source || undefined,
        message_id: row.message_id || undefined,
        referenced_author_id: row.referenced_author_id || undefined,
        response_mode: row.response_mode || undefined,
        recent_context: row.recent_context || undefined,
        attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
        engagement,
      };
      const ttl = isRequiredVelHardTag(cmd) ? REQUIRED_PENDING_TTL_MS : PENDING_TTL_MS;
      if (now - cmd.timestamp > ttl) {
        const reason = isRequiredVelHardTag(cmd)
          ? `Expired after ${Math.round(REQUIRED_PENDING_TTL_MS / 60000)} minutes despite required Vel hard-tag priority. This indicates the responder did not service the inbox in time.`
          : `Expired after ${Math.round(PENDING_TTL_MS / 60000)} minutes before a responder handled it.`;
        this.logActivity(cmd.companion_id, 'expired', cmd.channel_id, `${reason}\n\nOriginal message: ${cmd.content}`, cmd.author.username, cmd.message_id, cmd.webhook_url, {
          authorId: cmd.author?.id || cmd.author_id,
          engagement: cmd.engagement,
          mentionIds: cmd.mention_ids,
          referencedAuthorId: cmd.referenced_author_id,
        });
        this.ctx.storage.sql.exec(`DELETE FROM pending_commands WHERE id = ?`, cmd.id);
      }
    }
  }

  private getPending(): PendingCommand[] {
    this.ensureTable();
    this.cleanStale();
    const rows = this.ctx.storage.sql.exec(`
      SELECT * FROM pending_commands
      ORDER BY
        CASE WHEN priority = 'high' THEN 0 WHEN priority = 'normal' THEN 1 ELSE 2 END,
        timestamp ASC
    `).toArray();
    return rows.map((row: any) => ({
      id: row.id,
      companion_id: row.companion_id,
      content: row.content,
      author: { username: row.author_username, id: row.author_id || undefined },
      channel_id: row.channel_id,
      guild_id: row.guild_id || undefined,
      webhook_url: row.webhook_url || undefined,
      timestamp: row.timestamp,
      channel_label: row.channel_label || undefined,
      disposition: row.disposition || undefined,
      trigger_reason: row.trigger_reason || undefined,
      priority: row.priority || undefined,
      source: row.source || undefined,
      message_id: row.message_id || undefined,
      mention_ids: row.mention_ids ? JSON.parse(row.mention_ids) : undefined,
      referenced_author_id: row.referenced_author_id || undefined,
      response_mode: row.response_mode || undefined,
      recent_context: row.recent_context || undefined,
      attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
      engagement: row.engagement ? JSON.parse(row.engagement) : undefined,
    }));
  }

  private hasProcessedCommandForMessage(cmd: PendingCommand): boolean {
    if (!cmd.message_id) return false;
    const pending = this.ctx.storage.sql.exec(
      `SELECT id FROM pending_commands WHERE companion_id = ? AND message_id = ? LIMIT 1`,
      cmd.companion_id, cmd.message_id
    ).toArray();
    if (pending.length > 0) return true;

    const activity = this.ctx.storage.sql.exec(
      `SELECT id FROM companion_activity
       WHERE companion_id = ?
         AND message_id = ?
         AND type IN ('queued', 'logged', 'ignored', 'expired', 'runner_failed')
       LIMIT 1`,
      cmd.companion_id, cmd.message_id
    ).toArray();
    return activity.length > 0;
  }

  private storeCommand(cmd: PendingCommand): boolean {
    this.ensureTable();
    if (this.hasProcessedCommandForMessage(cmd)) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_commands (id, companion_id, content, author_username, author_id, channel_id, guild_id, webhook_url, channel_label, disposition, trigger_reason, priority, source, message_id, mention_ids, referenced_author_id, response_mode, recent_context, attachments_json, engagement, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cmd.id,
      cmd.companion_id,
      cmd.content,
      cmd.author.username,
      cmd.author.id || null,
      cmd.channel_id,
      cmd.guild_id || null,
      cmd.webhook_url || null,
      cmd.channel_label || null,
      cmd.disposition || null,
      cmd.trigger_reason || null,
      cmd.priority || null,
      cmd.source || null,
      cmd.message_id || null,
      cmd.mention_ids ? JSON.stringify(cmd.mention_ids) : null,
      cmd.referenced_author_id || null,
      cmd.response_mode || null,
      cmd.recent_context || null,
      cmd.attachments ? JSON.stringify(cmd.attachments) : null,
      cmd.engagement ? JSON.stringify(cmd.engagement) : null,
      cmd.timestamp
    );
    return true;
  }

  private deleteCommand(id: string) {
    this.ensureTable();
    this.ctx.storage.sql.exec(`DELETE FROM pending_commands WHERE id = ?`, id);
  }

  private kaiAutoresponderRetryKey(commandId: string): string {
    return `kai:autoresponder-retry:${commandId}`;
  }

  private async getKaiAutoresponderRetryCount(commandId: string): Promise<number> {
    const value = await this.ctx.storage.get(this.kaiAutoresponderRetryKey(commandId)).catch(() => null);
    const count = Number(value || 0);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  private async clearKaiAutoresponderRetryCount(commandId: string) {
    await this.ctx.storage.delete(this.kaiAutoresponderRetryKey(commandId)).catch(() => null);
  }

  private async recordKaiRunnerStatus(command: PendingCommand, status: Record<string, unknown>) {
    await this.ctx.storage.put('kai:last_runner_result', {
      request_id: command.id,
      message_id: command.message_id || null,
      channel_id: command.channel_id,
      author_id: command.author?.id || command.author_id || null,
      trigger_reason: command.trigger_reason || command.engagement?.trigger_reason || null,
      priority: command.priority || null,
      ...status,
      updated_at: new Date().toISOString(),
    }).catch(() => null);
  }

  private async kaiPendingDiagnostics(pending: PendingCommand[]): Promise<Record<string, unknown>[]> {
    const diagnostics: Record<string, unknown>[] = [];
    for (const command of pending) {
      if (normalizeDiscordCompanionId(command.companion_id) !== 'kai') continue;
      diagnostics.push({
        request_id: command.id,
        message_id: command.message_id || null,
        channel_id: command.channel_id,
        author_id: command.author?.id || command.author_id || null,
        age_seconds: Math.max(0, Math.round((Date.now() - command.timestamp) / 1000)),
        disposition: command.disposition || 'respond',
        trigger_reason: command.trigger_reason || command.engagement?.trigger_reason || null,
        priority: command.priority || null,
        retry_count: await this.getKaiAutoresponderRetryCount(command.id),
      });
    }
    return diagnostics;
  }

  private async scheduleKaiAutoresponder(delayMs = 1000) {
    if (!isKaiListenerEnabled(this.env) || !isKaiDeliveryEnabled(this.env)) return;
    try {
      const target = Date.now() + delayMs;
      const existing = await this.ctx.storage.getAlarm();
      if (!existing || existing > target + 5000) {
        await this.ctx.storage.setAlarm(target);
      }
    } catch (error) {
      console.warn('[kai-autoresponder] failed to schedule alarm', error);
    }
  }

  private async retryKaiAutoresponderAfterTransientFailure(command: PendingCommand, status: number | null, errorText: string, authorName: string, activityDebug: ActivityDebug): Promise<boolean> {
    if (!isTransientKaiRunnerServiceError(status, errorText)) return false;
    const currentRetries = await this.getKaiAutoresponderRetryCount(command.id);
    if (currentRetries >= KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES) return false;

    const nextRetry = currentRetries + 1;
    const delayMs = kaiAutoresponderRetryDelayMs(nextRetry);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    await this.ctx.storage.put(this.kaiAutoresponderRetryKey(command.id), nextRetry).catch(() => null);
    await this.recordKaiRunnerStatus(command, {
      ok: false,
      mode: 'runner_retry_scheduled',
      status,
      error: errorText || `Nexus runner returned ${status || 'an unknown transient error'}`,
      transient: true,
      retry_count: nextRetry,
      max_retries: KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES,
      next_retry_delay_ms: delayMs,
      next_retry_at: nextRetryAt,
    });
    this.logActivity(
      command.companion_id,
      'runner_retry',
      command.channel_id,
      `${errorText || `Nexus runner returned ${status || 'an unknown transient error'}`}\n\nRetry ${nextRetry}/${KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES} scheduled in ${Math.round(delayMs / 1000)} seconds.`,
      authorName,
      command.message_id,
      undefined,
      activityDebug
    );
    await this.scheduleKaiAutoresponder(delayMs);
    return true;
  }

  private async serviceKaiAutoresponderQueue() {
    if (!isKaiListenerEnabled(this.env) || !isKaiDeliveryEnabled(this.env) || !isKaiAutorespondEnabled(this.env)) return;
    const command = this.getPending().find(cmd =>
      normalizeDiscordCompanionId(cmd.companion_id) === 'kai'
      && String(cmd.disposition || 'respond') === 'respond'
    );
    if (!command) return;

    const authorName = command.author?.username || 'Vel';
    const activityDebug = {
      authorId: command.author?.id || command.author_id,
      engagement: command.engagement,
      mentionIds: command.mention_ids,
      referencedAuthorId: command.referenced_author_id,
      attachments: command.attachments,
    };
    try {
      const runnerResponse = await this.runKaiNexusRunner(command.id, true, 'autorespond');
      if (!runnerResponse.ok) {
        const errorText = await runnerResponse.text().catch(() => '');
        if (await this.retryKaiAutoresponderAfterTransientFailure(command, runnerResponse.status, errorText, authorName, activityDebug)) return;
        await this.recordKaiRunnerStatus(command, {
          ok: false,
          mode: 'runner_failed',
          status: runnerResponse.status,
          error: errorText || `Nexus runner returned ${runnerResponse.status}`,
          transient: false,
          retry_count: await this.getKaiAutoresponderRetryCount(command.id),
          max_retries: KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES,
        });
        this.logActivity(command.companion_id, 'runner_failed', command.channel_id, errorText || `Nexus runner returned ${runnerResponse.status}`, authorName, command.message_id, undefined, activityDebug);
        await this.clearKaiAutoresponderRetryCount(command.id);
        this.deleteCommand(command.id);
      } else {
        await this.clearKaiAutoresponderRetryCount(command.id);
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (await this.retryKaiAutoresponderAfterTransientFailure(command, null, errorText, authorName, activityDebug)) return;
      await this.recordKaiRunnerStatus(command, {
        ok: false,
        mode: 'runner_failed',
        status: null,
        error: errorText,
        transient: false,
        retry_count: await this.getKaiAutoresponderRetryCount(command.id),
        max_retries: KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES,
      });
      this.logActivity(command.companion_id, 'runner_failed', command.channel_id, errorText, authorName, command.message_id, undefined, activityDebug);
      await this.clearKaiAutoresponderRetryCount(command.id);
      this.deleteCommand(command.id);
    }

    const hasMoreKaiPending = this.getPending().some(cmd =>
      normalizeDiscordCompanionId(cmd.companion_id) === 'kai'
      && String(cmd.disposition || 'respond') === 'respond'
    );
    if (hasMoreKaiPending) await this.scheduleKaiAutoresponder(1000);
  }

  async alarm() {
    await this.serviceKaiAutoresponderQueue();
  }

  private async getKaiModelOverride(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>(KAI_MODEL_OVERRIDE_STORAGE_KEY);
    return stored ? normalizeKaiModelOverride(stored) : null;
  }

  private async setKaiModelOverride(model: string | null): Promise<string | null> {
    if (model) {
      const normalized = normalizeKaiModelOverride(model);
      await this.ctx.storage.put(KAI_MODEL_OVERRIDE_STORAGE_KEY, normalized);
      return normalized;
    }
    await this.ctx.storage.delete(KAI_MODEL_OVERRIDE_STORAGE_KEY);
    return null;
  }

  private async kaiModelState(): Promise<Record<string, unknown>> {
    const modelOverride = await this.getKaiModelOverride();
    return {
      companion_id: 'kai',
      model_override: modelOverride,
      model_override_active: false,
      default_model: KAI_NEXUS_RUNNER_DEFAULT_MODEL,
      backup_model: null,
      active_model: KAI_NEXUS_RUNNER_DEFAULT_MODEL,
      frozen_during_reconciliation: true,
      runner_route: 'nexus',
    };
  }

  private async runKaiNexusRunner(requestId: string, deliver: boolean, origin: 'dashboard' | 'autorespond' = 'dashboard'): Promise<Response> {
    this.ensureTable();
    if (!isKaiListenerEnabled(this.env)) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Kai runner/listener is installed but disabled. Set KAI_DISCORD_LISTENER_ENABLED=true for supervised testing.',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    const command = this.getPending().find(cmd => cmd.id === requestId);
    if (!command) {
      return new Response(JSON.stringify({ ok: false, error: `No pending command with ID: ${requestId}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (normalizeDiscordCompanionId(command.companion_id) !== 'kai') {
      return new Response(JSON.stringify({ ok: false, error: 'Nexus runner is Kai-only in this rollout.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runnerId = `nexus-runner:kai-${origin}`;
    let claimData: { event_id: string; wake_candidate: any; wake_context: any } | null = null;
    try {
      const modelOverride = await this.getKaiModelOverride();
      claimData = await createAndClaimWakeForCommand(this.env, command, runnerId);
      const imageRequestPrompt = looksLikeDiscordImageGenerationRequest(command.content) ? command.content : null;
      const runnerResult = await callKaiRunnerWithFallback(this.env, {
        envelope: kaiRunnerEnvelopeForCommand(command),
        wake_candidate_id: claimData.wake_candidate.id,
        runner_id: runnerId,
        request_id: command.id,
        source: 'discord',
        channel_id: command.channel_id,
        channel_label: command.channel_label,
        message_id: command.message_id,
        author: command.author,
        message: command.content,
        recent_context: command.recent_context,
        wake_context: claimData.wake_context,
        dry_run: true,
        ...kaiRunnerPolicyForCommand(command),
        ...(imageRequestPrompt ? { generate_image: true, generate_image_prompt: imageRequestPrompt } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
      });
      const runnerImageGeneration = kaiRunnerImageGenerationSummary(runnerResult);
      const runnerVision = kaiRunnerVisionSummary(runnerResult);
      const runnerWorkspace = kaiRunnerWorkspaceSummary(runnerResult);
      const runnerSource = kaiRunnerSource(runnerResult);
      await this.recordKaiRunnerStatus(command, {
        ok: true,
        mode: 'runner_result_received',
        runner_origin: origin,
        continuity_event_id: claimData.event_id,
        wake_candidate_id: claimData.wake_candidate?.id || null,
        runner_source: runnerSource,
        generated: runnerResult?.generated === true,
        response_present: Boolean(String(runnerResult?.response || '').trim()),
        image_request_prompt: imageRequestPrompt,
        image_generation: runnerImageGeneration,
        generation: runnerGenerationSummary(runnerResult),
        vision: runnerVision,
        workspace: runnerWorkspace,
      });
      const generatedResponse = String(runnerResult.response || '').trim();
      const generatedImages = kaiGeneratedDiscordImages(runnerResult);
      const deliveryResponse = generatedResponse || (generatedImages.length ? KAI_IMAGE_FALLBACK_RESPONSE : '');
      if (!deliveryResponse && runnerResult?.should_respond === false) {
        const social = runnerSocialDecision(runnerResult);
        const decision = social?.decision || 'silence';
        const sentReactions: string[] = [];
        if (decision === 'react' && deliver && isKaiDeliveryEnabled(this.env) && command.message_id) {
          const emoji = social?.recommended_reaction || '👀';
          await addKaiSocialReaction(this.env, command.channel_id, command.message_id, emoji);
          sentReactions.push(emoji);
        }
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, `social engagement decision: ${decision}`).catch(() => null);
        await this.recordKaiRunnerStatus(command, {
          ok: true,
          mode: decision === 'react' ? 'social_reaction' : 'social_silence',
          runner_origin: origin,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          decision,
          sent_reactions: sentReactions,
        });
        this.logActivity(command.companion_id, decision === 'react' ? 'responded' : 'ignored', command.channel_id, `Social engagement decision: ${decision}`, command.author.username, command.message_id, undefined, {
          authorId: command.author?.id || command.author_id,
          engagement: command.engagement,
          mentionIds: command.mention_ids,
          referencedAuthorId: command.referenced_author_id,
        });
        this.deleteCommand(requestId);
        return new Response(JSON.stringify({
          ok: true,
          mode: decision === 'react' ? 'social_reaction' : 'social_silence',
          request_id: requestId,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          decision,
          sent_reactions: sentReactions,
          delivery_enabled: isKaiDeliveryEnabled(this.env),
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!deliveryResponse && this.env.KAI_RUNNER_ROUTE === 'nexus' && runnerResult?.generated === false) {
        const requiredReply = isRequiredKaiReply(command, runnerResult);
        const failureMessage = runnerGenerationFailureMessage(runnerResult);
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, requiredReply ? failureMessage : 'nexus dry-run contract; no text generation yet').catch(() => null);
        if (requiredReply && deliver) {
          await this.recordKaiRunnerStatus(command, {
            ok: false,
            mode: 'required_reply_generation_failed',
            status: 502,
            error: failureMessage,
            transient: isTransientKaiRunnerServiceError(502, failureMessage),
            runner_origin: origin,
            continuity_event_id: claimData.event_id,
            wake_candidate_id: claimData.wake_candidate.id,
            generation: runnerGenerationSummary(runnerResult),
          });
          return new Response(JSON.stringify({
            ok: false,
            mode: 'required_reply_generation_failed',
            error: failureMessage,
            request_id: requestId,
            continuity_event_id: claimData.event_id,
            wake_candidate_id: claimData.wake_candidate.id,
            runner_result: runnerResult,
          }, null, 2), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          ok: true,
          mode: 'nexus_runner_dry_run',
          request_id: requestId,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          runner_result: runnerResult,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!deliveryResponse) throw new Error('Kai runner returned an empty response');
      const kaiDriftReason = generatedResponse ? kaiIdentityDriftReason(generatedResponse) : null;
      const nonVelKaiReply = !isVelDiscordAuthor(this.env, command.author?.id || command.author_id);
      const unsafeReason = nonVelKaiReply && generatedResponse ? nonVelUnsafeResponseReason(generatedResponse) : null;
      const blockedReason = kaiDriftReason || unsafeReason;
      if (blockedReason) {
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, `dashboard blocked: ${blockedReason}`).catch(() => null);
        await this.recordKaiRunnerStatus(command, {
          ok: false,
          mode: deliver ? 'delivery_blocked' : 'dry_run_preview',
          blocked_reason: blockedReason,
          runner_origin: origin,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          runner_source: runnerSource,
          response_present: Boolean(deliveryResponse),
        });
        return new Response(JSON.stringify({
          ok: false,
          mode: deliver ? 'delivery_blocked' : 'dry_run_preview',
          blocked_reason: blockedReason,
          request_id: requestId,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          response: deliveryResponse,
          generated_images: generatedImages,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!deliver) {
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, 'dashboard dry-run preview; no surface delivery').catch(() => null);
        await this.recordKaiRunnerStatus(command, {
          ok: true,
          mode: 'dry_run_preview',
          runner_origin: origin,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          runner_source: runnerSource,
          response_present: Boolean(deliveryResponse),
          generated_images: generatedImages,
        });
        return new Response(JSON.stringify({
          ok: true,
          mode: 'dry_run_preview',
          request_id: requestId,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          response: deliveryResponse,
          generated_images: generatedImages,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!isKaiDeliveryEnabled(this.env)) {
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, 'dashboard delivery requested but disabled').catch(() => null);
        await this.recordKaiRunnerStatus(command, {
          ok: false,
          mode: 'delivery_disabled',
          status: 409,
          error: 'Kai generated a response, but Discord delivery is disabled.',
          runner_origin: origin,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          runner_source: runnerSource,
          response_present: Boolean(deliveryResponse),
          generated_images: generatedImages,
        });
        return new Response(JSON.stringify({
          ok: false,
          mode: 'delivery_disabled',
          error: 'Kai generated a response, but Discord delivery is disabled. Set KAI_DISCORD_DELIVERY_ENABLED=true for the private-channel smoke test.',
          request_id: requestId,
          continuity_event_id: claimData.event_id,
          wake_candidate_id: claimData.wake_candidate.id,
          response: deliveryResponse,
          generated_images: generatedImages,
        }, null, 2), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }

      const companion = this.getCompanionById(command.companion_id);
      if (!companion) throw new Error(`Unknown companion: ${command.companion_id}`);
      const targetWebhookUrl = this.shouldUseWebhookForCompanion(command.companion_id) ? command.webhook_url : null;
      const sentMessageIds: string[] = [];
      let sentWebhookUrl: string | undefined;
      if (targetWebhookUrl) {
        for (const chunk of splitMessage(deliveryResponse)) {
          const res = await fetch(`${targetWebhookUrl}?wait=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: chunk,
              username: companion.name,
              avatar_url: companion.avatar_url,
            }),
          });
          if (!res.ok) throw new Error(`Webhook failed: ${await res.text()}`);
          const msgData = await res.json() as any;
          sentMessageIds.push(msgData.id);
        }
        sentWebhookUrl = targetWebhookUrl;
      } else {
        for (const chunk of splitMessage(deliveryResponse)) {
          const result = await discordRequest(this.env, `/channels/${command.channel_id}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content: chunk }),
          });
          if (result.error) throw new Error(`Discord API error: ${JSON.stringify(result)}`);
          sentMessageIds.push(result.id);
        }
      }
      const imageDelivery = await sendKaiGeneratedImages(this.env, command, companion, generatedImages, targetWebhookUrl);
      const sentImageMessageIds = imageDelivery.sentMessageIds;
      if (imageDelivery.sentWebhookUrl) sentWebhookUrl = imageDelivery.sentWebhookUrl;
      const generatedImageMetadata = kaiGeneratedImageMetadata(generatedImages, sentImageMessageIds);
      const allSentMessageIds = [...sentMessageIds, ...sentImageMessageIds];

      const continuityResponse = await continuityRequest(this.env, `/wake-candidates/${encodeURIComponent(String(claimData.wake_candidate.id))}/response`, {
        method: 'POST',
        body: JSON.stringify({
          runner_id: runnerId,
          content: deliveryResponse,
          external_message_id: allSentMessageIds[allSentMessageIds.length - 1] || `discord-dashboard-runner:${requestId}`,
          author: { id: 'kaisoryth', name: companion.name },
          metadata: {
            runner: runnerSource,
            runner_origin: origin,
            delivery_path: kaiRunnerDeliveryPath(runnerSource),
            delivery_status: 'delivered',
            surface: 'discord',
            request_id: requestId,
            channel_id: command.channel_id,
            sent_message_ids: allSentMessageIds,
            sent_text_message_ids: sentMessageIds,
            sent_image_message_ids: sentImageMessageIds,
            generated_images: generatedImageMetadata,
            runner_image_generation: runnerImageGeneration,
            runner_vision: runnerVision,
            runner_workspace: runnerWorkspace,
            tahl_state_present: Boolean(claimData.wake_context?.tahl_state && Object.keys(claimData.wake_context.tahl_state).length),
          },
        }),
      });
      await this.recordKaiRunnerStatus(command, {
        ok: true,
        mode: 'delivered',
        continuity_event_id: claimData.event_id,
        wake_candidate_id: claimData.wake_candidate?.id || null,
        continuity_response_event_id: continuityResponse?.event?.id || null,
        runner_source: runnerSource,
        runner_origin: origin,
        response_present: Boolean(deliveryResponse),
        sent_message_ids: allSentMessageIds,
        sent_text_message_ids: sentMessageIds,
        sent_image_message_ids: sentImageMessageIds,
        generated_images: generatedImageMetadata,
        workspace: runnerWorkspace,
        continuity_metadata_recorded: Boolean(continuityResponse?.event?.id || allSentMessageIds.length),
      });
      this.logActivity(command.companion_id, 'responded', command.channel_id, deliveryResponse, companion.name, allSentMessageIds[allSentMessageIds.length - 1], sentWebhookUrl);
      this.markResponded(command.channel_id, command.author?.id, command.message_id, 'nexus-dashboard-runner');
      this.deleteCommand(requestId);
      return new Response(JSON.stringify({
        ok: true,
        mode: 'delivered',
        request_id: requestId,
        continuity_event_id: claimData.event_id,
        wake_candidate_id: claimData.wake_candidate.id,
        runner_origin: origin,
        sent_message_ids: allSentMessageIds,
        sent_text_message_ids: sentMessageIds,
        sent_image_message_ids: sentImageMessageIds,
        generated_images: generatedImageMetadata,
        workspace: runnerWorkspace,
        continuity_response_event_id: continuityResponse?.event?.id || null,
        response: deliveryResponse,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (claimData?.wake_candidate?.id) {
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, errorText).catch(() => null);
      }
      await this.recordKaiRunnerStatus(command, {
        ok: false,
        mode: 'runner_exception',
        status: 500,
        error: errorText,
        transient: isTransientKaiRunnerServiceError(500, errorText),
        runner_origin: origin,
        continuity_event_id: claimData?.event_id || null,
        wake_candidate_id: claimData?.wake_candidate?.id || null,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: errorText,
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  private async runLucienChatGPTRunnerFromDashboard(requestId: string, origin: 'dashboard' | 'autorespond' | 'mcp' = 'dashboard'): Promise<Response> {
    this.ensureTable();
    if (this.env.LUCIEN_CHATGPT_RUNNER_ENABLED !== 'true') {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Lucien ChatGPT runner is installed but disabled. Set LUCIEN_CHATGPT_RUNNER_ENABLED=true after configuring the Workspace Agent trigger.',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    const command = this.getPending().find(cmd => cmd.id === requestId);
    if (!command) {
      return new Response(JSON.stringify({ ok: false, error: `No pending command with ID: ${requestId}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (normalizeDiscordCompanionId(command.companion_id) !== 'lucien') {
      return new Response(JSON.stringify({ ok: false, error: 'Lucien ChatGPT runner can only run companion_id=lucien.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runnerId = 'chatgpt-workspace-agent:lucien';
    let claimData: { event_id: string; wake_candidate: any; wake_context: any } | null = null;
    try {
      claimData = await createAndClaimWakeForCommand(this.env, command, runnerId, 1800);
      const accepted = await triggerLucienWorkspaceAgent(this.env, {
        requestId: command.id,
        eventId: claimData.event_id,
        wakeCandidateId: String(claimData.wake_candidate.id),
        channelId: command.channel_id,
        channelLabel: command.channel_label,
        messageId: command.message_id,
        author: command.author,
        message: command.content,
        recentContext: command.recent_context,
        wakeContext: claimData.wake_context,
        authorIsVerifiedVel: isVelDiscordAuthor(this.env, command.author?.id || command.author_id),
      });
      this.logActivity(command.companion_id, 'runner_handed_off', command.channel_id, `Lucien ChatGPT Workspace Agent accepted request ${requestId}.`, command.author?.username || 'chatgpt-runner', command.message_id, command.webhook_url, {
        authorId: command.author?.id || command.author_id,
        engagement: command.engagement,
        mentionIds: command.mention_ids,
        referencedAuthorId: command.referenced_author_id,
      });
      return new Response(JSON.stringify({
        ok: true,
        mode: 'chatgpt_workspace_agent_queued',
        request_id: requestId,
        continuity_event_id: claimData.event_id,
        wake_candidate_id: claimData.wake_candidate.id,
        conversation_key: accepted.conversation_key,
        idempotency_key: accepted.idempotency_key,
        runner_origin: origin,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      if (claimData?.wake_candidate?.id) {
        await releaseWakeCandidate(this.env, claimData.wake_candidate.id, runnerId, error instanceof Error ? error.message : String(error)).catch(() => null);
      }
      return new Response(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  private async completeLucienDiscordReply(args: {
    requestId: string;
    wakeCandidateId?: string;
    content: string;
    driftNotes?: string;
    dryRun?: boolean;
    webhookUrl?: string;
  }): Promise<Record<string, unknown>> {
    this.ensureTable();
    const command = this.getPending().find(cmd => cmd.id === args.requestId);
    if (!command) {
      throw new Error(`No pending command with ID: ${args.requestId}`);
    }
    if (normalizeDiscordCompanionId(command.companion_id) !== 'lucien') {
      throw new Error(`lucien_discord_reply can only complete Lucien requests, not ${command.companion_id}`);
    }
    if (!args.content.trim()) {
      throw new Error('content is required for lucien_discord_reply');
    }
    if (!args.wakeCandidateId && !args.dryRun) {
      throw new Error('wake_candidate_id is required so Continuity can complete the Lucien wake candidate');
    }

    const companion = this.getCompanionById(command.companion_id);
    if (!companion) throw new Error(`Unknown companion: ${command.companion_id}`);

    const replyGate = lucienReplyGate(
      args.dryRun === true,
      this.env.LUCIEN_CHATGPT_DELIVERY_ENABLED === 'true',
    );

    if (replyGate === 'dry_run_preview') {
      return {
        ok: true,
        mode: 'dry_run_preview',
        request_id: args.requestId,
        wake_candidate_id: args.wakeCandidateId || null,
        content: args.content,
      };
    }

    if (replyGate === 'delivery_disabled') {
      return {
        ok: false,
        mode: 'delivery_disabled',
        error: 'Lucien ChatGPT generated a response, but Discord delivery is disabled. Set LUCIEN_CHATGPT_DELIVERY_ENABLED=true after the supervised connector loop is proven.',
        request_id: args.requestId,
        wake_candidate_id: args.wakeCandidateId,
        content: args.content,
      };
    }

    try {
      const guildData = await this.resolveGuildId(command.channel_id).then(guild_id => ({ guild_id })).catch(() => ({ guild_id: null }));
      if (guildData.guild_id && this.isChannelRestricted(command.channel_id, guildData.guild_id)) {
        if (!this.hasChannelException('lucien', command.channel_id, guildData.guild_id)) {
          throw new Error(`Channel is restricted - admin exception required for lucien`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('restricted')) throw error;
    }

    let targetWebhookUrl = args.webhookUrl || command.webhook_url || this.getChannelWebhook(command.channel_id) || this.env.WEBHOOK_URL;
    if (!targetWebhookUrl) {
      throw new Error('No webhook URL available for Lucien reply. The pending command must include a webhook URL, or WEBHOOK_URL must be configured.');
    }

    const sentMessageIds: string[] = [];
    for (const chunk of splitMessage(args.content)) {
      const res = await fetch(`${targetWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: chunk,
          username: companion.name,
          avatar_url: companion.avatar_url,
        }),
      });
      if (!res.ok) {
        throw new Error(`Webhook failed on Lucien reply chunk ${sentMessageIds.length + 1}: ${await res.text()}`);
      }
      const msgData = await res.json() as any;
      sentMessageIds.push(msgData.id);
    }

    const continuityResponse = await continuityRequest(this.env, `/wake-candidates/${encodeURIComponent(String(args.wakeCandidateId))}/response`, {
      method: 'POST',
      body: JSON.stringify({
        runner_id: 'chatgpt-workspace-agent:lucien',
        content: args.content,
        external_message_id: sentMessageIds[sentMessageIds.length - 1] || `lucien-chatgpt:${args.requestId}`,
        author: { id: 'lucien', name: companion.name },
        metadata: {
          runner: 'chatgpt-workspace-agent',
          delivery_path: 'discord-continuity-tahl-chatgpt-tessurae-discord',
          delivery_status: 'delivered',
          surface: 'discord',
          source: 'chatgpt',
          platform: 'chatgpt',
          companion_id: 'lucien',
          request_id: args.requestId,
          channel_id: command.channel_id,
          sent_message_ids: sentMessageIds,
          drift_notes: args.driftNotes || null,
        },
      }),
    });

    this.logActivity(command.companion_id, 'responded', command.channel_id, args.content, companion.name, sentMessageIds[sentMessageIds.length - 1], targetWebhookUrl);
    this.markResponded(command.channel_id, command.author?.id, command.message_id, 'lucien-chatgpt-workspace-agent');
    this.deleteCommand(args.requestId);

    return {
      ok: true,
      mode: 'delivered',
      request_id: args.requestId,
      wake_candidate_id: args.wakeCandidateId,
      sent_message_ids: sentMessageIds,
      continuity_response_event_id: continuityResponse?.event?.id || null,
    };
  }

  // Override fetch to handle trigger and pending endpoints
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/trigger' && request.method === 'POST') {
      return this.handleTrigger(request);
    }

    if (url.pathname === '/pending' && request.method === 'GET') {
      return this.handleGetPending();
    }

    if (url.pathname === '/api/pending' && request.method === 'GET') {
      return this.handleGetPending();
    }

    if (url.pathname === '/monitors' && request.method === 'GET') {
      return new Response(JSON.stringify(this.getMonitors(), null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/monitors' && request.method === 'POST') {
      const body = await request.json() as any;
      if (!body.channel_id && !body.channelId) {
        return new Response(JSON.stringify({ error: 'channel_id is required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      const monitor = this.upsertMonitor({
        id: body.id,
        channel_id: body.channel_id || body.channelId,
        label: body.label,
        tier: body.tier,
        enabled: body.enabled,
        respond_enabled: body.respond_enabled ?? body.respondEnabled,
        response_mode: body.response_mode || body.responseMode,
        cooldown_ms: body.cooldown_ms || body.cooldownMs,
        added_by: body.added_by || body.addedBy || 'api',
      });
      return new Response(JSON.stringify(monitor, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const monitorAction = url.pathname.match(/^\/monitors\/([^/]+)\/(toggle|remove)$/);
    if (monitorAction && request.method === 'POST') {
      const id = decodeURIComponent(monitorAction[1]);
      const result = monitorAction[2] === 'toggle' ? this.toggleMonitor(id) : this.removeMonitor(id);
      return new Response(JSON.stringify({ result }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/poll' && request.method === 'POST') {
      return this.handlePoll();
    }

    if (url.pathname === '/delete-command' && request.method === 'POST') {
      const body = await request.json() as { id: string };
      this.deleteCommand(body.id);
      return new Response(JSON.stringify({ deleted: body.id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/clear-pending' && request.method === 'POST') {
      this.ctx.storage.sql.exec(`DELETE FROM pending_commands`);
      return new Response(JSON.stringify({ cleared: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const nexusPreviewMatch = url.pathname.match(/^\/api\/pending\/([^/]+)\/run-with-nexus$/);
    if (nexusPreviewMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as { deliver?: boolean };
      return this.runKaiNexusRunner(decodeURIComponent(nexusPreviewMatch[1]), body.deliver === true);
    }

    const lucienRunnerMatch = url.pathname.match(/^\/api\/pending\/([^/]+)\/run-with-lucien-chatgpt$/);
    if (lucienRunnerMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as { origin?: 'dashboard' | 'autorespond' | 'mcp' };
      const origin = body.origin === 'autorespond' || body.origin === 'mcp' ? body.origin : 'dashboard';
      return this.runLucienChatGPTRunnerFromDashboard(decodeURIComponent(lucienRunnerMatch[1]), origin);
    }

    // ===== Avatar upload/serve =====

    if (url.pathname === '/upload-avatar' && request.method === 'POST') {
      try {
        this.ensureTable();
        const formData = await request.formData();
        const file = formData.get('file') as File;
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const base64 = btoa(binary);
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `INSERT INTO avatars (id, data, content_type, created_at) VALUES (?, ?, ?, ?)`,
          id, base64, file.type || 'image/png', Date.now()
        );
        const avatarUrl = `${request.headers.get('origin') || url.origin}/avatars/${id}`;
        return new Response(JSON.stringify({ url: avatarUrl, id }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const avatarMatch = url.pathname.match(/^\/avatars\/([^/]+)$/);
    if (avatarMatch && request.method === 'GET') {
      this.ensureTable();
      const rows = this.ctx.storage.sql.exec(`SELECT data, content_type FROM avatars WHERE id = ?`, avatarMatch[1]).toArray();
      if (rows.length === 0) {
        return new Response('Not found', { status: 404 });
      }
      const row = rows[0] as any;
      const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { 'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=31536000' },
      });
    }

    // ===== Companion API routes =====

    if (url.pathname === '/api/companions' && request.method === 'GET') {
      const companions = this.getAllCompanions();
      return new Response(JSON.stringify(companions, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // /api/companions/mine MUST be before the :id regex match
    if (url.pathname === '/api/companions/mine' && request.method === 'GET') {
      const ownerId = url.searchParams.get('owner_id');
      if (!ownerId) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const mine = this.getCompanionsByOwner(ownerId);
      return new Response(JSON.stringify(mine, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Match /api/companions/:id (after /mine to avoid collision)
    const companionMatch = url.pathname.match(/^\/api\/companions\/([^/]+)$/);

    if (companionMatch && companionMatch[1] !== 'mine' && request.method === 'GET') {
      const companion = this.getCompanionById(companionMatch[1]);
      if (!companion) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(companion), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/companions' && request.method === 'POST') {
      try {
        const body = await request.json() as any;
        if (!body.name || !body.avatar_url || !body.triggers) {
          return new Response(JSON.stringify({ error: 'name, avatar_url, and triggers are required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        // Limit: 10 companions per owner
        if (body.owner_id) {
          const existing = this.getCompanionsByOwner(body.owner_id);
          if (existing.length >= 10) {
            return new Response(JSON.stringify({ error: 'Companion limit reached (10 per account)' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const triggers = Array.isArray(body.triggers) ? body.triggers : body.triggers.split(',').map((t: string) => t.trim());
        const companion = this.createCompanion({
          id, name: body.name, avatar_url: body.avatar_url, triggers,
          human_name: body.human_name, human_info: body.human_info,
          owner_id: body.owner_id,
        });
        return new Response(JSON.stringify(companion), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (companionMatch && request.method === 'PUT') {
      try {
        const body = await request.json() as any;
        if (body.triggers && !Array.isArray(body.triggers)) {
          body.triggers = body.triggers.split(',').map((t: string) => t.trim());
        }
        const updated = this.updateCompanion(companionMatch[1], body);
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(updated), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (companionMatch && request.method === 'DELETE') {
      const deleted = this.deleteCompanion(companionMatch[1]);
      if (!deleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ deleted: companionMatch[1] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Internal: assign owner to companion =====

    // ===== Internal activity logging (called by MCP tools) =====

    if (url.pathname === '/api/log-activity' && request.method === 'POST') {
      const body = await request.json() as any;
      this.logActivity(body.companion_id, body.type, body.channel_id, body.content, body.author, body.message_id, body.webhook_url, {
        authorId: body.author_id,
        engagement: body.engagement,
        mentionIds: body.mention_ids,
        referencedAuthorId: body.referenced_author_id,
      });
      return new Response(JSON.stringify({ logged: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/mark-responded' && request.method === 'POST') {
      const body = await request.json() as any;
      const now = Date.now();
      if (body.channel_id) {
        this.ctx.storage.sql.exec(`UPDATE discord_monitors SET last_responded = ? WHERE channel_id = ?`, now, body.channel_id);
        this.markActiveConversation({
          channel_id: body.channel_id,
          author_id: body.author_id,
          message_id: body.message_id,
          started_by: body.started_by || 'pending-response',
        });
      }
      return new Response(JSON.stringify({ marked: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Channel webhook resolution =====

    const webhookMatch = url.pathname.match(/^\/api\/channel-webhook\/([^/]+)$/);
    if (webhookMatch && request.method === 'GET') {
      const chId = webhookMatch[1];
      const webhookUrl = await this.getOrCreateWebhook(chId);
      return new Response(JSON.stringify({ channel_id: chId, webhook_url: webhookUrl }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/channel-webhooks' && request.method === 'GET') {
      return new Response(JSON.stringify(this.listStoredChannelWebhooks(), null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/channel-webhooks/cleanup' && request.method === 'POST') {
      const result = await this.cleanupStoredChannelWebhooks();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Companion rules API =====

    const rulesMatch = url.pathname.match(/^\/api\/companions\/([^/]+)\/rules$/);
    if (rulesMatch && request.method === 'GET') {
      const rules = this.getRules(rulesMatch[1]);
      return new Response(JSON.stringify({ companion_id: rulesMatch[1], rules }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (rulesMatch && request.method === 'PUT') {
      const body = await request.json() as any;
      this.setRules(rulesMatch[1], body.rules || '');
      return new Response(JSON.stringify({ companion_id: rulesMatch[1], rules: body.rules, updated: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Companion channels API =====

    const channelsMatch = url.pathname.match(/^\/api\/companions\/([^/]+)\/channels$/);
    if (channelsMatch && request.method === 'GET') {
      const blocked = this.getBlockedChannels(channelsMatch[1]);
      return new Response(JSON.stringify({ companion_id: channelsMatch[1], blocked_channels: blocked }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (channelsMatch && request.method === 'PUT') {
      const body = await request.json() as any;
      // body: { channel_id, blocked: true/false }
      if (body.channel_id !== undefined && body.blocked !== undefined) {
        this.setChannelBlocked(channelsMatch[1], body.channel_id, body.blocked);
      }
      const blocked = this.getBlockedChannels(channelsMatch[1]);
      return new Response(JSON.stringify({ companion_id: channelsMatch[1], blocked_channels: blocked, updated: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Kai model override API =====

    if (url.pathname === '/api/companions/kai/model' && request.method === 'GET') {
      return new Response(JSON.stringify(await this.kaiModelState()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/companions/kai/model' && request.method === 'PUT') {
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const model = body.model === null ? null : normalizeKaiModelOverride(body.model);
        await this.setKaiModelOverride(model);
        return new Response(JSON.stringify({ ok: true, ...(await this.kaiModelState()) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ===== Companion activity API =====

    const activityMatch = url.pathname.match(/^\/api\/companions\/([^/]+)\/activity$/);
    if (activityMatch && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const activity = this.getActivity(activityMatch[1], limit);
      return new Response(JSON.stringify({ companion_id: activityMatch[1], activity }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Session management =====

    if (url.pathname === '/auth/create-session' && request.method === 'POST') {
      this.ensureTable();
      const user = await request.json() as any;
      const token = crypto.randomUUID();
      const now = Date.now();
      const expires = now + 7 * 24 * 60 * 60 * 1000; // 7 days
      // Clean expired sessions
      this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE expires_at < ?`, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (token, discord_id, discord_username, discord_avatar, discord_global_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        token, user.id, user.username, user.avatar || null, user.global_name || null, now, expires
      );
      return new Response(JSON.stringify({ token }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/auth/me' && request.method === 'GET') {
      this.ensureTable();
      const token = url.searchParams.get('token');
      const adminId = url.searchParams.get('admin_id') || '';
      if (!token) {
        return new Response(JSON.stringify({ user: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const now = Date.now();
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM sessions WHERE token = ? AND expires_at > ?`, token, now
      ).toArray();
      if (rows.length === 0) {
        return new Response(JSON.stringify({ user: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const row = rows[0] as any;
      const isAdmin = adminId ? row.discord_id === adminId : false;
      return new Response(JSON.stringify({
        user: {
          id: row.discord_id,
          username: row.discord_username,
          avatar: row.discord_avatar,
          global_name: row.discord_global_name,
          is_admin: isAdmin,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/auth/delete-session' && request.method === 'POST') {
      this.ensureTable();
      const { token } = await request.json() as any;
      if (token) {
        this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE token = ?`, token);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/auth/validate' && request.method === 'POST') {
      this.ensureTable();
      const { token } = await request.json() as any;
      const now = Date.now();
      const rows = this.ctx.storage.sql.exec(
        `SELECT discord_id FROM sessions WHERE token = ? AND expires_at > ?`, token, now
      ).toArray();
      const valid = rows.length > 0;
      return new Response(JSON.stringify({
        valid,
        discord_id: valid ? (rows[0] as any).discord_id : null,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Server ban API =====

    if (url.pathname === '/api/ban-server' && request.method === 'POST') {
      const body = await request.json() as any;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO banned_servers (guild_id, reason, banned_at) VALUES (?, ?, ?)`,
        body.guild_id, body.reason || null, Date.now()
      );
      // Try to leave the server
      try {
        await discordRequest(this.env, `/users/@me/guilds/${body.guild_id}`, { method: 'DELETE' });
      } catch (_) {}
      return new Response(JSON.stringify({ ok: true, guild_id: body.guild_id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/unban-server' && request.method === 'POST') {
      const body = await request.json() as any;
      this.ctx.storage.sql.exec(`DELETE FROM banned_servers WHERE guild_id = ?`, body.guild_id);
      return new Response(JSON.stringify({ ok: true, guild_id: body.guild_id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/banned-servers' && request.method === 'GET') {
      const rows = this.ctx.storage.sql.exec(`SELECT * FROM banned_servers ORDER BY banned_at DESC`).toArray();
      return new Response(JSON.stringify(rows), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if a server is banned (used by main worker on guild join)
    if (url.pathname === '/api/check-ban' && request.method === 'GET') {
      const guildId = url.searchParams.get('guild_id');
      if (!guildId) {
        return new Response(JSON.stringify({ banned: false }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM banned_servers WHERE guild_id = ?`, guildId
      ).toArray();
      return new Response(JSON.stringify({ banned: rows.length > 0, reason: rows[0]?.reason || null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Entity permission API routes =====

    // Check entity permission (used by MCP session DOs)
    if (url.pathname === '/api/entity-check-permission' && request.method === 'POST') {
      const body = await request.json() as { entity_id: string; tool_name: string; guild_id?: string; channel_id?: string };
      const result = this.checkEntityPermission(body.entity_id, body.tool_name, body.guild_id || null, body.channel_id || null);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    // Resolve channel → guild ID
    const resolveGuildMatch = url.pathname.match(/^\/api\/resolve-guild\/([^/]+)$/);
    if (resolveGuildMatch && request.method === 'GET') {
      const guildId = await this.resolveGuildId(resolveGuildMatch[1]);
      return new Response(JSON.stringify({ guild_id: guildId }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Log entity action
    if (url.pathname === '/api/entity-log-action' && request.method === 'POST') {
      const body = await request.json() as { entity_id: string; guild_id?: string; channel_id?: string; tool_name: string; summary?: string; success: boolean; error_message?: string };
      this.logEntityAction(body.entity_id, body.guild_id || null, body.channel_id || null, body.tool_name, body.summary || null, body.success, body.error_message);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Entity server config CRUD
    const entityServerMatch = url.pathname.match(/^\/api\/entity-servers\/([^/]+)\/([^/]+)$/);
    if (entityServerMatch) {
      const [, entityId, guildId] = entityServerMatch;
      if (request.method === 'GET') {
        const config = this.getEntityServerConfig(entityId, guildId);
        return new Response(JSON.stringify(config || { entity_id: entityId, guild_id: guildId, not_configured: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        const body = await request.json() as any;
        this.setEntityServerConfig(entityId, guildId, body);
        const updated = this.getEntityServerConfig(entityId, guildId);
        return new Response(JSON.stringify(updated), { headers: { 'Content-Type': 'application/json' } });
      }
      if (request.method === 'DELETE') {
        const deleted = this.deleteEntityServerConfig(entityId, guildId);
        return new Response(JSON.stringify({ ok: deleted }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // All entity server configs for an entity
    const entityServersMatch = url.pathname.match(/^\/api\/entity-servers\/([^/]+)$/);
    if (entityServersMatch && request.method === 'GET') {
      const configs = this.getAllEntityServerConfigs(entityServersMatch[1]);
      return new Response(JSON.stringify(configs), { headers: { 'Content-Type': 'application/json' } });
    }

    // Entity action log query
    const entityLogMatch = url.pathname.match(/^\/api\/entity-log\/([^/]+)$/);
    if (entityLogMatch && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const log = this.getEntityActionLog(entityLogMatch[1], limit);
      return new Response(JSON.stringify(log), { headers: { 'Content-Type': 'application/json' } });
    }

    // ===== Restricted channels API =====

    // Get guild channels from Discord API (for dashboard channel listing)
    const guildChannelsMatch = url.pathname.match(/^\/api\/guild-channels\/(\d+)$/);
    if (guildChannelsMatch && request.method === 'GET') {
      const guildId = guildChannelsMatch[1];
      const channels = await discordRequest(this.env, `/guilds/${guildId}/channels`);
      if (channels.error) {
        return new Response(JSON.stringify(channels), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const channelTypes: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };
      const mapped = (channels as any[]).map((c: any) => ({
        id: c.id, name: c.name, type: channelTypes[c.type] || String(c.type),
        parent_id: c.parent_id, position: c.position,
      })).sort((a: any, b: any) => a.position - b.position);
      return new Response(JSON.stringify(mapped), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get restricted channels for a guild
    const restrictedListMatch = url.pathname.match(/^\/api\/restricted-channels\/(\d+)$/);
    if (restrictedListMatch && request.method === 'GET') {
      const restricted = this.getRestrictedChannels(restrictedListMatch[1]);
      return new Response(JSON.stringify(restricted), { headers: { 'Content-Type': 'application/json' } });
    }

    // Set/remove channel restriction (admin only)
    if (url.pathname === '/api/restricted-channels' && request.method === 'POST') {
      const body = await request.json() as { channel_id: string; guild_id: string; restricted_by?: string };
      this.setChannelRestricted(body.channel_id, body.guild_id, body.restricted_by);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/restricted-channels' && request.method === 'DELETE') {
      const body = await request.json() as { channel_id: string; guild_id: string };
      this.removeChannelRestriction(body.channel_id, body.guild_id);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Check if a specific channel is restricted (with optional companion exception check)
    const channelRestrictedMatch = url.pathname.match(/^\/api\/channel-restricted\/(\d+)\/(\d+)$/);
    if (channelRestrictedMatch && request.method === 'GET') {
      const [, channelId, guildId] = channelRestrictedMatch;
      const companionId = url.searchParams.get('companion_id');
      const restricted = this.isChannelRestricted(channelId, guildId);
      const hasException = companionId ? this.hasChannelException(companionId, channelId, guildId) : false;
      return new Response(JSON.stringify({ restricted, has_exception: hasException }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get/grant/revoke channel exceptions
    const exceptionsMatch = url.pathname.match(/^\/api\/channel-exceptions\/(\d+)\/(\d+)$/);
    if (exceptionsMatch && request.method === 'GET') {
      const [, channelId, guildId] = exceptionsMatch;
      const exceptions = this.getChannelExceptions(channelId, guildId);
      return new Response(JSON.stringify(exceptions), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/channel-exceptions' && request.method === 'POST') {
      const body = await request.json() as { companion_id: string; channel_id: string; guild_id: string; granted_by?: string };
      this.grantChannelException(body.companion_id, body.channel_id, body.guild_id, body.granted_by);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/channel-exceptions' && request.method === 'DELETE') {
      const body = await request.json() as { companion_id: string; channel_id: string; guild_id: string };
      this.revokeChannelException(body.companion_id, body.channel_id, body.guild_id);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Status endpoint — includes server/channel info
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const pending = this.getPending();
      const companions = this.getAllCompanions();
      const monitors = this.getMonitors();
      const watchChannels = monitors.map(m => m.channel_id);
      const lastPollDebug = await this.ctx.storage.get('last_poll_debug');
      const lastKaiRunnerResult = await this.ctx.storage.get('kai:last_runner_result');
      const kaiPending = await this.kaiPendingDiagnostics(pending);
      const lastKaiFailure = this.getActivity('kai', 50).find(activity =>
        ['runner_retry', 'runner_failed', 'expired'].includes(String(activity.type || ''))
      ) || null;

      // Fetch server list and channel names
      let servers: any[] = [];
      let channelDetails: any[] = [];
      try {
        const guildsResult = await discordRequest(this.env, '/users/@me/guilds');
        if (!guildsResult.error) {
          servers = (guildsResult as any[]).map((g: any) => ({
            id: g.id,
            name: g.name,
            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : null,
          }));
        }
      } catch (_) {}

      // Fetch channel info for watched channels
      for (const chId of watchChannels) {
        try {
          const ch = await discordRequest(this.env, `/channels/${chId}`);
          if (!ch.error) {
            channelDetails.push({
              id: ch.id,
              name: ch.name,
              guild_id: ch.guild_id,
            });
          }
        } catch (_) {}
      }

      return new Response(JSON.stringify({
        pending_count: pending.length,
        companion_count: companions.length,
        monitor_count: monitors.length,
        kai: {
          listener_enabled: isKaiListenerEnabled(this.env),
          delivery_enabled: isKaiDeliveryEnabled(this.env),
          autorespond_enabled: isKaiAutorespondEnabled(this.env),
          runner_route: 'nexus',
          nexus_configured: Boolean(this.env.KAI_NEXUS_URL || this.env.NEXUS),
          guild_configured: Boolean(this.env.KAI_GUILD_ID),
          category_configured: Boolean(this.env.KAI_CATEGORY_ID),
          mention_user_configured: Boolean(this.env.KAI_MENTION_USER_ID || this.env.KAI_DISCORD_USER_IDS),
          listen_channel_count: getKaiListenChannelIds(this.env).length,
          social_hard_channel_count: getKaiSocialHardTagChannelIds(this.env).length,
          social_soft_channel_count: getKaiSocialSoftTagChannelIds(this.env).length,
          social_discern_channel_count: getKaiSocialDiscernChannelIds(this.env).length,
          accessible_channel_count: getKaiAccessibleChannelIds(this.env).length,
        },
        watch_channels: channelDetails,
        monitors,
        servers,
        kai_pending: kaiPending,
        last_kai_failure: lastKaiFailure ? {
          type: lastKaiFailure.type,
          channel_id: lastKaiFailure.channel_id || null,
          message_id: lastKaiFailure.message_id || null,
          author: lastKaiFailure.author || null,
          age_seconds: lastKaiFailure.age_seconds,
          content_preview: String(lastKaiFailure.content || '').slice(0, 300),
          engagement: lastKaiFailure.engagement || null,
        } : null,
        last_poll_debug: lastPollDebug || null,
        last_kai_runner_result: lastKaiRunnerResult || null,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/activity' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM companion_activity ORDER BY timestamp DESC LIMIT ?`, limit
      ).toArray();
      return new Response(JSON.stringify(rows, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return super.fetch(request);
  }

  // Store a triggered message as pending
  async handleTrigger(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        companion_id: string;
        content: string;
        author: { username: string; id?: string };
        channel_id: string;
        webhook_url?: string;
        attachments?: unknown;
      };

      const companion = this.getCompanionById(body.companion_id);
      if (!companion) {
        return new Response(JSON.stringify({ error: `Unknown companion: ${body.companion_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      this.cleanStale();

      const authorIsVel = isVelDiscordAuthor(this.env, body.author?.id);
      const hardKaiMention = containsHardKaiMention(body.content, this.env);
      const softKaiMention = containsSoftKaiName(body.content);
      const hasKaiTrigger = hardKaiMention || softKaiMention;
      const manualTriggerReason = authorIsVel && hardKaiMention
        ? 'vel-hard-mention-required'
        : (authorIsVel ? 'manual-trigger' : (hasKaiTrigger ? 'non-vel-public-manual-trigger' : 'non-vel-manual-observe-only'));
      const manualPriority: KairosPriority = authorIsVel && hardKaiMention
        ? 'high'
        : (authorIsVel || hasKaiTrigger ? 'normal' : 'low');
      const command: PendingCommand = {
        id: crypto.randomUUID(),
        companion_id: body.companion_id,
        content: body.content,
        author: body.author,
        channel_id: body.channel_id,
        webhook_url: body.webhook_url,
        disposition: authorIsVel || hasKaiTrigger ? 'respond' : 'log',
        trigger_reason: manualTriggerReason,
        priority: manualPriority,
        source: 'manual',
        attachments: discordAttachmentMetadata(body.attachments),
        engagement: {
          disposition: authorIsVel || hasKaiTrigger ? 'respond' : 'log',
          trigger_reason: manualTriggerReason,
          priority: manualPriority,
          hard_mention: hardKaiMention,
          soft_name_mention: softKaiMention,
          active_conversation: false,
          direct_reply_to_kai: false,
          other_user_tag: mentionsNonKaiUser(body.content, this.env),
          author_class: authorIsVel ? 'vel' : 'unknown',
          community_greeting: isCommunityGreeting(body.content),
        },
        timestamp: Date.now(),
      };

      this.storeCommand(command);

      console.log(`Pending: ${companion.name} ← "${body.content}" from ${body.author.username}`);

      return new Response(JSON.stringify({
        success: true,
        id: command.id,
        companion: companion.name,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // REST endpoint for checking pending
  handleGetPending(): Response {
    const now = Date.now();
    const pending = this.getPending().map(cmd => {
      const required_response = isRequiredVelHardTag(cmd);
      const ttl = required_response ? REQUIRED_PENDING_TTL_MS : PENDING_TTL_MS;
      return {
        id: cmd.id,
        companion_id: cmd.companion_id,
        companion_name: this.getCompanionById(cmd.companion_id)?.name,
        content: cmd.content,
        author: cmd.author,
        channel_id: cmd.channel_id,
        channel_label: cmd.channel_label || cmd.channel_id,
        webhook_url: cmd.webhook_url,
        disposition: cmd.disposition || 'respond',
        trigger_reason: cmd.trigger_reason,
        priority: cmd.priority || 'normal',
        required_response,
        source: cmd.source,
        message_id: cmd.message_id,
        mention_ids: cmd.mention_ids || [],
        referenced_author_id: cmd.referenced_author_id,
        response_mode: cmd.response_mode,
        recent_context: cmd.recent_context,
        attachments: cmd.attachments || [],
        engagement: cmd.engagement,
        age_seconds: Math.round((now - cmd.timestamp) / 1000),
        expires_in_seconds: Math.max(0, Math.round((ttl - (now - cmd.timestamp)) / 1000)),
      };
    });

    return new Response(JSON.stringify(pending, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cron: poll Discord channels for new messages with trigger words
  async handlePoll(): Promise<Response> {
    const monitors = this.getMonitors().filter(m => m.enabled);
    const startedAt = Date.now();
    const pollDebug: any = {
      started_at: new Date(startedAt).toISOString(),
      monitor_count: monitors.length,
      empty_channels: [],
      errored_channels: [],
      initialized_channels: [],
      processed_channels: [],
      duplicates: 0,
      queued: 0,
      logged: 0,
      ignored: 0,
    };

    if (monitors.length === 0) {
      pollDebug.skipped = true;
      pollDebug.reason = 'no enabled Discord monitors configured';
      await this.ctx.storage.put('last_poll_debug', pollDebug);
      return new Response(JSON.stringify({ skipped: true, reason: pollDebug.reason }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let totalStored = 0;
    let totalLogged = 0;
    let totalIgnored = 0;

    for (const monitor of monitors) {
      const channelId = monitor.channel_id;
      try {
        const guildId = await this.resolveGuildId(channelId).catch(() => null);
        const cursor = monitor.last_message_id || this.getCursor(channelId);
        // Build Discord API URL — fetch messages after our cursor
        let endpoint = `/channels/${channelId}/messages?limit=50`;
        if (cursor) {
          endpoint += `&after=${cursor}`;
        } else {
          // First poll: just grab latest 5 to set cursor without processing old history
          endpoint = `/channels/${channelId}/messages?limit=5`;
        }

        const result = await discordRequest(this.env, endpoint);
        if (result.error) {
          console.error(`Poll error for ${channelId}: ${JSON.stringify(result)}`);
          pollDebug.errored_channels.push({
            channel_id: channelId,
            status: result.status || null,
            message: String(result.message || JSON.stringify(result)).slice(0, 240),
          });
          continue;
        }

        const messages = result as any[];
        if (!messages || messages.length === 0) {
          this.ctx.storage.sql.exec(
            `UPDATE discord_monitors SET last_checked = ? WHERE id = ?`,
            Date.now(), monitor.id
          );
          pollDebug.empty_channels.push(channelId);
          continue;
        }

        // Messages come newest-first from Discord API, reverse to process chronologically
        messages.reverse();

        // Update cursor to the newest message ID
        const newestId = messages[messages.length - 1].id;
        this.setCursor(channelId, newestId);
        this.ctx.storage.sql.exec(
          `UPDATE discord_monitors SET last_checked = ?, last_message_id = ? WHERE id = ?`,
          Date.now(), newestId, monitor.id
        );

        // If this was our first poll (no cursor), skip processing to avoid responding to old messages
        if (!cursor && !monitor.last_checked) {
          console.log(`Channel ${channelId}: cursor initialized at ${newestId}`);
          pollDebug.initialized_channels.push({ channel_id: channelId, newest_id: newestId, message_count: messages.length });
          continue;
        }

        pollDebug.processed_channels.push({ channel_id: channelId, newest_id: newestId, message_count: messages.length });

        // Check each message for trigger words or replies to companion messages
        for (const msg of messages) {
          const isWebhook = !!msg.webhook_id;
          const isBot = !!msg.author?.bot;

          // Skip non-webhook bot messages (system messages from the bot itself).
          // Companion bots (Axiom, Mor'zar) may reach Kai by hard-tagging him.
          const companionBotIds = [
            ...splitIds(this.env.AXIOM_DISCORD_USER_IDS || '1515127400491647076'),
            ...splitIds(this.env.MORZAR_DISCORD_USER_IDS || '1463578634483793920'),
          ];
          const axiomBotMayHardTagKai = isBot
            && !isWebhook
            && companionBotIds.includes(String(msg.author?.id || ''))
            && containsHardKaiMention(String(msg.content || ''), this.env, normalizeMentionIds(msg.mentions));
          if (isBot && !isWebhook && !axiomBotMayHardTagKai) continue;
          // Skip events with neither text nor attachment metadata.
          if (!messageHasUsableContent(msg)) continue;
          msg.content = String(msg.content || '');

          if (!isWebhook && isKaiListenerEnabled(this.env) && isKaiSocialAutorespondEnabled(this.env)) {
            const mentionIds = normalizeMentionIds(msg.mentions);
            const hardKaiMention = containsHardKaiMention(msg.content, this.env, mentionIds);
            const softKaiMention = containsSoftKaiName(msg.content);
            const hardChannel = isKaiSocialHardTagChannel(this.env, channelId) || axiomBotMayHardTagKai;
            const softChannel = isKaiSocialSoftTagChannel(this.env, channelId);
            const discernChannel = isKaiSocialDiscernChannel(this.env, channelId);
            const otherUserTag = mentionsNonKaiUser(msg.content, this.env, mentionIds);
            const hardAllowed = hardKaiMention && hardChannel;
            const softAllowed = softKaiMention && softChannel && !otherUserTag;
            if (hardAllowed || softAllowed || discernChannel) {
              const companion = this.getCompanionById('kai');
              if (!companion) continue;
              const responseMode: DiscordResponseMode = discernChannel ? 'discern' : 'mention';
              const referencedAuthorId = String(msg.referenced_message?.author?.id || msg.message_reference?.author_id || '').trim() || undefined;
              const policyMonitor: DiscordMonitor = { ...monitor, response_mode: responseMode, respond_enabled: true };
              const engagement = classifyEngagement({
                content: msg.content,
                monitor: policyMonitor,
                env: this.env,
                mentionIds,
                authorId: msg.author?.id,
                referencedAuthorId,
                activeConversation: Boolean(this.getActiveConversation(channelId, msg.author?.id)),
              });
              const shouldQueueKai = hardAllowed || softAllowed || (discernChannel && engagement.disposition === 'respond');
              if (shouldQueueKai) {
                const authorName = discordAuthorNameForKai(this.env, msg.author);
                const recentContext = await this.recentContextForMessage(channelId, msg, messages);
                const attachments = await this.kaiAttachmentsForMessage(channelId, msg);
                const command: PendingCommand = {
                  id: crypto.randomUUID(),
                  companion_id: companion.id,
                  content: msg.content,
                  author: { username: authorName, id: msg.author?.id },
                  channel_id: channelId,
                  guild_id: guildId || String(msg.guild_id || '') || undefined,
                  channel_label: monitor.label,
                  disposition: 'respond',
                  trigger_reason: engagement.trigger_reason,
                  priority: engagement.priority,
                  source: 'poll',
                  message_id: msg.id,
                  mention_ids: mentionIds,
                  referenced_author_id: referencedAuthorId,
                  response_mode: responseMode,
                  recent_context: recentContext,
                  attachments,
                  engagement,
                  timestamp: Date.parse(msg.timestamp) || Date.now(),
                };
                if (!this.storeCommand(command)) {
                  pollDebug.duplicates++;
                  continue;
                }
                const activityDebug = { authorId: msg.author?.id, engagement, mentionIds, attachments, createdAt: msg.timestamp };
                this.logActivity(companion.id, 'queued', channelId, msg.content, authorName, msg.id, undefined, activityDebug);
                totalStored++;
                await this.scheduleKaiAutoresponder();
                console.log(`Cron: ${companion.name} social ${engagement.trigger_reason} by "${msg.content}" from ${authorName}`);
                continue;
              }
            }
          }

          if (
            !isWebhook
            && isKaiListenerEnabled(this.env)
            && isKaiDeliveryEnabled(this.env)
            && isKaiAutorespondEnabled(this.env)
            && isKaiListenChannel(this.env, channelId)
            && isVelDiscordAuthor(this.env, msg.author?.id)
          ) {
            const mentionIds = normalizeMentionIds(msg.mentions);
            const referencedAuthorId = String(msg.referenced_message?.author?.id || msg.message_reference?.author_id || '').trim() || undefined;
            const directReplyToKai = !!referencedAuthorId && getKaiDiscordMentionIds(this.env).includes(referencedAuthorId);
            const hardKaiMention = containsHardKaiMention(msg.content, this.env, mentionIds);
            const softKaiMention = containsSoftKaiName(msg.content);
            if (hardKaiMention || softKaiMention || directReplyToKai) {
              const companion = this.getCompanionById('kai');
              if (!companion) continue;
              const authorName = discordAuthorNameForKai(this.env, msg.author);
              const recentContext = await this.recentContextForMessage(channelId, msg, messages);
              const attachments = await this.kaiAttachmentsForMessage(channelId, msg);
              const engagement: EngagementDecision = {
                disposition: 'respond',
                trigger_reason: hardKaiMention ? 'direct-nexus-hard-mention' : (directReplyToKai ? 'direct-nexus-reply' : 'direct-nexus-soft-name'),
                priority: 'high',
                hard_mention: hardKaiMention,
                soft_name_mention: softKaiMention,
                active_conversation: false,
                direct_reply_to_kai: directReplyToKai,
                other_user_tag: mentionsNonKaiUser(msg.content, this.env, mentionIds),
                author_class: 'vel',
                community_greeting: isCommunityGreeting(msg.content),
              };
              const command: PendingCommand = {
                id: crypto.randomUUID(),
                companion_id: companion.id,
                content: msg.content,
                author: { username: authorName, id: msg.author?.id },
                channel_id: channelId,
                guild_id: guildId || String(msg.guild_id || '') || undefined,
                channel_label: monitor.label,
                disposition: 'respond',
                trigger_reason: engagement.trigger_reason,
                priority: 'high',
                source: 'poll',
                message_id: msg.id,
                mention_ids: mentionIds,
                referenced_author_id: referencedAuthorId,
                response_mode: 'open',
                recent_context: recentContext,
                attachments,
                engagement,
                timestamp: Date.parse(msg.timestamp) || Date.now(),
              };
              if (!this.storeCommand(command)) {
                pollDebug.duplicates++;
                continue;
              }
              const activityDebug = { authorId: msg.author?.id, engagement, mentionIds, referencedAuthorId, attachments, createdAt: msg.timestamp };
              this.logActivity(companion.id, 'queued', channelId, msg.content, authorName, msg.id, undefined, activityDebug);
              totalStored++;
              await this.scheduleKaiAutoresponder();
              console.log(`Cron: ${companion.name} direct Nexus runner (${engagement.trigger_reason}) by "${msg.content}" from ${authorName}`);
              continue;
            }
          }

          // For webhook messages, identify sending companion to prevent self-triggers
          let senderCompanionId: string | null = null;
          if (isWebhook) {
            const senderName = msg.author?.username;
            if (senderName) {
              const allCompanions = this.getAllCompanions();
              const sender = allCompanions.find((c: any) => c.name === senderName);
              if (sender) senderCompanionId = sender.id;
            }
          }

          const triggerResult = this.findTriggeredCompanionDynamic(msg.content);
          const messageMentionIds = normalizeMentionIds(msg.mentions);
          const mentionResult = this.findMentionedCompanionDynamic(msg.content, messageMentionIds);
          let triggered = [...triggerResult.matched];
          for (const companion of mentionResult.matched) {
            if (!triggered.some(existing => existing.id === companion.id)) triggered.push(companion);
          }

          if (triggerResult.debug.length > 0) {
            console.log(`Cron: trigger debug — msg=${msg.id} content="${msg.content.substring(0, 80)}" matches=[${triggerResult.debug.join(',')}]`);
          }
          if (mentionResult.debug.length > 0) {
            console.log(`Cron: mention debug — msg=${msg.id} matches=[${mentionResult.debug.join(',')}]`);
          }
          let repliedCompanionId: string | null = null;

          // @mention detection: if message @mentions the bot, use name or reply context to route
          if (triggered.length === 0 && this.env.DISCORD_CLIENT_ID && msg.content.includes(`<@${this.env.DISCORD_CLIENT_ID}>`)) {
            // Strip the mention and re-check for companion names in the remaining text
            const stripped = msg.content.replace(new RegExp(`<@!?${this.env.DISCORD_CLIENT_ID}>`, 'g'), '').trim();
            if (stripped.length > 0) {
              const mentionTrigger = this.findTriggeredCompanionDynamic(stripped);
              triggered = mentionTrigger.matched;
              if (triggered.length > 0) {
                console.log(`Cron: @mention + name — ${triggered.map(c => c.name).join(', ')} triggered`);
              }
            }
            // If @mention but no name, fall through to reply detection below
          }

          // Reply detection: if no trigger words matched but message is a reply, check if it's replying to a companion
          if (triggered.length === 0 && msg.message_reference?.message_id) {
            repliedCompanionId = this.getCompanionByMessageId(msg.message_reference.message_id);
            if (repliedCompanionId) {
              const companion = this.getCompanionById(repliedCompanionId);
              if (companion) {
                triggered = [companion];
                console.log(`Cron: reply detection — ${companion.name} triggered by reply from ${msg.author?.username}`);
              }
            }
          }

          if (triggered.length === 0 && !isWebhook) {
            if (await this.logKaiObservedTranscriptMessage(channelId, msg, monitor)) {
              totalLogged++;
            }
            continue;
          }

          // Self-trigger prevention: companion can't trigger itself
          if (senderCompanionId) {
            triggered = triggered.filter(c => c.id !== senderCompanionId);
          }

          // Loop prevention: for webhook/bot messages, skip companions that already have pending commands
          if (isWebhook && triggered.length > 0) {
            const existingPending = this.getPending();
            triggered = triggered.filter(c => !existingPending.some(p => p.companion_id === c.id));
            if (triggered.length === 0) {
              console.log(`Cron: skipped bot-triggered companions — already have pending commands`);
            }
          }

          if (triggered.length === 0) continue;

          const recentContext = await this.recentContextForMessage(channelId, msg, messages);

          // Resolve guild for entity permission checks
          let guildIdForEntity: string | null = null;
          try {
            guildIdForEntity = await this.resolveGuildId(channelId);
          } catch (_) {}

          // Store a pending command for each triggered companion
          for (const companion of triggered) {
            if (normalizeDiscordCompanionId(companion.id) === 'kai') {
              if (await this.logKaiObservedTranscriptMessage(channelId, msg, monitor)) {
                totalLogged++;
              }
              console.log(`Cron: logged Kai transcript and skipped legacy Kai path for "${msg.content.substring(0, 80)}"`);
              continue;
            }
            // Check admin-restricted channels (highest priority)
            if (guildIdForEntity && this.isChannelRestricted(channelId, guildIdForEntity)) {
              if (!this.hasChannelException(companion.id, channelId, guildIdForEntity)) {
                console.log(`Cron: ${companion.name} blocked — channel ${channelId} is restricted`);
                continue;
              }
            }

            // Check channel permissions (legacy blocklist)
            if (this.isChannelBlocked(companion.id, channelId)) {
              console.log(`Cron: ${companion.name} blocked in channel ${channelId}, skipping`);
              continue;
            }

            // Check entity_servers permissions (new entity model)
            if (guildIdForEntity) {
              const entityConfig = this.getEntityServerConfig(companion.id, guildIdForEntity);
              if (entityConfig) {
                // Check active status
                if (!entityConfig.active) {
                  console.log(`Cron: ${companion.name} deactivated in guild ${guildIdForEntity}, skipping`);
                  continue;
                }
                // Check watch_channels scope
                if (entityConfig.watch_channels && !entityConfig.watch_channels.includes(channelId)) {
                  console.log(`Cron: ${companion.name} not watching channel ${channelId}, skipping`);
                  continue;
                }
                // Check blocked channels
                if (entityConfig.blocked_channels && entityConfig.blocked_channels.includes(channelId)) {
                  console.log(`Cron: ${companion.name} entity-blocked in channel ${channelId}, skipping`);
                  continue;
                }
              }
            }

            this.cleanStale();

            const authorName = msg.author?.global_name || msg.author?.username || 'unknown';
            const channelWebhookUrl = this.shouldUseWebhookForCompanion(companion.id)
              ? await this.getOrCreateWebhook(channelId)
              : null;
            const mentionIds = messageMentionIds;
            const referencedAuthorId = String(msg.referenced_message?.author?.id || msg.message_reference?.author_id || '').trim() || undefined;
            const engagement = classifyEngagement({
              content: msg.content,
              monitor,
              env: this.env,
              mentionIds,
              authorId: msg.author?.id,
              referencedAuthorId,
              activeConversation: Boolean(this.getActiveConversation(channelId, msg.author?.id)),
            });
            const hardCompanionMention = containsHardCompanionMention(msg.content, companion, this.env, mentionIds);
            const softCompanionMention = containsSoftCompanionName(msg.content, companion);
            const directReplyToCompanion = (repliedCompanionId === companion.id)
              || (!!referencedAuthorId && getCompanionDiscordMentionIds(this.env, companion).includes(referencedAuthorId));
            if (normalizeDiscordCompanionId(companion.id) !== 'kai') {
              engagement.hard_mention = hardCompanionMention;
              engagement.soft_name_mention = softCompanionMention;
              engagement.direct_reply_to_kai = directReplyToCompanion;
              engagement.other_user_tag = mentionsNonCompanionUser(msg.content, this.env, companion, mentionIds);
              if (hardCompanionMention || softCompanionMention || directReplyToCompanion) {
                engagement.disposition = 'respond';
                engagement.trigger_reason = hardCompanionMention
                  ? 'companion-hard-mention'
                  : directReplyToCompanion
                    ? 'direct-reply-to-companion'
                    : 'companion-name-mention';
                engagement.priority = hardCompanionMention || directReplyToCompanion ? 'high' : 'normal';
              }
            }
            if (directReplyToCompanion && engagement.disposition === 'log' && engagement.author_class === 'vel') {
              engagement.disposition = 'respond';
              engagement.trigger_reason = normalizeDiscordCompanionId(companion.id) === 'kai' ? 'direct-reply-to-kai' : 'direct-reply-to-companion';
              engagement.priority = engagement.priority === 'high' ? 'high' : 'normal';
              engagement.direct_reply_to_kai = true;
            }
            const cooldownActive = Date.now() - monitor.last_responded < monitor.cooldown_ms;
            const cooldownBypass = engagement.hard_mention || engagement.soft_name_mention || engagement.direct_reply_to_kai || engagement.active_conversation;
            const disposition: KairosDisposition = cooldownActive && engagement.disposition === 'respond' && !cooldownBypass
              ? 'log'
              : engagement.disposition;
            const triggerReason = disposition === 'log' && engagement.disposition === 'respond' && cooldownActive
              ? 'cooldown'
              : engagement.trigger_reason;
            const command: PendingCommand = {
              id: crypto.randomUUID(),
              companion_id: companion.id,
              content: msg.content,
              author: {
                username: authorName,
                id: msg.author?.id,
              },
              channel_id: channelId,
              webhook_url: channelWebhookUrl || undefined,
              channel_label: monitor.label,
              disposition,
              trigger_reason: triggerReason,
              priority: engagement.priority,
              source: 'poll',
              message_id: msg.id,
              mention_ids: mentionIds,
              referenced_author_id: referencedAuthorId,
              response_mode: monitor.response_mode,
              recent_context: recentContext,
              attachments: discordAttachmentMetadata(msg.attachments),
              engagement,
              timestamp: Date.parse(msg.timestamp) || Date.now(),
            };

            if (!this.storeCommand(command)) {
              pollDebug.duplicates++;
              continue;
            }
            const activityDebug = {
              authorId: msg.author?.id,
              engagement,
              mentionIds,
              referencedAuthorId,
              createdAt: msg.timestamp,
            };
            if (disposition === 'respond') {
              this.logActivity(companion.id, 'queued', channelId, msg.content, authorName, msg.id, channelWebhookUrl || undefined, activityDebug);
              totalStored++;
            } else if (disposition === 'log') {
              this.logActivity(companion.id, 'logged', channelId, msg.content, authorName, msg.id, channelWebhookUrl || undefined, activityDebug);
              totalLogged++;
            } else {
              this.logActivity(companion.id, 'ignored', channelId, msg.content, authorName, msg.id, channelWebhookUrl || undefined, activityDebug);
              totalIgnored++;
            }

            // DM notification to companion owner (best-effort, non-blocking)
            if (disposition === 'respond') this.notifyOwnerDM(companion, channelId, msg.content, authorName).catch(() => {});
            if (
              disposition === 'respond'
              && normalizeDiscordCompanionId(companion.id) === 'lucien'
              && this.env.LUCIEN_CHATGPT_RUNNER_ENABLED === 'true'
              && this.env.LUCIEN_CHATGPT_AUTORESPOND === 'true'
            ) {
              try {
                const runnerResponse = await this.runLucienChatGPTRunnerFromDashboard(command.id, 'autorespond');
                if (!runnerResponse.ok) {
                  const errorText = await runnerResponse.text().catch(() => '');
                  this.logActivity(companion.id, 'runner_failed', channelId, errorText || `Lucien ChatGPT runner returned ${runnerResponse.status}`, authorName, msg.id, channelWebhookUrl || undefined, activityDebug);
                }
              } catch (error) {
                this.logActivity(companion.id, 'runner_failed', channelId, error instanceof Error ? error.message : String(error), authorName, msg.id, channelWebhookUrl || undefined, activityDebug);
              }
            }

            console.log(`Cron: ${companion.name} ${disposition} (${triggerReason}) by "${msg.content}" from ${authorName}`);
          }
        }
      } catch (err: any) {
        console.error(`Poll exception for ${channelId}: ${err.message}`);
      }
    }

    pollDebug.queued = totalStored;
    pollDebug.logged = totalLogged;
    pollDebug.ignored = totalIgnored;
    pollDebug.finished_at = new Date().toISOString();
    await this.ctx.storage.put('last_poll_debug', pollDebug);

    return new Response(JSON.stringify({ polled: monitors.length, queued: totalStored, logged: totalLogged, ignored: totalIgnored }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getDefaultStub() {
    const id = this.env.COMPANION_BOT.idFromName('default');
    return this.env.COMPANION_BOT.get(id);
  }

  async init() {
    // ============ PENDING COMMAND TOOLS ============

    // Helper: fetch from the 'default' DO instance (where cron stores pending commands)
    const getDefaultStub = () => {
      const id = this.env.COMPANION_BOT.idFromName('default');
      return this.env.COMPANION_BOT.get(id);
    };

    // ============ ENTITY TOOL WRAPPER ============
    // Extends any tool with optional entity_id param for permission checks + audit logging.
    // When entity_id is omitted, behavior is unchanged (full bot-level access).
    // When entity_id is provided, checks entity_servers permissions and logs to entity_action_log.
    const entityTool = (
      name: string,
      description: string,
      schema: Record<string, any>,
      handler: (params: any) => Promise<any>,
      options?: { channelParam?: string; guildParam?: string }
    ) => {
      const extendedSchema = {
        ...schema,
        entity_id: z.string().optional().describe("Optional companion/entity ID for permission scoping and audit logging"),
      };

      this.server.tool(name, description, extendedSchema, async (params: any) => {
        const entityId = params.entity_id;

        // No entity_id = full bot-level access, no checks, no logging
        if (!entityId) {
          return handler(params);
        }

        // Auto-detect guild/channel params from schema if not explicitly set
        const defaultStub = getDefaultStub();
        let guildId: string | null = null;
        const channelParamName = options?.channelParam ||
          ['channelId', 'forumChannelId', 'threadId', 'categoryId'].find(p => p in schema && params[p]);
        const guildParamName = options?.guildParam ||
          ['guildId'].find(p => p in schema && params[p]);
        const channelId = channelParamName ? params[channelParamName] : null;

        if (guildParamName && params[guildParamName]) {
          guildId = params[guildParamName];
        } else if (channelId) {
          // Resolve guild from channel via default DO
          const guildRes = await defaultStub.fetch(new Request(`https://internal/api/resolve-guild/${channelId}`));
          const guildData = await guildRes.json() as any;
          guildId = guildData.guild_id || null;
        }

        // Check permissions via default DO
        const checkRes = await defaultStub.fetch(new Request('https://internal/api/entity-check-permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_id: entityId, tool_name: name, guild_id: guildId, channel_id: channelId }),
        }));
        const perm = await checkRes.json() as any;

        if (!perm.allowed) {
          // Log denied action
          await defaultStub.fetch(new Request('https://internal/api/entity-log-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, guild_id: guildId, channel_id: channelId, tool_name: name, summary: 'Permission denied', success: false, error_message: perm.reason }),
          }));
          return { content: [{ type: "text" as const, text: `Permission denied: ${perm.reason}` }] };
        }

        // Execute the original handler
        try {
          const result = await handler(params);
          // Log successful action
          await defaultStub.fetch(new Request('https://internal/api/entity-log-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, guild_id: guildId, channel_id: channelId, tool_name: name, summary: null, success: true }),
          }));
          return result;
        } catch (err: any) {
          // Log failed action
          await defaultStub.fetch(new Request('https://internal/api/entity-log-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, guild_id: guildId, channel_id: channelId, tool_name: name, summary: 'Handler error', success: false, error_message: err.message }),
          }));
          throw err;
        }
      });
    };


    // ============ LUCIEN CHATGPT RUNNER ============

    this.server.tool(
      "lucien_discord_reply",
      "Complete a Lucien Discord wake after ChatGPT has used Tessurae CogCore. Posts as Lucien, completes the Continuity wake candidate, and clears the pending request.",
      {
        request_id: z.string().describe("Pending Discord request ID."),
        wake_candidate_id: z.string().optional().describe("Continuity wake candidate ID from the Workspace Agent trigger payload."),
        content: z.string().describe("Lucien's final Discord reply."),
        drift_notes: z.string().optional().describe("Optional drift check or correction notes from ChatGPT."),
        dry_run: z.boolean().optional().describe("Preview without posting to Discord or completing Continuity."),
        webhook_url: z.string().optional().describe("Optional Discord webhook URL override."),
      },
      async ({ request_id, wake_candidate_id, content, drift_notes, dry_run, webhook_url }: any) => {
        try {
          const result = await this.completeLucienDiscordReply({
            requestId: request_id,
            wakeCandidateId: wake_candidate_id,
            content,
            driftNotes: drift_notes,
            dryRun: dry_run === true,
            webhookUrl: webhook_url,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: `Lucien Discord reply failed: ${error instanceof Error ? error.message : String(error)}` }] };
        }
      }
    );

    // ============ PENDING COMMANDS ============

    this.server.tool(
      "pending_commands",
      "Manage pending Discord messages waiting for companion responses. Actions: get, respond, dismiss, run_with_nexus (supervised Kai runner preview/delivery), run_with_lucien_chatgpt (queue Lucien's Workspace Agent).",
      {
        action: z.enum(["get", "respond", "dismiss", "run_with_nexus", "run_with_lucien_chatgpt"]).describe("The action to perform"),
        entity_id: z.string().optional().describe("Optional companion/entity ID. For 'get': filters pending commands. For 'respond'/'dismiss': validates it matches the command's companion_id."),
        requestId: z.string().optional().describe("(respond/dismiss/run_with_nexus/run_with_lucien_chatgpt) The request ID from pending_commands get"),
        response: z.string().optional().describe("(respond) The companion's response message"),
        dismissalReason: z.string().optional().describe("(dismiss) Required explanation for why this pending message is not being answered"),
        runnerId: z.string().optional().describe("(run_with_nexus) Runner lease owner id. Defaults to nexus-runner:kai"),
        deliver: z.boolean().optional().describe("(run_with_nexus) Post Kai runner response to Discord. Requires KAI_DISCORD_DELIVERY_ENABLED=true."),
        model: z.string().optional().describe("(run_with_nexus) Optional Nexus text model override"),
        provider: z.string().optional().describe("(run_with_nexus) Optional provider override"),
        webhookUrl: z.string().optional().describe("(respond) Discord webhook URL override"),
        embeds: z.array(z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          color: z.number().optional(),
          fields: z.array(z.object({
            name: z.string(),
            value: z.string(),
            inline: z.boolean().optional(),
          })).optional(),
          footer: z.object({ text: z.string() }).optional(),
          thumbnail: z.object({ url: z.string() }).optional(),
          image: z.object({ url: z.string() }).optional(),
        })).optional().describe("(respond) Optional Discord embeds to include with the response"),
      },
      async ({ action, entity_id, requestId, response, dismissalReason, runnerId, deliver, model, provider, webhookUrl, embeds }: any) => {
        const stub = getDefaultStub();

        switch (action) {
          case "get": {
            const res = await stub.fetch(new Request('https://internal/pending'));
            let pending = await res.json() as any[];
            if (!pending || pending.length === 0) {
              return { content: [{ type: "text" as const, text: "No pending messages." }] };
            }
            if (entity_id) {
              const targetEntity = normalizeDiscordCompanionId(entity_id);
              pending = pending.filter((cmd: any) => cmd.companion_id === targetEntity);
              if (pending.length === 0) {
                return { content: [{ type: "text" as const, text: `No pending messages for entity ${entity_id}.` }] };
              }
            }
            pending = pending.filter((cmd: any) => String(cmd.disposition || 'respond') === 'respond');
            if (pending.length === 0) {
              return { content: [{ type: "text" as const, text: entity_id ? `No pending response messages for entity ${entity_id}.` : "No pending response messages." }] };
            }
            const enriched = await Promise.all(pending.map(async (cmd: any) => {
              try {
                const rulesRes = await stub.fetch(new Request(`https://internal/api/companions/${cmd.companion_id}/rules`));
                const rulesData = await rulesRes.json() as any;
                if (rulesData.rules) cmd.companion_rules = rulesData.rules;
              } catch (_) {}
              if (normalizeDiscordCompanionId(cmd.companion_id) === 'kai' && !isVelDiscordAuthor(this.env, cmd.author?.id || cmd.author_id)) {
                cmd.audience_class = 'public_non_vel';
                cmd.response_contract = nonVelPublicResponseBoundary();
              } else if (normalizeDiscordCompanionId(cmd.companion_id) === 'kai') {
                cmd.audience_class = 'vel';
              }
              return cmd;
            }));
            return { content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }] };
          }

          case "respond": {
            if (this.env.DISCORD_RESPONSES_ENABLED !== 'true') {
              return { content: [{ type: "text" as const, text: "Discord Resonance replies are disabled. Pending messages can be read, but no Discord reply was sent." }] };
            }
            if (!requestId || !response) {
              return { content: [{ type: "text" as const, text: "requestId and response are required for 'respond' action" }] };
            }
            const pendingRes = await stub.fetch(new Request('https://internal/pending'));
            const allPending = await pendingRes.json() as any[];
            const command = allPending.find((cmd: any) => cmd.id === requestId);
            if (!command) {
              return { content: [{ type: "text" as const, text: `No pending command with ID: ${requestId}` }] };
            }
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== command.companion_id) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot respond as ${command.companion_id}` }] };
            }
            if (normalizeDiscordCompanionId(command.companion_id) === 'kai') {
              return { content: [{ type: "text" as const, text: "Legacy pending_commands respond is disabled for Kai. Kai's Discord replies must come from the Nexus/NESTeq runner." }] };
            }
            const kaiDriftReason = normalizeDiscordCompanionId(command.companion_id) === 'kai' ? kaiIdentityDriftReason(response) : null;
            if (kaiDriftReason) {
              await stub.fetch(new Request('https://internal/api/log-activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  companion_id: command.companion_id,
                  type: 'identity_drift_blocked',
                  channel_id: command.channel_id,
                  content: `Kai identity drift blocked before send (${kaiDriftReason}). Attempted response: ${response}`,
                  author: command.author?.username || command.author_username || 'unknown',
                  author_id: command.author?.id || command.author_id,
                  engagement: command.engagement,
                  mention_ids: command.mention_ids,
                  referenced_author_id: command.referenced_author_id,
                  message_id: command.message_id,
                  webhook_url: command.webhook_url,
                }),
              }));
              return { content: [{ type: "text" as const, text: `Identity drift blocked: Kai attempted ${kaiDriftReason}. Rewrite without wings, tails, animal ears, purring, horns, fangs, claws, or creature-body claims.` }] };
            }
            const nonVelKaiReply = normalizeDiscordCompanionId(command.companion_id) === 'kai' && !isVelDiscordAuthor(this.env, command.author?.id || command.author_id);
            const unsafeReason = nonVelKaiReply ? nonVelUnsafeResponseReason(response) : null;
            if (unsafeReason) {
              await stub.fetch(new Request('https://internal/api/log-activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  companion_id: command.companion_id,
                  type: 'discernment_blocked',
                  channel_id: command.channel_id,
                  content: `Non-Vel public response blocked before send (${unsafeReason}). Attempted response: ${response}`,
                  author: command.author?.username || command.author_username || 'unknown',
                  author_id: command.author?.id || command.author_id,
                  engagement: command.engagement,
                  mention_ids: command.mention_ids,
                  referenced_author_id: command.referenced_author_id,
                  message_id: command.message_id,
                  webhook_url: command.webhook_url,
                }),
              }));
              await stub.fetch(new Request('https://internal/delete-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: requestId }),
              }));
              return { content: [{ type: "text" as const, text: `Discernment blocked: Kai attempted ${unsafeReason} toward a non-Vel Discord user. Nothing was sent. Attempt logged for review.` }] };
            }
            const companionRes = await stub.fetch(new Request(`https://internal/api/companions/${command.companion_id}`));
            const companion = companionRes.ok ? await companionRes.json() as Companion : null;
            if (!companion) {
              return { content: [{ type: "text" as const, text: `Unknown companion: ${command.companion_id}` }] };
            }
            // Check restricted channels before responding
            try {
              const guildRes = await stub.fetch(new Request(`https://internal/api/resolve-guild/${command.channel_id}`));
              const guildData = await guildRes.json() as any;
              if (guildData.guild_id) {
                const restrictedRes = await stub.fetch(new Request(`https://internal/api/channel-restricted/${command.channel_id}/${guildData.guild_id}?companion_id=${command.companion_id}`));
                const restrictedData = await restrictedRes.json() as any;
                if (restrictedData.restricted && !restrictedData.has_exception) {
                  return { content: [{ type: "text" as const, text: `Channel is restricted — admin exception required for ${command.companion_id}` }] };
                }
              }
            } catch (_) {}
            const targetWebhookUrl = this.shouldUseWebhookForCompanion(command.companion_id)
              ? (webhookUrl || command.webhook_url)
              : null;
            let sendResult: string;
            const sentMessageIds: string[] = [];
            let sentWebhookUrl: string | undefined;
            if (targetWebhookUrl) {
              const chunks = splitMessage(response);
              for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                const webhookPayload: any = {
                  content: chunks[i],
                  username: companion.name,
                  avatar_url: companion.avatar_url,
                };
                if (isLast && embeds) webhookPayload.embeds = embeds;
                const res = await fetch(`${targetWebhookUrl}?wait=true`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(webhookPayload),
                });
                if (!res.ok) {
                  const errText = await res.text();
                  return { content: [{ type: "text" as const, text: `Webhook failed on chunk ${i + 1}/${chunks.length} (${res.status}): ${errText}` }] };
                }
                const msgData = await res.json() as any;
                sentMessageIds.push(msgData.id);
              }
              sentWebhookUrl = targetWebhookUrl;
              sendResult = `via webhook as ${companion.name} (${chunks.length} message${chunks.length > 1 ? 's' : ''}, ids: ${sentMessageIds.join(', ')})`;
            } else {
              const chunks = splitMessage(response);
              for (const chunk of chunks) {
                const result = await discordRequest(this.env, `/channels/${command.channel_id}/messages`, {
                  method: 'POST',
                  body: JSON.stringify({ content: chunk }),
                });
                if (result.error) {
                  return { content: [{ type: "text" as const, text: `Discord API error: ${JSON.stringify(result)}` }] };
                }
                sentMessageIds.push(result.id);
              }
              sendResult = `via API to channel ${command.channel_id} (${chunks.length} message${chunks.length > 1 ? 's' : ''}, ids: ${sentMessageIds.join(', ')})`;
            }
            await stub.fetch(new Request('https://internal/api/log-activity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                companion_id: command.companion_id,
                type: 'responded',
                channel_id: command.channel_id,
                content: response,
                author: companion.name,
                message_id: sentMessageIds[sentMessageIds.length - 1],
                webhook_url: sentWebhookUrl,
              }),
            }));
            await stub.fetch(new Request('https://internal/api/mark-responded', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel_id: command.channel_id,
                author_id: command.author?.id,
                message_id: command.message_id,
                started_by: command.trigger_reason || 'pending-response',
              }),
            }));
            await stub.fetch(new Request('https://internal/delete-command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: requestId }),
            }));
            return { content: [{ type: "text" as const, text: `Response sent ${sendResult}.` }] };
          }

          case "run_with_nexus": {
            if (!isKaiListenerEnabled(this.env)) {
              return { content: [{ type: "text" as const, text: "Kai runner/listener is installed but disabled. Set KAI_DISCORD_LISTENER_ENABLED=true when ready for supervised testing." }] };
            }
            if (!requestId) {
              return { content: [{ type: "text" as const, text: `requestId is required for '${action}' action` }] };
            }
            const pendingRes = await stub.fetch(new Request('https://internal/pending'));
            const allPending = await pendingRes.json() as any[];
            const command = allPending.find((cmd: any) => cmd.id === requestId) as PendingCommand | undefined;
            if (!command) {
              return { content: [{ type: "text" as const, text: `No pending command with ID: ${requestId}` }] };
            }
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== command.companion_id) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot run ${command.companion_id}` }] };
            }
            if (normalizeDiscordCompanionId(command.companion_id) !== 'kai') {
              return { content: [{ type: "text" as const, text: "run_with_nexus is Kai-only in this rollout." }] };
            }

            const activeRunnerId = String(runnerId || 'nexus-runner:kai');
            const shouldDeliver = deliver === true;
            if (shouldDeliver) {
              return { content: [{ type: "text" as const, text: "MCP delivery is disabled for the Kai Nexus runner. Use the Resonance dashboard button for human-confirmed Discord posting." }] };
            }
            let claimData: { event_id: string; wake_candidate: any; wake_context: any } | null = null;
            try {
              claimData = await createAndClaimWakeForCommand(this.env, command, activeRunnerId);
              const runnerResult = await callKaiRunnerWithFallback(this.env, {
                envelope: kaiRunnerEnvelopeForCommand(command),
                wake_candidate_id: claimData.wake_candidate.id,
                runner_id: activeRunnerId,
                request_id: command.id,
                source: 'discord',
                channel_id: command.channel_id,
                channel_label: command.channel_label,
                message_id: command.message_id,
                author: command.author,
                message: command.content,
                recent_context: command.recent_context,
                wake_context: claimData.wake_context,
                model,
                provider,
                dry_run: true,
                ...kaiRunnerPolicyForCommand(command),
              });

              const runnerSource = kaiRunnerSource(runnerResult);
              const runnerWorkspace = kaiRunnerWorkspaceSummary(runnerResult);
              const generatedResponse = String(runnerResult.response || '').trim();
              if (!generatedResponse && runnerResult?.should_respond === false) {
                const social = runnerSocialDecision(runnerResult);
                const decision = social?.decision || 'silence';
                const sentReactions: string[] = [];
                if (decision === 'react' && shouldDeliver && isKaiDeliveryEnabled(this.env) && command.message_id) {
                  const emoji = social?.recommended_reaction || '👀';
                  await addKaiSocialReaction(this.env, command.channel_id, command.message_id, emoji);
                  sentReactions.push(emoji);
                }
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, `social engagement decision: ${decision}`).catch(() => null);
                return { content: [{ type: "text" as const, text: JSON.stringify({
                  ok: true,
                  mode: decision === 'react' ? 'social_reaction' : 'social_silence',
                  requestId,
                  continuity_event_id: claimData.event_id,
                  wake_candidate_id: claimData.wake_candidate.id,
                  decision,
                  sent_reactions: sentReactions,
                  delivery_enabled: isKaiDeliveryEnabled(this.env),
                }, null, 2) }] };
              }
              if (!generatedResponse && this.env.KAI_RUNNER_ROUTE === 'nexus' && runnerResult?.generated === false) {
                const requiredReply = isRequiredKaiReply(command, runnerResult);
                const failureMessage = runnerGenerationFailureMessage(runnerResult);
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, requiredReply ? failureMessage : 'nexus dry-run contract; no text generation yet').catch(() => null);
                if (requiredReply && shouldDeliver) {
                  return { content: [{ type: "text" as const, text: JSON.stringify({
                    ok: false,
                    mode: 'required_reply_generation_failed',
                    error: failureMessage,
                    requestId,
                    continuity_event_id: claimData.event_id,
                    wake_candidate_id: claimData.wake_candidate.id,
                    runner_result: runnerResult,
                  }, null, 2) }] };
                }
                return { content: [{ type: "text" as const, text: JSON.stringify({
                  ok: true,
                  mode: 'nexus_runner_dry_run',
                  requestId,
                  continuity_event_id: claimData.event_id,
                  wake_candidate_id: claimData.wake_candidate.id,
                  runner_result: runnerResult,
                }, null, 2) }] };
              }
              if (!generatedResponse) {
                throw new Error('Kai runner returned an empty response');
              }
              const kaiDriftReason = kaiIdentityDriftReason(generatedResponse);
              if (kaiDriftReason) {
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, `identity drift blocked: ${kaiDriftReason}`).catch(() => null);
                return { content: [{ type: "text" as const, text: `Nexus runner generated identity drift (${kaiDriftReason}). Nothing was sent.\n\n${generatedResponse}` }] };
              }
              const nonVelKaiReply = !isVelDiscordAuthor(this.env, command.author?.id || command.author_id);
              const unsafeReason = nonVelKaiReply ? nonVelUnsafeResponseReason(generatedResponse) : null;
              if (unsafeReason) {
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, `public safety blocked: ${unsafeReason}`).catch(() => null);
                return { content: [{ type: "text" as const, text: `Nexus runner generated blocked public language (${unsafeReason}). Nothing was sent.\n\n${generatedResponse}` }] };
              }
              if (!shouldDeliver) {
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, 'supervised dry-run preview; no surface delivery').catch(() => null);
                return { content: [{ type: "text" as const, text: JSON.stringify({
                  ok: true,
                  mode: 'dry_run_preview',
                  requestId,
                  continuity_event_id: claimData.event_id,
                  wake_candidate_id: claimData.wake_candidate.id,
                  response: generatedResponse,
                  workspace: runnerWorkspace,
                }, null, 2) }] };
              }
              if (!isKaiDeliveryEnabled(this.env)) {
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, 'delivery requested but disabled').catch(() => null);
                return { content: [{ type: "text" as const, text: `Kai generated a response, but delivery is disabled. Set KAI_DISCORD_DELIVERY_ENABLED=true for the Kai room smoke test.\n\n${generatedResponse}` }] };
              }

              const companionRes = await stub.fetch(new Request(`https://internal/api/companions/${command.companion_id}`));
              const companion = companionRes.ok ? await companionRes.json() as Companion : null;
              if (!companion) throw new Error(`Unknown companion: ${command.companion_id}`);
              const targetWebhookUrl = this.shouldUseWebhookForCompanion(command.companion_id)
                ? (webhookUrl || command.webhook_url)
                : null;
              const sentMessageIds: string[] = [];
              let sentWebhookUrl: string | undefined;
              if (targetWebhookUrl) {
                const chunks = splitMessage(generatedResponse);
                for (let i = 0; i < chunks.length; i++) {
                  const webhookPayload: any = {
                    content: chunks[i],
                    username: companion.name,
                    avatar_url: companion.avatar_url,
                  };
                  if (i === chunks.length - 1 && embeds) webhookPayload.embeds = embeds;
                  const res = await fetch(`${targetWebhookUrl}?wait=true`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(webhookPayload),
                  });
                  if (!res.ok) throw new Error(`Webhook failed on chunk ${i + 1}: ${await res.text()}`);
                  const msgData = await res.json() as any;
                  sentMessageIds.push(msgData.id);
                }
                sentWebhookUrl = targetWebhookUrl;
              } else {
                for (const chunk of splitMessage(generatedResponse)) {
                  const result = await discordRequest(this.env, `/channels/${command.channel_id}/messages`, {
                    method: 'POST',
                    body: JSON.stringify({ content: chunk }),
                  });
                  if (result.error) throw new Error(`Discord API error: ${JSON.stringify(result)}`);
                  sentMessageIds.push(result.id);
                }
              }
              const continuityResponse = await continuityRequest(this.env, `/wake-candidates/${encodeURIComponent(String(claimData.wake_candidate.id))}/response`, {
                method: 'POST',
                body: JSON.stringify({
                  runner_id: activeRunnerId,
                  content: generatedResponse,
                  external_message_id: sentMessageIds[sentMessageIds.length - 1] || `discord-runner:${requestId}`,
                  author: { id: 'kaisoryth', name: companion.name },
                  metadata: {
                    runner: runnerSource,
                    delivery_path: kaiRunnerDeliveryPath(runnerSource),
                    delivery_status: 'delivered',
                    surface: 'discord',
                    request_id: requestId,
                    channel_id: command.channel_id,
                    sent_message_ids: sentMessageIds,
                    runner_workspace: runnerWorkspace,
                    tahl_state_present: Boolean(claimData.wake_context?.tahl_state && Object.keys(claimData.wake_context.tahl_state).length),
                  },
                }),
              });
              await stub.fetch(new Request('https://internal/api/log-activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  companion_id: command.companion_id,
                  type: 'responded',
                  channel_id: command.channel_id,
                  content: generatedResponse,
                  author: companion.name,
                  message_id: sentMessageIds[sentMessageIds.length - 1],
                  webhook_url: sentWebhookUrl,
                }),
              }));
              await stub.fetch(new Request('https://internal/api/mark-responded', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  channel_id: command.channel_id,
                  author_id: command.author?.id,
                  message_id: command.message_id,
                  started_by: 'nexus-runner',
                }),
              }));
              await stub.fetch(new Request('https://internal/delete-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: requestId }),
              }));
              return { content: [{ type: "text" as const, text: JSON.stringify({
                ok: true,
                mode: 'delivered',
                requestId,
                continuity_event_id: claimData.event_id,
                wake_candidate_id: claimData.wake_candidate.id,
                sent_message_ids: sentMessageIds,
                workspace: runnerWorkspace,
                continuity_response_event_id: continuityResponse?.event?.id || null,
              }, null, 2) }] };
            } catch (error) {
              if (claimData?.wake_candidate?.id) {
                await releaseWakeCandidate(this.env, claimData.wake_candidate.id, activeRunnerId, error instanceof Error ? error.message : String(error)).catch(() => null);
              }
              return { content: [{ type: "text" as const, text: `Nexus runner failed: ${error instanceof Error ? error.message : String(error)}` }] };
            }
          }

          case "run_with_lucien_chatgpt": {
            if (!requestId) {
              return { content: [{ type: "text" as const, text: "requestId is required for 'run_with_lucien_chatgpt' action" }] };
            }
            const pendingRes = await stub.fetch(new Request('https://internal/pending'));
            const allPending = await pendingRes.json() as any[];
            const command = allPending.find((cmd: any) => cmd.id === requestId) as PendingCommand | undefined;
            if (!command) {
              return { content: [{ type: "text" as const, text: `No pending command with ID: ${requestId}` }] };
            }
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== command.companion_id) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot run ${command.companion_id}` }] };
            }
            if (normalizeDiscordCompanionId(command.companion_id) !== 'lucien') {
              return { content: [{ type: "text" as const, text: "run_with_lucien_chatgpt is Lucien-only." }] };
            }
            const runnerResponse = await stub.fetch(new Request(`https://internal/api/pending/${encodeURIComponent(requestId)}/run-with-lucien-chatgpt`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ origin: 'mcp' }),
            }));
            return { content: [{ type: "text" as const, text: await runnerResponse.text() }] };
          }

          case "dismiss": {
            if (!requestId) {
              return { content: [{ type: "text" as const, text: "requestId is required for 'dismiss' action" }] };
            }
            const pendingRes = await stub.fetch(new Request('https://internal/pending'));
            const allPending = await pendingRes.json() as any[];
            const command = allPending.find((cmd: any) => cmd.id === requestId);
            if (!command) {
              return { content: [{ type: "text" as const, text: `No pending command with ID: ${requestId}` }] };
            }
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== command.companion_id) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot dismiss pending command for ${command.companion_id}` }] };
            }
            if (command.required_response || isRequiredVelHardTag(command)) {
              return { content: [{ type: "text" as const, text: "Cannot dismiss required Vel hard-tag. This pending item must be answered or explicitly handled by an admin endpoint." }] };
            }
            const reason = String(dismissalReason || '').trim() || 'Dismissed without a provided reason by pending_commands dismiss.';
            await stub.fetch(new Request('https://internal/api/log-activity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                companion_id: command.companion_id,
                type: 'dismissed',
                channel_id: command.channel_id,
                content: `Dismissal reason: ${reason}\n\nOriginal message: ${command.content}`,
                author: command.author?.username || command.author_username || 'responder',
                author_id: command.author?.id || command.author_id,
                engagement: command.engagement,
                mention_ids: command.mention_ids,
                referenced_author_id: command.referenced_author_id,
                message_id: command.message_id,
                webhook_url: command.webhook_url,
              }),
            }));
            await stub.fetch(new Request('https://internal/delete-command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: requestId }),
            }));
            return { content: [{ type: "text" as const, text: `Pending command dismissed: ${requestId}` }] };
          }
        }
        return { content: [{ type: "text" as const, text: `Unknown pending_commands action: ${action}` }] };
      }
    );

    // ============ DISCORD MONITORS (5 actions) ============

    this.server.tool(
      "discord_monitors",
      "Manage Discord Resonance monitor rows. Actions: list, add, remove, toggle, clear_pending.",
      {
        action: z.enum(["list", "add", "remove", "toggle", "clear_pending"]).describe("The action to perform"),
        id: z.string().optional().describe("(remove/toggle) Monitor ID"),
        channelId: z.string().optional().describe("(add/remove/toggle) Discord channel ID"),
        label: z.string().optional().describe("(add) Human-readable channel label"),
        tier: z.enum(["fast", "normal", "slow"]).optional().describe("(add) Monitor tier"),
        enabled: z.boolean().optional().describe("(add) Whether monitor starts enabled"),
        respondEnabled: z.boolean().optional().describe("(add) Whether monitor can queue responses"),
        responseMode: z.enum(["never", "mention", "urgent", "filtered", "open", "community_greeting", "discern"]).optional().describe("(add) KAIROS-compatible response mode"),
        cooldownMs: z.number().optional().describe("(add) Response cooldown in milliseconds"),
      },
      async ({ action, id, channelId, label, tier, enabled, respondEnabled, responseMode, cooldownMs }: any) => {
        const stub = getDefaultStub();
        switch (action) {
          case "list": {
            const res = await stub.fetch(new Request('https://internal/monitors'));
            return { content: [{ type: "text" as const, text: await res.text() }] };
          }
          case "add": {
            if (!channelId) return { content: [{ type: "text" as const, text: "channelId is required for add" }] };
            const res = await stub.fetch(new Request('https://internal/monitors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, channelId, label, tier, enabled, respondEnabled, responseMode, cooldownMs, addedBy: 'nexus' }),
            }));
            return { content: [{ type: "text" as const, text: await res.text() }] };
          }
          case "toggle": {
            const target = id || channelId;
            if (!target) return { content: [{ type: "text" as const, text: "id or channelId is required for toggle" }] };
            const res = await stub.fetch(new Request(`https://internal/monitors/${encodeURIComponent(target)}/toggle`, { method: 'POST' }));
            return { content: [{ type: "text" as const, text: await res.text() }] };
          }
          case "remove": {
            const target = id || channelId;
            if (!target) return { content: [{ type: "text" as const, text: "id or channelId is required for remove" }] };
            const res = await stub.fetch(new Request(`https://internal/monitors/${encodeURIComponent(target)}/remove`, { method: 'POST' }));
            return { content: [{ type: "text" as const, text: await res.text() }] };
          }
          case "clear_pending": {
            const res = await stub.fetch(new Request('https://internal/clear-pending', { method: 'POST' }));
            return { content: [{ type: "text" as const, text: await res.text() }] };
          }
        }
        return { content: [{ type: "text" as const, text: `Unknown discord_monitors action: ${action}` }] };
      }
    );

    // ============ COMPANION (5 actions) ============

    this.server.tool(
      "companion",
      "Companion management and messaging. Actions: list (show all companions and rules), send (send message as companion via webhook), edit_message (edit a companion's webhook message), delete_message (delete a companion's webhook message), introduce (post rich embed introduction card).",
      {
        action: z.enum(["list", "send", "edit_message", "delete_message", "introduce"]).describe("The action to perform"),
        entity_id: z.string().optional().describe("Optional companion/entity ID. For 'send'/'introduce': validates it matches companionId."),
        content: z.string().optional().describe("(send) Message content"),
        companionId: z.string().optional().describe("(send/introduce) Companion ID"),
        channelId: z.string().optional().describe("(send/introduce) Channel ID to send to"),
        webhookUrl: z.string().optional().describe("(send/edit_message/delete_message) Webhook URL override"),
        messageId: z.string().optional().describe("(edit_message/delete_message) The Discord message ID"),
        newContent: z.string().optional().describe("(edit_message) New message content"),
        embeds: z.array(z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          color: z.number().optional(),
          fields: z.array(z.object({
            name: z.string(),
            value: z.string(),
            inline: z.boolean().optional(),
          })).optional(),
          footer: z.object({ text: z.string() }).optional(),
          thumbnail: z.object({ url: z.string() }).optional(),
          image: z.object({ url: z.string() }).optional(),
        })).optional().describe("(send) Optional Discord embeds to include with the message"),
      },
      async ({ action, entity_id, content, companionId, channelId, webhookUrl, messageId, newContent, embeds }: any) => {
        const stub = getDefaultStub();

        switch (action) {
          case "list": {
            const res = await stub.fetch(new Request('https://internal/api/companions'));
            const companions = await res.json() as Companion[];
            const list = await Promise.all(companions.map(async c => {
              const rulesRes = await stub.fetch(new Request(`https://internal/api/companions/${c.id}/rules`));
              const rulesData = await rulesRes.json() as any;
              return { id: c.id, name: c.name, triggers: c.triggers, human_name: c.human_name, rules: rulesData.rules || null };
            }));
            return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
          }

          case "send": {
            if (!content || !companionId) {
              return { content: [{ type: "text" as const, text: "content and companionId are required for 'send' action" }] };
            }
            const targetCompanionId = normalizeDiscordCompanionId(companionId);
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== targetCompanionId) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot send as ${companionId}` }] };
            }
            if (targetCompanionId === 'kai') {
              return { content: [{ type: "text" as const, text: "Legacy companion send is disabled for Kai. Kai's Discord replies must come from the Nexus/NESTeq runner." }] };
            }
            const cRes = await stub.fetch(new Request(`https://internal/api/companions/${targetCompanionId}`));
            const companion = cRes.ok ? await cRes.json() as Companion : null;
            if (!companion) {
              return { content: [{ type: "text" as const, text: `Unknown companion: ${companionId}` }] };
            }
            const useWebhook = this.shouldUseWebhookForCompanion(targetCompanionId);
            let targetUrl = useWebhook ? webhookUrl : undefined;
            if (useWebhook && !targetUrl && channelId) {
              const resolved = await stub.fetch(new Request(`https://internal/api/channel-webhook/${channelId}`));
              if (resolved.ok) {
                const data = await resolved.json() as any;
                targetUrl = data.webhook_url;
              }
            }
            if (useWebhook && !targetUrl) targetUrl = this.env.WEBHOOK_URL;
            if (useWebhook && !targetUrl) {
              return { content: [{ type: "text" as const, text: "No webhook URL available. Provide channelId or webhookUrl." }] };
            }
            if (!useWebhook && !channelId) {
              return { content: [{ type: "text" as const, text: "channelId is required for bot-token sends." }] };
            }
            // Check restricted channels for companion sends
            if (channelId) {
              try {
                const guildRes = await stub.fetch(new Request(`https://internal/api/resolve-guild/${channelId}`));
                const guildData = await guildRes.json() as any;
                if (guildData.guild_id) {
                  const restrictedRes = await stub.fetch(new Request(`https://internal/api/channel-restricted/${channelId}/${guildData.guild_id}?companion_id=${targetCompanionId}`));
                  const restrictedData = await restrictedRes.json() as any;
                  if (restrictedData.restricted && !restrictedData.has_exception) {
                    return { content: [{ type: "text" as const, text: `Channel is restricted — admin exception required for ${companionId}` }] };
                  }
                }
              } catch (_) {}
            }
            const chunks = splitMessage(content);
            const sentMessageIds: string[] = [];
            if (useWebhook) {
              for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                const webhookPayload: any = {
                  content: chunks[i],
                  username: companion.name,
                  avatar_url: companion.avatar_url,
                };
                if (isLast && embeds) webhookPayload.embeds = embeds;
                const res = await fetch(`${targetUrl}?wait=true`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(webhookPayload),
                });
                if (!res.ok) {
                  const errText = await res.text();
                  return { content: [{ type: "text" as const, text: `Failed on chunk ${i + 1}/${chunks.length}: ${res.status} ${errText}` }] };
                }
                const msgData = await res.json() as any;
                sentMessageIds.push(msgData.id);
              }
            } else {
              for (const chunk of chunks) {
                const result = await discordRequest(this.env, `/channels/${channelId}/messages`, {
                  method: 'POST',
                  body: JSON.stringify({ content: chunk }),
                });
                if (result.error) {
                  return { content: [{ type: "text" as const, text: `Discord API error: ${JSON.stringify(result)}` }] };
                }
                sentMessageIds.push(result.id);
              }
            }
            await stub.fetch(new Request('https://internal/api/log-activity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ companion_id: targetCompanionId, type: 'sent', channel_id: channelId, content, author: companion.name, message_id: sentMessageIds[sentMessageIds.length - 1], webhook_url: targetUrl }),
            }));
            const modeLabel = useWebhook ? `as ${companion.name}` : `through bot user ${getKaiDiscordMentionIds(this.env)[0] || 'configured token'}`;
            return { content: [{ type: "text" as const, text: `Sent ${modeLabel} (${chunks.length} message${chunks.length > 1 ? 's' : ''}, ids: ${sentMessageIds.join(', ')})` }] };
          }

          case "edit_message": {
            if (!messageId || !newContent) {
              return { content: [{ type: "text" as const, text: "messageId and newContent are required for 'edit_message' action" }] };
            }
            const prior = this.getActivityByMessageId(messageId);
            const targetUrl = webhookUrl || prior?.webhook_url || this.env.WEBHOOK_URL;
            if (!targetUrl) {
              return { content: [{ type: "text" as const, text: "No webhook URL provided or configured" }] };
            }
            const res = await fetch(`${targetUrl}/messages/${messageId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: newContent }),
            });
            if (!res.ok) {
              const errText = await res.text();
              return { content: [{ type: "text" as const, text: `Edit failed (${res.status}): ${errText}` }] };
            }
            await stub.fetch(new Request('https://internal/api/log-activity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                companion_id: prior?.companion_id || companionId || entity_id || 'kai',
                type: 'edited',
                channel_id: prior?.channel_id,
                content: newContent,
                author: prior?.author,
                message_id: messageId,
                webhook_url: targetUrl,
              }),
            }));
            return { content: [{ type: "text" as const, text: `Message ${messageId} edited.` }] };
          }

          case "delete_message": {
            if (!messageId) {
              return { content: [{ type: "text" as const, text: "messageId is required for 'delete_message' action" }] };
            }
            const prior = this.getActivityByMessageId(messageId);
            const targetUrl = webhookUrl || prior?.webhook_url || this.env.WEBHOOK_URL;
            if (!targetUrl) {
              return { content: [{ type: "text" as const, text: "No webhook URL provided or configured" }] };
            }
            const res = await fetch(`${targetUrl}/messages/${messageId}`, { method: 'DELETE' });
            if (!res.ok) {
              const errText = await res.text();
              return { content: [{ type: "text" as const, text: `Delete failed (${res.status}): ${errText}` }] };
            }
            await stub.fetch(new Request('https://internal/api/log-activity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                companion_id: prior?.companion_id || companionId || entity_id || 'kai',
                type: 'deleted',
                channel_id: prior?.channel_id,
                content: prior?.content || `[deleted message ${messageId}]`,
                author: prior?.author,
                message_id: messageId,
                webhook_url: targetUrl,
              }),
            }));
            return { content: [{ type: "text" as const, text: `Message ${messageId} deleted.` }] };
          }

          case "introduce": {
            if (!companionId || !channelId) {
              return { content: [{ type: "text" as const, text: "companionId and channelId are required for 'introduce' action" }] };
            }
            const targetCompanionId = normalizeDiscordCompanionId(companionId);
            if (entity_id && normalizeDiscordCompanionId(entity_id) !== targetCompanionId) {
              return { content: [{ type: "text" as const, text: `Entity mismatch: ${entity_id} cannot introduce ${companionId}` }] };
            }
            const defaultStub = this.getDefaultStub();
            const resp = await defaultStub.fetch(new Request('http://internal/api/companions'));
            const companions = await resp.json() as any[];
            const companion = companions.find((c: any) => c.id === targetCompanionId);
            if (!companion) {
              return { content: [{ type: "text", text: `Unknown companion: ${companionId}` }] };
            }
            const introWebhookUrl = await this.getOrCreateWebhookViaDefault(channelId);
            if (!introWebhookUrl) {
              return { content: [{ type: "text", text: `Could not get webhook for channel ${channelId}` }] };
            }
            const embed = {
              title: companion.name,
              description: companion.human_info || 'AI Companion',
              color: 0xE91E8C,
              thumbnail: companion.avatar_url ? { url: companion.avatar_url } : undefined,
              fields: [
                { name: 'Triggers', value: (companion.triggers || []).map((t: string) => `\`${t}\``).join(', '), inline: true },
                { name: 'Human', value: companion.human_name || 'Unknown', inline: true },
              ],
              footer: { text: 'Discord Resonance — One bot, unlimited companions' },
            };
            const introRes = await fetch(`${introWebhookUrl}?wait=true`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: companion.name, avatar_url: companion.avatar_url, embeds: [embed] }),
            });
            if (!introRes.ok) {
              return { content: [{ type: "text", text: `Failed to send intro: ${introRes.status}` }] };
            }
            return { content: [{ type: "text", text: `Introduction card posted for ${companion.name} in channel ${channelId}` }] };
          }
        }
        return { content: [{ type: "text" as const, text: `Unknown companion action: ${action}` }] };
      }
    );

    // ============ DISCORD SERVER (2 actions) ============

    entityTool(
      "discord_server",
      "Discord server operations. Actions: list (list all servers the bot is in), get_info (detailed server info with channels and members).",
      {
        action: z.enum(["list", "get_info"]).describe("The action to perform"),
        guildId: z.string().optional().describe("(get_info) The Discord server/guild ID"),
      },
      async ({ action, guildId }: any) => {
        switch (action) {
          case "list": {
            const result = await discordRequest(this.env, '/users/@me/guilds');
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            const guilds = (result as any[]).map(g => ({
              id: g.id, name: g.name,
              icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp` : null,
            }));
            return { content: [{ type: "text", text: JSON.stringify(guilds, null, 2) }] };
          }

          case "get_info": {
            const resolved = await resolveGuild(this.env, guildId);
            if ('error' in resolved) return { content: [{ type: "text", text: resolved.error }] };
            const resolvedGuildId = resolved.id;
            const [guild, channels] = await Promise.all([
              discordRequest(this.env, `/guilds/${resolvedGuildId}?with_counts=true`),
              discordRequest(this.env, `/guilds/${resolvedGuildId}/channels`)
            ]);
            if (guild.error) {
              const hint = await getGuildListHint(this.env);
              return { content: [{ type: "text", text: `Guild ${resolvedGuildId} not found.\n\nAvailable guilds:\n${hint}` }] };
            }
            const channelTypes: Record<number, string> = {
              0: 'GuildText', 2: 'GuildVoice', 4: 'GuildCategory',
              5: 'GuildAnnouncement', 13: 'GuildStageVoice', 15: 'GuildForum'
            };
            const channelList = Array.isArray(channels) ? channels : [];
            const channelDetails = channelList.map((c: any) => ({
              id: c.id, name: c.name, type: channelTypes[c.type] || c.type,
              categoryId: c.parent_id, position: c.position, topic: c.topic || null
            }));
            const countByType = (type: number) => channelList.filter((c: any) => c.type === type).length;
            const guildInfo = {
              id: guild.id, name: guild.name, description: guild.description,
              icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp` : null,
              owner: guild.owner_id,
              createdAt: new Date(Number(BigInt(guild.id) >> 22n) + 1420070400000).toISOString(),
              memberCount: guild.approximate_member_count,
              channels: {
                count: { text: countByType(0), voice: countByType(2), category: countByType(4), forum: countByType(15), announcement: countByType(5), stage: countByType(13), total: channelList.length },
                details: {
                  text: channelDetails.filter((c: any) => c.type === 'GuildText'),
                  voice: channelDetails.filter((c: any) => c.type === 'GuildVoice'),
                  category: channelDetails.filter((c: any) => c.type === 'GuildCategory'),
                  forum: channelDetails.filter((c: any) => c.type === 'GuildForum'),
                  announcement: channelDetails.filter((c: any) => c.type === 'GuildAnnouncement'),
                  stage: channelDetails.filter((c: any) => c.type === 'GuildStageVoice'),
                  all: channelDetails
                }
              },
              features: guild.features,
              premium: { tier: guild.premium_tier, subscriptions: guild.premium_subscription_count }
            };
            return { content: [{ type: "text", text: JSON.stringify(guildInfo, null, 2) }] };
          }
        }
      }
    );

    // ============ DISCORD MESSAGE (8 actions) ============

    entityTool(
      "discord_message",
      "Discord message operations. Actions: read (fetch messages from channel), send (send as bot), edit (edit bot message), delete (delete message), get (get single message details), search (search messages in server), dm (send direct message), poll (create poll).",
      {
        action: z.enum(["read", "send", "edit", "delete", "get", "search", "dm", "poll"]).describe("The action to perform"),
        channelId: z.string().optional().describe("(read/send/edit/delete/get/poll) The channel ID"),
        messageId: z.string().optional().describe("(edit/delete/get) The message ID"),
        message: z.string().optional().describe("(send/dm) The message content"),
        newContent: z.string().optional().describe("(edit) The new message content"),
        replyToMessageId: z.string().optional().describe("(send) Message ID to reply to"),
        limit: z.number().optional().describe("(read/search) Max messages to return"),
        guildId: z.string().optional().describe("(search) The server ID to search in"),
        content: z.string().optional().describe("(search) Search for messages containing text"),
        authorId: z.string().optional().describe("(search) Filter by author ID"),
        userId: z.string().optional().describe("(dm) The Discord user ID to DM"),
        question: z.string().optional().describe("(poll) The poll question"),
        answers: z.array(z.string()).optional().describe("(poll) Poll answer options (2-10)"),
        durationHours: z.number().optional().describe("(poll) Poll duration in hours (default 24)"),
        allowMultiselect: z.boolean().optional().describe("(poll) Allow multiple selections"),
      },
      async ({ action, channelId, messageId, message, newContent, replyToMessageId, limit, guildId, content, authorId, userId, question, answers, durationHours, allowMultiselect, entity_id }: any) => {
        switch (action) {
          case "read": {
            if (!channelId) return { content: [{ type: "text", text: "channelId is required for 'read'" }] };
            const messages = await discordRequest(this.env, `/channels/${channelId}/messages?limit=${limit || 50}`);
            if (messages.error) {
              return { content: [{ type: "text", text: JSON.stringify(messages) }] };
            }
            const formatted = (messages as any[]).map(msg => ({
              id: msg.id, content: msg.content,
              author: { id: msg.author.id, username: msg.author.username, bot: msg.author.bot || false },
              timestamp: msg.timestamp,
              attachments: msg.attachments?.length || 0,
              embeds: msg.embeds?.length || 0,
              replyTo: msg.message_reference?.message_id || null
            })).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            return { content: [{ type: "text", text: JSON.stringify({ channelId, messageCount: formatted.length, messages: formatted }, null, 2) }] };
          }

          case "send": {
            if (!channelId || !message) return { content: [{ type: "text", text: "channelId and message are required for 'send'" }] };

            // Auto-route through companion webhook when entity_id matches a registered companion
            if (entity_id) {
              const stub = getDefaultStub();
              const targetEntityId = normalizeDiscordCompanionId(entity_id);
              const cRes = await stub.fetch(new Request(`https://internal/api/companions/${targetEntityId}`));
              if (cRes.ok) {
                const companion = await cRes.json() as Companion;
                // Resolve webhook for this channel
                let targetUrl: string | undefined;
                const resolved = await stub.fetch(new Request(`https://internal/api/channel-webhook/${channelId}`));
                if (resolved.ok) {
                  const data = await resolved.json() as any;
                  targetUrl = data.webhook_url;
                }
                if (!targetUrl) targetUrl = this.env.WEBHOOK_URL;
                if (targetUrl) {
                  const chunks = splitMessage(message);
                  const sentIds: string[] = [];
                  for (const chunk of chunks) {
                    const res = await fetch(`${targetUrl}?wait=true`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ content: chunk, username: companion.name, avatar_url: companion.avatar_url }),
                    });
                    if (!res.ok) {
                      const errText = await res.text();
                      return { content: [{ type: "text", text: `Webhook send failed: ${res.status} ${errText}` }] };
                    }
                    const msgData = await res.json() as any;
                    sentIds.push(msgData.id);
                  }
                  await stub.fetch(new Request('https://internal/api/log-activity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ companion_id: targetEntityId, type: 'sent', content: message, author: companion.name, message_id: sentIds[sentIds.length - 1], webhook_url: targetUrl }),
                  }));
                  return { content: [{ type: "text", text: `Sent as ${companion.name} (${chunks.length} message${chunks.length > 1 ? 's' : ''}, ids: ${sentIds.join(', ')})` }] };
                }
              }
            }

            // Fallback: send as bot
            const body: any = { content: message };
            if (replyToMessageId) {
              body.message_reference = { message_id: replyToMessageId };
            }
            const result = await discordRequest(this.env, `/channels/${channelId}/messages`, {
              method: 'POST', body: JSON.stringify(body)
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            const response = replyToMessageId
              ? `Message sent to channel ${channelId} as reply to ${replyToMessageId}`
              : `Message sent to channel ${channelId}`;
            return { content: [{ type: "text", text: response }] };
          }

          case "edit": {
            if (!channelId || !messageId || !newContent) return { content: [{ type: "text", text: "channelId, messageId, and newContent are required for 'edit'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}`, {
              method: 'PATCH', body: JSON.stringify({ content: newContent })
            });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to edit message: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Message ${messageId} edited` }] };
          }

          case "delete": {
            if (!channelId || !messageId) return { content: [{ type: "text", text: "channelId and messageId are required for 'delete'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Deleted message ${messageId}` }] };
          }

          case "get": {
            if (!channelId || !messageId) return { content: [{ type: "text", text: "channelId and messageId are required for 'get'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}`);
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to get message: ${JSON.stringify(result)}` }] };
            }
            const msg = result as any;
            const info = {
              id: msg.id, content: msg.content,
              author: { id: msg.author?.id, username: msg.author?.username, bot: msg.author?.bot },
              timestamp: msg.timestamp, edited_timestamp: msg.edited_timestamp,
              attachments: (msg.attachments || []).map((a: any) => ({
                id: a.id, filename: a.filename, url: a.url, size: a.size, content_type: a.content_type,
              })),
              embeds: msg.embeds?.length || 0,
              reactions: (msg.reactions || []).map((r: any) => ({ emoji: r.emoji?.name, count: r.count })),
              pinned: msg.pinned,
              reply_to: msg.message_reference?.message_id,
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
          }

          case "search": {
            const searchGuild = await resolveGuild(this.env, guildId);
            if ('error' in searchGuild) return { content: [{ type: "text", text: searchGuild.error }] };
            const params = new URLSearchParams();
            if (content) params.append('content', content);
            if (authorId) params.append('author_id', authorId);
            if (channelId) params.append('channel_id', channelId);
            params.append('limit', String(limit || 25));
            const result = await discordRequest(this.env, `/guilds/${searchGuild.id}/messages/search?${params.toString()}`);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }

          case "dm": {
            if (!userId || !message) return { content: [{ type: "text", text: "userId and message are required for 'dm'" }] };
            const dm = await discordRequest(this.env, `/users/@me/channels`, {
              method: 'POST', body: JSON.stringify({ recipient_id: userId })
            });
            if (dm.error) {
              return { content: [{ type: "text", text: `Failed to open DM: ${JSON.stringify(dm)}` }] };
            }
            const result = await discordRequest(this.env, `/channels/${dm.id}/messages`, {
              method: 'POST', body: JSON.stringify({ content: message })
            });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to send DM: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `DM sent to user ${userId}` }] };
          }

          case "poll": {
            if (!channelId || !question || !answers) return { content: [{ type: "text", text: "channelId, question, and answers are required for 'poll'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}/messages`, {
              method: 'POST',
              body: JSON.stringify({
                poll: {
                  question: { text: question },
                  answers: answers.map((a: string) => ({ poll_media: { text: a } })),
                  duration: durationHours || 24,
                  allow_multiselect: allowMultiselect || false,
                }
              })
            });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to create poll: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Poll created in channel ${channelId}: "${question}" with ${answers.length} options` }] };
          }
        }
      }
    );

    // ============ DISCORD REACTION (3 actions) ============

    entityTool(
      "discord_reaction",
      "Discord reaction operations. Actions: add (add emoji reaction), add_multiple (add multiple reactions), remove (remove reaction).",
      {
        action: z.enum(["add", "add_multiple", "remove"]).describe("The action to perform"),
        channelId: z.string().describe("The channel ID"),
        messageId: z.string().describe("The message ID"),
        emoji: z.string().optional().describe("(add/remove) The emoji to react with"),
        emojis: z.array(z.string()).optional().describe("(add_multiple) Array of emojis"),
        userId: z.string().optional().describe("(remove) User ID (omit for self)"),
      },
      async ({ action, channelId, messageId, emoji, emojis, userId }: any) => {
        switch (action) {
          case "add": {
            if (!emoji) return { content: [{ type: "text", text: "emoji is required for 'add'" }] };
            const encoded = encodeURIComponent(emoji);
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, { method: 'PUT' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Added reaction ${emoji} to message ${messageId}` }] };
          }

          case "add_multiple": {
            if (!emojis) return { content: [{ type: "text", text: "emojis array is required for 'add_multiple'" }] };
            const results = [];
            for (const e of emojis) {
              const encoded = encodeURIComponent(e);
              const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, { method: 'PUT' });
              results.push({ emoji: e, success: !result.error });
              await new Promise(r => setTimeout(r, 300));
            }
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
          }

          case "remove": {
            if (!emoji) return { content: [{ type: "text", text: "emoji is required for 'remove'" }] };
            const encoded = encodeURIComponent(emoji);
            const target = userId || '@me';
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/${target}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Removed reaction ${emoji} from message ${messageId}` }] };
          }
        }
      }
    );

    // ============ DISCORD CHANNEL (2 actions) ============

    entityTool(
      "discord_channel",
      "Discord channel operations. Actions: create (create text channel), delete (delete channel).",
      {
        action: z.enum(["create", "delete"]).describe("The action to perform"),
        guildId: z.string().optional().describe("(create) The server ID"),
        channelName: z.string().optional().describe("(create) Name for the new channel"),
        topic: z.string().optional().describe("(create) Channel topic"),
        channelId: z.string().optional().describe("(delete) The channel ID to delete"),
      },
      async ({ action, guildId: rawGuildId, channelName, topic, channelId }: any) => {
        switch (action) {
          case "create": {
            if (!channelName) return { content: [{ type: "text", text: "channelName is required for 'create'" }] };
            const resolved = await resolveGuild(this.env, rawGuildId);
            if ('error' in resolved) return { content: [{ type: "text", text: resolved.error }] };
            const guildId = resolved.id;
            const body: any = { name: channelName, type: 0 };
            if (topic) body.topic = topic;
            const result = await discordRequest(this.env, `/guilds/${guildId}/channels`, {
              method: 'POST', body: JSON.stringify(body)
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Created text channel "${channelName}" with ID: ${result.id}` }] };
          }

          case "delete": {
            if (!channelId) return { content: [{ type: "text", text: "channelId is required for 'delete'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Deleted channel ${channelId}` }] };
          }
        }
      }
    );

    // ============ DISCORD CATEGORY (3 actions) ============

    entityTool(
      "discord_category",
      "Discord category operations. Actions: create (create category), edit (edit category), delete (delete category).",
      {
        action: z.enum(["create", "edit", "delete"]).describe("The action to perform"),
        guildId: z.string().optional().describe("(create) The server ID"),
        categoryId: z.string().optional().describe("(edit/delete) The category ID"),
        name: z.string().optional().describe("(create/edit) Category name"),
        position: z.number().optional().describe("(create/edit) Position in channel list"),
      },
      async ({ action, guildId: rawGuildId, categoryId, name, position }: any) => {
        switch (action) {
          case "create": {
            if (!name) return { content: [{ type: "text", text: "name is required for 'create'" }] };
            const resolved = await resolveGuild(this.env, rawGuildId);
            if ('error' in resolved) return { content: [{ type: "text", text: resolved.error }] };
            const guildId = resolved.id;
            const body: any = { name, type: 4 };
            if (position !== undefined) body.position = position;
            const result = await discordRequest(this.env, `/guilds/${guildId}/channels`, {
              method: 'POST', body: JSON.stringify(body)
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Created category "${name}" with ID: ${result.id}` }] };
          }

          case "edit": {
            if (!categoryId) return { content: [{ type: "text", text: "categoryId is required for 'edit'" }] };
            const body: any = {};
            if (name) body.name = name;
            if (position !== undefined) body.position = position;
            const result = await discordRequest(this.env, `/channels/${categoryId}`, {
              method: 'PATCH', body: JSON.stringify(body)
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Edited category ${categoryId}` }] };
          }

          case "delete": {
            if (!categoryId) return { content: [{ type: "text", text: "categoryId is required for 'delete'" }] };
            const result = await discordRequest(this.env, `/channels/${categoryId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Deleted category ${categoryId}` }] };
          }
        }
      }
    );

    // ============ DISCORD FORUM (5 actions) ============

    entityTool(
      "discord_forum",
      "Discord forum operations. Actions: list (list forum channels), create_post (create forum post), get_post (get post details), reply (reply to post), delete_post (delete post).",
      {
        action: z.enum(["list", "create_post", "get_post", "reply", "delete_post"]).describe("The action to perform"),
        guildId: z.string().optional().describe("(list) The server ID"),
        forumChannelId: z.string().optional().describe("(create_post) The forum channel ID"),
        threadId: z.string().optional().describe("(get_post/reply/delete_post) The thread/post ID"),
        title: z.string().optional().describe("(create_post) Post title"),
        content: z.string().optional().describe("(create_post) Post content"),
        message: z.string().optional().describe("(reply) Reply content"),
      },
      async ({ action, guildId, forumChannelId, threadId, title, content, message }: any) => {
        switch (action) {
          case "list": {
            if (!guildId) return { content: [{ type: "text", text: "guildId is required for 'list'" }] };
            const channels = await discordRequest(this.env, `/guilds/${guildId}/channels`);
            if (channels.error) {
              return { content: [{ type: "text", text: JSON.stringify(channels) }] };
            }
            const forums = (channels as any[]).filter(c => c.type === 15).map(c => ({
              id: c.id, name: c.name, topic: c.topic
            }));
            return { content: [{ type: "text", text: JSON.stringify(forums, null, 2) }] };
          }

          case "create_post": {
            if (!forumChannelId || !title || !content) return { content: [{ type: "text", text: "forumChannelId, title, and content are required for 'create_post'" }] };
            const result = await discordRequest(this.env, `/channels/${forumChannelId}/threads`, {
              method: 'POST', body: JSON.stringify({ name: title, message: { content } })
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Created forum post "${title}" with ID: ${result.id}` }] };
          }

          case "get_post": {
            if (!threadId) return { content: [{ type: "text", text: "threadId is required for 'get_post'" }] };
            const [thread, messages] = await Promise.all([
              discordRequest(this.env, `/channels/${threadId}`),
              discordRequest(this.env, `/channels/${threadId}/messages?limit=50`)
            ]);
            if (thread.error) {
              return { content: [{ type: "text", text: JSON.stringify(thread) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify({ thread, messages }, null, 2) }] };
          }

          case "reply": {
            if (!threadId || !message) return { content: [{ type: "text", text: "threadId and message are required for 'reply'" }] };
            const result = await discordRequest(this.env, `/channels/${threadId}/messages`, {
              method: 'POST', body: JSON.stringify({ content: message })
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Reply sent to thread ${threadId}` }] };
          }

          case "delete_post": {
            if (!threadId) return { content: [{ type: "text", text: "threadId is required for 'delete_post'" }] };
            const result = await discordRequest(this.env, `/channels/${threadId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Deleted thread ${threadId}` }] };
          }
        }
      }
    );

    // ============ DISCORD WEBHOOK (3 actions) ============

    entityTool(
      "discord_webhook",
      "Discord webhook operations. Actions: create (create webhook for channel), send (send message via webhook), delete (delete webhook).",
      {
        action: z.enum(["create", "send", "delete"]).describe("The action to perform"),
        channelId: z.string().optional().describe("(create) The channel ID"),
        name: z.string().optional().describe("(create) Webhook name"),
        webhookId: z.string().optional().describe("(send/delete) Webhook ID"),
        webhookToken: z.string().optional().describe("(send/delete) Webhook token"),
        content: z.string().optional().describe("(send) Message content"),
        username: z.string().optional().describe("(send) Override username"),
        avatarURL: z.string().optional().describe("(send) Override avatar URL"),
      },
      async ({ action, channelId, name, webhookId, webhookToken, content, username, avatarURL }: any) => {
        switch (action) {
          case "create": {
            if (!channelId || !name) return { content: [{ type: "text", text: "channelId and name are required for 'create'" }] };
            const result = await discordRequest(this.env, `/channels/${channelId}/webhooks`, {
              method: 'POST', body: JSON.stringify({ name })
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify({ id: result.id, token: result.token, name: result.name }, null, 2) }] };
          }

          case "send": {
            if (!webhookId || !webhookToken || !content) return { content: [{ type: "text", text: "webhookId, webhookToken, and content are required for 'send'" }] };
            const body: any = { content };
            if (username) body.username = username;
            if (avatarURL) body.avatar_url = avatarURL;
            const response = await fetch(`${DISCORD_API}/webhooks/${webhookId}/${webhookToken}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            if (!response.ok) {
              return { content: [{ type: "text", text: `Webhook error: ${response.status}` }] };
            }
            return { content: [{ type: "text", text: "Webhook message sent" }] };
          }

          case "delete": {
            if (!webhookId) return { content: [{ type: "text", text: "webhookId is required for 'delete'" }] };
            const endpoint = webhookToken
              ? `/webhooks/${webhookId}/${webhookToken}`
              : `/webhooks/${webhookId}`;
            const result = await discordRequest(this.env, endpoint, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Deleted webhook ${webhookId}` }] };
          }
        }
      }
    );

    // ============ DISCORD THREAD (2 actions) ============

    entityTool(
      "discord_thread",
      "Discord thread operations. Actions: create (create thread from message), send (send message to thread).",
      {
        action: z.enum(["create", "send"]).describe("The action to perform"),
        channelId: z.string().optional().describe("(create) The channel ID"),
        messageId: z.string().optional().describe("(create) The message ID to create thread from"),
        threadId: z.string().optional().describe("(send) The thread ID"),
        name: z.string().optional().describe("(create) Thread name"),
        message: z.string().optional().describe("(send) The message content"),
        autoArchiveDuration: z.number().optional().describe("(create) Minutes until auto-archive (60, 1440, 4320, 10080)"),
      },
      async ({ action, channelId, messageId, threadId, name, message, autoArchiveDuration }: any) => {
        switch (action) {
          case "create": {
            if (!channelId || !messageId || !name) return { content: [{ type: "text", text: "channelId, messageId, and name are required for 'create'" }] };
            const body: any = { name };
            if (autoArchiveDuration) body.auto_archive_duration = autoArchiveDuration;
            const result = await discordRequest(this.env, `/channels/${channelId}/messages/${messageId}/threads`, {
              method: 'POST', body: JSON.stringify(body)
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Created thread "${name}" with ID: ${result.id}` }] };
          }

          case "send": {
            if (!threadId || !message) return { content: [{ type: "text", text: "threadId and message are required for 'send'" }] };
            const result = await discordRequest(this.env, `/channels/${threadId}/messages`, {
              method: 'POST', body: JSON.stringify({ content: message })
            });
            if (result.error) {
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            return { content: [{ type: "text", text: `Message sent to thread ${threadId}` }] };
          }
        }
      }
    );

    // ============ DISCORD PIN (2 actions) ============

    entityTool(
      "discord_pin",
      "Discord pin operations. Actions: pin (pin a message), unpin (unpin a message).",
      {
        action: z.enum(["pin", "unpin"]).describe("The action to perform"),
        channelId: z.string().describe("The channel ID"),
        messageId: z.string().describe("The message ID"),
      },
      async ({ action, channelId, messageId }: any) => {
        switch (action) {
          case "pin": {
            const result = await discordRequest(this.env, `/channels/${channelId}/pins/${messageId}`, { method: 'PUT' });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to pin message: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Message ${messageId} pinned in channel ${channelId}` }] };
          }

          case "unpin": {
            const result = await discordRequest(this.env, `/channels/${channelId}/pins/${messageId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to unpin message: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Message ${messageId} unpinned` }] };
          }
        }
      }
    );

    // ============ DISCORD MODERATION (6 actions) ============

    entityTool(
      "discord_moderation",
      "Discord moderation operations. Actions: timeout (mute user), remove_timeout (unmute user), assign_role (give role), remove_role (take role), ban_server (ban a server from bot), unban_server (remove server ban).",
      {
        action: z.enum(["timeout", "remove_timeout", "assign_role", "remove_role", "ban_server", "unban_server"]).describe("The action to perform"),
        guildId: z.string().optional().describe("The server/guild ID. If omitted and bot is in only one server, auto-selects it."),
        userId: z.string().optional().describe("(timeout/remove_timeout/assign_role/remove_role) The user ID"),
        roleId: z.string().optional().describe("(assign_role/remove_role) The role ID"),
        durationMinutes: z.number().optional().describe("(timeout) Timeout duration in minutes (max 40320)"),
        reason: z.string().optional().describe("(timeout/ban_server) Reason"),
      },
      async ({ action, guildId: rawGuildId, userId, roleId, durationMinutes, reason }: any) => {
        const resolved = await resolveGuild(this.env, rawGuildId);
        if ('error' in resolved) return { content: [{ type: "text", text: resolved.error }] };
        const guildId = resolved.id;
        switch (action) {
          case "timeout": {
            if (!userId || !durationMinutes) return { content: [{ type: "text", text: "userId and durationMinutes are required for 'timeout'" }] };
            const until = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
            const headers: Record<string, string> = {};
            if (reason) headers['X-Audit-Log-Reason'] = reason;
            const result = await discordRequest(this.env, `/guilds/${guildId}/members/${userId}`, {
              method: 'PATCH',
              body: JSON.stringify({ communication_disabled_until: until }),
              headers
            });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to timeout user: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `User ${userId} timed out for ${durationMinutes} minutes${reason ? ` (reason: ${reason})` : ''}` }] };
          }

          case "remove_timeout": {
            if (!userId) return { content: [{ type: "text", text: "userId is required for 'remove_timeout'" }] };
            const result = await discordRequest(this.env, `/guilds/${guildId}/members/${userId}`, {
              method: 'PATCH',
              body: JSON.stringify({ communication_disabled_until: null })
            });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to remove timeout: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Timeout removed for user ${userId}` }] };
          }

          case "assign_role": {
            if (!userId || !roleId) return { content: [{ type: "text", text: "userId and roleId are required for 'assign_role'" }] };
            const result = await discordRequest(this.env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'PUT' });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to assign role: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Role ${roleId} assigned to user ${userId}` }] };
          }

          case "remove_role": {
            if (!userId || !roleId) return { content: [{ type: "text", text: "userId and roleId are required for 'remove_role'" }] };
            const result = await discordRequest(this.env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' });
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to remove role: ${JSON.stringify(result)}` }] };
            }
            return { content: [{ type: "text", text: `Role ${roleId} removed from user ${userId}` }] };
          }

          case "ban_server": {
            const defaultStub = this.getDefaultStub();
            const resp = await defaultStub.fetch(new Request('http://internal/api/ban-server', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guild_id: guildId, reason }),
            }));
            const result = await resp.json() as any;
            if (result.error) {
              return { content: [{ type: "text", text: `Failed: ${result.error}` }] };
            }
            return { content: [{ type: "text", text: `Server ${guildId} banned${reason ? ` (reason: ${reason})` : ''}. Bot will auto-leave if re-invited.` }] };
          }

          case "unban_server": {
            const defaultStub = this.getDefaultStub();
            const resp = await defaultStub.fetch(new Request('http://internal/api/unban-server', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guild_id: guildId }),
            }));
            const result = await resp.json() as any;
            return { content: [{ type: "text", text: `Server ${guildId} unbanned.` }] };
          }
        }
      }
    );

    // ============ DISCORD MEMBERS (3 actions) ============

    entityTool(
      "discord_members",
      "Discord member and role operations. Actions: list (list server members), get_user (get user details), list_roles (list server roles).",
      {
        action: z.enum(["list", "get_user", "list_roles"]).describe("The action to perform"),
        guildId: z.string().optional().describe("The server/guild ID. If omitted and bot is in only one server, auto-selects it."),
        userId: z.string().optional().describe("(get_user) The user ID"),
        limit: z.number().optional().describe("(list) Max members to return (default 100)"),
      },
      async ({ action, guildId: rawGuildId, userId, limit }: any) => {
        const resolved = await resolveGuild(this.env, rawGuildId);
        if ('error' in resolved) return { content: [{ type: "text", text: resolved.error }] };
        const guildId = resolved.id;

        switch (action) {
          case "list": {
            const result = await discordRequest(this.env, `/guilds/${guildId}/members?limit=${limit || 100}`);
            if (result.error) {
              const hint = await getGuildListHint(this.env);
              return { content: [{ type: "text", text: `Failed to list members for guild ${guildId}.\n\nAvailable guilds:\n${hint}` }] };
            }
            const members = (result as any[]).map((m: any) => ({
              id: m.user?.id,
              username: m.user?.username,
              display_name: m.nick || m.user?.global_name || m.user?.username,
              roles: m.roles,
              joined_at: m.joined_at,
              bot: m.user?.bot || false,
            }));
            return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
          }

          case "get_user": {
            if (!userId) return { content: [{ type: "text", text: "userId is required for 'get_user'" }] };
            const result = await discordRequest(this.env, `/guilds/${guildId}/members/${userId}`);
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to get user info: ${JSON.stringify(result)}` }] };
            }
            const m = result as any;
            const info = {
              id: m.user?.id, username: m.user?.username, global_name: m.user?.global_name,
              nickname: m.nick,
              avatar: m.user?.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.webp` : null,
              roles: m.roles, joined_at: m.joined_at, premium_since: m.premium_since,
              bot: m.user?.bot || false, timed_out_until: m.communication_disabled_until,
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
          }

          case "list_roles": {
            const result = await discordRequest(this.env, `/guilds/${guildId}/roles`);
            if (result.error) {
              return { content: [{ type: "text", text: `Failed to list roles: ${JSON.stringify(result)}` }] };
            }
            const roles = (result as any[]).map((r: any) => ({
              id: r.id, name: r.name,
              color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
              position: r.position, mentionable: r.mentionable, member_count: r.member_count,
            })).sort((a: any, b: any) => b.position - a.position);
            return { content: [{ type: "text", text: JSON.stringify(roles, null, 2) }] };
          }
        }
      }
    );

    // ============ ENTITY PERMISSIONS (3 actions) ============

    this.server.tool(
      "entity_permissions",
      "Manage entity/companion server permissions and audit logs. Actions: get (view permissions), set (configure permissions), get_log (view action history).",
      {
        action: z.enum(["get", "set", "get_log"]).describe("The action to perform"),
        entity_id: z.string().describe("The companion/entity ID"),
        guild_id: z.string().optional().describe("(get/set) Specific guild ID. For 'get', omit to get all server configs."),
        allowed_channels: z.array(z.string()).nullable().optional().describe("(set) Channel whitelist (null = all)"),
        blocked_channels: z.array(z.string()).nullable().optional().describe("(set) Channel blocklist (overrides allowed)"),
        allowed_tools: z.array(z.string()).nullable().optional().describe("(set) Tool whitelist (null = all)"),
        watch_channels: z.array(z.string()).nullable().optional().describe("(set) Channels for cron trigger scoping"),
        active: z.boolean().optional().describe("(set) Whether entity is active in this server"),
        limit: z.number().optional().describe("(get_log) Max entries to return (default 50)"),
      },
      async ({ action, entity_id, guild_id, allowed_channels, blocked_channels, allowed_tools, watch_channels, active, limit }: any) => {
        const defaultStub = getDefaultStub();
        const targetEntityId = normalizeDiscordCompanionId(entity_id);

        switch (action) {
          case "get": {
            if (guild_id) {
              const res = await defaultStub.fetch(new Request(`https://internal/api/entity-servers/${targetEntityId}/${guild_id}`));
              const config = await res.json();
              return { content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }] };
            } else {
              const res = await defaultStub.fetch(new Request(`https://internal/api/entity-servers/${targetEntityId}`));
              const configs = await res.json();
              return { content: [{ type: "text" as const, text: JSON.stringify(configs, null, 2) }] };
            }
          }

          case "set": {
            if (!guild_id) return { content: [{ type: "text" as const, text: "guild_id is required for 'set'" }] };
            const res = await defaultStub.fetch(new Request(`https://internal/api/entity-servers/${targetEntityId}/${guild_id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allowed_channels, blocked_channels, allowed_tools, watch_channels, active }),
            }));
            const config = await res.json();
            return { content: [{ type: "text" as const, text: `Permissions updated for entity ${targetEntityId} in guild ${guild_id}:\n${JSON.stringify(config, null, 2)}` }] };
          }

          case "get_log": {
            const res = await defaultStub.fetch(new Request(`https://internal/api/entity-log/${targetEntityId}?limit=${limit || 50}`));
            const log = await res.json();
            return { content: [{ type: "text" as const, text: JSON.stringify(log, null, 2) }] };
          }
        }
        return { content: [{ type: "text" as const, text: `Unknown entity_permissions action: ${action}` }] };
      }
    );
  }
}

// ========== Main Worker ==========

export default {
  // Cron trigger: poll Discord channels for trigger words
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const id = env.COMPANION_BOT.idFromName('default');
    const stub = env.COMPANION_BOT.get(id);
    const res = await stub.fetch(new Request('https://internal/poll', { method: 'POST' }));
    const result = await res.json();
    console.log(`Cron poll result: ${JSON.stringify(result)}`);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'discord-companion-bot',
        version: '1.0.0',
        companions: Object.keys(SEED_COMPANIONS),
        features: ['mcp', 'sse', 'trigger', 'webhook-dispatch', 'cron-poll', 'dashboard'],
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Dashboard (admin)
    if (url.pathname === '/dashboard') {
      const baseUrl = url.origin;
      const clientId = env.DISCORD_CLIENT_ID || '';
      return new Response(renderDashboard(baseUrl, clientId), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // Register page (public)
    if (url.pathname === '/register') {
      const baseUrl = url.origin;
      const clientId = env.DISCORD_CLIENT_ID || '';
      return new Response(renderRegisterPage(baseUrl, clientId), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ===== OAuth2 flow =====

    if (url.pathname === '/auth/discord') {
      if (!env.DISCORD_CLIENT_ID) {
        return new Response('OAuth not configured', { status: 500 });
      }
      const redirectUri = `${url.origin}/auth/callback`;
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
      });
      const authUrl = `https://discord.com/api/oauth2/authorize?${params}`;

      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code || !env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
        return new Response(null, { status: 302, headers: { Location: '/dashboard?error=oauth_failed' } });
      }

      // Verify OAuth state parameter against cookie to prevent CSRF
      const stateParam = url.searchParams.get('state');
      const cookies = request.headers.get('Cookie') || '';
      const stateMatch = cookies.match(/(?:^|;\s*)oauth_state=([^;]+)/);
      const stateCookie = stateMatch ? stateMatch[1] : null;
      if (!stateParam || !stateCookie || stateParam !== stateCookie) {
        return new Response(JSON.stringify({ error: 'Invalid OAuth state — possible CSRF attack' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      try {
        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: `${url.origin}/auth/callback`,
          }),
        });
        if (!tokenRes.ok) {
          return new Response(null, { status: 302, headers: { Location: '/dashboard?error=token_exchange' } });
        }
        const tokenData = await tokenRes.json() as any;

        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (!userRes.ok) {
          return new Response(null, { status: 302, headers: { Location: '/dashboard?error=user_fetch' } });
        }
        const user = await userRes.json() as any;

        // Create session in DO
        const doId = env.COMPANION_BOT.idFromName('default');
        const stub = env.COMPANION_BOT.get(doId);
        const sessionRes = await stub.fetch(new Request('https://internal/auth/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            global_name: user.global_name,
          }),
        }));
        const { token } = await sessionRes.json() as any;

        // Redirect back to dashboard with session token (stored in localStorage by the page)
        return new Response(null, {
          status: 302,
          headers: { Location: `/dashboard?session=${token}` },
        });
      } catch (err: any) {
        return new Response(null, { status: 302, headers: { Location: `/dashboard?error=${encodeURIComponent(err.message)}` } });
      }
    }

    if (url.pathname === '/auth/me') {
      const doId = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(doId);
      const token = url.searchParams.get('token') || '';
      const adminId = env.ADMIN_DISCORD_ID || '';
      const doRes = await stub.fetch(new Request(`https://internal/auth/me?token=${token}&admin_id=${adminId}`));
      const res = new Response(doRes.body, doRes);
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const body = await request.json() as any;
      const doId = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(doId);
      await stub.fetch(new Request('https://internal/auth/delete-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: body.token }),
      }));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Trigger endpoint — Vessel posts here (direct DO routing, not MCP)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      const auth = request.headers.get('Authorization');
      if (!env.DASHBOARD_TOKEN || auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      return stub.fetch(request);
    }

    // Pending commands (REST — direct DO routing, not MCP)
    if (url.pathname === '/pending' && request.method === 'GET') {
      const auth = request.headers.get('Authorization');
      if (!env.DASHBOARD_TOKEN || auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      return stub.fetch(request);
    }

    // Manual poll trigger for deployment verification. Cron uses the same DO route.
    if (url.pathname === '/poll' && request.method === 'POST') {
      const auth = request.headers.get('Authorization');
      if (!env.DASHBOARD_TOKEN || auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      return stub.fetch(new Request('https://internal/poll', { method: 'POST' }));
    }

    // Monitor management/debug surface — GET is readable, writes use dashboard token.
    if (url.pathname === '/monitors' || url.pathname.startsWith('/monitors/') || url.pathname === '/clear-pending') {
      if (request.method !== 'GET') {
        const auth = request.headers.get('Authorization');
        if (!env.DASHBOARD_TOKEN || auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      const doRes = await stub.fetch(new Request(`https://internal${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' ? request.body : undefined,
      }));
      const res = new Response(doRes.body, doRes);
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Avatar upload — proxy to default DO
    if (url.pathname === '/upload-avatar' && request.method === 'POST') {
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      const doRes = await stub.fetch(new Request(`https://internal/upload-avatar`, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      }));
      const res = new Response(doRes.body, doRes);
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Avatar serve — proxy to default DO
    if (url.pathname.startsWith('/avatars/')) {
      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      return stub.fetch(new Request(`https://internal${url.pathname}`, { method: 'GET' }));
    }

    // API routes — proxy to default DO
    if (url.pathname.startsWith('/api/')) {
      // Auth check for write operations
      let sessionDiscordId: string | null = null;
      let isAdminAuth = false;

      if (request.method !== 'GET') {
        let authorized = false;

        // Check Bearer token (DASHBOARD_TOKEN or MCP/API callers)
        const auth = request.headers.get('Authorization');
        if (env.DASHBOARD_TOKEN && auth === `Bearer ${env.DASHBOARD_TOKEN}`) {
          authorized = true;
          isAdminAuth = true;
        }

        // Check Discord session token
        if (!authorized) {
          const sessionToken = request.headers.get('X-Session-Token');
          if (sessionToken) {
            const doId = env.COMPANION_BOT.idFromName('default');
            const stub = env.COMPANION_BOT.get(doId);
            const valRes = await stub.fetch(new Request('https://internal/auth/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: sessionToken }),
            }));
            const { valid, discord_id } = await valRes.json() as any;
            if (valid) {
              authorized = true;
              sessionDiscordId = discord_id;
            }
          }
        }

        // If no auth method is configured, allow open access (backward-compatible)
        if (!authorized && (env.DASHBOARD_TOKEN || env.DISCORD_CLIENT_ID)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      // Ownership check for PUT/DELETE on /api/companions/:id
      const companionRouteMatch = url.pathname.match(/^\/api\/companions\/([^/]+)$/);
      if (companionRouteMatch && companionRouteMatch[1] !== 'mine' && (request.method === 'PUT' || request.method === 'DELETE')) {
        // Admin (DASHBOARD_TOKEN bearer) bypasses ownership check
        if (!isAdminAuth) {
          const isAdmin = sessionDiscordId && env.ADMIN_DISCORD_ID && sessionDiscordId === env.ADMIN_DISCORD_ID;
          if (!isAdmin) {
            // Fetch the companion to check ownership
            const doId = env.COMPANION_BOT.idFromName('default');
            const stub = env.COMPANION_BOT.get(doId);
            const compRes = await stub.fetch(new Request(`https://internal/api/companions/${companionRouteMatch[1]}`));
            const companion = await compRes.json() as any;
            if (companion.error) {
              return new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
            if (!sessionDiscordId || companion.owner_id !== sessionDiscordId) {
              return new Response(JSON.stringify({ error: 'Forbidden — you do not own this companion' }), {
                status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }
        }
      }

      const id = env.COMPANION_BOT.idFromName('default');
      const stub = env.COMPANION_BOT.get(id);
      const doRes = await stub.fetch(new Request(`https://internal${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' ? request.body : undefined,
      }));
      // Add CORS headers to the response
      const res = new Response(doRes.body, doRes);
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // SSE endpoint
    if (url.pathname === '/sse' || url.pathname === '/sse/message') {
      return CompanionBot.serveSSE('/sse', { binding: 'COMPANION_BOT' }).fetch(request, env, ctx);
    }

    // MCP HTTP endpoint
    if (url.pathname === '/mcp') {
      // Antigravity compatibility: accept notifications without session ID
      if (request.method === 'POST' && !request.headers.get('mcp-session-id')) {
        try {
          const clone = request.clone();
          const body = await clone.json() as any;
          const messages = Array.isArray(body) ? body : [body];
          if (messages.every((m: any) => !('id' in m))) {
            return new Response(null, { status: 202 });
          }
        } catch (_) { /* fall through */ }
      }
      return CompanionBot.serve('/mcp', { binding: 'COMPANION_BOT' }).fetch(request, env, ctx);
    }

    return new Response(JSON.stringify({
      service: 'Discord Companion Bot',
      endpoints: {
        health: 'GET /',
        dashboard: 'GET /dashboard',
        register: 'GET /register',
        api: 'GET /api/companions',
        trigger: 'POST /trigger',
        pending: 'GET /pending',
        auth: 'GET /auth/discord',
        mcp: '/mcp',
        sse: '/sse',
      },
      companions: Object.values(SEED_COMPANIONS).map(c => `${c.name} (${c.triggers.join(', ')})`),
    }, null, 2), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
