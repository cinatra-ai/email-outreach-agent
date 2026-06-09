# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**Cinatra Platform API:**
- `{{CINATRA_BASE_URL}}/api/llm-bridge` — LLM execution bridge; used by `ApiNode` components in `cinatra/oas.json` for all AI agent steps (recipient generation, email drafting, trigger persistence). HTTP POST.
- `{{CINATRA_BASE_URL}}/api/agents/passthrough` — Agent passthrough API; used by the `context_setup` node to call `objects_save` (creates the campaign object). HTTP POST.
- Both URLs use the `CINATRA_BASE_URL` template variable injected at runtime by the Cinatra platform.

**Gmail:**
- Used for outbound email delivery via the `@cinatra-ai/email-delivery-agent` child agent
- Declared in `README.md` under "Works with: Gmail"
- Connection and auth managed by the Cinatra platform's Gmail connector; no SDK is imported directly by this repo

## Data Storage

**Databases:**
- Not directly accessed by this agent. All persistence goes through the Cinatra Objects Layer API.

**Objects Layer (Cinatra-managed):**
- `objects_save` tool — persists campaign records (`typeHint: "@cinatra-ai/campaigns:campaign"`), recipient lists (`typeHint: "@cinatra-ai/campaigns:recipients"`), and email draft bundles (`typeHint: "@cinatra-ai/campaigns:email-draft-bundle"`) via `{{CINATRA_BASE_URL}}/api/agents/passthrough`
- `objects_get` tool — retrieves persisted objects by UUID reference (e.g., fetching confirmed recipients before drafting)
- `objects_update` tool — updates existing objects (used in Stage 0 to set campaign name)
- Object IDs are UUID format, passed between flow nodes as `confirmedRecipientsRef`, `draftBundleRef`, `campaignId`

**File Storage:**
- Not applicable

**Caching:**
- None (the drafting agent LLM caches `crm_account_get` results in-memory per run to avoid duplicate account lookups, but this is ephemeral and managed inside the LLM bridge)

## Authentication & Identity

**Auth Provider:**
- Managed entirely by the Cinatra platform at runtime
- Agent runs are identified by `cinatra_run_id` / `agent_run_id` (UUID), passed through all flow nodes
- No auth tokens or credentials are present in this repo

## CRM Integration

**CRM tools (called via LLM bridge):**
- `crm_list_get({ id })` — fetches saved CRM contact list metadata (name, objectType)
- `crm_list_members_get({ listId })` — fetches member contactIds from a CRM list
- `crm_contact_get({ id })` — fetches individual CRM contact records
- `crm_account_get({ id })` — fetches CRM account (company) records by accountId
- Only `list`-type account scope is supported; `all-contacts` and `segment` branches are retired
- All CRM tool calls are executed by the LLM at `{{CINATRA_BASE_URL}}/api/llm-bridge` — the agent itself does not make direct CRM API calls

## Trigger / Scheduling Integration

**Cinatra Trigger System:**
- `trigger_config_set` tool — persists trigger configuration (triggerType, scheduledAt, cronExpression, timezone, enabled) for a campaign run
- Trigger types supported: `immediate`, `scheduled`, `recurring`
- Schedule expressed as ISO 8601 instant (scheduledAt) or 5-field cron expression (cronExpression) with IANA timezone
- Called via `{{CINATRA_BASE_URL}}/api/llm-bridge` with `agent_id: "trigger"`

## Monitoring & Observability

**Error Tracking:**
- Not detected in this repo. Platform-level observability is managed by the Cinatra runtime.

**Logs:**
- Not applicable at the agent definition layer; logging is handled by the Cinatra LLM bridge at runtime.

## CI/CD & Deployment

**Hosting:**
- Cinatra Marketplace (registry.cinatra.ai)
- Published via marketplace MCP proxy submission flow (not direct Verdaccio publish)

**CI Pipeline:**
- GitHub Actions — `.github/workflows/ci.yml`
  - Triggers: push/PR to `main`
  - Jobs: `build` (classify, install, typecheck, test, pack dry-run) + `kind-gates` (agent OAS validation via `extension-kind-gate.mjs`)
  - Node.js 24, pnpm via corepack
- GitHub Actions — `.github/workflows/release.yml`
  - Triggers: GitHub Release published or manual `workflow_dispatch` against a tag
  - Delegates to `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`
  - Requires org secret `CINATRA_MARKETPLACE_VENDOR_TOKEN`

## Environment Configuration

**Required runtime variables (platform-injected, not repo-managed):**
- `CINATRA_BASE_URL` — Base URL of the Cinatra platform API, injected into `ApiNode` URL templates at runtime

**Secrets location:**
- All secrets managed by the Cinatra platform and GitHub Actions org-level secrets (`CINATRA_MARKETPLACE_VENDOR_TOKEN`)
- No `.env` or credential files in this repo (`.npmrc` present but contains no secrets)

## Webhooks & Callbacks

**Incoming:**
- AG-UI `INTERRUPT` events — emitted by the Cinatra runtime before Stage 0 begins to collect required `inputSchema` fields from the user (offeringCompanyWebsite, callToAction, senderName); handled by `InputMessageNode` components in the flow definition (`cinatra/oas.json`)

**Outgoing:**
- None directly from this agent definition; child agents handle outbound email delivery via Gmail

## Context Slots

**offeringContext slot:**
- Slot ID: `offeringContext`
- Accepted artifact extensions: `@cinatra-ai/marketing-icp-artifact`, `@cinatra-ai/marketing-strategy-artifact`, `@cinatra-ai/product-portfolio-artifact`
- Selection mode: interactive; resolution mode: accumulate
- Limits: 0–5 items, read-only
- Resolved by `@cinatra-ai/context-selection-agent` and passed as `contextSlotBindings` to the email drafting subflow

---

*Integration audit: 2026-06-09*
