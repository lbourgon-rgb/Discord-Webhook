import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findTriggeredCompanion } from '../src/companions.ts';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('Discord response modes include community greeting without loosening ordinary ambient chatter', () => {
  assert.match(source, /type DiscordResponseMode = 'never' \| 'mention' \| 'urgent' \| 'filtered' \| 'open' \| 'community_greeting'/);
  assert.match(source, /function isCommunityGreeting\(content: string\)/);
  assert.match(source, /function allowsCommunityGreeting\(monitor: DiscordMonitor\)/);
  assert.match(source, /communityGreeting && allowsCommunityGreeting\(input\.monitor\) && !otherUserTag/);
  assert.match(source, /non-vel-public-community-greeting/);
  assert.match(source, /otherUserTag \? 'other-user-tag-not-kai' : 'ambient-message'/);
});

test('Kai soft-name mentions bypass monitor cooldowns', () => {
  assert.match(source, /const cooldownBypass = engagement\.hard_mention \|\| engagement\.soft_name_mention \|\| engagement\.direct_reply_to_kai \|\| engagement\.active_conversation/);
});

test('Kai Discord responses block non-canonical body drift before posting', () => {
  assert.match(source, /function kaiIdentityDriftReason\(content: string\): string \| null/);
  assert.match(source, /non-canonical Kai body\/creature claim/);
  assert.match(source, /type: 'identity_drift_blocked'/);
  assert.match(source, /Rewrite without wings, tails, animal ears, purring, horns, fangs, claws, or creature-body claims/);
});

test('Discord identity classification keeps Kai mention ids separate from Vel author ids', () => {
  assert.match(source, /function getKaiDiscordMentionIds\(env: Env\): string\[\]/);
  assert.match(source, /function getVelDiscordUserIds\(env: Env\): string\[\]/);
  assert.match(source, /const authorClass: 'vel' \| 'unknown' = input\.authorId && velIds\.includes\(input\.authorId\) \? 'vel' : 'unknown'/);
  assert.match(source, /const directReplyToKai = !!input\.referencedAuthorId && kaiIds\.includes\(input\.referencedAuthorId\)/);
  assert.match(source, /function mentionsNonKaiUser\(content: string, env: Env, mentionIds: string\[\] = \[\]\): boolean/);
  assert.match(source, /other_user_tag: otherUserTag/);
});

test('Discord Continuity logging preserves author id and engagement debug metadata', () => {
  assert.match(source, /author: \{ id: debug\?\.authorId \|\| undefined, name:/);
  assert.match(source, /author_id, engagement, message_id, webhook_url/);
  assert.match(source, /created_at: debug\?\.createdAt/);
  assert.match(source, /mention_ids: debug\?\.mentionIds \|\| \[\]/);
  assert.match(source, /referenced_author_id: debug\?\.referencedAuthorId \|\| null/);
  assert.match(source, /activity_type: type/);
  assert.match(source, /pre_response_required: type === 'triggered' \|\| type === 'queued'/);
});

test("Mor'zar Discord identity is seeded with bot id and scoped triggers", () => {
  const companionsSource = readFileSync(new URL('../src/companions.ts', import.meta.url), 'utf8');
  assert.match(companionsSource, /morzar: \{/);
  assert.match(companionsSource, /id: 'morzar'/);
  assert.match(companionsSource, /triggers: \['mor', 'morzar', "mor'zar", 'mor-zar'\]/);
  assert.match(companionsSource, /bot_user_ids: \['1463578634483793920'\]/);
});

test('Lucien Discord identity is seeded without invented bot id and scoped aliases', () => {
  const companionsSource = readFileSync(new URL('../src/companions.ts', import.meta.url), 'utf8');
  assert.match(companionsSource, /lucien: \{/);
  assert.match(companionsSource, /id: 'lucien'/);
  assert.match(companionsSource, /triggers: \['lucien', 'lucian', 'tessurae'\]/);
  assert.match(companionsSource, /bot_user_ids: \[\]/);
  assert.match(source, /raw === 'lucian' \|\| raw === 'tessurae'\) return 'lucien'/);
});

test('Axiom Discord identity is seeded with bot id and scoped trigger', () => {
  const companionsSource = readFileSync(new URL('../src/companions.ts', import.meta.url), 'utf8');
  assert.match(companionsSource, /axiom: \{/);
  assert.match(companionsSource, /id: 'axiom'/);
  assert.match(companionsSource, /triggers: \['axiom', 'codex'\]/);
  assert.match(companionsSource, /bot_user_ids: \['1515127400491647076'\]/);
  assert.match(source, /AXIOM_DISCORD_USER_IDS\?: string/);
  assert.match(source, /raw === 'codex'\) return 'axiom'/);
  assert.match(source, /splitIds\(env\.AXIOM_DISCORD_USER_IDS \|\| '1515127400491647076'\)/);
});

test('Keth-Grok Discord identity is seeded without invented bot id and scoped aliases', () => {
  const companionsSource = readFileSync(new URL('../src/companions.ts', import.meta.url), 'utf8');
  assert.match(companionsSource, /'grok-keth': \{/);
  assert.match(companionsSource, /id: 'grok-keth'/);
  assert.match(companionsSource, /name: 'Keth-Grok'/);
  assert.match(companionsSource, /triggers: \['grok', 'keth-grok', 'grok-keth', 'averel', "a'verel"\]/);
  assert.match(companionsSource, /bot_user_ids: \[\]/);
  assert.match(source, /GROK_KETH_DISCORD_USER_IDS\?: string/);
  assert.match(source, /raw === 'grok' \|\| raw === 'keth-grok' \|\| raw === 'kethgrok' \|\| raw === 'averel'/);
  assert.match(source, /splitIds\(env\.GROK_KETH_DISCORD_USER_IDS \|\| ''\)/);
});

test('Codex soft-name mention wakes Axiom', () => {
  const triggered = findTriggeredCompanion('codex, can you check this?');
  assert.deepEqual(triggered.map(companion => companion.id), ['axiom']);
});

test('Keth-Grok soft-name aliases wake only Keth-Grok', () => {
  for (const alias of ['grok', 'keth-grok', 'grok-keth', 'averel', "a'verel"]) {
    const triggered = findTriggeredCompanion(`${alias}, can you check this?`);
    assert.deepEqual(triggered.map(companion => companion.id), ['grok-keth']);
  }
});

test('Lucien aliases wake Lucien', () => {
  for (const alias of ['lucien', 'lucian', 'tessurae']) {
    const triggered = findTriggeredCompanion(`${alias}, can you check this?`);
    assert.deepEqual(triggered.map(companion => companion.id), ['lucien']);
  }
});

test("Mor'zar mentions join the companion-aware wake predicate without merging into Kai", () => {
  assert.match(source, /MORZAR_DISCORD_USER_IDS\?: string/);
  assert.match(source, /function getCompanionDiscordMentionIds\(env: Env, companion: string \| Companion\): string\[\]/);
  assert.match(source, /splitIds\(env\.MORZAR_DISCORD_USER_IDS \|\| '1463578634483793920'\)/);
  assert.match(source, /function containsHardCompanionMention\(content: string, companion: string \| Companion, env: Env, mentionIds: string\[\] = \[\]\): boolean/);
  assert.match(source, /function containsSoftCompanionName\(content: string, companion: Companion\): boolean/);
  assert.match(source, /findMentionedCompanionDynamic\(content: string, mentionIds: string\[\] = \[\]\)/);
  assert.match(source, /if \(!triggered\.some\(existing => existing\.id === companion\.id\)\) triggered\.push\(companion\)/);
});

test('Axiom mentions join the companion-aware wake predicate without merging into Kai', () => {
  assert.match(source, /AXIOM_DISCORD_USER_IDS\?: string/);
  assert.match(source, /if \(companionId === 'axiom'\) configured = splitIds\(env\.AXIOM_DISCORD_USER_IDS \|\| '1515127400491647076'\)/);
  assert.match(source, /const hardCompanionMention = containsHardCompanionMention\(msg\.content, companion, this\.env, mentionIds\)/);
  assert.match(source, /normalizeDiscordCompanionId\(companion\.id\) !== 'kai'/);
  assert.match(source, /engagement\.trigger_reason = hardCompanionMention[\s\S]+: 'companion-name-mention'/);
});

test('Lucien uses ChatGPT runner hooks and stays out of Kai Haven runner', () => {
  assert.match(source, /LUCIEN_CHATGPT_RUNNER_ENABLED\?: string/);
  assert.match(source, /LUCIEN_CHATGPT_AUTORESPOND\?: string/);
  assert.match(source, /LUCIEN_CHATGPT_DELIVERY_ENABLED\?: string/);
  assert.match(source, /runLucienChatGPTRunnerFromDashboard/);
  assert.match(source, /triggerLucienWorkspaceAgent/);
  assert.match(source, /const runnerId = 'chatgpt-workspace-agent:lucien'/);
  assert.match(source, /lucien_discord_reply/);
  assert.match(source, /run_with_lucien_chatgpt/);
  assert.match(source, /run_with_haven is Kai-only in this rollout/);
  assert.match(source, /run_with_lucien_chatgpt is Lucien-only/);
});

test('Lucien Discord reply tool covers delivery guardrails', () => {
  assert.match(source, /completeLucienDiscordReply/);
  assert.match(source, /mode: 'dry_run_preview'/);
  assert.match(source, /mode: 'delivery_disabled'/);
  assert.match(source, /lucien_discord_reply can only complete Lucien requests/);
  assert.match(source, /wake_candidate_id is required/);
  assert.match(source, /Channel is restricted - admin exception required for lucien/);
  assert.match(source, /Webhook failed on Lucien reply chunk/);
  assert.match(source, /this\.deleteCommand\(args\.requestId\)/);
  assert.match(source, /No pending command with ID/);
});

test("Mor'zar queued Discord activity remains companion_id=morzar for Continuity wake creation", () => {
  assert.match(source, /engagement\.trigger_reason = hardCompanionMention[\s\S]+: 'companion-name-mention'/);
  assert.match(source, /this\.logActivity\(companion\.id, 'queued'/);
  assert.match(source, /companion_id: normalizeCompanionId\(event\.companion_id\)/);
  assert.match(source, /pre_response_required: event\.pre_response_required === true/);
});

test('Manual trigger engagement includes the same debug shape as live poll decisions', () => {
  assert.match(source, /engagement: \{[\s\S]+hard_mention: hardKaiMention/);
  assert.match(source, /soft_name_mention: softKaiMention/);
  assert.match(source, /author_class: authorIsVel \? 'vel' : 'unknown'/);
  assert.match(source, /community_greeting: isCommunityGreeting\(body\.content\)/);
});

test('Kai Haven runner stays guarded behind explicit flags and wake leases', () => {
  assert.match(source, /HAVEN_RUNNER_API_KEY\?: string/);
  assert.match(source, /KAI_HAVEN_RUNNER_ENABLED\?: string/);
  assert.match(source, /KAI_HAVEN_RUNNER_DELIVERY_ENABLED\?: string/);
  assert.match(source, /action: z\.enum\(\["get", "respond", "dismiss", "run_with_haven", "run_with_lucien_chatgpt"\]\)/);
  assert.match(source, /createAndClaimWakeForCommand\(this\.env, command, activeRunnerId\)/);
  assert.match(source, /findContinuityEventForCommand\(env, command\)/);
  assert.match(source, /UNIQUE constraint failed/);
  assert.match(source, /callHavenKaiRunnerWithFallback\(this\.env/);
  assert.match(source, /KAI_HAVEN_RUNNER_FALLBACK_MODELS/);
  assert.match(source, /currently at capacity\|overloaded\|rate limit\|temporarily unavailable\|returned no choices\|timed out/);
  assert.match(source, /wake_context: claimData\.wake_context/);
  assert.match(source, /dry_run: true/);
  assert.match(source, /KAI_HAVEN_RUNNER_DELIVERY_ENABLED !== 'true'/);
  assert.match(source, /delivery_path: 'discord-continuity-tahl-haven-serythrae-discord'/);
  assert.match(source, /runner_origin: origin/);
  assert.match(source, /tahl_state_present: Boolean\(claimData\.wake_context\?\.tahl_state/g);
  assert.doesNotMatch(source, /skipContinuity: true/);
  assert.match(source, /timestamp: Date\.parse\(msg\.timestamp\) \|\| Date\.now\(\)/);
  assert.match(source, /\/wake-candidates\/\$\{encodeURIComponent\(String\(claimData\.wake_candidate\.id\)\)\}\/response/);
});

test('Kai bypasses legacy Kairos trigger path and legacy send tools', () => {
  assert.match(source, /KAI_HAVEN_RUNNER_AUTORESPOND\?: string/);
  assert.match(source, /direct-haven-hard-mention/);
  assert.match(source, /runHavenRunnerFromDashboard\(command\.id, true, 'autorespond'\)/);
  assert.match(source, /Cron: skipped legacy Kai path/);
  assert.match(source, /Legacy pending_commands respond is disabled for Kai/);
  assert.match(source, /Legacy companion send is disabled for Kai/);
});
