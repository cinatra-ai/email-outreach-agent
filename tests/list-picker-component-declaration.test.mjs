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
