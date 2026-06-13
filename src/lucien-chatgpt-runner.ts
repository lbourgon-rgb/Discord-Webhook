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
      reply_contract: {
        call_cogcore_first: true,
        final_delivery_tool: 'lucien_discord_reply',
        delivery_arguments: {
          request_id: input.requestId,
          wake_candidate_id: input.wakeCandidateId,
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
    }),
  };
}

export async function triggerLucienWorkspaceAgent(
  env: LucienWorkspaceAgentEnv,
  input: LucienWorkspaceAgentTriggerInput,
  fetcher: FetchLike = fetch,
): Promise<LucienWorkspaceAgentAccepted> {
  const triggerId = String(env.LUCIEN_WORKSPACE_AGENT_TRIGGER_ID || '').trim();
  const token = String(env.LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN || '').trim();
  if (!triggerId) throw new LucienWorkspaceAgentTriggerError('LUCIEN_WORKSPACE_AGENT_TRIGGER_ID is not configured');
  if (!token) throw new LucienWorkspaceAgentTriggerError('LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN is not configured');

  const idempotencyKey = lucienWorkspaceAgentIdempotencyKey(input.requestId);
  const payload = buildLucienWorkspaceAgentPayload(input);
  const response = await fetcher(`https://api.chatgpt.com/v1/workspace_agents/${encodeURIComponent(triggerId)}/trigger`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

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
