import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/social-provenance.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { isTrustedStoredWebhook } = await import(moduleUrl);

test('accepts only the webhook id embedded in the stored channel webhook URL', () => {
  const storedUrl = 'https://discord.com/api/webhooks/123456789/secret-token';
  assert.equal(isTrustedStoredWebhook(storedUrl, '123456789'), true);
  assert.equal(isTrustedStoredWebhook(storedUrl, '987654321'), false);
});

test('fails closed for missing or malformed webhook provenance', () => {
  assert.equal(isTrustedStoredWebhook(null, '123456789'), false);
  assert.equal(isTrustedStoredWebhook('https://discord.com/channels/1/2', '123456789'), false);
  assert.equal(isTrustedStoredWebhook('https://discord.com/api/webhooks/123456789/secret-token', ''), false);
});
