# Coding Conventions

**Analysis Date:** 2026-06-09

## Overview

This is a Cinatra agent extension repo — a source mirror with no `src/` TypeScript to ship. The primary authored artifacts are `skills/email-outreach/SKILL.md` (LLM prompt instructions) and `extension-kind-gate.mjs` (a self-contained Node ESM CI gate script). Conventions below apply to both.

## Naming Patterns

**Files:**
- Skill prompt files: `SKILL.md` (uppercase, Markdown)
- Gate script: `extension-kind-gate.mjs` (kebab-case, `.mjs` ESM suffix)
- CI workflows: `ci.yml`, `release.yml` (kebab-case YAML)
- Cinatra artifacts: `cinatra/oas.json` (flat directory, lowercase)

**Functions (in `extension-kind-gate.mjs`):**
- `camelCase` for all exported and internal functions: `validateAgent`, `validateWorkflow`, `validateBpmnSanity`, `findWorkflowSidecars`, `runGate`, `parseArgs`, `walkLlmStrings`, `scanOasString`
- Private/internal helpers are NOT exported; exported functions form the public API surface

**Variables:**
- `camelCase` for locals and parameters
- `SCREAMING_SNAKE_CASE` for module-level constants: `LLM_VISIBLE_FIELDS`, `BANNED_PRIMITIVES`, `BANNED_TYPEHINTS`, `PRIMITIVE_PATTERNS`, `OBJECTS_LIST_CRM_RE`, `BPMN_MODEL_NS`, `WORKFLOW_PACKAGE_NAME_RE`

**Types:**
- No TypeScript in this repo's own source (tsconfig.json targets a `src/` that does not exist). `extension-kind-gate.mjs` uses plain JavaScript with JSDoc-style inline comments.

## Code Style

**Formatting:**
- No `.prettierrc` or `.eslintrc` present — no enforced formatter detected
- 2-space indentation used throughout `extension-kind-gate.mjs`
- Double-quoted strings throughout JS source
- Trailing commas in multi-line arrays/objects

**Linting:**
- No ESLint config detected. CI runs `node extension-kind-gate.mjs --package-root .` directly without a lint step.

## Module Design

**Module system:** ES Modules (`"type": "module"` in `package.json`). `extension-kind-gate.mjs` uses named `import { ... } from "node:..."` for all builtins.

**Exports:** All validation functions are named exports. The `main()` entry point is NOT exported — it is guarded by a `invokedDirectly` check so the file is importable as a library (for testing) and runnable as a CLI.

```js
// Pattern: guard main() so the module is both importable and directly runnable
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main();
}
```

**Barrel Files:** Not applicable — single-file gate, no module tree.

## Import Organization

**Order (observed in `extension-kind-gate.mjs`):**
1. Node built-in imports only (`node:fs`, `node:path`) — no third-party imports
2. No path aliases (single file, no module resolution needed)

**Zero-dependency constraint:** The gate MUST import only Node builtins. This is enforced by design (CI runs unauthenticated before the `@cinatra-ai` registry is reachable). Any addition of a third-party import would break CI for all extracted repos.

## Error Handling

**Pattern:** Pure functions return `string[]` errors arrays, never throw.

```js
// Pattern: accumulate errors and return — never throw from validators
export function validateAgent(packageRoot) {
  const errors = [];
  // ...
  if (!existsSync(oasPath)) return errors; // early return on missing optional artifact
  try {
    parsed = JSON.parse(readFileSync(oasPath, "utf8"));
  } catch (err) {
    errors.push(`cinatra/oas.json failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  // ...
  return errors;
}
```

**Error message format:** Structured as `"<context>: <explanation>"` — always includes the offending value or file path, always provides a fix hint.

**Top-level:** `main()` wraps execution in `try/catch` and calls `process.exit(1)` on unexpected errors. Exit codes: `0` = pass, `1` = violations.

## Logging

**Framework:** `console.log` (pass) and `console.error` (violations). No logging library.

**Patterns:**
- Pass: `console.log("✓ extension-kind-gate: agent extension passed.")`
- Fail: `console.error("✗ extension-kind-gate: N violations:\n")` then per-violation `console.error("  • ...")`

## Comments

**When to Comment:**
- Module-level block comments explain the design rationale and intentional constraints (e.g., why zero-dependency, scope boundaries, what the marketplace re-validates)
- Section dividers use `// ----` lines with a heading
- Individual functions have a JSDoc-style block comment when non-obvious

**Skill prompt (SKILL.md):**
- Steps are numbered with `STEP X.Y —` prefix
- Field references use backtick code formatting inline
- `Do NOT` convention used for explicit prohibitions (capitalized, bold intent)

## Function Design

**Size:** Validator functions are focused — each validates exactly one concern (`validateAgent`, `validateWorkflow`, `validateBpmnSanity`, `validateWorkflowPackageShape`, `findWorkflowSidecars`).

**Parameters:** Single `packageRoot` string for validators, or primitive values for pure helpers.

**Return Values:** Always `string[]` for validators (empty = pass), `{ kind, errors }` for the top-level dispatcher `runGate`.

## Skill Prompt Conventions (SKILL.md)

- Stage/step numbering: `Stage N — Title` and `STEP N.M — Description`
- Tool calls documented with field-by-field breakdown
- Variable assignments written as `Save it as <varName>`
- Prohibitions written as `Do NOT <action> — <reason>`
- Input references use `input.<fieldName>` dotted notation
- Conditionals written inline: `(if provided; omit if not)`

---

*Convention analysis: 2026-06-09*
