interface KaiPolicyCommand {
  content?: string
  engagement?: {
    author_class?: 'vel' | 'unknown' | string
  }
}

const WORKSPACE_WRITE_VERB = /\b(?:create|write|edit|update|revise|replace|append|save)\b/i
const WORKSPACE_OBJECT = /\b(?:file|workspace|document|text file|notes? file|workspace path)\b/i
const WORKSPACE_FILENAME = /(?:^|\s|[`'"(])(?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|json|jsonc|yaml|yml|toml|csv|tsv|js|mjs|cjs|ts|tsx|jsx|css|html|xml)(?:$|\s|[`'"),.:;!?])/i
const NEGATED_WRITE_VERB = /\b(?:do\s+not|don't|dont|never|no\s+need\s+to|avoid|without|refrain\s+from|not)\b(?:\s+\S+){0,4}\s+\b(?:create|write|edit|update|revise|replace|append|save)(?:ing)?\b/i
const EMPTY_WRITE_REQUEST = /\b(?:create|write|edit|update|revise|replace|append|save)\b(?:\s+\S+){0,4}\s+\b(?:nothing|no\s+changes?|none)\b/i
const NON_ACTION_WRITE_MENTION = /\b(?:how|whether)\s+to\s+(?:create|write|edit|update|revise|replace|append|save)\b|\bwrite\s+(?:access|permission|scope|policy)\b/i
const EXPLICIT_WRITE_ACTION = /^(?:(?:hey|hi)\s+)?(?:kai(?:'soryth|soryth)?\s+)?(?:(?:please\s+)?(?:create|write|edit|update|revise|replace|append|save)\b|(?:can|could|would|will)\s+you\s+please\s+(?:create|write|edit|update|revise|replace|append|save)\b|(?:i\s+(?:want|need)\s+you\s+to|i\s+would\s+like\s+you\s+to|go\s+ahead\s+(?:and\s+)?|feel\s+free\s+to|you\s+should\s+|let'?s\s+)(?:create|write|edit|update|revise|replace|append|save)\b)/i

function hasPositiveWorkspaceWriteClause(clause: string): boolean {
  if (!WORKSPACE_WRITE_VERB.test(clause)) return false
  if (!WORKSPACE_OBJECT.test(clause) && !WORKSPACE_FILENAME.test(clause)) return false
  if (NEGATED_WRITE_VERB.test(clause) || EMPTY_WRITE_REQUEST.test(clause)) return false
  if (NON_ACTION_WRITE_MENTION.test(clause)) return false
  return EXPLICIT_WRITE_ACTION.test(clause.trim())
}

export function hasExplicitKaiWorkspaceWriteIntent(content: string): boolean {
  const text = String(content || '').trim()
  if (!text) return false
  // Evaluate bounded clauses independently so a later positive request can be
  // honored, but a negated mention can never authorize mutation by itself.
  return text
    // A period is intentionally not a separator because it is part of every
    // recognized filename extension (for example, notes/canary.md).
    .split(/(?:[\r\n,;!?]+|\b(?:but|however|instead)\b)/i)
    .some((clause) => hasPositiveWorkspaceWriteClause(clause.trim()))
}

export function kaiRunnerPolicyForCommand(command: KaiPolicyCommand): Record<string, unknown> {
  const verifiedVel = command.engagement?.author_class === 'vel'
  const allowWorkspaceWrite = verifiedVel && hasExplicitKaiWorkspaceWriteIntent(String(command.content || ''))
  return {
    continuity_policy: {
      allowed_conversation_ids: [],
    },
    ...(allowWorkspaceWrite ? {
      write_policy: {
        allow: true,
        scopes: ['workspace'],
        reason_code: 'explicit-user-request',
      },
    } : {}),
  }
}
