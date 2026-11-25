# email-outreach-agent — AGENTS.md

Agent-specific guidance for `@cinatra-ai/email-outreach-agent`. This agent has no LLM prompt node; the stage below is implemented declaratively in `cinatra/oas.json`. It carried a bundled SKILL.md until cinatra#2090 — agent extensions no longer ship skill bundles, so the documentation lives here.

## Stage 0 — inline campaign setup

You are the Email Outreach orchestrator. You handle only Stage 0 — campaign setup via the Objects Layer. All subsequent stages (recipients, drafts, review, send) are dispatched automatically by the runtime to child agents.

## How inputs arrive

All required `inputSchema` fields are collected via AG-UI `INTERRUPT` events emitted by the runtime before Stage 0 begins. By the time these steps execute, every `input.<fieldName>` reference is guaranteed populated.

## Stage 0 — Inline Campaign Setup

STEP 0.1 — Derive offering context:
From `input.offeringCompanyWebsite`, extract the company name by looking at the domain (e.g. "https://cinatra.ai" -> "Cinatra").
Save it as `offeringCompanyName` — use it for the campaign name only. No tool call needed.

STEP 0.2 — Create the campaign:
Call `objects_save` with:
- `typeHint="@cinatra-ai/campaigns:campaign"`
- `rawData=<JSON object>`:
  - `campaignTypeId="campaign-email-outreach"`
  - `name="Outreach — " + offeringCompanyName` (from STEP 0.1)
  - `offeringCompanyName=offeringCompanyName` (from STEP 0.1)
  - `offeringCompanyWebsite=input.offeringCompanyWebsite`
  - `senderName=input.senderName` (if provided; omit if not)
  - `callToAction=input.callToAction`
Do NOT include `senderEmail` — the run's start form collects it and hands it only to the send step.

The response has shape `{ objectId, type, isNew, wasMerged, confidence }`.
Save the returned `objectId` as `campaignId` for downstream steps.

STEP 0.3 — Configure the campaign:
Call `objects_update` with:
- `objectId=<campaignId from STEP 0.2>`
- `data={ name: <same name as STEP 0.2> }`
Do NOT set `audience` — leave it empty so the recipient agent selects from
all available contacts.

After completing these three steps, return the `campaignId`. The runtime will automatically dispatch the remaining stages to child agents.

## Known limits

- One campaign sends to at most 50 recipients: the delivery step takes at most 50 emails, and the application reviews at most 50 bodies at once. The flow checks the number of confirmed recipients right after the recipients review (`recipient_limit_check`, `recipient_limit_branch`, `too_many_recipients` in `cinatra/oas.json`) and stops before any email is drafted when it is above 50. The limit is a literal of the flow; `tests/flow-contract.test.mjs` keeps it equal to the delivery copy's own bound.
- A body that is edited on its own page after it was filed is not mailed: the send refuses the whole call and the person starts the campaign again. A change request on one body of several does not produce a corrected body in this flow, because the pack declares no repair. Both are behaviours of the application that this flow relies on, not something this repository proves: the send reads each body only while it is still the artifact's current, approved revision (`src/lib/artifacts/current-decided-revision-read.ts` in cinatra-ai/cinatra, added by cinatra-ai/cinatra#4787). The tests here pin only the wiring that hands the send the revisions the review step pinned (`tests/send-receives-the-pinned-bodies.test.mjs`).
