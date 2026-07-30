export function isTrustedStoredWebhook(storedUrl: unknown, webhookId: unknown): boolean {
  const candidateId = String(webhookId || '').trim();
  if (!candidateId) return false;
  const storedId = String(storedUrl || '').match(/\/webhooks\/([^/]+)\//)?.[1] || '';
  return storedId.length > 0 && storedId === candidateId;
}
