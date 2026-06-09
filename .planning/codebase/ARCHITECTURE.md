<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Email Outreach Flow (Orchestrator)                │
│                    `cinatra/oas.json` — top-level Flow               │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  setup_gate      │  context_setup   │  context_offeringContext       │
│  InputMessageNode│  ApiNode         │  (context-selection-agent)     │
│  (HITL: form)    │  (objects_save)  │  (context slots / artifacts)   │
└────────┬─────────┴────────┬─────────┴──────────────────────────────-┘
         │                  │
         ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Subflow Sequence (runtime-dispatched child agents)      │
│                                                                      │
│  recipients_flow → skills_flow → drafts_flow → sender_flow          │
│                                                    │                 │
│                                              trigger_flow → end      │
│                                                                      │
│  Each node is a FlowNode embedding a self-contained subflow spec.    │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cinatra Platform APIs  (via {{CINATRA_BASE_URL}})                   │
│  /api/agents/passthrough  (objects_save / objects_update)            │
│  /api/llm-bridge          (LLM agents: recipients, drafts, delivery) │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | Location in OAS |
|-----------|----------------|-----------------|
| `start` | Receive `cinatra_run_id`, context slot IDs | `$referenced_components.start` |
| `setup_gate` | HITL: collect `offeringCompanyWebsite`, `callToAction`, `senderName` | `$referenced_components.setup_gate` |
| `context_setup` | API: persist campaign object via `objects_save` passthrough | `$referenced_components.context_setup` |
| `recipients_flow` | Subflow: select contact list, materialise and confirm recipient list | `$referenced_components.email-recipient-selection-subflow` |
| `skills_flow` | Subflow: skill recommender agent selects drafting context | FlowNode → `@cinatra-ai/skill-recommender-agent` |
| `context_offeringContext` | Resolve offering context slot artifacts before drafting | `$referenced_components.context_offeringContext` (ContextSlotNode) |
| `drafts_flow` | Subflow: generate personalised drafts, HITL approval gate | `$referenced_components.email-drafting-subflow` |
| `sender_flow` | Subflow: deliver approved emails via Gmail, HITL approval gate | `$referenced_components.email-delivery-subflow` |
| `trigger_flow` | Subflow: configure and persist campaign trigger (immediate/scheduled/recurring) | `$referenced_components.trigger-subflow` |
| `end` | Terminal node — no outputs | `$referenced_components.end` |

## Pattern Overview

**Overall:** Declarative multi-stage agentic flow (Cinatra AgentSpec v26.1.0)

**Key Characteristics:**
- The entire workflow is encoded as a single JSON document (`cinatra/oas.json`) using the Cinatra AgentSpec DSL — there is no executable TypeScript runtime code in this repo.
- Control flow and data flow are explicit, typed edges in the OAS graph; the Cinatra runtime executes the graph.
- Every consequential step has `requiresApproval: true` — the flow pauses for human-in-the-loop (HITL) confirmation via AG-UI `INTERRUPT` events before advancing.
- LLM work (recipient generation, email drafting, delivery, trigger persistence) is delegated to `ApiNode` nodes hitting `/api/llm-bridge` with inline system/user prompt templates.
- Inter-stage data is persisted to the Objects Layer (UUIDs passed as refs: `confirmedRecipientsRef`, `draftBundleRef`).

## Layers

**Flow Orchestration Layer:**
- Purpose: Define the stage sequence and wire data between stages.
- Location: `cinatra/oas.json` — top-level `Flow` component
- Contains: `StartNode`, `InputMessageNode` (HITL gates), `ApiNode` (API/LLM calls), `FlowNode` (subflow delegation), `EndNode`, control/data flow edges
- Depends on: Cinatra platform runtime
- Used by: Cinatra marketplace / runtime engine

**Subflow Layer (inline, embedded in `cinatra/oas.json`):**
- Purpose: Encapsulate per-stage logic for recipients, drafting, delivery, and triggering.
- Location: `$referenced_components` within `cinatra/oas.json` — `email-recipient-selection-subflow`, `email-drafting-subflow`, `email-delivery-subflow`, `trigger-subflow`
- Contains: Stage-specific start/end nodes, LLM `ApiNode`s, HITL `InputMessageNode`s, plugin nodes (regex match, template, branching)
- Depends on: Cinatra `/api/llm-bridge` for LLM execution; Objects Layer for ref-based data handoff

**Skill/Instruction Layer:**
- Purpose: Provide LLM system-prompt instructions for Stage 0 (campaign setup).
- Location: `skills/email-outreach/SKILL.md`
- Contains: Step-by-step instructions for the orchestrator agent to call `objects_save` and `objects_update`
- Depends on: Objects Layer tools (`objects_save`, `objects_update`)
- Used by: Cinatra runtime when invoking the orchestrator LLM

**CI Gate Layer:**
- Purpose: Pre-publish sanity check — validates `cinatra/oas.json` parses correctly and contains no retired CRM primitives.
- Location: `extension-kind-gate.mjs`
- Contains: Self-contained Node.js script (zero external deps) — parses OAS JSON, scans LLM-visible prompt strings for banned primitives
- Used by: `.github/workflows/ci.yml`

## Data Flow

### Primary Campaign Execution Path

1. **User submits setup form** — `setup_gate` (HITL `InputMessageNode`) emits `setupJson` (`cinatra/oas.json` line ~459)
2. **Campaign object persisted** — `context_setup` (`ApiNode`) calls `objects_save` via `/api/agents/passthrough`; emits `offeringCompanyWebsite`, `callToAction`, `senderName` (`cinatra/oas.json` line ~499)
3. **Recipients materialised** — `recipients_flow` → `recipients-generate` (`ApiNode` → `/api/llm-bridge`); calls `crm_list_members_get`, `crm_contact_get`, then `objects_save`; emits `confirmedRecipientsRef` (UUID)
4. **Skills recommended** — `skills_flow` (delegated to `@cinatra-ai/skill-recommender-agent`)
5. **Offering context resolved** — `context_offeringContext` binds artifact slots; emits `contextSlotBindings` array
6. **Drafts generated** — `drafts_flow` → `drafts-draft` (`ApiNode` → `/api/llm-bridge`); calls `objects_get(confirmedRecipientsRef)`, generates drafts, calls `objects_save`; emits `draftBundleRef` (UUID)
7. **Drafts approved** — `drafts-approval_gate` (HITL gate)
8. **Emails delivered** — `sender_flow` → `sender-send` (`ApiNode` → `/api/llm-bridge`); uses `confirmedRecipientsRef` + `draftBundleRef` + `senderEmail`
9. **Trigger configured** — `trigger_flow` → `trigger-configure_gate` (HITL) → `trigger-persist` (`ApiNode` → `/api/llm-bridge`); calls `trigger_config_set`

### Input Validation Guard (Drafts Subflow)

The drafts subflow includes an inline input guard before executing:
1. `drafts-uuid_match` — PluginRegexNode validates `confirmedRecipientsRef` is a UUID
2. `drafts-check_inputs_predicate` — PluginTemplateNode renders `present` / `missing`
3. `drafts-check_inputs` — BranchingNode: if `present` → skip `data_gate`; if `missing` → show `drafts-data_gate` (HITL to collect ref)

**State Management:**
- All cross-stage data is passed by reference (UUID) through the Objects Layer, not inlined in flow variables. Only scalar inputs (`campaignId`, website, CTA, sender name, run ID) travel as direct data flow edges.

## Key Abstractions

**InputMessageNode (HITL Gate):**
- Purpose: Pause the flow and emit an AG-UI `INTERRUPT` event; resume only when the user submits the required schema
- Examples: `setup_gate`, `recipients-scope_gate`, `recipients-review_gate`, `drafts-approval_gate`, `trigger-configure_gate`
- Pattern: `requiresApproval: true`, `renderer: "@cinatra-ai/<package>:<surface>"`, `inputMessageSchema` with JSON Schema

**ApiNode (LLM Bridge):**
- Purpose: Send a system+user prompt to `/api/llm-bridge`; the runtime invokes an LLM that calls MCP tools and returns structured JSON
- Examples: `context_setup`, `recipients-generate`, `drafts-draft`, `sender-send`, `trigger-persist`
- Pattern: `url: "{{CINATRA_BASE_URL}}/api/llm-bridge"`, `data.system` = full instruction set, `data.user` = templated inputs with `{{ variable }}`

**FlowNode (Subflow Delegation):**
- Purpose: Embed a child flow as a stage; the runtime instantiates it independently
- Examples: `recipients_flow`, `drafts_flow`, `sender_flow`, `trigger_flow`
- Pattern: `component_type: "FlowNode"`, `subflow: { "$component_ref": "<subflow-id>" }`

**Objects Layer Ref:**
- Purpose: Decouple large data (recipient lists, draft bundles) from the flow's data edges; stages exchange UUIDs
- Key refs: `confirmedRecipientsRef`, `draftBundleRef`
- Pattern: Always call `objects_save` BEFORE returning JSON from an LLM node; pass the returned `objectId` downstream

## Entry Points

**Flow Entry:**
- Location: `cinatra/oas.json` — `start_node: { "$component_ref": "start" }`
- Triggers: Cinatra runtime instantiates the flow; AG-UI sends `INTERRUPT` for `setup_gate` before any step executes
- Responsibilities: Accept `cinatra_run_id`, `contextParentPackageName`, `offeringContextSlotId`, `contextProjectId`

**Skill Entry (Stage 0 Orchestrator):**
- Location: `skills/email-outreach/SKILL.md`
- Triggers: Cinatra runtime invokes the orchestrator LLM with this skill as system prompt
- Responsibilities: Execute Stage 0 — derive company name, call `objects_save`, call `objects_update`, return `campaignId`

**CI Gate Entry:**
- Location: `extension-kind-gate.mjs`
- Triggers: `node extension-kind-gate.mjs --package-root .` in CI
- Responsibilities: Parse `cinatra/oas.json`, scan for banned CRM primitives in LLM prompts, exit 0/1

## Architectural Constraints

- **No TypeScript source:** `tsconfig.json` exists (targets `src/`) but there is no `src/` directory — the config is a scaffold placeholder for future UI extensions. All agent logic lives in `cinatra/oas.json` and `skills/email-outreach/SKILL.md`.
- **No circular imports:** Not applicable — no module graph.
- **Global state:** None. All runtime state flows through the Cinatra Objects Layer (server-side).
- **Threading:** Single declarative graph; parallelism is not used — all nodes execute sequentially per the control flow edges.
- **Self-contained CI:** `extension-kind-gate.mjs` uses only Node builtins; runs unauthenticated before the `@cinatra-ai` registry is reachable.

## Anti-Patterns

### Returning JSON before `objects_save`

**What happens:** An LLM node returns its output JSON before calling `objects_save` on the Objects Layer.
**Why it's wrong:** Downstream nodes receive a `draftBundleRef` / `confirmedRecipientsRef` that does not exist yet, causing lookup failures.
**Do this instead:** Every `ApiNode` system prompt that emits a ref (e.g., `drafts-draft`, `recipients-generate`) explicitly instructs the LLM: "Call `objects_save` BEFORE returning any JSON." (`cinatra/oas.json` — `drafts-draft.data.system`, `recipients-generate.data.system`)

### Using retired CRM primitives

**What happens:** A future edit to an `ApiNode` system prompt uses a retired `lists_*` or `all-contacts` scope primitive.
**Why it's wrong:** The Cinatra platform no longer supports these; the runtime will error.
**Do this instead:** Use `crm_list_get` / `crm_list_members_get` / `crm_contact_get` / `crm_account_get` — enforced at CI time by `extension-kind-gate.mjs`.

## Error Handling

**Strategy:** Fail-fast within LLM nodes — each system prompt instructs the LLM to return an error JSON envelope (e.g., `{"error":"unsupported_account_scope",...}`) rather than silently proceeding with bad inputs. The Cinatra runtime surfaces these as flow errors.

**Patterns:**
- Unsupported account scope → `recipients-generate` returns `{"error":"unsupported_account_scope","scopeType":"...","summary":"..."}` and halts
- Empty contact list → `recipients-generate` returns empty-list envelope
- Missing `confirmedRecipientsRef` → `drafts-check_inputs` branches to `drafts-data_gate` (HITL fallback) rather than erroring silently

## Cross-Cutting Concerns

**Logging:** Delegated entirely to the Cinatra platform runtime — no application-level logging in this repo.
**Validation:** Input schema validation via JSON Schema on `InputMessageNode.inputMessageSchema`; UUID format validation via `PluginRegexNode` before draft generation.
**Authentication:** All API calls use `{{CINATRA_BASE_URL}}` — the runtime injects auth credentials. No credentials in this repo.

---

*Architecture analysis: 2026-06-09*
