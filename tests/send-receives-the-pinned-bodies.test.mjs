// ---------------------------------------------------------------------------
// The bodies the send receives are the revisions the review step pinned -
// zero-dependency, runs under tests/run.mjs. cinatra-ai/cinatra#3089.
//
// The drafting copy files each drafted body, and its filing step hands the
// review step the list of the filed revisions (reviewTargets, one artifact
// revision per draft): those are the revisions the application's review pins and
// shows. The same filing step's list leaves the copy as approvedBodyArtifacts.
// The delivery copy's read step joins each body to its draft and hands on the
// bodies the send mails (emailBodies); the send takes them from the read step
// only, and its publish card's Emails row shows them.
//
// This suite follows that list through cinatra/oas.json, edge by edge: from the
// filing step to the review step and to the drafting copy's end, from the
// drafting copy to the delivery copy, through its read step to its end, and from
// there to the send. No other edge feeds any of these inputs, and no model step
// stands on the road.
//
// WHAT THIS DOES NOT PROVE. Nothing in this repository can show what the
// application's review approves, or what its send does with a body that changed
// after it was filed. The suite pins only this package's wiring: the send is
// handed the revisions the filing step filed and the review step pinned, and no
// step here replaces, edits or re-reads them. What the application does with
// those revisions is its own behaviour; see "Known limits" in AGENTS.md.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const refs = oas.$referenced_components;
const drafts = refs["email-drafting-subflow"];
const delivery = refs["email-delivery-subflow"];
const refOf = (node) => (node && typeof node === "object" ? node.$component_ref : undefined);

/** Every source of `step.input` in `flow`, as "source.output". */
const sources = (flow, step, input) =>
  flow.data_flow_connections
    .filter((e) => refOf(e.destination_node) === step && e.destination_input === input)
    .map((e) => `${refOf(e.source_node)}.${e.source_output}`);

/** Every reader of `step.output` in `flow`, as "destination.input". */
const readers = (flow, step, output) =>
  flow.data_flow_connections
    .filter((e) => refOf(e.source_node) === step && e.source_output === output)
    .map((e) => `${refOf(e.destination_node)}.${e.destination_input}`);

test("the drafting copy hands the review the revisions its filing step filed, and hands on the bodies of that same step", () => {
  assert.deepEqual(sources(drafts, "drafts-end", "approvedBodyArtifacts"), ["drafts-file_drafts.artifacts"]);
  assert.deepEqual(sources(drafts, "drafts-approval_gate", "reviewTargets"), ["drafts-file_drafts.reviewTargets"]);
  assert.ok(drafts.outputs.some((o) => o.title === "approvedBodyArtifacts"));
  // The copy reaches its end only past the review step.
  const control = drafts.control_flow_connections.map((e) => [refOf(e.from_node), refOf(e.to_node)]);
  assert.deepEqual(control.filter(([from]) => from === "drafts-file_drafts").map(([, to]) => to), ["drafts-approval_gate"]);
  assert.deepEqual(control.filter(([from]) => from === "drafts-approval_gate").map(([, to]) => to), ["drafts-end"]);
});

test("the delivery copy takes the filed, pinned bodies from the drafting copy and nothing else", () => {
  assert.deepEqual(sources(oas, "sender_flow", "emailBodies"), ["drafts_flow.approvedBodyArtifacts"]);
  assert.deepEqual(readers(oas, "drafts_flow", "approvedBodyArtifacts"), ["sender_flow.emailBodies"]);
  assert.deepEqual(sources(oas, "sender_flow", "callToAction"), ["drafts_flow.callToAction"]);
  assert.deepEqual(sources(oas, "sender_flow", "approvedDraftBundleRef"), ["drafts_flow.draftBundleRef"]);
});

test("the delivery copy's read step joins the handed-in bodies to the drafts and hands on what the send mails", () => {
  assert.deepEqual(sources(delivery, "sender-resolve_send", "emailBodies"), ["sender-start.emailBodies"]);
  for (const output of ["recipients", "emailBodies", "callToAction"]) {
    assert.deepEqual(sources(delivery, "sender-end", output), [`sender-resolve_send.${output}`]);
  }
  const read = delivery.$referenced_components["sender-resolve_send"];
  assert.equal(read.data.tool, "extension_tool");
  assert.equal(read.data.input.name, "send_contents");
  assert.equal(read.metadata.cinatra.riskClass, "read_only");
  assert.equal(read.metadata.cinatra.publishes, false);
  // A run with no reviewed body hands the read step an empty list, which its
  // input refuses (at least one body): the run ends before the publish card.
  assert.equal(delivery.inputs.find((i) => i.title === "emailBodies").json_schema.minItems, 1);
});

test("the send takes the bodies, the recipients and the call to action from the read step only, and its card shows them", () => {
  for (const input of ["emailBodies", "recipients", "callToAction"]) {
    assert.deepEqual(sources(oas, "send", input), [`sender_flow.${input}`], `send.${input} has another source`);
  }
  const send = refs.send;
  const emails = send.metadata.cinatra.publishRows.find((row) => row.label === "Emails");
  assert.deepEqual(emails, { kind: "artifacts", label: "Emails", input: "emailBodies" });
  // The send start reads the list from the released decision: the list is an
  // input of the step, not an argument a model could write.
  assert.ok(!Object.keys(send.data.input).includes("emailBodies"));
  assert.ok(send.inputs.some((i) => i.title === "emailBodies"));
});

test("no model step stands on the road from the filed bodies to the send, so nothing rewrites a body", () => {
  const isModel = (node) => typeof node?.url === "string" && node.url.includes("/api/llm-bridge");
  for (const id of ["drafts-file_drafts", "drafts-approval_gate"]) assert.ok(!isModel(drafts.$referenced_components[id]), id);
  for (const id of ["sender-file_recipients", "sender-resolve_send"]) assert.ok(!isModel(delivery.$referenced_components[id]), id);
  assert.ok(!isModel(refs.send));
});
