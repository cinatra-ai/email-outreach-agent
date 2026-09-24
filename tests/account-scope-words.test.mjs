// Account scope — the words the step shows are the agent's own declaration.
//
// The list-picker binding's `params` reach the host's renderer verbatim, so
// the question the step asks and the message a person reads when there is
// nothing to pick yet are declared here, on that binding, and nowhere else
// (cinatra-ai/cinatra#3358). The gate step in the service description keeps
// naming the renderer only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

const LIST_PICKER_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const QUESTION = "Which views or lists in your CRM should this run take its recipients from?";
const EMPTY_STATE =
  "There are no views or lists to pick from yet. Create one in your CRM, then open this step again.";

const bindings = pkg.cinatra.fieldRenderers.filter((r) => r.id === LIST_PICKER_ID);
const listPicker = bindings[0];
const params = listPicker?.params ?? {};

test("the account scope binding declares the question the step asks", () => {
  assert.equal(bindings.length, 1, `expected exactly one "${LIST_PICKER_ID}" binding`);
  assert.equal(params.question, QUESTION);
});

test("the account scope binding declares the message shown when there is nothing to pick", () => {
  assert.equal(params.emptyState, EMPTY_STATE);
});

test("the declared words are plain, name no product, route or package, and fit the params budget", () => {
  for (const key of ["question", "emptyState"]) {
    const value = params[key];
    if (value === undefined) continue; // presence is the two arms above
    assert.equal(typeof value, "string", `${key} must be a string`);
    assert.ok(value.length > 0, `${key} must not be empty`);
    assert.equal(value, value.trim(), `${key} must be trimmed`);
    assert.ok(!value.includes("Twenty"), `${key} names a product`);
    assert.ok(!/(^|\s)\//.test(value), `${key} carries a slash-led route`);
    assert.ok(!value.includes("http"), `${key} carries an address`);
    assert.ok(!value.includes("@cinatra-ai/"), `${key} names a package`);
  }
  if (params.question !== undefined) {
    assert.ok(params.question.endsWith("?"), "the question must end with a question mark");
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(params), "utf8") <= 2048,
    "the binding's params exceed the 2048-byte budget",
  );
});

test("the binding and the gate step keep everything else as it was", () => {
  assert.ok(listPicker, `the manifest stopped declaring the "${LIST_PICKER_ID}" renderer`);
  assert.equal(listPicker.kind, "list-picker");
  assert.equal(listPicker.priority, 90);
  assert.equal(params.selection, "multiple");
  assert.equal(params.minSelected, 1);

  const gateSteps = oas.$referenced_components?.recipients_flow?.metadata?.cinatra?.gateSteps;
  assert.ok(Array.isArray(gateSteps), "recipients_flow stopped declaring its gate steps");
  const steps = gateSteps.filter((n) => n.name === "Account scope");
  assert.equal(steps.length, 1, "expected exactly one Account scope gate step");
  const [step] = steps;
  assert.equal(step.renderer, LIST_PICKER_ID);
  assert.equal(step.gateCount, 1);
  assert.equal(step.hitlOwnedBy, "self");
  assert.ok(!("question" in step), "the gate step declares a question of its own");
  assert.ok(!("emptyState" in step), "the gate step declares an empty-state message of its own");
});
