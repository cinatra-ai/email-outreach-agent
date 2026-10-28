// ---------------------------------------------------------------------------
// A recipient removed on the review is not drafted or mailed — zero-dependency,
// runs under tests/run.mjs. cinatra-ai/cinatra#3089.
//
// The recipients review lets the operator remove recipients. The review's answer
// lists the removals; the platform applies them only when a step after the review
// calls its recipients persist, `email_outreach_recipients_update`, with that
// answer. The persist removes the rows, by contactId, from the run's own recipients
// object, in place. Drafting, recipient filing and the send all read that object
// through `confirmedRecipientsRef`, so they see the reviewed list only if the
// persist ran before them.
//
// This suite runs the outreach's recipients sub-flow as declared in cinatra/oas.json
// (its steps in control order, each step's inputs from its data edges), with:
//   - the review's answer as the operator's input, in the shape the review screen
//     sends (cinatra-ai/email-artifacts src/renderers/campaign-recipients-review.tsx,
//     buildResumePayload: campaignId, approvedRecipientIds, removedRecipients with
//     id, contactId, accountId and recipientEmail, edited; no decision field),
//   - a copy of the platform's recipients persist (cinatra
//     src/app/api/agents/passthrough/recipients-review-seam.ts and
//     packages/agents/src/mcp/recipients-persist-handler.ts): it admits only a run
//     whose package is the id scope of a `campaign-recipients-review` binding with
//     `midRunHitl`, it parses the answer verbatim from the step's input and needs
//     its removedRecipients array, and it removes exactly the rows whose contactId
//     a removal names, in place, from the run's recipients object,
//   - a stand-in for the generating step, which saves the recipients object.
// Then it follows `confirmedRecipientsRef` into the drafting and delivery
// sub-flows and reads what each of their steps would read.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const refs = oas.$referenced_components;

const RECIPIENTS_TYPE = "@cinatra-ai/campaigns:recipients";
const PERSIST_TOOL = "email_outreach_recipients_update";
const REVIEW_KIND = "campaign-recipients-review";

const ROWS = [
  { contactId: "c-1", name: "Ada Example", title: "", email: "ada@example.com", accountId: "a-1", accountName: "Example One" },
  { contactId: "c-2", name: "Ben Example", title: "", email: "ben@example.com", accountId: "a-2", accountName: "Example Two" },
  { contactId: "c-3", name: "Cy Example", title: "", email: "cy@example.com", accountId: "a-3", accountName: "Example Three" },
];

const refOf = (n) => n?.$component_ref;

/** The answer the recipients review screen sends: the kept ids and the explicit removals. */
function reviewAnswer(removedIds) {
  const removed = ROWS.filter((r) => removedIds.includes(r.contactId));
  const kept = ROWS.filter((r) => !removedIds.includes(r.contactId));
  return JSON.stringify({
    campaignId: "campaign-1",
    approvedRecipientIds: kept.map((r) => r.contactId),
    removedRecipients: removed.map((r) => ({
      id: r.contactId,
      contactId: r.contactId,
      accountId: r.accountId,
      recipientEmail: r.email,
    })),
    edited: removed.length > 0,
  });
}

/** Packages the platform's persist admits: the id scope of every mid-run review binding. */
function admittedPackages() {
  return new Set(
    (manifest.cinatra?.fieldRenderers ?? [])
      .filter((b) => b && b.kind === REVIEW_KIND && b.midRunHitl === true && typeof b.id === "string")
      .map((b) => b.id.split(":")[0])
      .filter((pkg) => pkg.length > 0),
  );
}

/** Replaces each `{{ name }}` with the step's input of that name; any other markup is an error. */
function render(template, inputs) {
  const out = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name) => {
    assert.ok(Object.hasOwn(inputs, name), `the template reads '${name}', which no data edge feeds`);
    return String(inputs[name]);
  });
  assert.ok(!/\{\{|\{%/.test(out), `unknown template markup: ${template}`);
  return out;
}

/** The platform's recipients persist, as copied above. */
function persist(store, node, inputs) {
  assert.ok(
    admittedPackages().has(manifest.name),
    `${PERSIST_TOOL} refuses a run of ${manifest.name}: its package declares no ${REVIEW_KIND} mid-run binding`,
  );
  assert.equal(render(node.data.agent_run_id, inputs), "run-1", "the persist is not called for this run");
  const resumePayloadJson = render(node.data.input.resumePayloadJson, inputs);
  const payload = JSON.parse(resumePayloadJson);
  assert.ok(Array.isArray(payload.removedRecipients), "the answer carries no removedRecipients array");
  const removed = payload.removedRecipients.map((r) => (typeof r?.contactId === "string" && r.contactId ? r.contactId : null));
  assert.ok(!removed.includes(null), "a removal names no contactId");
  const bundles = [...store.values()].filter((o) => o.type === RECIPIENTS_TYPE);
  assert.equal(bundles.length, 1, "the run holds no recipients object");
  const kept = bundles[0].data.confirmedRecipients.filter((r) => !removed.includes(r.contactId));
  if (kept.length !== bundles[0].data.confirmedRecipients.length) {
    bundles[0].data = { ...bundles[0].data, confirmedRecipients: kept, recipientCount: kept.length };
  }
  return { ok: true, reviewedRecipients: kept, reviewedCount: kept.length };
}

/** Runs the recipients sub-flow; returns its end values. */
function runRecipients(store, answer) {
  const flow = refs["email-recipient-selection-subflow"];
  const steps = flow.$referenced_components;
  const values = new Map(); // "<step>.<output>" -> value
  const inputsOf = (id) => {
    const out = {};
    for (const e of flow.data_flow_connections) {
      if (refOf(e.destination_node) !== id) continue;
      const key = `${refOf(e.source_node)}.${e.source_output}`;
      assert.ok(values.has(key), `${id}.${e.destination_input} reads ${key} before it is written`);
      out[e.destination_input] = values.get(key);
    }
    return out;
  };
  const flowInputs = { agent_run_id: "run-1", campaignId: "campaign-1" };
  let id = Object.keys(steps).find((k) => steps[k].component_type === "StartNode");
  for (let guard = 0; guard < 50; guard++) {
    const node = steps[id];
    const inputs = inputsOf(id);
    let outputs;
    if (node.component_type === "StartNode") {
      outputs = Object.fromEntries(node.inputs.map((i) => [i.title, flowInputs[i.title] ?? null]));
    } else if (node.component_type === "InputMessageNode" && id.endsWith("scope_gate")) {
      outputs = { accountScope: JSON.stringify(["list-1"]) };
    } else if (node.component_type === "InputMessageNode" && id.endsWith("review_gate")) {
      outputs = { userResponse: answer };
    } else if (node.component_type === "ApiNode" && node.data?.tool === PERSIST_TOOL) {
      outputs = persist(store, node, inputs);
    } else if (node.component_type === "ApiNode" && id.endsWith("generate")) {
      store.set("obj-recipients-1", { type: RECIPIENTS_TYPE, data: { confirmedRecipients: ROWS.map((r) => ({ ...r })) } });
      outputs = { confirmedRecipientsRef: "obj-recipients-1", recipientCount: ROWS.length, confirmedRecipients: ROWS };
    } else if (node.component_type === "EndNode") {
      return inputs;
    } else {
      assert.fail(`step ${id} (${node.component_type}) is not modelled by this suite`);
    }
    for (const [k, v] of Object.entries(outputs)) values.set(`${id}.${k}`, v);
    const next = flow.control_flow_connections.filter((e) => refOf(e.from_node) === id);
    assert.equal(next.length, 1, `step ${id} has ${next.length} next steps`);
    id = refOf(next[0].to_node);
  }
  assert.fail("the recipients sub-flow does not reach its end");
}

/** The recipients ref a step of a later sub-flow reads, followed edge by edge from the recipients sub-flow. */
function refReadBy(flowNodeId, stepId, input, recipientsEnd) {
  const into = oas.data_flow_connections.filter(
    (e) => refOf(e.destination_node) === flowNodeId && refOf(e.source_node) === "recipients_flow",
  );
  assert.equal(into.length, 1, `${flowNodeId} is not fed one value of the recipients sub-flow`);
  const subflow = refs[refOf(refs[flowNodeId].subflow)];
  const start = Object.keys(subflow.$referenced_components).find(
    (k) => subflow.$referenced_components[k].component_type === "StartNode",
  );
  const edge = subflow.data_flow_connections.find(
    (e) =>
      refOf(e.source_node) === start &&
      e.source_output === into[0].destination_input &&
      refOf(e.destination_node) === stepId &&
      e.destination_input === input,
  );
  assert.ok(edge, `${stepId}.${input} does not read ${flowNodeId}.${into[0].destination_input}`);
  return recipientsEnd[into[0].source_output];
}

function readList(store, ref) {
  const obj = store.get(ref);
  assert.ok(obj, `no object at ${ref}`);
  return obj.data.confirmedRecipients.map((r) => r.contactId);
}

test("a recipient removed on the review does not reach drafting", () => {
  const store = new Map();
  const end = runRecipients(store, reviewAnswer(["c-2"]));
  const ref = refReadBy("drafts_flow", "drafts-draft", "confirmedRecipientsRef", end);
  assert.deepEqual(readList(store, ref), ["c-1", "c-3"], "drafting reads a recipient the operator removed");
});

test("a recipient removed on the review is neither filed nor sent", () => {
  const store = new Map();
  const end = runRecipients(store, reviewAnswer(["c-2"]));
  for (const step of ["sender-file_recipients", "sender-send"]) {
    const ref = refReadBy("sender_flow", step, "confirmedRecipientsRef", end);
    assert.deepEqual(readList(store, ref), ["c-1", "c-3"], `${step} reads a recipient the operator removed`);
  }
});

test("the campaign counts the recipients the review kept", () => {
  const store = new Map();
  const end = runRecipients(store, reviewAnswer(["c-1", "c-3"]));
  assert.equal(end.recipientCount, 1, "the recipients sub-flow hands on a count of recipients the review did not keep");
  assert.ok(
    oas.data_flow_connections.some(
      (e) => refOf(e.source_node) === "recipients_flow" && e.source_output === "recipientCount" && refOf(e.destination_node) === "campaign_summary",
    ),
    "the campaign summary does not read the recipients sub-flow's count",
  );
});

test("a review that removes nobody keeps every recipient", () => {
  const store = new Map();
  const end = runRecipients(store, reviewAnswer([]));
  assert.deepEqual(readList(store, refReadBy("drafts_flow", "drafts-draft", "confirmedRecipientsRef", end)), ["c-1", "c-2", "c-3"]);
  assert.equal(end.recipientCount, 3);
});

test("the platform admits the outreach's own run to the recipients persist", () => {
  assert.ok(
    admittedPackages().has(manifest.name),
    `${manifest.name} declares no ${REVIEW_KIND} binding with midRunHitl under its own scope`,
  );
});

test("the review's answer reaches the persist verbatim, as its provenance check needs", () => {
  const flow = refs["email-recipient-selection-subflow"];
  const apply = Object.entries(flow.$referenced_components).filter(([, n]) => n.data?.tool === PERSIST_TOOL);
  assert.equal(apply.length, 1, "the recipients sub-flow carries no recipients persist step");
  const [applyId, node] = apply[0];
  assert.equal(node.data.input.resumePayloadJson, "{{ resumePayload }}");
  assert.ok(
    flow.data_flow_connections.some(
      (e) =>
        refOf(e.source_node) === "recipients-review_gate" &&
        e.source_output === "userResponse" &&
        refOf(e.destination_node) === applyId &&
        e.destination_input === "resumePayload",
    ),
    "the review's answer does not feed the persist",
  );
  assert.ok(
    flow.control_flow_connections.some(
      (e) => refOf(e.from_node) === "recipients-review_gate" && refOf(e.to_node) === applyId,
    ),
    "the persist does not follow the review",
  );
});

test("the screen's answer carries no decision, and the recipients road needs none", () => {
  assert.equal(Object.hasOwn(JSON.parse(reviewAnswer(["c-2"])), "decision"), false);
  const flow = refs["email-recipient-selection-subflow"];
  const branching = Object.entries(flow.$referenced_components).filter(([, n]) => n.component_type === "BranchingNode");
  assert.deepEqual(branching.map(([id]) => id), [], "a step of the recipients sub-flow branches on the answer");
  const readers = flow.data_flow_connections.filter(
    (e) => refOf(e.source_node) === "recipients-review_gate" && e.source_output === "userResponse",
  );
  for (const e of readers) {
    const to = refOf(e.destination_node);
    assert.ok(
      to === "recipients-end" || flow.$referenced_components[to]?.data?.tool === PERSIST_TOOL,
      `${to} reads the review's answer`,
    );
  }
  assert.ok(
    !oas.data_flow_connections.some((e) => refOf(e.source_node) === "recipients_flow" && e.source_output === "userResponse"),
    "a later step of the outreach reads the review's answer",
  );
});

// The review screen's binding, @cinatra-ai/email-recipient-selection-agent:campaign-recipients-review,
// is declared by @cinatra-ai/email-artifacts at priority 80. Every binding of the kind also
// answers to the kind's bare name, and the higher priority wins it.
const SCREEN_BINDING_PRIORITY = 80;

test("the outreach's own binding never outranks the review screen's binding", () => {
  const own = (manifest.cinatra?.fieldRenderers ?? []).filter((b) => b?.kind === REVIEW_KIND);
  assert.equal(own.length, 1, `${manifest.name} declares ${own.length} ${REVIEW_KIND} bindings`);
  assert.equal(own[0].id, `${manifest.name}:${REVIEW_KIND}`);
  assert.ok(Number.isInteger(own[0].priority) && own[0].priority < SCREEN_BINDING_PRIORITY, `priority ${own[0].priority}`);
  assert.equal(own[0].component, undefined, "the outreach ships no display of its own");
});
