import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findTriggeredCompanion } from '../src/companions.ts';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('Discord response modes include community greeting without loosening ordinary ambient chatter', () => {
  assert.match(source, /type DiscordResponseMode = 'never' \| 'mention' \| 'urgent' \| 'filtered' \| 'open' \| 'community_greeting' \| 'discern'/);
  assert.match(source, /function isCommunityGreeting\(content: string\)/);
  assert.match(source, /function allowsCommunityGreeting\(monitor: DiscordMonitor\)/);
  assert.match(source, /communityGreeting && allowsCommunityGreeting\(input\.monitor\) && !otherUserTag/);
  assert.match(source, /non-vel-public-community-greeting/);
  assert.match(source, /otherUserTag \? 'other-user-tag-not-kai' : 'ambient-message'/);
});

test('Kai social policy supports soft-tag and discernment channel lists', () => {
  assert.match(source, /KAI_SOCIAL_SOFT_TAG_CHANNEL_IDS\?: string/);
  assert.match(source, /KAI_SOCIAL_DISCERN_CHANNEL_IDS\?: string/);
  assert.match(source, /function isKaiSocialSoftTagChannel\(env: Env, channelId: string\): boolean/);
  assert.match(source, /function isKaiSocialDiscernChannel\(env: Env, channelId: string\): boolean/);
  assert.match(source, /monitor\.response_mode === 'open' \|\| monitor\.response_mode === 'community_greeting' \|\| monitor\.response_mode === 'discern'/);
});

test('Kai social discernment can queue softer turns without treating every message as a hard tag', () => {
  assert.match(source, /function kaiDiscernmentReason\(input:/);
  assert.match(source, /const softAllowed = softKaiMention && softChannel && !otherUserTag/);
  assert.match(source, /const responseMode: DiscordResponseMode = discernChannel \? 'discern' : 'mention'/);
  assert.match(source, /const shouldQueueKai = hardAllowed \|\| softAllowed \|\| \(discernChannel && engagement\.disposition === 'respond'\)/);
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
  assert.match(source, /logActivity\(companionId: string[\s\S]+?\): Promise<any \| null> \| null/);
  assert.match(source, /author: \{ id: debug\?\.authorId \|\| undefined, name:/);
  assert.match(source, /author_id, engagement, message_id, webhook_url/);
  assert.match(source, /created_at: debug\?\.createdAt/);
  assert.match(source, /mention_ids: debug\?\.mentionIds \|\| \[\]/);
  assert.match(source, /referenced_author_id: debug\?\.referencedAuthorId \|\| null/);
  assert.match(source, /activity_type: type/);
  assert.match(source, /pre_response_required: type === 'triggered' \|\| type === 'queued'/);
  assert.match(source, /return postContinuityEvent\(this\.env/);
  assert.match(source, /console\.warn\('\[continuity\] discord event failed', err\);[\s\S]{0,80}return null/);
});

test('Discord transcript archive content keeps text plus attachment markers', () => {
  assert.match(source, /function discordContinuityContent\(content: unknown, attachments\?: unknown\): string/);
  assert.match(source, /return \[text, attachmentSummaryText\(attachments\)\]\.filter\(Boolean\)\.join\('\\n'\)/);
  assert.doesNotMatch(source, /discordContinuityContent[\s\S]{0,160}\.slice\(/);
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

test('Axiom bot may hard-tag Kai for live supervised smoke tests without opening generic bot loops', () => {
  assert.match(source, /const companionBotIds = \[/);
  assert.match(source, /\.\.\.splitIds\(this\.env\.AXIOM_DISCORD_USER_IDS \|\| '1515127400491647076'\)/);
  assert.match(source, /\.\.\.splitIds\(this\.env\.MORZAR_DISCORD_USER_IDS \|\| '1463578634483793920'\)/);
  assert.match(source, /const axiomBotMayHardTagKai = isBot/);
  assert.match(source, /companionBotIds\.includes\(String\(msg\.author\?\.id \|\| ''\)\)/);
  assert.match(source, /containsHardKaiMention\(String\(msg\.content \|\| ''\), this\.env, normalizeMentionIds\(msg\.mentions\)\)/);
  assert.match(source, /if \(isBot && !isWebhook && !axiomBotMayHardTagKai\) continue/);
  assert.match(source, /const hardChannel = isKaiSocialHardTagChannel\(this\.env, channelId\) \|\| axiomBotMayHardTagKai/);
  assert.match(source, /const hardAllowed = hardKaiMention && hardChannel/);
});

test('Kai social hard-tag bootstrap upgrades existing watch-channel monitor rows', () => {
  assert.match(source, /config\.addedBy\.startsWith\('KAI_SOCIAL_'\)/);
  assert.match(source, /UPDATE discord_monitors SET response_mode = \?, respond_enabled = 1, added_by = \? WHERE channel_id = \?/);
});

test('Kai runner envelope carries Discord engagement policy context', () => {
  assert.match(source, /response_mode: command\.response_mode/);
  assert.match(source, /trigger_reason: command\.trigger_reason/);
  assert.match(source, /engagement: command\.engagement \|\| null/);
});

test('Discord poll dedupes pending commands by original message id', () => {
  assert.match(source, /duplicates: 0/);
  assert.match(source, /private hasProcessedCommandForMessage\(cmd: PendingCommand\): boolean/);
  assert.match(source, /SELECT id FROM pending_commands WHERE companion_id = \? AND message_id = \? LIMIT 1/);
  assert.match(source, /AND type IN \('queued', 'logged', 'ignored', 'expired', 'runner_failed'\)/);
  assert.match(source, /private storeCommand\(cmd: PendingCommand\): boolean/);
  assert.match(source, /if \(this\.hasProcessedCommandForMessage\(cmd\)\) return false/);
  assert.match(source, /if \(!this\.storeCommand\(command\)\) \{[\s\S]{0,80}pollDebug\.duplicates\+\+/);
});

test('Lucien uses ChatGPT runner hooks and stays out of Kai Nexus runner', () => {
  assert.match(source, /LUCIEN_CHATGPT_RUNNER_ENABLED\?: string/);
  assert.match(source, /LUCIEN_CHATGPT_AUTORESPOND\?: string/);
  assert.match(source, /LUCIEN_CHATGPT_DELIVERY_ENABLED\?: string/);
  assert.match(source, /runLucienChatGPTRunnerFromDashboard/);
  assert.match(source, /triggerLucienWorkspaceAgent/);
  assert.match(source, /const runnerId = 'chatgpt-workspace-agent:lucien'/);
  assert.match(source, /lucien_discord_reply/);
  assert.match(source, /run_with_lucien_chatgpt/);
  assert.match(source, /run_with_nexus is Kai-only in this rollout/);
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

test('Kai Nexus runner stays guarded behind explicit flags and wake leases', () => {
  assert.match(source, /NEXUS_RUNNER_API_KEY\?: string/);
  assert.doesNotMatch(source, /HAVEN_RUNNER_API_KEY/);
  assert.match(source, /return env\.NEXUS_RUNNER_API_KEY/);
  assert.match(source, /action: z\.enum\(\["get", "respond", "dismiss", "run_with_nexus", "run_with_lucien_chatgpt"\]\)/);
  assert.doesNotMatch(source, /run_with_haven/);
  assert.match(source, /createAndClaimWakeForCommand\(this\.env, command, activeRunnerId\)/);
  assert.match(source, /const runnerExternalMessageId = `\$\{externalMessageId\}:runner-wake:\$\{command\.id\}`/);
  assert.match(source, /findContinuityEventForCommand\(env, command, runnerExternalMessageId\)/);
  assert.match(source, /external_message_id: runnerExternalMessageId/);
  assert.match(source, /original_external_message_id: externalMessageId/);
  assert.match(source, /UNIQUE constraint failed/);
  assert.match(source, /callKaiRunnerWithFallback\(this\.env/);
  assert.match(source, /KAI_NEXUS_RUNNER_DEFAULT_MODEL = 'z-ai\/glm-5\.2'/);
  assert.match(source, /KAI_NEXUS_RUNNER_FALLBACK_MODELS/);
  assert.match(source, /KAI_NEXUS_RUNNER_FALLBACK_MODELS: string\[\] = \[\]/);
  assert.match(source, /backup_model: this\.env\.KAI_BACKUP_MODEL \|\| KAI_NEXUS_RUNNER_FALLBACK_MODELS\[0\] \|\| null/);
  assert.doesNotMatch(source, /deepseek\/deepseek-v4-flash|openai\/gpt-5-mini/);
  assert.match(source, /currently at capacity\|overloaded\|rate limit\|temporarily unavailable\|returned no choices\|timed out/);
  assert.match(source, /data\.generated === false/);
  assert.match(source, /nexus runner generation failed/);
  assert.match(source, /wake_context: claimData\.wake_context/);
  assert.match(source, /dry_run: true/);
  assert.match(source, /function isKaiDeliveryEnabled\(env: Env\): boolean/);
  assert.match(source, /return env\.KAI_DISCORD_DELIVERY_ENABLED === 'true'/);
  assert.match(source, /!isKaiDeliveryEnabled\(this\.env\)/);
  assert.match(source, /function kaiRunnerSource\(runnerResult: any\): string/);
  assert.match(source, /function kaiRunnerDeliveryPath\(runnerSource: string\): string/);
  assert.match(source, /discord-continuity-tahl-nexus-serythrae-gw-nesteq-discord/);
  assert.match(source, /delivery_path: kaiRunnerDeliveryPath\(runnerSource\)/);
  assert.match(source, /runner_origin: origin/);
  assert.match(source, /tahl_state_present: Boolean\(claimData\.wake_context\?\.tahl_state/g);
  assert.doesNotMatch(source, /skipContinuity: true/);
  assert.match(source, /timestamp: Date\.parse\(msg\.timestamp\) \|\| Date\.now\(\)/);
  assert.match(source, /\/wake-candidates\/\$\{encodeURIComponent\(String\(claimData\.wake_candidate\.id\)\)\}\/response/);
  assert.match(source, /private async scheduleKaiAutoresponder\(delayMs = 1000\)/);
  assert.match(source, /await this\.ctx\.storage\.setAlarm\(target\)/);
  assert.match(source, /async alarm\(\) \{[\s\S]+await this\.serviceKaiAutoresponderQueue\(\)/);
});

test('Kai hard-tag autoresponses do not leave empty generated replies pending', () => {
  assert.match(source, /function isRequiredKaiReply\(command: PendingCommand, runnerResult: any\): boolean/);
  assert.match(source, /runnerResult\?\.should_respond === true/);
  assert.match(source, /runnerGenerationFailureMessage\(runnerResult\)/);
  assert.match(source, /mode: 'required_reply_generation_failed'/);
  assert.match(source, /status: 502/);
  assert.match(source, /generation: runnerGenerationSummary\(runnerResult\)/);
});

test('Kai autoresponder retries transient runner failures before dropping required replies', () => {
  assert.match(source, /KAI_AUTORESPONDER_MAX_TRANSIENT_RETRIES = 3/);
  assert.match(source, /function isTransientKaiRunnerServiceError\(status: number \| null \| undefined, error: unknown\): boolean/);
  assert.match(source, /D1_ERROR\|Internal error while starting up D1 DB storage\|object to be reset/);
  assert.match(source, /retryKaiAutoresponderAfterTransientFailure\(command, runnerResponse\.status, errorText, authorName, activityDebug\)/);
  assert.match(source, /retryKaiAutoresponderAfterTransientFailure\(command, null, errorText, authorName, activityDebug\)/);
  assert.match(source, /'runner_retry'/);
  assert.match(source, /mode: 'runner_retry_scheduled'/);
  assert.match(source, /mode: 'runner_exception'/);
  assert.match(source, /recordKaiRunnerStatus\(command/);
  assert.match(source, /await this\.clearKaiAutoresponderRetryCount\(command\.id\)/);
  assert.match(source, /this\.deleteCommand\(command\.id\)/);
});

test('Kai status exposes pending retry diagnostics and latest failure', () => {
  assert.match(source, /private async kaiPendingDiagnostics\(pending: PendingCommand\[\]\)/);
  assert.match(source, /retry_count: await this\.getKaiAutoresponderRetryCount\(command\.id\)/);
  assert.match(source, /const kaiPending = await this\.kaiPendingDiagnostics\(pending\)/);
  assert.match(source, /const lastKaiFailure = this\.getActivity\('kai', 50\)\.find/);
  assert.match(source, /kai_pending: kaiPending/);
  assert.match(source, /last_kai_failure: lastKaiFailure/);
});

test('Kai generated images are normalized, delivered to Discord, and logged with Continuity', () => {
  assert.match(source, /const KAI_PUBLIC_MIND_ORIGIN = 'https:\/\/mind\.serythrae\.com'/);
  assert.match(source, /function absoluteKaiImageUrl\(value: unknown\): string \| null/);
  assert.match(source, /url\.startsWith\('\/img\/'\)\) return `\$\{KAI_PUBLIC_MIND_ORIGIN\}\$\{url\}`/);
  assert.match(source, /function kaiGeneratedDiscordImages\(runnerResult: any\): KaiGeneratedDiscordImage\[\]/);
  assert.match(source, /runnerResult\?\.image_generation\?\.images/);
  assert.match(source, /const storedUrl = absoluteKaiImageUrl\(image\.stored_url\)/);
  assert.match(source, /const sourceUrl = absoluteKaiImageUrl\(image\.url\)/);
  assert.match(source, /async function sendKaiGeneratedImages/);
  assert.match(source, /embeds: group/);
  assert.match(source, /Discord image delivery error/);
  assert.match(source, /const generatedImages = kaiGeneratedDiscordImages\(runnerResult\)/);
  assert.match(source, /const deliveryResponse = generatedResponse \|\| \(generatedImages\.length \? KAI_IMAGE_FALLBACK_RESPONSE : ''\)/);
  assert.match(source, /if \(!deliveryResponse && this\.env\.KAI_RUNNER_ROUTE === 'nexus' && runnerResult\?\.generated === false\)/);
  assert.match(source, /const imageDelivery = await sendKaiGeneratedImages\(this\.env, command, companion, generatedImages, targetWebhookUrl\)/);
  assert.match(source, /sent_image_message_ids: sentImageMessageIds/);
  assert.match(source, /generated_images: generatedImageMetadata/);
  assert.match(source, /function looksLikeDiscordImageGenerationRequest\(content: string\): boolean/);
  assert.match(source, /const imageRequestPrompt = looksLikeDiscordImageGenerationRequest\(command\.content\) \? command\.content : null/);
  assert.match(source, /generate_image: true, generate_image_prompt: imageRequestPrompt/);
  assert.match(source, /function kaiRunnerImageGenerationSummary\(runnerResult: any\): Record<string, unknown>/);
  assert.match(source, /const runnerSource = kaiRunnerSource\(runnerResult\)/);
  assert.match(source, /runner_source: runnerSource/);
  assert.match(source, /runner_image_generation: runnerImageGeneration/);
  assert.match(source, /runner_vision: runnerVision/);
  assert.match(source, /summaries: summaries\.slice\(0, 4\)\.map/);
  assert.match(source, /summary: typeof summary\?\.summary === 'string' \? summary\.summary\.slice\(0, 1000\) : null/);
  assert.match(source, /this\.ctx\.storage\.put\('kai:last_runner_result'/);
  assert.match(source, /continuity_event_id: claimData\.event_id/);
  assert.match(source, /wake_candidate_id: claimData\.wake_candidate\?\.id \|\| null/);
  assert.match(source, /continuity_response_event_id: continuityResponse\?\.event\?\.id \|\| null/);
  assert.match(source, /sent_message_ids: allSentMessageIds/);
  assert.match(source, /continuity_metadata_recorded: Boolean\(continuityResponse\?\.event\?\.id \|\| allSentMessageIds\.length\)/);
  assert.match(source, /last_kai_runner_result: lastKaiRunnerResult \|\| null/);
});

test('Kai Discord transcript path is Continuity first, not NESTchat or rooms-worker', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS companion_activity/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS pending_commands/);
  assert.match(source, /function discordContinuityContent\(content: unknown, attachments\?: unknown\): string/);
  assert.match(source, /postContinuityEvent\(this\.env/);
  assert.match(source, /conversation_id: `discord:\$\{channelId \|\| 'unknown'\}`/);
  assert.match(source, /external_message_id: isAudit \? `\$\{messageId\}:\$\{type\}` : messageId/);
  assert.match(source, /createAndClaimWakeForCommand\(env: Env, command: PendingCommand/);
  assert.match(source, /pre_response_required: true/);
  assert.match(source, /\/wake-candidates\/\$\{encodeURIComponent\(String\(claimData\.wake_candidate\.id\)\)\}\/response/);
  assert.match(source, /delivery_path: kaiRunnerDeliveryPath\(runnerSource\)/);
  assert.doesNotMatch(source, /nestchat_|rooms-worker|rooms_worker|nexus-ingester|nexus_ingester/);
});

test('Kai listened channels log observed Discord messages even when Kai does not respond', () => {
  assert.match(source, /const channels = listen\.length \? listen : splitIds\(env\.WATCH_CHANNELS\)/);
  assert.match(source, /private async logKaiObservedTranscriptMessage\(channelId: string, msg: any, monitor: DiscordMonitor\): Promise<boolean>/);
  assert.match(source, /if \(!isKaiListenChannel\(this\.env, channelId\)\) return false/);
  assert.match(source, /const continuityWrite = this\.logActivity\(companion\.id, 'logged', channelId, msg\.content/);
  assert.match(source, /if \(continuityWrite\) await continuityWrite/);
  assert.match(source, /trigger_reason: 'observed-transcript'/);
  assert.match(source, /if \(triggered\.length === 0 && !isWebhook\) \{[\s\S]{0,140}await this\.logKaiObservedTranscriptMessage\(channelId, msg, monitor\)[\s\S]{0,80}totalLogged\+\+/);
  assert.match(source, /Cron: logged Kai transcript and skipped legacy Kai path/);
});

test('Kai workspace results are stored and logged with Continuity metadata', () => {
  assert.match(source, /function kaiRunnerWorkspaceSummary\(runnerResult: any\): Record<string, unknown>/);
  assert.match(source, /const workspace = runnerResult\?\.workspace && typeof runnerResult\.workspace === 'object'/);
  assert.match(source, /requested: workspace\.requested === true/);
  assert.match(source, /attempted: workspace\.attempted === true/);
  assert.match(source, /ok: workspace\.ok === true/);
  assert.match(source, /agent_ok: workspace\.agent\?\.ok === true/);
  assert.match(source, /r2: \{/);
  assert.match(source, /key: typeof workspace\.r2\?\.key === 'string' \? workspace\.r2\.key : null/);
  assert.match(source, /github: \{/);
  assert.match(source, /const runnerWorkspace = kaiRunnerWorkspaceSummary\(runnerResult\)/);
  assert.match(source, /workspace: runnerWorkspace/);
  assert.match(source, /runner_workspace: runnerWorkspace/);
});

test('Kai runner recent context is fetched around the triggering Discord message', () => {
  assert.match(source, /function mergeDiscordMessages\(\.\.\.groups: any\[\]\[\]\): any\[\]/);
  assert.match(source, /private async recentContextForMessage\(channelId: string, msg: any, batchMessages: any\[\]\): Promise<string>/);
  assert.match(source, /private async referencedContextMessages\(channelId: string, msg: any\): Promise<any\[\]>/);
  assert.match(source, /if \(msg\?\.referenced_message\) return \[msg\.referenced_message\]/);
  assert.match(source, /\/channels\/\$\{channelId\}\/messages\/\$\{encodeURIComponent\(referencedId\)\}/);
  assert.match(source, /\/channels\/\$\{channelId\}\/messages\?before=\$\{encodeURIComponent\(currentId\)\}&limit=20/);
  assert.match(source, /return this\.formatRecentContext\(mergeDiscordMessages\(beforeMessages, referencedMessages, batchThroughCurrent\)\.slice\(-28\)\)/);
  assert.doesNotMatch(source, /const recentContext = this\.formatRecentContext\(messages\);/);
  assert.match(source, /const recentContext = await this\.recentContextForMessage\(channelId, msg, messages\);/);
});

test('Kai OCR can use images from the replied-to Discord message', () => {
  assert.match(source, /private async referencedImageAttachments\(channelId: string, msg: any\): Promise<Array<Record<string, unknown>>>/);
  assert.match(source, /source: 'referenced-discord-message'/);
  assert.match(source, /await this\.referencedImageAttachments\(channelId, msg\)/);
  assert.match(source, /await this\.recentImageAttachmentsBefore\(channelId, msg\)/);
});

test('Kai bypasses legacy Kairos trigger path and legacy send tools', () => {
  assert.match(source, /direct-nexus-hard-mention/);
  assert.match(source, /await this\.scheduleKaiAutoresponder\(\)/);
  assert.match(source, /serviceKaiAutoresponderQueue\(\)[\s\S]+runKaiNexusRunner\(command\.id, true, 'autorespond'\)/);
  assert.match(source, /String\(cmd\.trigger_reason \|\| ''\) === 'direct-nexus-hard-mention'/);
  assert.match(source, /Cron: logged Kai transcript and skipped legacy Kai path/);
  assert.match(source, /Legacy pending_commands respond is disabled for Kai/);
  assert.match(source, /Legacy companion send is disabled for Kai/);
});
