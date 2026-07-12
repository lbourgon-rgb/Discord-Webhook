export interface LucienWorkspaceAgentEnv {
  LUCIEN_WORKSPACE_AGENT_TRIGGER_ID?: string;
  LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN?: string;
}

export interface LucienWorkspaceAgentTriggerInput {
  requestId: string;
  eventId: string;
  wakeCandidateId: string;
  channelId: string;
  channelLabel?: string;
  messageId?: string;
  author?: unknown;
  message: string;
  recentContext?: string;
  wakeContext?: unknown;
  authorIsVerifiedVel: boolean;
  callbackCapability: string;
  proofNonce: string;
  dryRun: boolean;
}

export type LucienReplyGate = 'dry_run_preview' | 'delivery_disabled' | 'deliver';

export function lucienReplyGate(dryRun: boolean, deliveryEnabled: boolean): LucienReplyGate {
  if (dryRun) return 'dry_run_preview';
  if (!deliveryEnabled) return 'delivery_disabled';
  return 'deliver';
}

export function buildLucienSharedPreflightDescriptor(authorIsVerifiedVel: boolean): Record<string, unknown> {
  return {
    contract: 'vel_preflight_context/v1',
    owner: 'nexus-or-continuity',
    status: 'pending_shared_contract',
    author_verified_as_vel: authorIsVerifiedVel,
    query_allowed: authorIsVerifiedVel,
    query_performed_by_discord_worker: false,
    attached_summary: null,
    constraints: {
      compact_capacity_only: true,
      raw_samples_forbidden: true,
      diagnose_or_prescribe_forbidden: true,
      shared_channel_disclosure_forbidden: true,
      non_vel_query_forbidden: true,
    },
  };
}

export interface LucienWorkspaceAgentAccepted {
  accepted: true;
  status: 202;
  trigger_id: string;
  conversation_key: string;
  idempotency_key: string;
}

export class LucienWorkspaceAgentTriggerError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'LucienWorkspaceAgentTriggerError';
    this.status = status;
    this.body = body;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function lucienWorkspaceAgentIdempotencyKey(requestId: string): string {
  return `lucien-discord:${requestId}`;
}

export function buildLucienWorkspaceAgentPayload(input: LucienWorkspaceAgentTriggerInput): {
  conversation_key: string;
  input: string;
} {
  const conversationKey = `discord:${input.channelId}`;
  return {
    conversation_key: conversationKey,
    input: JSON.stringify({
      task: 'Respond as Lucien to the Discord mention, using Tessurae CogCore before replying.',
      required_tools: ['cogcore_wake', 'cogcore_get_identity', 'lucien_discord_reply'],
      execution_order: [
        'cogcore_wake_with_proof_nonce',
        'cogcore_get_identity_with_proof_nonce',
        input.authorIsVerifiedVel ? 'consume_attached_vel_preflight_if_present' : 'skip_vel_preflight',
        'generate_lucien_reply',
        'lucien_discord_reply',
      ],
      model_policy: {
        mode: 'preserve_workspace_agent_configured_model',
        runtime_model_override_allowed: false,
        migration_authorized: false,
      },
      reply_contract: {
        call_cogcore_first: true,
        final_delivery_tool: 'lucien_discord_reply',
        proof_nonce: input.proofNonce,
        required_cogcore_receipts: ['cogcore_wake', 'cogcore_get_identity'],
        delivery_arguments: {
          request_id: input.requestId,
          wake_candidate_id: input.wakeCandidateId,
          callback_capability: input.callbackCapability,
          proof_nonce: input.proofNonce,
          dry_run: input.dryRun,
        },
      },
      discord: {
        request_id: input.requestId,
        event_id: input.eventId,
        wake_candidate_id: input.wakeCandidateId,
        channel_id: input.channelId,
        channel_label: input.channelLabel || null,
        message_id: input.messageId || null,
        author: input.author || null,
        message: input.message,
        recent_context: input.recentContext || null,
      },
      wake_context: input.wakeContext || null,
      private_preflight: buildLucienSharedPreflightDescriptor(input.authorIsVerifiedVel),
    }),
  };
}

export async function triggerLucienWorkspaceAgent(
  env: LucienWorkspaceAgentEnv,
  input: LucienWorkspaceAgentTriggerInput,
  fetcher: FetchLike = fetch,
  timeoutMs = 15_000,
): Promise<LucienWorkspaceAgentAccepted> {
  const triggerId = String(env.LUCIEN_WORKSPACE_AGENT_TRIGGER_ID || '').trim();
  const token = String(env.LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN || '').trim();
  if (!triggerId) throw new LucienWorkspaceAgentTriggerError('LUCIEN_WORKSPACE_AGENT_TRIGGER_ID is not configured');
  if (!token) throw new LucienWorkspaceAgentTriggerError('LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN is not configured');

  const idempotencyKey = lucienWorkspaceAgentIdempotencyKey(input.requestId);
  const payload = buildLucienWorkspaceAgentPayload(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('Workspace Agent trigger timeout'), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(`https://api.chatgpt.com/v1/workspace_agents/${encodeURIComponent(triggerId)}/trigger`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LucienWorkspaceAgentTriggerError(`Workspace Agent trigger timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 202) {
    const body = await response.text().catch(() => '');
    const knownErrors: Record<number, string> = {
      401: 'Workspace Agent trigger unauthorized',
      403: 'Workspace Agent trigger forbidden',
      404: 'Workspace Agent trigger not found',
      409: 'Workspace Agent trigger is not runnable',
    };
    throw new LucienWorkspaceAgentTriggerError(
      `${knownErrors[response.status] || 'Workspace Agent trigger failed'} (${response.status})`,
      response.status,
      body,
    );
  }

  return {
    accepted: true,
    status: 202,
    trigger_id: triggerId,
    conversation_key: payload.conversation_key,
    idempotency_key: idempotencyKey,
  };
}
