import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/kai-runner-policy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const policyModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('verified Vel explicit workspace file write receives only workspace scope', () => {
  const policy = policyModule.kaiRunnerPolicyForCommand({
    content: 'Kai, please write this into notes/canary.md in your workspace.',
    engagement: { author_class: 'vel' },
  });
  assert.deepEqual(policy, {
    continuity_policy: { allowed_conversation_ids: [] },
    write_policy: {
      allow: true,
      scopes: ['workspace'],
      reason_code: 'explicit-user-request',
    },
  });
});

test('verified Vel prose request is not mistaken for a file write', () => {
  const policy = policyModule.kaiRunnerPolicyForCommand({
    content: 'Write me a tiny poem about rain.',
    engagement: { author_class: 'vel' },
  });
  assert.deepEqual(policy, { continuity_policy: { allowed_conversation_ids: [] } });
});

test('bot or unknown author cannot authorize workspace writes', () => {
  for (const authorClass of ['unknown', 'bot', undefined]) {
    const policy = policyModule.kaiRunnerPolicyForCommand({
      content: 'Write file notes/canary.md in the workspace.',
      engagement: authorClass ? { author_class: authorClass } : undefined,
    });
    assert.deepEqual(policy, { continuity_policy: { allowed_conversation_ids: [] } });
  }
});

test('explicit edit with a filename is recognized while read-only intent stays default deny', () => {
  assert.equal(policyModule.hasExplicitKaiWorkspaceWriteIntent('Edit `notes/canary.md` and replace the heading.'), true);
  assert.equal(policyModule.hasExplicitKaiWorkspaceWriteIntent('Read `notes/canary.md` and tell me the heading.'), false);
});

test('negated and non-action write mentions stay default deny', () => {
  for (const content of [
    'Do not write to any file; just read it.',
    "Don't edit `notes/canary.md`, only inspect it.",
    'Please write nothing to the workspace file.',
    'Explain how to edit a file safely.',
    'Does Kai have write access to the workspace?',
  ]) {
    assert.equal(policyModule.hasExplicitKaiWorkspaceWriteIntent(content), false, content);
    assert.deepEqual(policyModule.kaiRunnerPolicyForCommand({
      content,
      engagement: { author_class: 'vel' },
    }), { continuity_policy: { allowed_conversation_ids: [] } }, content);
  }
});

test('a separate positive clause remains explicit after an unrelated negation', () => {
  assert.equal(
    policyModule.hasExplicitKaiWorkspaceWriteIntent("Don't summarize it; edit `notes/canary.md` directly."),
    true,
  );
  assert.equal(
    policyModule.hasExplicitKaiWorkspaceWriteIntent('Could you please update `notes/canary.md` for me?'),
    true,
  );
});

test('conditional, hypothetical, and capability language cannot mint write scope', () => {
  for (const content of [
    'If you were to edit notes/canary.md, what would you change?',
    'Before you edit notes/canary.md, tell me what you would change.',
    'When you update the workspace file, what happens?',
    'Could you edit notes/canary.md?',
  ]) {
    assert.equal(policyModule.hasExplicitKaiWorkspaceWriteIntent(content), false, content);
    assert.equal('write_policy' in policyModule.kaiRunnerPolicyForCommand({
      content,
      engagement: { author_class: 'vel' },
    }), false, content);
  }
});

test('caller never grants cross-channel context by inference', () => {
  const policy = policyModule.kaiRunnerPolicyForCommand({
    content: 'What did we say elsewhere?',
    engagement: { author_class: 'vel' },
  });
  assert.deepEqual(policy.continuity_policy.allowed_conversation_ids, []);
  assert.equal('write_policy' in policy, false);
});
