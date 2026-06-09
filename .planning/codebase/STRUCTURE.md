# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
email-outreach-agent/
├── cinatra/                  # Cinatra platform artefacts
│   └── oas.json              # AgentSpec v26.1.0 flow definition (source of truth)
├── skills/                   # Agent skill / instruction files
│   └── email-outreach/
│       └── SKILL.md          # Stage 0 orchestrator system-prompt instructions
├── .github/
│   └── workflows/
│       ├── ci.yml            # CI — runs extension-kind-gate.mjs
│       └── release.yml       # Release pipeline
├── extension-kind-gate.mjs   # Self-contained CI gate (validates OAS + banned primitives)
├── package.json              # npm manifest + Cinatra agent metadata
├── tsconfig.json             # TypeScript config (scaffold; no src/ yet)
├── .npmrc                    # npm registry config
├── LICENSE                   # Apache-2.0
└── README.md                 # Human-readable feature overview
```

## Directory Purposes

**`cinatra/`:**
- Purpose: Holds all Cinatra platform artefacts for this agent package
- Contains: `oas.json` — the complete AgentSpec flow definition (nodes, subflows, data/control edges, HITL schemas, LLM prompts)
- Key files: `cinatra/oas.json`

**`skills/email-outreach/`:**
- Purpose: Houses the LLM skill (system-prompt instructions) for the top-level orchestrator agent
- Contains: `SKILL.md` — step-by-step Stage 0 instructions for campaign creation via the Objects Layer
- Key files: `skills/email-outreach/SKILL.md`

**`.github/workflows/`:**
- Purpose: GitHub Actions CI and release automation
- Contains: `ci.yml` (runs `extension-kind-gate.mjs`), `release.yml` (publishes to npm registry)
- Key files: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

## Key File Locations

**Entry Points:**
- `cinatra/oas.json`: The entire flow definition — all stages, HITL gates, LLM prompts, data flow wiring
- `skills/email-outreach/SKILL.md`: Stage 0 orchestrator instructions (invoked before the flow graph starts)

**Configuration:**
- `package.json`: Package name (`@cinatra-ai/email-outreach-agent`), version, Cinatra manifest (`cinatra.*`), agent dependencies
- `tsconfig.json`: TypeScript compiler options targeting a future `src/` directory
- `.npmrc`: Registry configuration (note existence only — not read)

**Core Logic:**
- `cinatra/oas.json`: All agent behaviour — LLM prompts are inline in `ApiNode.data.system` strings; HITL input schemas are in `InputMessageNode.metadata.cinatra.inputMessageSchema`

**CI:**
- `extension-kind-gate.mjs`: Zero-dependency Node.js script; validates OAS JSON and scans for retired CRM primitives

## Naming Conventions

**Files:**
- AgentSpec: `cinatra/oas.json` (fixed name, required by platform)
- Skill files: `skills/<agent-slug>/SKILL.md` (slug matches the agent's functional name)
- CI gate: `extension-kind-gate.mjs` (shipped by extraction tooling, not hand-authored)

**Node IDs inside `cinatra/oas.json`:**
- Top-level flow nodes: `snake_case` (e.g., `setup_gate`, `context_setup`, `recipients_flow`)
- Subflow nodes: `<subflow-prefix>-<role>` (e.g., `recipients-scope_gate`, `drafts-approval_gate`, `trigger-persist`)
- Plugin utility nodes: `<subflow-prefix>-<function>` (e.g., `drafts-uuid_match`, `drafts-check_inputs_predicate`)

**Cinatra package names:**
- `@cinatra-ai/<agent-slug>-agent` pattern (e.g., `@cinatra-ai/email-outreach-agent`, `@cinatra-ai/email-drafting-agent`)

**Agent/surface IDs:**
- `<agent-slug>:<step-index>:<surface-role>` (e.g., `email-outreach:step-0:setup`, `email-drafting:step-1:output`)

## Where to Add New Code

**New flow stage (additional step in the campaign pipeline):**
- Add a new `FlowNode` or `ApiNode` entry inside `cinatra/oas.json` → `nodes` array and `$referenced_components`
- Wire it with `ControlFlowEdge` and `DataFlowEdge` entries in the respective connection arrays
- If it needs a child agent, declare the dependency in `package.json` → `cinatra.dependencies` and `cinatra.agentDependencies`

**New HITL screen / approval gate:**
- Add an `InputMessageNode` to `$referenced_components` with `requiresApproval: true` and a `renderer` pointing to the appropriate UI surface
- Add it to `cinatra.hitlScreens` in `metadata.cinatra` if it is a new screen surface

**New LLM step:**
- Add an `ApiNode` targeting `{{CINATRA_BASE_URL}}/api/llm-bridge` with `data.system` (full instruction), `data.user` (templated inputs), and `data.agent_id`
- Follow the pattern: always instruct the LLM to call `objects_save` before returning JSON when a ref output is required

**New skill instruction:**
- Add or update a `SKILL.md` under `skills/<slug>/`
- If it is a new sub-agent skill, create `skills/<new-slug>/SKILL.md`

**TypeScript UI extensions (future):**
- Place source under `src/` — `tsconfig.json` is already configured for `src/**/*.ts` and `src/**/*.tsx`
- There is currently no `src/` directory; create it when adding UI component code

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents (this file and ARCHITECTURE.md)
- Generated: Yes, by gsd-map-codebase
- Committed: Yes (committed alongside agent code for planning continuity)

**`cinatra/`:**
- Purpose: Platform-required artefact directory
- Generated: Partially (initial scaffold generated by Cinatra extraction tooling; maintained manually thereafter)
- Committed: Yes

---

*Structure analysis: 2026-06-09*
