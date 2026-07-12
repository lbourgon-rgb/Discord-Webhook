export interface LucienCogCoreProof {
  nonce: string;
  wake_receipt_id: string;
  identity_receipt_id: string;
}

export interface LucienWorkspaceRunReceipt {
  request_id: string;
  event_id: string;
  wake_candidate_id: string;
  proof_nonce: string;
  status: string;
  mode?: string | null;
  response_preview?: string | null;
  response_sha256?: string | null;
  wake_receipt_id?: string | null;
  identity_receipt_id?: string | null;
  error?: string | null;
  created_at: number;
  updated_at: number;
}

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function secretMatchesHash(candidate: string, expectedHex: string): Promise<boolean> {
  if (!candidate || !expectedHex) return false;
  const candidateHex = await sha256Hex(candidate);
  if (candidateHex.length !== expectedHex.length) return false;
  let difference = 0;
  for (let index = 0; index < candidateHex.length; index += 1) {
    difference |= candidateHex.charCodeAt(index) ^ expectedHex.charCodeAt(index);
  }
  return difference === 0;
}

export async function secretMatches(candidate: string, expected: string | undefined): Promise<boolean> {
  if (!candidate || !expected) return false;
  return secretMatchesHash(candidate, await sha256Hex(expected));
}

export function validateLucienCogCoreProof(
  proof: LucienCogCoreProof | undefined,
  expectedNonce: string,
): LucienCogCoreProof {
  if (!proof) throw new Error('cogcore_proof is required');
  if (proof.nonce !== expectedNonce) throw new Error('cogcore_proof nonce does not match the supervised run');
  if (!proof.wake_receipt_id?.trim()) throw new Error('cogcore_wake receipt is required');
  if (!proof.identity_receipt_id?.trim()) throw new Error('cogcore_get_identity receipt is required');
  return {
    nonce: proof.nonce,
    wake_receipt_id: proof.wake_receipt_id.trim(),
    identity_receipt_id: proof.identity_receipt_id.trim(),
  };
}

export function lucienResponsePreview(content: string, maxChars = 2_000): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function isLucienSupervisedCanarySource(source: string | undefined): boolean {
  return source === 'workspace-agent-supervised-canary';
}

export function sanitizeLucienWorkspaceRunReceipt(
  receipt: LucienWorkspaceRunReceipt,
): LucienWorkspaceRunReceipt & { discord_posted: boolean } {
  return {
    ...receipt,
    discord_posted: receipt.status === 'delivered',
  };
}
