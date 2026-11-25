// ---------------------------------------------------------------------------
// The send is the flow's one top-level publishing step, and it runs only after
// a person released it - zero-dependency, runs under tests/run.mjs.
// cinatra-ai/cinatra#3089.
//
// The application stops a run in front of a publishing step only when that step
// is a TOP-LEVEL node of the root flow (a key of the root $referenced_components
// listed in the root nodes, of an action kind, declaring
// metadata.cinatra.publishes as the boolean true): the compiler's
// collectPublishingSteps refuses publishes: true anywhere else. It shows the
// step's publish card (its publishRows) and lets the run reach the step only
// after the person chose to send. The passthrough road serves the send start
// (email_outreach_send_initial_start) only as the literal data.tool of such a
// top-level /api/agents/passthrough step whose newest publish decision is
// released, once.
//
// So the delivery copy (sender_flow) prepares the send and the group's hoist
// carries the delivery agent's own send step, unchanged, to the outreach's top
// level as `send` (scripts/embedded-copies.json). This suite holds the flow to
// that shape and to the edges into the send: every input the send takes is fed
// by exactly one data edge from a step that has that output, and no edge of the
// root flow names an input or an output its step does not have.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { serialize } from "../scripts/embedded-copies.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const refs = oas.$referenced_components;
const send = refs.send;
const refOf = (node) => (node && typeof node === "object" ? node.$component_ref : undefined);
const topLevel = oas.nodes.map(refOf);
const SEND_TOOL = "email_outreach_send_initial_start";
const ACTION_KINDS = new Set(["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"]);

/** Every component of the composite, the copies' steps included, with the flow it sits in. */
function everyNode(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) everyNode(v, out);
    return out;
  }
  if (typeof node.component_type === "string" && typeof node.id === "string") out.push(node);
  for (const v of Object.values(node)) everyNode(v, out);
  return out;
}

/** The outputs a root step hands on: a start its inputs, a FlowNode its sub-flow's outputs, else its own. */
function gives(id) {
  const node = refs[id];
  if (!node) return null;
  if (node.component_type === "StartNode") return node.inputs.map((i) => i.title);
  if (node.component_type === "FlowNode") return refs[refOf(node.subflow)].outputs.map((o) => o.title);
  return (node.outputs ?? []).map((o) => o.title);
}

/** The inputs a root step takes: an end its outputs, a FlowNode its sub-flow's inputs, else its own. */
function takes(id) {
  const node = refs[id];
  if (!node) return null;
  if (node.component_type === "EndNode") return node.outputs.map((o) => o.title);
  if (node.component_type === "FlowNode") return refs[refOf(node.subflow)].inputs.map((i) => i.title);
  return (node.inputs ?? []).map((i) => i.title);
}

const edgesInto = (id, input) =>
  oas.data_flow_connections.filter((e) => refOf(e.destination_node) === id && e.destination_input === input);

test("the send is a top-level step of the root flow and its one publishing step", () => {
  assert.ok(send, "the root flow carries no send step");
  assert.equal(send.id, "send");
  assert.ok(topLevel.includes("send"), "the send is not listed among the root flow's nodes");
  assert.equal(send.component_type, "ApiNode");
  assert.ok(ACTION_KINDS.has(send.component_type));
  assert.equal(send.metadata.cinatra.publishes, true);
  const publishing = everyNode(oas).filter((n) => n.metadata?.cinatra?.publishes === true).map((n) => n.id);
  assert.deepEqual(publishing, ["send"], "another step declares publishes: true");
  // The prepared send declares that it publishes nothing; it files records and reads, inside Cinatra.
  assert.equal(refs.sender_flow.metadata.cinatra.publishes, false);
  assert.equal(refs.sender_flow.metadata.cinatra.packageName, "@cinatra-ai/email-delivery-agent");
});

test("the send is a model-free call of the send start on the passthrough road, the step the road serves it to", () => {
  assert.equal(send.url, "{{CINATRA_BASE_URL}}/api/agents/passthrough");
  assert.equal(send.http_method, "POST");
  assert.equal(send.data.tool, SEND_TOOL, "the call names no literal tool");
  assert.equal(send.data.agent_run_id, "{{ agent_run_id }}");
  // Each argument is a template over one of the step's own inputs: no model writes one.
  const inputs = new Set(send.inputs.map((i) => i.title));
  for (const [key, value] of Object.entries(send.data.input)) {
    const names = [...value.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `the argument ${key} is not a template`);
    for (const name of names) assert.ok(inputs.has(name), `the argument ${key} renders ${name}, which is no input of the send`);
  }
  // No other step of the composite names the send tools: only this step can send.
  for (const node of everyNode(oas)) {
    if (node.id === "send") continue;
    assert.ok(!JSON.stringify(node.data ?? {}).includes("email_outreach_send_"), `${node.id} names a send tool`);
  }
});

test("the send is the delivery agent's own send step, carried to the top level unchanged", () => {
  const fixture = readFileSync(path.join(root, "tests/fixtures/email-outreach-delivery-send.json"), "utf8");
  assert.equal(serialize(send), fixture, "the top-level send differs from the delivery agent's send step");
  assert.equal(refs["email-delivery-subflow"].$referenced_components["sender-send"], undefined, "the send is also nested in the copy");
});

test("the send follows the prepared send and the person's release, and the run ends through the closing statement", () => {
  const control = oas.control_flow_connections.map((e) => [refOf(e.from_node), refOf(e.to_node)]);
  assert.deepEqual(control.filter(([, to]) => to === "send").map(([from]) => from), ["sender_flow"], "the send is reached from another step");
  assert.deepEqual(control.filter(([from]) => from === "send").map(([, to]) => to), ["campaign_summary"]);
  assert.deepEqual(control.filter(([from]) => from === "sender_flow").map(([, to]) => to), ["send"]);
  assert.deepEqual(control.filter(([from]) => from === "drafts_flow").map(([, to]) => to), ["sender_flow"]);
  // The release on the publish card is the one approval in front of the send.
  assert.equal(send.metadata.cinatra.requiresApproval, false);
  assert.equal(send.metadata.cinatra.riskClass, "email_send");
  const sendRisk = everyNode(oas).filter((n) => n.metadata?.cinatra?.riskClass === "email_send").map((n) => n.id);
  assert.deepEqual(sendRisk, ["send"], "another step carries the send risk class");
  assert.deepEqual(oas.nodes.map(refOf), [
    "start",
    "context_setup",
    "recipients_flow",
    "context_offeringContext",
    "drafts_flow",
    "sender_flow",
    "send",
    "end",
    "campaign_summary",
  ]);
});

test("the publish card shows the sending mailbox, the recipients, the emails and the call to action", () => {
  const rows = send.metadata.cinatra.publishRows;
  assert.deepEqual(
    rows.map((row) => [row.label, row.input]),
    [
      ["From", "senderEmail"],
      ["Recipients", "recipients"],
      ["Emails", "emailBodies"],
      ["Call to action", "callToAction"],
    ],
  );
});

const INTO_SEND = [
  ["sender_flow.recipients", "recipients"],
  ["sender_flow.emailBodies", "emailBodies"],
  ["sender_flow.callToAction", "callToAction"],
  ["context_setup.campaignId", "campaignId"],
  ["drafts_flow.draftBundleRef", "approvedDraftBundleRef"],
  ["recipients_flow.confirmedRecipientsRef", "confirmedRecipientsRef"],
  ["start.cinatra_run_id", "agent_run_id"],
  ["start.senderEmail", "senderEmail"],
];

test("every input of the send is fed by exactly one data edge, from the step that holds its value", () => {
  const titles = send.inputs.map((i) => i.title);
  assert.deepEqual([...titles].sort(), INTO_SEND.map(([, input]) => input).sort(), "the send takes other inputs than this suite feeds");
  for (const [from, input] of INTO_SEND) {
    const fed = edgesInto("send", input);
    assert.equal(fed.length, 1, `send.${input} is fed by ${fed.length} data edges`);
    assert.equal(`${refOf(fed[0].source_node)}.${fed[0].source_output}`, from, `send.${input} is not fed from ${from}`);
    assert.equal(fed[0].name, `${from.split(".")[0]}_to_send_${input}`);
  }
});

test("the sender mailbox is asked on the start form and is no longer an input of the delivery copy", () => {
  const start = refs.start;
  assert.ok(start.inputs.some((i) => i.title === "senderEmail" && i.json_schema?.format === "email"));
  assert.ok(start.metadata.cinatra.required.includes("senderEmail"));
  assert.equal(start.metadata.cinatra.inputRenderers.senderEmail, "@cinatra-ai/email-outreach-agent:gmail-sender");
  assert.ok(!refs["email-delivery-subflow"].inputs.some((i) => i.title === "senderEmail"));
  assert.deepEqual(edgesInto("sender_flow", "senderEmail"), []);
});

test("no data edge of the root flow names an input or an output its step does not have", () => {
  const problems = [];
  for (const edge of oas.data_flow_connections) {
    const from = refOf(edge.source_node);
    const to = refOf(edge.destination_node);
    const out = gives(from);
    const inn = takes(to);
    if (!out) problems.push(`${edge.name}: no step ${from}`);
    else if (!out.includes(edge.source_output)) problems.push(`${edge.name}: ${from} has no output ${edge.source_output}`);
    if (!inn) problems.push(`${edge.name}: no step ${to}`);
    else if (!inn.includes(edge.destination_input)) problems.push(`${edge.name}: ${to} has no input ${edge.destination_input}`);
  }
  for (const edge of oas.control_flow_connections) {
    for (const end of [refOf(edge.from_node), refOf(edge.to_node)]) {
      if (!topLevel.includes(end)) problems.push(`${edge.name}: ${end} is no step of the root flow`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the closing statement and the end read the send's answer, and nothing reads a retired result", () => {
  for (const [to, inputs] of [
    ["campaign_summary", ["status", "sentCount", "errorMessage", "alreadySentCount", "inDoubtCount"]],
    ["end", ["status", "sentCount", "operationId", "errorMessage", "alreadySentCount", "inDoubtCount"]],
  ]) {
    for (const input of inputs) {
      const fed = edgesInto(to, input);
      assert.equal(fed.length, 1, `${to}.${input} is not fed once`);
      assert.equal(`${refOf(fed[0].source_node)}.${fed[0].source_output}`, `send.${input}`);
    }
  }
  assert.ok(!JSON.stringify(oas.data_flow_connections).includes("sendResult"), "an edge still names the retired sendResult");
});

test("the closing statement says what the send did, in plain words, for each of its answers", () => {
  const message = refs.campaign_summary.message;
  assert.match(message, /status == 'completed'/);
  assert.match(message, /status == 'failed'/);
  assert.match(message, /did not report a result/);
  assert.match(message, /\{\{ errorMessage \}\}/);
  assert.match(message, /check with your mail provider/);
  assert.ok(!/sendResult/.test(message), "the closing statement still reads the retired sendResult");
});
