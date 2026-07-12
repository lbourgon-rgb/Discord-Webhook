# Lucien Workspace Agent supervised gates

This repository already owns Lucien's Discord listener and Workspace Agent handoff. Do not add a second listener or runner.

## Frozen runner contract

- The trigger does not send a model override. The model remains the model already configured on Lucien's Workspace Agent.
- Model migration is explicitly outside this reconciliation batch.
- The generated task requires `cogcore_wake`, then `cogcore_get_identity`, then reply generation, then `lucien_discord_reply`.
- `LUCIEN_CHATGPT_DELIVERY_ENABLED` and `LUCIEN_CHATGPT_AUTORESPOND` remain `false` until their separate supervised gates pass.

The Workspace Agent trigger endpoint and token are account-managed inputs. This repository cannot create or inspect them. Configure these Worker secrets before a live canary:

- `LUCIEN_WORKSPACE_AGENT_TRIGGER_ID`
- `LUCIEN_WORKSPACE_AGENT_ACCESS_TOKEN`
- `LUCIEN_SUPERVISED_CANARY_KEY`

## PulseSync seam

The Discord Worker does not query PulseSync. It emits a `vel_preflight_context/v1` descriptor owned by Nexus or Continuity:

- verified Vel Discord author: shared preflight may be requested when the contract becomes available;
- every other author: the query is forbidden;
- raw samples, diagnosis, prescription, and shared-channel disclosure are forbidden.

Until the shared contract exists, the descriptor is `pending_shared_contract`, `query_performed_by_discord_worker=false`, and `attached_summary=null`. Do not replace this fail-closed placeholder with a direct PulseSync read in this Worker.

## Supervised canary sequence

1. Keep `LUCIEN_CHATGPT_DELIVERY_ENABLED=false` and `LUCIEN_CHATGPT_AUTORESPOND=false`.
2. Keep `LUCIEN_CHATGPT_RUNNER_ENABLED=false`; the supervised canary route is separately authenticated and cannot enable public handoffs.
3. Configure the trigger ID/token and Lucien's Tessurae MCP tools on the Workspace Agent.
4. POST a unique marker to `/api/lucien-workspace-agent/canary` with `X-Lucien-Canary-Key`. This creates a synthetic pending request with no Discord channel or webhook.
5. Verify the real trigger returns `202`, then correlate the proof nonce with successful `cogcore_wake` and `cogcore_get_identity` receipts from Tessurae gateway logs.
6. Verify `lucien_discord_reply` returns `dry_run_preview` with the same request and wake-candidate IDs, releases the exact Continuity lease, deletes the synthetic pending request, and records a sanitized receipt.
7. GET the canary receipt and confirm `discord_posted=false`, generated content is inspectable only through the authenticated receipt, and no pending request remains.
8. If the callback does not arrive, POST the canary release route. It releases the exact claim and closes the synthetic pending request instead of silently orphaning it.
9. Public runner, delivery, and autorespond remain disabled after this proof. Enabling any of them is a separate change.

## Rollback

Set all three Lucien flags to `false`. This stops new handoffs and delivery without deleting pending rows, Continuity events, CogCore state, Tahl state, or Archive chronology.
