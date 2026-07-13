import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/continuity-ingress.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { commitRequiredContinuityIngress } = await import(moduleUrl);

test('required Continuity ingress remains retryable before local dedupe', async () => {
  const continuityEvents = new Set();
  let attempts = 0;
  let stored = false;
  let localLogs = 0;
  const operation = () => commitRequiredContinuityIngress({
    postContinuity: async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient Continuity failure');
      continuityEvents.add('discord:axiom:message-1');
      return { inserted: continuityEvents.size === 1 };
    },
    storeCommand: () => {
      if (stored) return false;
      stored = true;
      return true;
    },
    logLocal: () => { localLogs++; },
  });

  await assert.rejects(operation, /transient Continuity failure/);
  assert.equal(stored, false);
  assert.equal(localLogs, 0);

  assert.equal(await operation(), true);
  assert.equal(await operation(), false);
  assert.equal(continuityEvents.size, 1);
  assert.equal(localLogs, 1);
});
