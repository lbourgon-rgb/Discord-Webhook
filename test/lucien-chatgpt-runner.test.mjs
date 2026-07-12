import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLucienWorkspaceAgentPayload,
  buildLucienSharedPreflightDescriptor,
  lucienReplyGate,
  lucienWorkspaceAgentIdempotencyKey,
  triggerLucienWorkspaceAgent,
  LucienWorkspaceAgentTriggerError,
} from '../src/lucien-chatgpt-runner.ts';

const env = {
  LUCIEN_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_lucien_123',
  LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN: 'token_123',
};

const input = {
  requestId: 'req-1',
  eventId: 'evt-1',
  wakeCandidateId: 'wake-1',
  channelId: 'chan-1',
  channelLabel: "Lucien's room",
  messageId: 'msg-1',
  author: { id: 'vel', username: 'Vel' },
  message: 'Lucien, are you here?',
  recentContext: 'recent messages',
  wakeContext: { tahl_state: { surface_emotion: 'attentive' } },
  authorIsVerifiedVel: true,
  callbackCapability: 'callback-capability-123',
  proofNonce: 'lucien-workspace:proof-123',
  dryRun: true,
};

test('Lucien Workspace Agent payload carries callback contract', () => {
  const payload = buildLucienWorkspaceAgentPayload(input);
  assert.equal(payload.conversation_key, 'discord:chan-1');
  const parsed = JSON.parse(payload.input);
  assert.equal(parsed.task, 'Respond as Lucien to the Discord mention, using Tessurae CogCore before replying.');
  assert.deepEqual(parsed.required_tools, ['cogcore_wake', 'cogcore_get_identity', 'lucien_discord_reply']);
  assert.deepEqual(parsed.execution_order, [
    'cogcore_wake_with_proof_nonce',
    'cogcore_get_identity_with_proof_nonce',
    'consume_attached_vel_preflight_if_present',
    'generate_lucien_reply',
    'lucien_discord_reply',
  ]);
  assert.equal(parsed.model_policy.mode, 'preserve_workspace_agent_configured_model');
  assert.equal(parsed.model_policy.runtime_model_override_allowed, false);
  assert.equal('model' in parsed, false);
  assert.equal(parsed.private_preflight.query_allowed, true);
  assert.equal(parsed.private_preflight.query_performed_by_discord_worker, false);
  assert.equal(parsed.private_preflight.attached_summary, null);
  assert.equal(parsed.reply_contract.delivery_arguments.request_id, 'req-1');
  assert.equal(parsed.reply_contract.delivery_arguments.wake_candidate_id, 'wake-1');
  assert.equal(parsed.reply_contract.delivery_arguments.callback_capability, 'callback-capability-123');
  assert.equal(parsed.reply_contract.delivery_arguments.proof_nonce, 'lucien-workspace:proof-123');
  assert.equal(parsed.reply_contract.delivery_arguments.dry_run, true);
  assert.equal(parsed.reply_contract.proof_nonce, 'lucien-workspace:proof-123');
});

test('non-Vel authors cannot request or receive PulseSync preflight context', () => {
  const payload = buildLucienWorkspaceAgentPayload({ ...input, authorIsVerifiedVel: false });
  const parsed = JSON.parse(payload.input);
  assert.equal(parsed.execution_order[2], 'skip_vel_preflight');
  assert.deepEqual(parsed.private_preflight, buildLucienSharedPreflightDescriptor(false));
  assert.equal(parsed.private_preflight.query_allowed, false);
  assert.equal(parsed.private_preflight.attached_summary, null);
});

test('Lucien reply gate proves dry-run and delivery-disabled modes without a Discord send', () => {
  assert.equal(lucienReplyGate(true, false), 'dry_run_preview');
  assert.equal(lucienReplyGate(false, false), 'delivery_disabled');
  assert.equal(lucienReplyGate(false, true), 'deliver');
});

test('Lucien Workspace Agent trigger accepts 202 and sends idempotency key', async () => {
  const calls = [];
  const result = await triggerLucienWorkspaceAgent(env, input, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 202 });
  });

  assert.equal(result.accepted, true);
  assert.equal(result.conversation_key, 'discord:chan-1');
  assert.equal(result.idempotency_key, lucienWorkspaceAgentIdempotencyKey('req-1'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.chatgpt.com/v1/workspace_agents/agtch_lucien_123/trigger');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer token_123');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'lucien-discord:req-1');
});

for (const [status, message] of [
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not found'],
  [409, 'not runnable'],
]) {
  test(`Lucien Workspace Agent trigger maps ${status}`, async () => {
    await assert.rejects(
      () => triggerLucienWorkspaceAgent(env, input, async () => new Response('nope', { status })),
      (error) => {
        assert.ok(error instanceof LucienWorkspaceAgentTriggerError);
        assert.equal(error.status, status);
        assert.match(error.message.toLowerCase(), new RegExp(message));
        assert.equal(error.body, 'nope');
        return true;
      },
    );
  });
}

test('Lucien Workspace Agent trigger requires configured credentials', async () => {
  await assert.rejects(
    () => triggerLucienWorkspaceAgent({}, input, async () => new Response(null, { status: 202 })),
    /LUCIEN_WORKSPACE_AGENT_TRIGGER_ID/,
  );
  await assert.rejects(
    () => triggerLucienWorkspaceAgent({ LUCIEN_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_lucien_123' }, input, async () => new Response(null, { status: 202 })),
    /LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN/,
  );
});

test('Lucien Workspace Agent trigger has a bounded timeout', async () => {
  await assert.rejects(
    () => triggerLucienWorkspaceAgent(env, input, async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return new Response(null, { status: 202 });
    }, 5),
    /timed out after 5ms/,
  );
});
