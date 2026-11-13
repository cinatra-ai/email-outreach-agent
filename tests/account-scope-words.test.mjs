// Account scope — the words the step shows are the agent's own declaration.
//
// The list-picker binding's `params` reach the host's renderer verbatim, so
// the question the step asks and the message a person reads when there is
// nothing to pick yet are declared here, on that binding, and nowhere else
// (cinatra-ai/cinatra#3358). The gate step in the service description keeps
// naming the renderer only.
//
// The recipient selection package declares the same binding, and the
// application refuses two declarations of one binding whose params differ. So
// the params here are the ones that package declares at
// cinatra-ai/email-recipient-selection-agent 0c0517fb (cinatra-ai/cinatra#3562):
// the empty-state words name the CRM the lists are read from, and the refresh
// value is the answer its flow reads as "read the lists again".

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
  "There are no views or lists in Twenty CRM to pick from yet. Create one in Twenty CRM.";
const REFRESH_VALUE = "refresh";

// The params of the same binding as cinatra-ai/email-recipient-selection-agent
// declares it at 0c0517fb, key for key.
const RECIPIENT_SELECTION_PARAMS = {
  selection: "multiple",
  minSelected: 1,
  question: QUESTION,
  emptyState: EMPTY_STATE,
  refreshValue: REFRESH_VALUE,
};

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

test("the binding declares exactly the params the recipient selection package declares", () => {
  assert.deepEqual(params, RECIPIENT_SELECTION_PARAMS);
  assert.deepEqual(Object.keys(params), Object.keys(RECIPIENT_SELECTION_PARAMS));
});

test("the declared refresh value is the answer the embedded branch reads as a re-read", () => {
  const copy = oas.$referenced_components?.["email-recipient-selection-subflow"];
  const branch = copy?.$referenced_components?.["recipients-scope_branch"];
  assert.equal(branch?.component_type, "BranchingNode", "the embedded copy has no branch after the account scope");
  assert.deepEqual(branch.mapping, { [REFRESH_VALUE]: "refresh" });
  const reRead = copy.control_flow_connections.filter(
    (e) => e.from_node?.$component_ref === "recipients-scope_branch" && e.from_branch === "refresh",
  );
  assert.deepEqual(
    reRead.map((e) => e.to_node?.$component_ref),
    ["recipients-fetch_lists"],
    "the refresh branch does not go back to the list read",
  );
});

test("the declared words are plain, name no route or package, and fit the params budget", () => {
  for (const key of ["question", "emptyState"]) {
    const value = params[key];
    if (value === undefined) continue; // presence is the two arms above
    assert.equal(typeof value, "string", `${key} must be a string`);
    assert.ok(value.length > 0, `${key} must not be empty`);
    assert.equal(value, value.trim(), `${key} must be trimmed`);
    if (key === "question") assert.ok(!value.includes("Twenty"), `${key} names a product`);
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
