import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canonicalKaiResidenceMessage,
  kaiResidenceChannelId,
  kaiResidenceTransportReceiptId,
  parseKaiResidenceDeliveryJob,
  validateKaiResidenceDeliveryProof,
} from '../src/kai-residence-discord.ts';

const workerSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

function job(overrides = {}) {
  return {
    companion_id: 'kaisoryth',
    job_key: 'response-1:discord',
    response_event_id: 'response-1',
    candidate_id: 'candidate-1',
    source_event_id: 'residence-source-1',
    continuity_event_id: 'continuity-source-1',
    surface: 'discord',
    conversation_id: 'discord:1416976728223514780',
    session_id: 'kai-inbox',
    runner_id: 'serythrae-platform:mini-pc',
    runner_epoch: 7,
    candidate_lease_epoch: 11,
    ...overrides,
  };
}

function proof(overrides = {}) {
  return {
    valid: true,
    proof: {
      companion_id: 'kaisoryth',
      response_event_id: 'response-1',
      candidate_id: 'candidate-1',
      source_event_id: 'residence-source-1',
      continuity_event_id: 'continuity-source-1',
      surface: 'discord',
      conversation_id: 'discord:1416976728223514780',
      session_id: 'kai-inbox',
      runner_id: 'serythrae-platform:mini-pc',
      runner_epoch: 7,
      candidate_lease_epoch: 11,
      committed_at: '2026-08-25T12:00:00.000Z',
      ...overrides,
    },
  };
}

function canonicalResponse(overrides = {}) {
  return {
    companion_id: 'kaisoryth',
    response_event_id: 'response-1',
    candidate_id: 'candidate-1',
    source_event_id: 'residence-source-1',
    continuity_event_id: 'continuity-source-1',
    surface: 'discord',
    conversation_id: 'discord:1416976728223514780',
    session_id: 'kai-inbox',
    runner_id: 'serythrae-platform:mini-pc',
    runner_epoch: 7,
    candidate_lease_epoch: 11,
    committed_at: '2026-08-25T12:00:00.000Z',
    content: 'Canonical Kai response.',
    ...overrides,
  };
}

function sourceEvent(overrides = {}) {
  return {
    event: {
      id: 'continuity-source-1',
      companion_id: 'kaisoryth',
      source: 'discord',
      conversation_id: 'discord:1416976728223514780',
      role: 'human',
      external_message_id: '1511111111111111111',
      ...overrides,
    },
  };
}

test('residence delivery accepts only the canonical Discord job and derives its channel', () => {
  const parsed = parseKaiResidenceDeliveryJob(job());
  assert.equal(parsed.ok, true);
  assert.equal(kaiResidenceChannelId(parsed.value), '1416976728223514780');

  assert.equal(parseKaiResidenceDeliveryJob(job({ surface: 'eshmor' })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob(job({ companion_id: 'morzar' })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob(job({ continuity_event_id: '' })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob(job({ session_id: '' })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob(job({ runner_epoch: 0 })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob(job({ job_key: 'caller-chosen' })).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob({ ...job(), content: 'caller-injected draft' }).ok, false);
  assert.equal(parseKaiResidenceDeliveryJob({ ...job(), channel_id: '999' }).ok, false);
});

test('all canonical ownership fields must match the Continuity delivery proof', () => {
  const parsed = parseKaiResidenceDeliveryJob(job());
  assert.equal(parsed.ok, true);
  assert.equal(validateKaiResidenceDeliveryProof(parsed.value, proof()), null);

  for (const [field, value] of [
    ['companion_id', 'morzar'],
    ['response_event_id', 'other-response'],
    ['candidate_id', 'other-candidate'],
    ['source_event_id', 'other-source'],
    ['continuity_event_id', 'other-continuity-source'],
    ['surface', 'eshmor'],
    ['conversation_id', 'discord:999'],
    ['session_id', 'other-session'],
    ['runner_id', 'ghost-runner'],
    ['runner_epoch', 8],
    ['candidate_lease_epoch', 12],
  ]) {
    assert.match(validateKaiResidenceDeliveryProof(parsed.value, proof({ [field]: value })), new RegExp(field));
  }
});

test('Discord content comes from the canonical response and reply identity from its canonical source event', () => {
  const parsed = parseKaiResidenceDeliveryJob(job());
  assert.equal(parsed.ok, true);
  const canonical = canonicalKaiResidenceMessage(parsed.value, canonicalResponse(), sourceEvent());
  assert.deepEqual(canonical, {
    ok: true,
    value: { content: 'Canonical Kai response.', reply_to_message_id: '1511111111111111111' },
  });

  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse({ companion_id: 'morzar' }), sourceEvent()).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse({ content: '' }), sourceEvent()).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse({ source_event_id: 'other-residence-source' }), sourceEvent()).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse({ continuity_event_id: 'other-continuity-source' }), sourceEvent()).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse({ runner_epoch: 99 }), sourceEvent()).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse(), sourceEvent({ id: 'other-source' })).ok, false);
  assert.equal(canonicalKaiResidenceMessage(parsed.value, canonicalResponse(), sourceEvent({ external_message_id: 'not-discord' })).ok, false);
});

test('transport receipt identity is deterministic for a job and its Discord messages', async () => {
  const parsed = parseKaiResidenceDeliveryJob(job());
  assert.equal(parsed.ok, true);
  const otherSession = parseKaiResidenceDeliveryJob(job({ session_id: 'other-session' }));
  assert.equal(otherSession.ok, true);
  const first = await kaiResidenceTransportReceiptId(parsed.value, ['message-1', 'message-2']);
  const replay = await kaiResidenceTransportReceiptId(parsed.value, ['message-1', 'message-2']);
  const changed = await kaiResidenceTransportReceiptId(parsed.value, ['message-1']);
  const rebound = await kaiResidenceTransportReceiptId(otherSession.value, ['message-1', 'message-2']);
  assert.equal(first, replay);
  assert.notEqual(first, changed);
  assert.notEqual(first, rebound);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test('residence transport is separate from the harness and explicitly promoted in production config', () => {
  assert.match(workerSource, /KAI_RESIDENCE_DISCORD_API_KEY\?: string/);
  assert.match(workerSource, /KAI_RESIDENCE_DISCORD_DELIVERY_ENABLED\?: string/);
  assert.match(workerSource, /isKaiResidenceBearerAuthorized\(request, env\.KAI_RESIDENCE_DISCORD_API_KEY\)/);
  assert.match(workerSource, /url\.pathname === '\/api\/residence\/kaisoryth\/read-messages'/);
  assert.match(workerSource, /url\.pathname === '\/api\/residence\/kaisoryth\/deliver'/);
  assert.match(workerSource, /wake-responses\/\$\{encodeURIComponent\(job\.response_event_id\)\}\/delivery-proof/);
  assert.match(workerSource, /control\/wake-responses\/\$\{encodeURIComponent\(job\.response_event_id\)\}/);
  assert.match(workerSource, /events\/\$\{encodeURIComponent\(job\.continuity_event_id\)\}/);
  assert.match(workerSource, /kai:residence-delivery:\$\{job\.job_key\}/);
  assert.match(workerSource, /kaiResidenceTransportReceiptId\(job, receipt\.sent_message_ids\)/);
  assert.match(workerSource, /canonicalMessage\.value\.content/);
  assert.match(wrangler, /KAI_RESIDENCE_DISCORD_DELIVERY_ENABLED = "true"/);
  assert.match(wrangler, /KAI_RESIDENCE_DISCORD_API_KEY: Dedicated bearer token/);
  assert.doesNotMatch(workerSource, /kai:residence-delivery:\$\{responseEventId\}/);
});
