// Lifecycle D W8 — the outreach flow itself.
//
// W6 (#3094) declared what this composite promises: five pauses, each named by
// the one screen that draws it, and no setup pause. This suite holds the RUN to
// that declaration — the flow, not the manifest.
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

test("(1) the start form asks for the three setup fields the pause used to ask for", () => {
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
  assert.deepEqual(start.metadata.cinatra.required, ["offeringCompanyWebsite", "callToAction"]);
  assert.equal(start.metadata.cinatra.renderer, `${PKG}:setup-form`);
  assert.equal(start.metadata.cinatra.inputRenderers.callToAction, `${PKG}:cta`);
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
// (2) five pauses, each on the one screen that draws it
// ---------------------------------------------------------------------------

const THE_FIVE = [
  ["recipients-scope_gate", `${PKG}:list-picker`],
  ["recipients-review_gate", "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review"],
  ["ctx-offeringContext-context_select_gate", "@cinatra-ai/context-selection-agent:context-selector"],
  ["drafts-approval_gate", "@cinatra-ai/email-drafting-agent:email-drafts-review"],
  ["sender-approval_gate", "@cinatra-ai/email-delivery-agent:send-confirmation"],
];

test("(2) the run pauses exactly five times", () => {
  assert.deepEqual([...pauses.keys()].sort(), THE_FIVE.map(([id]) => id).sort());
});

test("(2) each pause draws the one screen the manifest declares for it", () => {
  assert.deepEqual(THE_FIVE.map(([, screen]) => screen), flowMeta.hitlScreens);
  for (const [id, screen] of THE_FIVE) {
    assert.equal(screenOf(pauses.get(id)), screen, `the "${id}" pause does not draw ${screen}`);
  }
});

test("(2) no pause draws an intermediate output screen", () => {
  for (const [id, node] of pauses) {
    assert.ok(!String(screenOf(node)).endsWith(":output"), `the "${id}" pause draws an output screen`);
  }
});

test("(2) the two output screens stay on the steps that name them", () => {
  assert.equal(
    recipientsFlow.$referenced_components["recipients-generate"].metadata.cinatra.renderer,
    "@cinatra-ai/email-recipient-selection-agent:output",
  );
  assert.equal(
    draftsFlow.$referenced_components["drafts-draft"].metadata.cinatra.renderer,
    "@cinatra-ai/email-drafting-agent:output",
  );
});

// ---------------------------------------------------------------------------
// (3) the review stops fed with what they review, the three decisions applied
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

test("(3) the drafts review is fed the bodies it reviews, as artifacts", () => {
  const gate = pauses.get("drafts-approval_gate");
  const schema = gate.metadata.cinatra.inputMessageSchema;
  assert.equal(schema["x-renderer"], "@cinatra-ai/email-drafting-agent:email-drafts-review");
  const bodies = schema.properties.draftBodyArtifacts;
  assert.ok(bodies, "the gate is not fed the draft bodies");
  assert.equal(bodies["x-artifact-kind"], "@cinatra-ai/email:body");
  assert.ok(hasDataEdge(draftsFlow, "drafts-draft.draftBodyArtifacts", "drafts-approval_gate.draftBodyArtifacts"));
});

test("(3) both reviews apply the three decisions", () => {
  for (const id of ["recipients-review_gate", "drafts-approval_gate"]) {
    const schema = pauses.get(id).metadata.cinatra.inputMessageSchema;
    assert.deepEqual(schema.properties.decision.enum, DECISIONS, `the "${id}" review does not offer the three decisions`);
    assert.ok(schema.required.includes("decision"), `the "${id}" review does not require a decision`);
  }
});

// ---------------------------------------------------------------------------
// (4) the send confirmation before the send
// ---------------------------------------------------------------------------

test("(4) the confirmation stands before the send, not after it", () => {
  assert.ok(hasEdge(deliveryFlow, "sender-start", "sender-approval_gate"), "the run does not reach the confirmation first");
  assert.ok(hasEdge(deliveryFlow, "sender-approval_gate", "sender-send"), "the confirmation does not gate the send");
  assert.ok(hasEdge(deliveryFlow, "sender-send", "sender-end"));
  assert.ok(!hasEdge(deliveryFlow, "sender-send", "sender-approval_gate"), "the confirmation still stands after the send");
});

test("(4) the campaign id and the sender mailbox are carried to the send step", () => {
  const send = deliveryFlow.$referenced_components["sender-send"];
  const titles = send.inputs.map((i) => i.title);
  assert.ok(titles.includes("campaignId"), "the send step is not given the campaign id");
  assert.ok(titles.includes("senderEmail"), "the send step is not given the sender mailbox");
  assert.ok(deliveryFlow.inputs.some((i) => i.title === "campaignId"), "the send subflow takes no campaign id");
  assert.ok(hasDataEdge(deliveryFlow, "sender-start.campaignId", "sender-send.campaignId"));
  assert.ok(hasDataEdge(deliveryFlow, "sender-start.senderEmail", "sender-send.senderEmail"));
  assert.ok(hasDataEdge(oas, "context_setup.campaignId", "sender_flow.campaignId"), "the campaign id never reaches the send subflow");
  assert.match(send.data.user, /campaignId/, "the send step does not pass the campaign id on");
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
  assert.ok(hasEdge(oas, "sender_flow", "campaign_summary"), "the closing statement does not follow the send");
  assert.ok(hasEdge(oas, "campaign_summary", "end"), "the closing statement does not reach the end");
  assert.ok(!hasEdge(oas, "sender_flow", "end"), "the run can still end without stating its results");
  const outputs = refs.end.outputs.map((o) => o.title);
  for (const title of ["campaignId", "recipientCount", "sendResult"]) {
    assert.ok(outputs.includes(title), `the end node does not carry ${title}`);
  }
});

test("(6) an empty or failed campaign ends in plain language, not in a code", () => {
  const message = refs.campaign_summary.message;
  assert.match(message, /no recipients/i, "an empty campaign has no plain-language ending");
  assert.match(message, /could not be sent|failed/i, "a failed campaign has no plain-language ending");
  assert.match(message, /\{\{ *recipientCount/, "the ending does not state how many recipients were reached");
});
