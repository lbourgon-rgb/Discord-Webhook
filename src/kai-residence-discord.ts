export interface KaiResidenceDeliveryJob {
  companion_id: 'kaisoryth';
  job_key: string;
  response_event_id: string;
  candidate_id: string;
  source_event_id: string;
  continuity_event_id: string;
  surface: 'discord';
  conversation_id: string;
  session_id: string;
  runner_id: string;
  runner_epoch: number;
  candidate_lease_epoch: number;
}

export interface KaiResidenceCanonicalMessage {
  content: string;
  reply_to_message_id: string | null;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const DELIVERY_JOB_KEYS = new Set([
  'companion_id',
  'job_key',
  'response_event_id',
  'candidate_id',
  'source_event_id',
  'continuity_event_id',
  'surface',
  'conversation_id',
  'session_id',
  'runner_id',
  'runner_epoch',
  'candidate_lease_epoch',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maxLength ? text : null;
}

function positiveEpoch(value: unknown): number | null {
  const epoch = Number(value);
  return Number.isInteger(epoch) && epoch > 0 ? epoch : null;
}

export function parseKaiResidenceDeliveryJob(value: unknown): ParseResult<KaiResidenceDeliveryJob> {
  const body = asRecord(value);
  const unexpected = Object.keys(body).find(key => !DELIVERY_JOB_KEYS.has(key));
  if (unexpected) {
    return { ok: false, error: `Unexpected delivery field: ${unexpected}` };
  }

  const responseEventId = boundedText(body.response_event_id, 240);
  const candidateId = boundedText(body.candidate_id, 240);
  const sourceEventId = boundedText(body.source_event_id, 240);
  const continuityEventId = boundedText(body.continuity_event_id, 240);
  const conversationId = boundedText(body.conversation_id, 240);
  const sessionId = boundedText(body.session_id, 128);
  const runnerId = boundedText(body.runner_id, 240);
  const jobKey = boundedText(body.job_key, 520);
  const runnerEpoch = positiveEpoch(body.runner_epoch);
  const candidateLeaseEpoch = positiveEpoch(body.candidate_lease_epoch);

  if (!responseEventId || !candidateId || !sourceEventId || !continuityEventId || !conversationId || !sessionId || !runnerId || !jobKey) {
    return { ok: false, error: 'Delivery job identity fields are required and must be bounded strings' };
  }
  if (body.companion_id !== 'kaisoryth') {
    return { ok: false, error: 'Kai residence Discord transport only accepts companion_id=kaisoryth' };
  }
  if (body.surface !== 'discord') {
    return { ok: false, error: 'Kai residence Discord transport only accepts surface=discord' };
  }
  if (runnerEpoch === null || candidateLeaseEpoch === null) {
    return { ok: false, error: 'runner_epoch and candidate_lease_epoch must be positive integers' };
  }
  if (jobKey !== `${responseEventId}:discord`) {
    return { ok: false, error: 'job_key must be the canonical response_event_id:discord key' };
  }
  if (!/^discord(?:-dm)?:\d+$/.test(conversationId)) {
    return { ok: false, error: 'conversation_id must name a Discord channel' };
  }

  return {
    ok: true,
    value: {
      companion_id: 'kaisoryth',
      job_key: jobKey,
      response_event_id: responseEventId,
      candidate_id: candidateId,
      source_event_id: sourceEventId,
      continuity_event_id: continuityEventId,
      surface: 'discord',
      conversation_id: conversationId,
      session_id: sessionId,
      runner_id: runnerId,
      runner_epoch: runnerEpoch,
      candidate_lease_epoch: candidateLeaseEpoch,
    },
  };
}

export function kaiResidenceChannelId(job: KaiResidenceDeliveryJob): string {
  return job.conversation_id.slice(job.conversation_id.lastIndexOf(':') + 1);
}

export function kaiResidenceJobFingerprint(job: KaiResidenceDeliveryJob): string {
  return [
    job.companion_id,
    job.job_key,
    job.response_event_id,
    job.candidate_id,
    job.source_event_id,
    job.continuity_event_id,
    job.surface,
    job.conversation_id,
    job.session_id,
    job.runner_id,
    String(job.runner_epoch),
    String(job.candidate_lease_epoch),
  ].join('\n');
}

export function validateKaiResidenceDeliveryProof(
  job: KaiResidenceDeliveryJob,
  value: unknown,
): string | null {
  const response = asRecord(value);
  const proof = asRecord(response.proof);
  if (response.valid !== true) return 'Continuity did not return a valid canonical delivery proof';

  const expected: Array<[string, string | number]> = [
    ['companion_id', job.companion_id],
    ['response_event_id', job.response_event_id],
    ['candidate_id', job.candidate_id],
    ['source_event_id', job.source_event_id],
    ['continuity_event_id', job.continuity_event_id],
    ['surface', job.surface],
    ['conversation_id', job.conversation_id],
    ['session_id', job.session_id],
    ['runner_id', job.runner_id],
    ['runner_epoch', job.runner_epoch],
    ['candidate_lease_epoch', job.candidate_lease_epoch],
  ];
  for (const [field, expectedValue] of expected) {
    const actual = typeof expectedValue === 'number' ? Number(proof[field]) : String(proof[field] || '');
    if (actual !== expectedValue) return `Continuity delivery proof mismatch: ${field}`;
  }
  if (!boundedText(proof.committed_at, 120)) return 'Continuity delivery proof is missing committed_at';
  return null;
}

export function canonicalKaiResidenceMessage(
  job: KaiResidenceDeliveryJob,
  canonicalValue: unknown,
  sourceValue: unknown,
): ParseResult<KaiResidenceCanonicalMessage> {
  const response = asRecord(canonicalValue);
  const comparisons: Array<[string, unknown, string | number]> = [
    ['response_event_id', response.response_event_id, job.response_event_id],
    ['companion_id', response.companion_id, 'kaisoryth'],
    ['candidate_id', response.candidate_id, job.candidate_id],
    ['source_event_id', response.source_event_id, job.source_event_id],
    ['continuity_event_id', response.continuity_event_id, job.continuity_event_id],
    ['surface', response.surface, job.surface],
    ['conversation_id', response.conversation_id, job.conversation_id],
    ['session_id', response.session_id, job.session_id],
    ['runner_id', response.runner_id, job.runner_id],
    ['runner_epoch', Number(response.runner_epoch), job.runner_epoch],
    ['candidate_lease_epoch', Number(response.candidate_lease_epoch), job.candidate_lease_epoch],
  ];
  for (const [field, actualValue, expectedValue] of comparisons) {
    const actual = typeof expectedValue === 'number' ? Number(actualValue) : String(actualValue || '');
    if (actual !== expectedValue) return { ok: false, error: `Canonical response mismatch: ${field}` };
  }

  const content = typeof response.content === 'string' ? response.content.trim() : '';
  if (!content || content.length > 20_000) {
    return { ok: false, error: 'Canonical response content is empty or exceeds the transport limit' };
  }

  const sourceEnvelope = asRecord(sourceValue);
  const sourceEvent = asRecord(sourceEnvelope.event);
  const sourceComparisons: Array<[string, unknown, string]> = [
    ['source.event.id', sourceEvent.id, job.continuity_event_id],
    ['source.event.companion_id', sourceEvent.companion_id, 'kaisoryth'],
    ['source.event.source', sourceEvent.source, job.surface],
    ['source.event.conversation_id', sourceEvent.conversation_id, job.conversation_id],
  ];
  for (const [field, actualValue, expectedValue] of sourceComparisons) {
    if (String(actualValue || '') !== expectedValue) {
      return { ok: false, error: `Canonical source event mismatch: ${field}` };
    }
  }
  const replyTo = String(sourceEvent.external_message_id || '').trim();
  if (!/^\d+$/.test(replyTo)) {
    return { ok: false, error: 'Canonical source event has no Discord message identity' };
  }
  return {
    ok: true,
    value: {
      content,
      reply_to_message_id: replyTo,
    },
  };
}

export async function kaiResidenceTransportReceiptId(job: KaiResidenceDeliveryJob, messageIds: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`kai-residence-discord\n${kaiResidenceJobFingerprint(job)}\n${messageIds.join('\n')}`),
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export async function isKaiResidenceBearerAuthorized(request: Request, expectedSecret: string | undefined): Promise<boolean> {
  const expected = String(expectedSecret || '').trim();
  const authorization = request.headers.get('Authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}
