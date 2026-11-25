// Lifecycle D W8 — the outreach flow itself.
//
// W6 (#3094) declared what this composite promises: five pauses and no setup
// pause. This suite holds the RUN to that declaration — the flow, not the
// manifest. Since cinatra#3089 two of the five are drawn by the application
// itself: the drafts review on its review card (one review per filed body) and
// the send on its publish card, in front of the top-level publishing step; the
// other three are drawn by the screens the manifest declares.
//
// Items (1)-(6) of cinatra#3096, each asserted on cinatra/oas.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

const PKG = "@cinatra-ai/email-outreach-agent";
const refs = oas.$referenced_components;
const flowMeta = oas.metadata.cinatra;

const recipientsFlow = refs["email-recipient-selection-subflow"];
const draftsFlow = refs["email-drafting-subflow"];
const deliveryFlow = refs["email-delivery-subflow"];
const send = refs.send;

/** Every InputMessageNode in the composite, parent flow and inlined subflows. */
function collectPauses(node, out = new Map()) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectPauses(v, out);
    return out;
  }
  if (node.component_type === "InputMessageNode" && typeof node.id === "string") out.set(node.id, node);
  for (const v of Object.values(node)) collectPauses(v, out);
  return out;
}

const pauses = collectPauses(oas);

/** The screen a pause draws: its own renderer, or the renderer of its one input. */
function screenOf(node) {
  const meta = node.metadata?.cinatra ?? {};
  if (typeof meta.renderer === "string") return meta.renderer;
  const inputRenderers = Object.values(meta.inputRenderers ?? {});
  return inputRenderers.length === 1 ? inputRenderers[0] : undefined;
}

const edges = (flow) =>
  (flow.control_flow_connections ?? []).map((e) => [
    e.from_node.$component_ref,
    e.to_node.$component_ref,
    e.from_branch ?? null,
  ]);
const hasEdge = (flow, from, to) => edges(flow).some(([f, t]) => f === from && t === to);
const dataEdges = (flow) =>
  (flow.data_flow_connections ?? []).map((e) => [
    e.source_node.$component_ref + "." + e.source_output,
    e.destination_node.$component_ref + "." + e.destination_input,
  ]);
const hasDataEdge = (flow, from, to) => dataEdges(flow).some(([f, t]) => f === from && t === to);

// ---------------------------------------------------------------------------
// (1) the setup pause folded into the start form, the data gate retired
// ---------------------------------------------------------------------------

test("(1) the setup pause is gone from the flow", () => {
  assert.equal(pauses.get("setup_gate"), undefined, "setup_gate is still a pause");
  assert.ok(hasEdge(oas, "start", "context_setup"), "the run no longer starts straight into the setup write");
});

test("(1) the start form asks for the three setup fields the pause used to ask for, and the sender mailbox", () => {
  const start = refs.start;
  const titles = start.inputs.map((i) => i.title);
  for (const field of ["offeringCompanyWebsite", "callToAction", "senderName"]) {
    assert.ok(titles.includes(field), `the start form does not ask for ${field}`);
    assert.ok(
      oas.inputs.some((i) => i.title === field),
      `${field} is not a flow input`,
    );
    assert.ok(!(start.metadata.cinatra.hidden ?? []).includes(field), `${field} is hidden on the start form`);
  }
  // The setup form draws exactly the fields named in metadata.cinatra.required,
  // so all three of the fields the retired pause used to ask for are named there,
  // and the sender mailbox the send takes (the send is a step of this flow now,
  // so the delivery copy no longer asks for it).
  assert.deepEqual(start.metadata.cinatra.required, ["offeringCompanyWebsite", "callToAction", "senderName", "senderEmail"]);
  assert.equal(start.metadata.cinatra.renderer, `${PKG}:setup-form`);
  assert.equal(start.metadata.cinatra.inputRenderers.callToAction, `${PKG}:cta`);
  assert.equal(start.metadata.cinatra.inputRenderers.senderEmail, `${PKG}:gmail-sender`);
  assert.ok(titles.includes("senderEmail") && oas.inputs.some((i) => i.title === "senderEmail"));
});

test("(1) the setup write reads the start form, not a gate output", () => {
  for (const field of ["offeringCompanyWebsite", "callToAction", "senderName"]) {
    assert.ok(hasDataEdge(oas, `start.${field}`, `context_setup.${field}`), `context_setup does not read ${field}`);
  }
  assert.ok(
    !dataEdges(oas).some(([from]) => from.startsWith("setup_gate.")),
    "a data edge still leaves the retired setup pause",
  );
});

test("every start-node input is either drawn on a form or supplied by the flow", () => {
  const starts = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.component_type === "StartNode") starts.push(node);
    Object.values(node).forEach(walk);
  };
  walk(oas);
  assert.ok(starts.length > 0, "the composite has no start node");
  for (const start of starts) {
    const required = new Set(start.metadata?.cinatra?.required ?? []);
    const hidden = new Set(start.metadata?.cinatra?.hidden ?? []);
    for (const input of start.inputs ?? []) {
      assert.ok(
        required.has(input.title) || hidden.has(input.title),
        `${start.id}.${input.title} is neither drawn on a form nor supplied by the flow`,
      );
    }
  }
});

test("(1) the drafting data gate is retired and its failure ends the run with its reason", () => {
  assert.equal(pauses.get("drafts-data_gate"), undefined, "the data gate is still a pause");
  const missing = edges(draftsFlow).find(([from, , branch]) => from === "drafts-check_inputs" && branch === "default");
  assert.ok(missing, "the missing-inputs branch is gone");
  const [, target] = missing;
  const node = draftsFlow.$referenced_components[target];
  assert.equal(node.component_type, "OutputMessageNode", "the missing-inputs branch no longer ends the run");
  assert.match(node.message, /recipient/i, "the ending does not state the reason it stopped");
  assert.ok(hasEdge(draftsFlow, target, "drafts-end"), "the stated reason does not reach the end");
});

// ---------------------------------------------------------------------------
// (2) five pauses: three on the screens the manifest declares, two on the
//     application's own cards
// ---------------------------------------------------------------------------

const DRAWN = [
  ["recipients-scope_gate", `${PKG}:list-picker`],
  ["recipients-review_gate", "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review"],
  ["ctx-offeringContext-context_select_gate", "@cinatra-ai/context-selection-agent:context-selector"],
];
const REVIEWED = "drafts-approval_gate";

test("(2) the run pauses exactly five times", () => {
  // Four pauses are steps of the flow; the fifth is the stop the application
  // inserts in front of the one top-level publishing step.
  assert.deepEqual([...pauses.keys()].sort(), [...DRAWN.map(([id]) => id), REVIEWED].sort());
  const publishing = oas.nodes.map((n) => n.$component_ref).filter((id) => refs[id]?.metadata?.cinatra?.publishes === true);
  assert.deepEqual(publishing, ["send"]);
});

test("(2) each pause draws the one screen the manifest declares for it, or the application's card", () => {
  assert.deepEqual(DRAWN.map(([, screen]) => screen), flowMeta.hitlScreens);
  for (const [id, screen] of DRAWN) {
    assert.equal(screenOf(pauses.get(id)), screen, `the "${id}" pause does not draw ${screen}`);
  }
  // The drafts review draws no screen of its own: its marker names the filed
  // bodies, and the application opens one review per body on its review card.
  const review = pauses.get(REVIEWED).metadata.cinatra;
  assert.equal(screenOf(pauses.get(REVIEWED)), undefined);
  assert.deepEqual(review.artifactReview, { targetsInput: "reviewTargets" });
  // The send draws no screen of its own: the application's publish card shows its rows.
  assert.equal(send.metadata.cinatra.publishes, true);
  assert.deepEqual(send.metadata.cinatra.publishRows.map((row) => row.label), ["From", "Recipients", "Emails", "Call to action"]);
});

test("(2) no pause draws an intermediate output screen", () => {
  for (const [id, node] of pauses) {
    assert.ok(!String(screenOf(node)).endsWith(":output"), `the "${id}" pause draws an output screen`);
  }
});

test("(2) the recipients output screen stays on the step that names it, and the drafting step draws none", () => {
  assert.equal(
    recipientsFlow.$referenced_components["recipients-generate"].metadata.cinatra.renderer,
    "@cinatra-ai/email-recipient-selection-agent:output",
  );
  assert.equal(draftsFlow.$referenced_components["drafts-draft"].metadata.cinatra.renderer, undefined);
});

// ---------------------------------------------------------------------------
// (3) the review stops fed with what they review
// ---------------------------------------------------------------------------

const DECISIONS = ["approve", "revise", "reject"];

test("(3) the recipients review is fed the recipients it reviews", () => {
  const gate = pauses.get("recipients-review_gate");
  const schema = gate.metadata.cinatra.inputMessageSchema;
  assert.equal(schema["x-renderer"], "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review");
  assert.ok(schema.properties.confirmedRecipients, "the gate is not fed the recipients");
  assert.ok(schema.properties.recipientCount, "the gate is not fed the recipient count");
  assert.ok(hasDataEdge(recipientsFlow, "recipients-generate.confirmedRecipients", "recipients-review_gate.confirmedRecipients"));
  assert.ok(hasDataEdge(recipientsFlow, "recipients-generate.recipientCount", "recipients-review_gate.recipientCount"));
});

test("(3) the drafts review is fed the bodies it reviews, as filed email bodies", () => {
  const file = draftsFlow.$referenced_components["drafts-file_drafts"];
  assert.equal(file.data.tool, "artifact_materialize");
  assert.equal(file.data.input.objectTypeId, "@cinatra-ai/email:body");
  assert.equal(file.data.input.node_id, "drafts-file_drafts");
  const gate = pauses.get(REVIEWED);
  assert.equal(gate.metadata.cinatra.surfaceGateInputs, true);
  assert.ok(gate.inputs.some((i) => i.title === "reviewTargets"));
  assert.ok(hasDataEdge(draftsFlow, "drafts-file_drafts.reviewTargets", "drafts-approval_gate.reviewTargets"));
  assert.ok(hasEdge(draftsFlow, "drafts-file_drafts", "drafts-approval_gate"), "the review does not follow the filing");
});

test("(3) the recipients review applies the three decisions, and the drafts review requires an answer", () => {
  const schema = pauses.get("recipients-review_gate").metadata.cinatra.inputMessageSchema;
  assert.deepEqual(schema.properties.decision.enum, DECISIONS, "the recipients review does not offer the three decisions");
  assert.ok(schema.required.includes("decision"), "the recipients review does not require a decision");
  const drafts = pauses.get(REVIEWED).metadata.cinatra;
  assert.equal(drafts.requiresApproval, true);
  assert.deepEqual(drafts.inputMessageSchema.required, ["userResponse"]);
});

// ---------------------------------------------------------------------------
// (4) the publish stop before the send
// ---------------------------------------------------------------------------

test("(4) the send is a top-level step of the flow, after the prepared send and the person's release", () => {
  // The delivery copy prepares the send and sends nothing: it files the
  // recipient records and reads what the send mails. The send is carried to the
  // top level, where the application stops the run in front of it.
  assert.ok(hasEdge(deliveryFlow, "sender-start", "sender-file_recipients"));
  assert.ok(hasEdge(deliveryFlow, "sender-file_recipients", "sender-resolve_send"));
  assert.ok(hasEdge(deliveryFlow, "sender-resolve_send", "sender-end"));
  assert.equal(deliveryFlow.$referenced_components["sender-resolve_send"].metadata.cinatra.riskClass, "read_only");
  assert.equal(deliveryFlow.$referenced_components["sender-send"], undefined, "the send is still nested in the copy");
  assert.ok(hasEdge(oas, "sender_flow", "send"), "the send does not follow the prepared send");
  assert.ok(hasEdge(oas, "send", "campaign_summary"));
  assert.deepEqual(edges(oas).filter(([, to]) => to === "send").map(([from]) => from), ["sender_flow"]);
  assert.equal(send.metadata.cinatra.requiresApproval, false, "a second approval stands beside the publish card");
});

test("(4) the campaign id and the sender mailbox are carried to the send step", () => {
  const titles = send.inputs.map((i) => i.title);
  assert.ok(titles.includes("campaignId"), "the send step is not given the campaign id");
  assert.ok(titles.includes("senderEmail"), "the send step is not given the sender mailbox");
  assert.ok(hasDataEdge(oas, "context_setup.campaignId", "send.campaignId"), "the campaign id never reaches the send");
  assert.ok(hasDataEdge(oas, "start.senderEmail", "send.senderEmail"), "the sender mailbox never reaches the send");
  assert.equal(send.data.input.senderEmail, "{{ senderEmail }}");
  assert.match(send.data.input.campaignId, /\{\{ campaignId \}\}$/, "the send step does not pass the campaign id on");
});

// ---------------------------------------------------------------------------
// (5) the drafting step reads the pinned context through the artifact read road
// ---------------------------------------------------------------------------

test("(5) the drafting step reads the pinned context through the artifact read road", () => {
  const draft = draftsFlow.$referenced_components["drafts-draft"];
  assert.ok(
    (draft.inputs ?? []).some((i) => i.title === "contextSlotBindings"),
    "the drafting step declares no context bindings input",
  );
  assert.ok(hasDataEdge(draftsFlow, "drafts-start.contextSlotBindings", "drafts-draft.contextSlotBindings"));
  assert.match(draft.data.system, /artifact_representation_get/, "the drafting step does not use the artifact read road");
  assert.ok(
    !/offeringContextSlotId|contextProjectId/.test(JSON.stringify(draft)),
    "the drafting step still reaches into the parent's slot",
  );
});

// ---------------------------------------------------------------------------
// (6) the end node states the campaign's results, in plain language
// ---------------------------------------------------------------------------

test("(6) the run ends stating the campaign's results", () => {
  const summary = refs.campaign_summary;
  assert.ok(summary, "the run has no closing statement");
  assert.equal(summary.component_type, "OutputMessageNode");
  assert.ok(hasEdge(oas, "send", "campaign_summary"), "the closing statement does not follow the send");
  assert.ok(hasEdge(oas, "campaign_summary", "end"), "the closing statement does not reach the end");
  assert.ok(!hasEdge(oas, "send", "end") && !hasEdge(oas, "sender_flow", "end"), "the run can still end without stating its results");
  const outputs = refs.end.outputs.map((o) => o.title);
  for (const title of ["campaignId", "recipientCount", "status", "sentCount", "errorMessage", "alreadySentCount", "inDoubtCount"]) {
    assert.ok(outputs.includes(title), `the end node does not carry ${title}`);
  }
});

test("(6) an empty or failed campaign ends in plain language, not in a code", () => {
  const message = refs.campaign_summary.message;
  assert.match(message, /no recipients/i, "an empty campaign has no plain-language ending");
  assert.match(message, /could not be sent|failed/i, "a failed campaign has no plain-language ending");
  assert.match(message, /\{\{ *recipientCount/, "the ending does not state how many recipients were reached");
});
