import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isLucienSupervisedCanarySource,
  lucienResponsePreview,
  sanitizeLucienWorkspaceRunReceipt,
  secretMatches,
  secretMatchesHash,
  sha256Hex,
  validateLucienCogCoreProof,
} from '../src/lucien-workspace-proof.ts';

test('request-scoped callback capabilities are verified without storing plaintext', async () => {
  const hash = await sha256Hex('secret-capability');
  assert.equal(await secretMatchesHash('secret-capability', hash), true);
  assert.equal(await secretMatchesHash('wrong-capability', hash), false);
  assert.equal(await secretMatches('operator-key', 'operator-key'), true);
  assert.equal(await secretMatches('operator-key', 'different'), false);
});

test('CogCore proof must carry both receipts for the exact nonce', () => {
  const proof = validateLucienCogCoreProof({
    nonce: 'proof-1',
    wake_receipt_id: 'wake-receipt',
    identity_receipt_id: 'identity-receipt',
  }, 'proof-1');
  assert.equal(proof.wake_receipt_id, 'wake-receipt');
  assert.throws(() => validateLucienCogCoreProof({
    nonce: 'wrong',
    wake_receipt_id: 'wake-receipt',
    identity_receipt_id: 'identity-receipt',
  }, 'proof-1'), /nonce/);
  assert.throws(() => validateLucienCogCoreProof({
    nonce: 'proof-1',
    wake_receipt_id: '',
    identity_receipt_id: 'identity-receipt',
  }, 'proof-1'), /wake/);
});

test('safe receipts expose no callback capability and report Discord delivery truthfully', () => {
  const receipt = sanitizeLucienWorkspaceRunReceipt({
    request_id: 'req-1',
    event_id: 'evt-1',
    wake_candidate_id: 'wake-1',
    proof_nonce: 'proof-1',
    status: 'completed_dry_run',
    mode: 'dry_run_preview',
    response_preview: 'safe preview',
    response_sha256: 'abc',
    created_at: 1,
    updated_at: 2,
  });
  assert.equal(receipt.discord_posted, false);
  assert.equal('callback_capability' in receipt, false);
  assert.equal(lucienResponsePreview('a\n\n b'), 'a b');
  assert.equal(lucienResponsePreview('abcdef', 4), 'abc…');
  assert.equal(isLucienSupervisedCanarySource('workspace-agent-supervised-canary'), true);
  assert.equal(isLucienSupervisedCanarySource('discord'), false);
});
