# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Not detected — no `jest.config.*`, `vitest.config.*`, or test runner in `package.json` scripts
- The repo has no `src/` TypeScript and no `*.test.*` or `*.spec.*` files

**Assertion Library:**
- Not applicable

**Run Commands:**
```bash
# No test script defined in package.json
# CI step: corepack pnpm test --if-present  (skips gracefully if absent)
node extension-kind-gate.mjs --package-root .   # functional validation gate (CI)
npm pack --dry-run                               # package shape validation (CI)
```

## Test File Organization

**Location:** No test files present in this repo.

**Naming:** Not applicable.

**Structure:** Not applicable.

## What CI Validates Instead

This repo relies on the `extension-kind-gate.mjs` script as its functional validation layer rather than a traditional test suite. It is both the CI gate and an importable module with exported pure functions.

**Gate entry point:** `extension-kind-gate.mjs`

**Exported pure functions (importable for external testing):**
- `parseArgs(argv)` — CLI argument parser
- `validateAgent(packageRoot)` → `string[]` — scans `cinatra/oas.json` for retired CRM primitives
- `validateWorkflow(packageRoot)` → `string[]` — validates workflow package shape + BPMN sidecar
- `validateWorkflowPackageShape(pkg)` → `string[]` — pure package.json shape validator
- `validateBpmnSanity(xml)` → `string[]` — pure XML/BPMN well-formedness checker
- `findWorkflowSidecars(packageRoot)` → `string[]` — recursive BPMN sidecar finder
- `runGate(packageRoot)` → `{ kind, errors }` — top-level dispatcher

**Key design:** All validators are pure functions (string/object in → `string[]` out, no side effects), making them unit-testable without filesystem setup when called directly. The monorepo (not this repo) is expected to own the actual unit test suite for these exported functions.

## Mocking

**Framework:** Not applicable — no test suite present.

**What would need mocking if tests were added:**
- `node:fs` (`readFileSync`, `existsSync`, `readdirSync`) — all filesystem access in `extension-kind-gate.mjs`
- The pure functions (`validateBpmnSanity`, `validateWorkflowPackageShape`) require NO mocking — they are fully pure

## Fixtures and Factories

**Test Data:** Not applicable — no test suite present.

**Implicit fixtures in gate script:**
- `BANNED_PRIMITIVES` array in `extension-kind-gate.mjs` — defines the exact set of retired CRM tool names to scan for
- `BANNED_TYPEHINTS` array — legacy entity typeHint strings to reject
- `BPMN_MODEL_NS` constant — canonical BPMN 2.0 namespace URI used for document validation

## Coverage

**Requirements:** None enforced — no coverage tooling configured.

**View Coverage:** Not applicable.

## CI Test Strategy

**CI pipeline:** `.github/workflows/ci.yml`

**Two-job structure:**

1. **`build` job** (runs on every push/PR to `main`):
   - Classifies repo as source mirror vs standalone using first-party dep detection
   - Source mirrors (repos with `@cinatra-ai/*` optional peers): skip install, typecheck, and test — monorepo owns those
   - Standalone repos: `pnpm install --no-frozen-lockfile` → typecheck → `pnpm test --if-present`
   - All repos: `npm pack --dry-run` validates publish payload shape

2. **`kind-gates` job** (runs after `build`, needs: build):
   - Runs `node extension-kind-gate.mjs --package-root .`
   - For `kind: "agent"`: scans `cinatra/oas.json` for retired CRM primitives in LLM-visible fields
   - For `kind: "workflow"`: validates package shape + BPMN sidecar well-formedness
   - Self-contained, zero Node dependencies — runs before `@cinatra-ai` registry is reachable

**This repo's classification:** Source mirror (`cinatra.agentDependencies` lists `@cinatra-ai/*` packages). Tests are skipped standalone; the monorepo runs them.

## Test Types

**Unit Tests:** Not present in this repo. The gate's pure functions are designed to be unit-testable by the monorepo.

**Integration Tests:** Not applicable.

**E2E Tests:** Not applicable.

## Common Patterns

**Async Testing:** Not applicable — all gate functions are synchronous.

**Error Testing:** The gate returns `string[]` rather than throwing, making error-path testing straightforward:

```js
// Pattern the gate uses (mirrors what tests would assert against):
const errors = validateAgent("/some/package/root");
// errors.length === 0 → pass
// errors[0] === "cinatra/oas.json [field] token: reason" → specific violation
```

---

*Testing analysis: 2026-06-09*
