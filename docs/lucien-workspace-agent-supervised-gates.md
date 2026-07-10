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

## PulseSync seam

The Discord Worker does not query PulseSync. It emits a `vel_preflight_context/v1` descriptor owned by Nexus or Continuity:

- verified Vel Discord author: shared preflight may be requested when the contract becomes available;
- every other author: the query is forbidden;
- raw samples, diagnosis, prescription, and shared-channel disclosure are forbidden.

Until the shared contract exists, the descriptor is `pending_shared_contract`, `query_performed_by_discord_worker=false`, and `attached_summary=null`. Do not replace this fail-closed placeholder with a direct PulseSync read in this Worker.

## Supervised canary sequence

1. Keep `LUCIEN_CHATGPT_DELIVERY_ENABLED=false` and `LUCIEN_CHATGPT_AUTORESPOND=false`.
2. Set only `LUCIEN_CHATGPT_RUNNER_ENABLED=true` after the trigger ID/token and Lucien's Tessurae MCP tools are configured on the Workspace Agent.
3. Baseline Lucien's old Continuity wake candidates so no historical item is claimed.
4. Create one new hard tag in one private channel.
5. Run `pending_commands` with `action=run_with_lucien_chatgpt` for that new request.
6. Verify the Workspace Agent called `cogcore_wake` and `cogcore_get_identity`, generated a response, and called `lucien_discord_reply` with `dry_run=true`.
7. Verify the reply result is `dry_run_preview`, no Discord message was created, and the wake is still available for supervised completion or explicit release.
8. Repeat once with `dry_run=false` while delivery remains disabled; verify `delivery_disabled` and still no Discord message.
9. Only after those receipts pass, enable delivery for one private-channel canary. Enable autorespond in a later, separate change.

## Rollback

Set all three Lucien flags to `false`. This stops new handoffs and delivery without deleting pending rows, Continuity events, CogCore state, Tahl state, or Archive chronology.
