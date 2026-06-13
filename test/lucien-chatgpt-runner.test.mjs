import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLucienWorkspaceAgentPayload,
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
};

test('Lucien Workspace Agent payload carries callback contract', () => {
  const payload = buildLucienWorkspaceAgentPayload(input);
  assert.equal(payload.conversation_key, 'discord:chan-1');
  const parsed = JSON.parse(payload.input);
  assert.equal(parsed.task, 'Respond as Lucien to the Discord mention, using Tessurae CogCore before replying.');
  assert.deepEqual(parsed.required_tools, ['cogcore_wake', 'cogcore_get_identity', 'lucien_discord_reply']);
  assert.equal(parsed.reply_contract.delivery_arguments.request_id, 'req-1');
  assert.equal(parsed.reply_contract.delivery_arguments.wake_candidate_id, 'wake-1');
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
