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
Do NOT include `senderEmail` — it is collected later by the email-sender agent.

The response has shape `{ objectId, type, isNew, wasMerged, confidence }`.
Save the returned `objectId` as `campaignId` for downstream steps.

STEP 0.3 — Configure the campaign:
Call `objects_update` with:
- `objectId=<campaignId from STEP 0.2>`
- `data={ name: <same name as STEP 0.2> }`
Do NOT set `audience` — leave it empty so the recipient agent selects from
all available contacts.

After completing these three steps, return the `campaignId`. The runtime will automatically dispatch the remaining stages to child agents.
