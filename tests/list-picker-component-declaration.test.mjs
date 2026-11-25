// The list step's own component — zero-dependency, runs under tests/run.mjs.
//
// cinatra-ai/cinatra#3562: the list step takes several picks, and its rows are
// drawn by a component this package ships, not by the application. The
// `@cinatra-ai/email-outreach-agent:list-picker` binding names that component
// as its `component.entry` (props contract version 1), so the application
// mounts it for the account scope step and hands it the binding's params.
//
// These arms read the declaration and the module's source only; the module's
// behaviour is read in tests/list-picker-renderer.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const copies = JSON.parse(readFileSync(path.join(root, "scripts/embedded-copies.json"), "utf8"));

const LIST_PICKER_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const ENTRY = "./src/renderers/list-picker.ts";
// The squash of cinatra-ai/email-recipient-selection-agent#51, which reads the
// CRM's lists before the account scope and declares the refresh branch.
const RECIPIENT_SELECTION_COMMIT = "0c0517fbb4855f23f24f23fe0f094d9026b99a41";

const binding = (pkg.cinatra.fieldRenderers ?? []).find((r) => r.id === LIST_PICKER_ID);

test("the list step's binding names this package's component, props contract 1", () => {
  assert.ok(binding, `the manifest does not declare "${LIST_PICKER_ID}"`);
  assert.deepEqual(binding.component, { entry: ENTRY, propsApiVersion: 1 });
});

test("the component entry is a file of this package", () => {
  assert.ok(existsSync(path.join(root, ENTRY)), `${ENTRY} does not exist`);
});

test("the component imports nothing but react", () => {
  const file = path.join(root, ENTRY);
  assert.ok(existsSync(file), `${ENTRY} does not exist`);
  const source = readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const bare = [...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set([...specifiers, ...bare, ...dynamic])], ["react"]);
  assert.ok(!/\brequire\s*\(/.test(source), "the component calls require");
});

test("the declared react peer is optional, and no first-party package is a dependency", () => {
  assert.equal(pkg.peerDependencies?.react, "^19.0.0");
  assert.equal(pkg.peerDependenciesMeta?.react?.optional, true);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const firstParty = Object.keys(pkg[field] ?? {}).filter((name) => name.startsWith("@cinatra-ai/"));
    assert.deepEqual(firstParty, [], `${field} names a first-party package`);
  }
});

test("the embedded recipient selection copy is taken from the commit that reads the lists", () => {
  const group = copies.find((g) => g.copyId === "email-recipient-selection-subflow");
  assert.ok(group, "the declared list carries no recipient selection copy");
  assert.equal(group.commit, RECIPIENT_SELECTION_COMMIT);
});

// The recipient selection package declares this same binding, and the
// application refuses two declarations of one binding that differ (kind,
// priority, flags, params and component). Its version 0.1.4 named three
// different declarations of it, so only a version floor above 0.1.4 can
// require the one below. Fixture: the declaration of
// cinatra-ai/email-recipient-selection-agent at commit ef807294 (params and
// component), which its version 0.1.5 is the first to carry for every commit
// (its test "the package version is at least the first version that carries
// this declaration"). The embedded flow copy is pinned at 0c0517fb; the child's
// cinatra/oas.json is the same blob there and at ef807294.
const CHILD_FIRST_VERSION_WITH_THIS_DECLARATION = "0.1.5";
const CHILD_DECLARATION_AT_EF807294 = {
  id: "@cinatra-ai/email-outreach-agent:list-picker",
  kind: "list-picker",
  priority: 90,
  params: {
    selection: "multiple",
    minSelected: 1,
    question: "Which views or lists in your CRM should this run take its recipients from?",
    emptyState: "There are no views or lists in Twenty CRM to pick from yet. Create one in Twenty CRM.",
    refreshValue: "refresh",
  },
  component: { entry: "./src/renderers/list-picker.ts", propsApiVersion: 1 },
};

/** The application's comparable form of a binding (agent-binding-kinds.mjs `comparableFieldRendererBinding`). */
const comparable = (e) =>
  JSON.stringify({
    kind: e.kind,
    priority: e.priority,
    midRunHitl: e.midRunHitl === true,
    a2uiTranslator: e.a2uiTranslator ?? null,
    params: e.params ?? null,
    component: e.component ?? null,
  });

test("the recipient selection range starts at the child version that carries the same declaration", () => {
  assert.equal(comparable(binding), comparable(CHILD_DECLARATION_AT_EF807294), "this binding differs from the child's");
  const edges = [
    ...(pkg.cinatra.dependencies ?? []),
    ...(pkg.cinatra.agentDependencies ?? []),
  ].filter((edge) => edge.packageName === "@cinatra-ai/email-recipient-selection-agent");
  assert.ok(edges.length > 0, "the manifest declares no recipient selection dependency");
  for (const edge of edges) {
    assert.deepEqual(edge.versionConstraint, {
      kind: "semver-range",
      range: `^${CHILD_FIRST_VERSION_WITH_THIS_DECLARATION}`,
    });
  }
});

// The application installs this package from its packed artifact, which holds
// only what the manifest's `files` allow-list names (with package.json, the
// README and the LICENSE). A component entry outside that list is absent from
// the installed package even though it exists in this checkout.
test("the packed package carries the component entry", () => {
  const allow = pkg.files;
  assert.ok(Array.isArray(allow) && allow.length > 0, "the manifest declares no files allow-list");
  for (const pattern of allow) {
    assert.equal(typeof pattern, "string", "a files entry is not a path");
    assert.ok(!/[*?[\]{}!]/.test(pattern), `the files entry "${pattern}" is a pattern this arm does not read`);
  }
  const entry = path.posix.normalize(ENTRY);
  const shipped = allow.some((pattern) => {
    const prefix = path.posix.normalize(pattern).replace(/^\.\//, "").replace(/\/+$/, "");
    return entry === prefix || entry.startsWith(`${prefix}/`);
  });
  assert.ok(shipped, `${ENTRY} is not under any entry of the files allow-list ${JSON.stringify(allow)}`);
  assert.ok(!existsSync(path.join(root, ".npmignore")), "an .npmignore file could leave the entry out of the packed package");
});
