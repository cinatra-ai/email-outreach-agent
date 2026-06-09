# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- JSON — Agent flow definition and OAS spec (`cinatra/oas.json`)
- Markdown — Agent skill/prompt definition (`skills/email-outreach/SKILL.md`)

**Secondary:**
- JavaScript (ESM) — CI gate script (`extension-kind-gate.mjs`)
- TypeScript — Declared as compile target via `tsconfig.json` (targets `src/` directory; no TypeScript source files are currently present in the repo — this is a content-only agent extension)

## Runtime

**Environment:**
- Node.js 24 (required by CI: `actions/setup-node@v4` with `node-version: "24"`)
- ES Module format (`"type": "module"` in `package.json`)

**Package Manager:**
- pnpm via corepack (`corepack enable` in CI)
- No committed lockfile (standalone repos use `--no-frozen-lockfile`)

## Frameworks

**Core:**
- Cinatra Agent Runtime (`agentspec_version: "26.1.0"`) — declarative flow orchestration engine that interprets `cinatra/oas.json`

**Testing:**
- Not applicable — this is a source-mirror repo; the cinatra monorepo owns test execution. No test framework is configured locally.

**Build/Dev:**
- TypeScript compiler (`tsc`) — configured via `tsconfig.json` (ES2023 target, ESNext modules, bundler module resolution, `outDir: dist`, `rootDir: src`)
- `npm pack --dry-run` — CI validates package shape without publishing

## Key Dependencies

**Critical:**
- No runtime npm dependencies declared (`dependencies` field absent from `package.json`)
- All `@cinatra-ai/*` agent packages are declared as **optional peerDependencies** (enforced by CI lint); they are resolved only inside the cinatra monorepo workspace

**Agent Dependencies (cinatra.agentDependencies):**
- `@cinatra-ai/email-recipient-selection-agent` `^0.1.0` — selects and confirms recipients from CRM lists
- `@cinatra-ai/skill-recommender-agent` `^0.1.0` — recommends drafting skills
- `@cinatra-ai/email-drafting-agent` `^0.1.0` — generates personalized email drafts
- `@cinatra-ai/reviewer-agent` `^0.1.0` — human-in-the-loop review gates
- `@cinatra-ai/email-delivery-agent` `^0.1.0` — test and send emails via Gmail
- `@cinatra-ai/context-selection-agent` `^0.1.1` — resolves offering context artifacts
- `@cinatra-ai/trigger-agent` (runtime dependency, `^*`) — configures campaign trigger schedule

**Infrastructure:**
- `extension-kind-gate.mjs` — self-contained zero-dependency Node.js validation script for CI (validates `cinatra/oas.json` agent surface and retired-primitive scan)

## Configuration

**Environment:**
- `CINATRA_BASE_URL` — runtime template variable injected by the Cinatra platform into all `ApiNode` URLs (e.g., `{{CINATRA_BASE_URL}}/api/llm-bridge`, `{{CINATRA_BASE_URL}}/api/agents/passthrough`)
- No `.env` files present in this repo; secrets are managed by the Cinatra platform at runtime

**Build:**
- `tsconfig.json` — standalone TypeScript config (does not extend monorepo config); strict mode with `noImplicitAny: false`
- `.npmrc` — present (existence noted; contents not read)

## Platform Requirements

**Development:**
- Node.js 24+
- pnpm via corepack
- The Cinatra monorepo workspace for full typecheck/test (this repo is a source mirror; host-internal `@cinatra-ai/*` peers are not published to any registry)

**Production:**
- Deployed to the Cinatra Marketplace via GitHub Releases
- Release pipeline uses reusable workflow at `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`
- Requires org secret `CINATRA_MARKETPLACE_VENDOR_TOKEN` and OIDC `id-token: write` permission for build provenance

---

*Stack analysis: 2026-06-09*
