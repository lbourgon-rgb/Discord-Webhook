import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const policySource = await readFile(new URL('../src/companion-peer-ingress.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(policySource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  decideTrustedPeerIngress,
  identifyTrustedPeerCompanion,
  isLegacyKaiPeerHardTagActor,
  selectAxiomScopedPeerTargets,
} = await import(moduleUrl);

const identities = [
  { companion_id: 'morzar', discord_user_ids: ['1463578634483793920'] },
  { companion_id: 'axiom', discord_user_ids: ['1515127400491647076', '1521672973264617616'] },
];

function recordWake(decision, sourceMessageId, receipts) {
  if (!decision.admitted || receipts.events.has(sourceMessageId)) return;
  receipts.events.add(sourceMessageId);
  receipts.wakes.add(sourceMessageId);
}

test("trusted Mor'zar hard tag creates exactly one event and wake decision", () => {
  const actor = identifyTrustedPeerCompanion('1463578634483793920', identities);
  const targets = selectAxiomScopedPeerTargets({
    content: '<@1515127400491647076> privacy-safe canary',
    referenced_author_id: null,
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  assert.deepEqual(targets, [{ companion_id: 'axiom', target_mode: 'hard_mention' }]);
  const decision = decideTrustedPeerIngress({
    actor_companion_id: actor,
    target_companion_id: targets[0].companion_id,
    target_mode: targets[0].target_mode,
    channel_allowed: true,
    source_already_processed: false,
    reply_depth: 0,
    loop_depth: 0,
  });
  const receipts = { events: new Set(), wakes: new Set() };
  recordWake(decision, 'message-hard-tag', receipts);
  assert.equal(receipts.events.size, 1);
  assert.equal(receipts.wakes.size, 1);
  assert.deepEqual(decision.peer_wake, {
    trusted: true,
    actor_companion_id: 'morzar',
    target_companion_id: 'axiom',
    target_mode: 'hard_mention',
    reply_depth: 0,
    loop_depth: 0,
    reason_code: 'trusted-peer-hard-mention',
  });
});

test("trusted Mor'zar direct reply creates exactly one event and wake decision", () => {
  const targets = selectAxiomScopedPeerTargets({
    content: 'privacy-safe direct reply canary',
    referenced_author_id: '1515127400491647076',
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  assert.deepEqual(targets, [{ companion_id: 'axiom', target_mode: 'direct_reply' }]);
  const decision = decideTrustedPeerIngress({
    actor_companion_id: 'morzar',
    target_companion_id: targets[0].companion_id,
    target_mode: targets[0].target_mode,
    channel_allowed: true,
    source_already_processed: false,
    reply_depth: 1,
    loop_depth: 1,
  });
  const receipts = { events: new Set(), wakes: new Set() };
  recordWake(decision, 'message-direct-reply', receipts);
  assert.equal(receipts.events.size, 1);
  assert.equal(receipts.wakes.size, 1);
  assert.equal(decision.peer_wake.reason_code, 'trusted-peer-direct-reply');
  assert.equal(decision.peer_wake.reply_depth, 1);
  assert.equal(decision.peer_wake.loop_depth, 1);
});

test('duplicate source message creates no second event or wake', () => {
  const first = decideTrustedPeerIngress({
    actor_companion_id: 'morzar', target_companion_id: 'axiom', target_mode: 'hard_mention',
    channel_allowed: true, source_already_processed: false, reply_depth: 0, loop_depth: 0,
  });
  const duplicate = decideTrustedPeerIngress({
    actor_companion_id: 'morzar', target_companion_id: 'axiom', target_mode: 'hard_mention',
    channel_allowed: true, source_already_processed: true, reply_depth: 0, loop_depth: 0,
  });
  const receipts = { events: new Set(), wakes: new Set() };
  recordWake(first, 'same-source-message', receipts);
  recordWake(duplicate, 'same-source-message', receipts);
  assert.equal(receipts.events.size, 1);
  assert.equal(receipts.wakes.size, 1);
  assert.equal(duplicate.admitted, false);
  assert.equal(duplicate.reason_code, 'trusted-peer-duplicate-source');
});

test('known peer without an exact target creates no wake', () => {
  const decision = decideTrustedPeerIngress({
    actor_companion_id: 'morzar', target_companion_id: '', target_mode: 'hard_mention',
    channel_allowed: true, source_already_processed: false, reply_depth: 0, loop_depth: 0,
  });
  assert.deepEqual(decision, { admitted: false, reason_code: 'trusted-peer-no-target' });
});

test('untrusted automated author creates no wake', () => {
  const actor = identifyTrustedPeerCompanion('999999999999999999', identities);
  const decision = decideTrustedPeerIngress({
    actor_companion_id: actor, target_companion_id: 'axiom', target_mode: 'hard_mention',
    channel_allowed: true, source_already_processed: false, reply_depth: 0, loop_depth: 0,
  });
  assert.equal(actor, null);
  assert.deepEqual(decision, { admitted: false, reason_code: 'untrusted-automated-author' });
});

test('Axiom self-message creates no wake', () => {
  const actor = identifyTrustedPeerCompanion('1515127400491647076', identities);
  const decision = decideTrustedPeerIngress({
    actor_companion_id: actor, target_companion_id: 'axiom', target_mode: 'hard_mention',
    channel_allowed: true, source_already_processed: false, reply_depth: 0, loop_depth: 0,
  });
  assert.deepEqual(decision, { admitted: false, reason_code: 'trusted-peer-self-target' });
});

test('existing human hard-tag path remains outside automated peer admission', async () => {
  const listenerSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(listenerSource, /const peerAuthorCompanion = isBot && !isWebhook/);
  assert.match(listenerSource, /if \(isBot && !isWebhook && !peerAuthorCompanion\)/);
  assert.match(listenerSource, /let triggered = peerAuthorCompanion[\s\S]{0,220}: \[\.\.\.triggerResult\.matched\]/);
  assert.match(listenerSource, /if \(!peerAuthorCompanion\) \{[\s\S]{0,180}mentionResult\.matched/);
  assert.match(listenerSource, /const hardCompanionMention = containsHardCompanionMention/);
  assert.doesNotMatch(listenerSource, /priorPeerPending/);
  assert.match(listenerSource, /channel_allowed: monitor\.respond_enabled && monitor\.response_mode !== 'never'/);
});

test('reply-depth, loop-depth, and channel gates fail closed with finite reason codes', () => {
  const base = {
    actor_companion_id: 'morzar', target_companion_id: 'axiom', target_mode: 'direct_reply',
    channel_allowed: true, source_already_processed: false, reply_depth: 1, loop_depth: 0,
  };
  assert.equal(decideTrustedPeerIngress({ ...base, channel_allowed: false }).reason_code, 'trusted-peer-channel-blocked');
  assert.equal(decideTrustedPeerIngress({ ...base, reply_depth: 2 }).reason_code, 'trusted-peer-reply-depth-exceeded');
  assert.equal(decideTrustedPeerIngress({ ...base, loop_depth: 2 }).reason_code, 'trusted-peer-loop-depth-exceeded');
});

test('observe-only monitor policy queues no peer command, event, or wake', () => {
  const decision = decideTrustedPeerIngress({
    actor_companion_id: 'morzar',
    target_companion_id: 'axiom',
    target_mode: 'hard_mention',
    channel_allowed: false,
    source_already_processed: false,
    reply_depth: 0,
    loop_depth: 0,
  });
  let queuedCommands = 0;
  const receipts = { events: new Set(), wakes: new Set() };
  if (decision.admitted) {
    queuedCommands++;
    recordWake(decision, 'observe-only-source', receipts);
  }
  assert.equal(decision.reason_code, 'trusted-peer-channel-blocked');
  assert.equal(queuedCommands, 0);
  assert.equal(receipts.events.size, 0);
  assert.equal(receipts.wakes.size, 0);
});

test('peer hard mention requires literal Discord syntax and ignores mentions-array-only pings', () => {
  const mentionsArrayOnly = selectAxiomScopedPeerTargets({
    content: 'A reply notification populated mentions, but has no literal tag.',
    referenced_author_id: null,
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  const literalNicknameMention = selectAxiomScopedPeerTargets({
    content: '<@!1515127400491647076> exact tag',
    referenced_author_id: null,
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  assert.deepEqual(mentionsArrayOnly, []);
  assert.deepEqual(literalNicknameMention, [{ companion_id: 'axiom', target_mode: 'hard_mention' }]);
});

test('peer target selector is Axiom-only except for pre-existing literal Kai hard tags', () => {
  const lucienTag = selectAxiomScopedPeerTargets({
    content: '<@111111111111111111> hello',
    referenced_author_id: '111111111111111111',
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  const kaiDirectReply = selectAxiomScopedPeerTargets({
    content: 'reply without a hard tag',
    referenced_author_id: '1447789482253484175',
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  const kaiHardTag = selectAxiomScopedPeerTargets({
    content: '<@1447789482253484175> supervised smoke test',
    referenced_author_id: null,
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  const axiomAndKaiHardTags = selectAxiomScopedPeerTargets({
    content: '<@1515127400491647076> <@1447789482253484175> dual target',
    referenced_author_id: null,
    axiom_discord_user_ids: identities[1].discord_user_ids,
    kai_discord_user_ids: ['1447789482253484175'],
  });
  assert.deepEqual(lucienTag, []);
  assert.deepEqual(kaiDirectReply, []);
  assert.deepEqual(kaiHardTag, [{ companion_id: 'kai', target_mode: 'hard_mention' }]);
  assert.deepEqual(axiomAndKaiHardTags, [{ companion_id: 'axiom', target_mode: 'hard_mention' }]);
});

test('legacy peer-to-Kai exception is limited to Axiom and Morzar actors', () => {
  assert.equal(isLegacyKaiPeerHardTagActor('axiom'), true);
  assert.equal(isLegacyKaiPeerHardTagActor('morzar'), true);
  assert.equal(isLegacyKaiPeerHardTagActor('kai'), false);
  assert.equal(isLegacyKaiPeerHardTagActor('lucien'), false);
  assert.equal(isLegacyKaiPeerHardTagActor('grok-keth'), false);
  assert.equal(isLegacyKaiPeerHardTagActor(null), false);
});
