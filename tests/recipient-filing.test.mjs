// The outreach files one recipient record per confirmed recipient before any
// email is sent.
//
// The delivery copy inside cinatra/oas.json prepares the send: it carries the
// delivery agent's filing step first, handed the run, the confirmed recipient
// list and the campaign, then its read step. The send itself is the flow's
// top-level publishing step after the copy (cinatra#3089), so the filing comes
// before the publish card and before any email. The copy's steps call declared
// tools by name, and the platform resolves the name of an embedded child's
// step against the child's own installed package (the delivery agent), so this
// package neither declares nor ships the delivery agent's tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const deliveryFlow = oas.$referenced_components["email-delivery-subflow"];
const FILING = "sender-file_recipients";
const TOOL = "recipient_records";

const refOf = (node) => (node && typeof node === "object" ? node.$component_ref : undefined);
const hasEdge = (from, to) =>
  (deliveryFlow.control_flow_connections ?? []).some((e) => refOf(e.from_node) === from && refOf(e.to_node) === to);
const hasDataEdge = (from, output, to, input) =>
  (deliveryFlow.data_flow_connections ?? []).some(
    (e) =>
      refOf(e.source_node) === from &&
      e.source_output === output &&
      refOf(e.destination_node) === to &&
      e.destination_input === input,
  );

function toolCalls(node, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) toolCalls(v, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (node.component_type === "ApiNode" && node.data?.tool === "extension_tool") {
    out.push({ id: node.id, name: node.data.input?.name });
  }
  for (const v of Object.values(node)) toolCalls(v, out);
  return out;
}

test("(8) the delivery copy files the recipient records before the send", () => {
  assert.ok(
    (deliveryFlow.nodes ?? []).some((n) => refOf(n) === FILING),
    "the delivery copy has no recipient filing step",
  );
  assert.ok(hasEdge("sender-start", FILING), "the filing step is not the copy's first step");
  assert.ok(hasEdge(FILING, "sender-resolve_send"), "the read step does not follow the filing step");
  assert.equal(deliveryFlow.$referenced_components["sender-send"], undefined, "the send is still inside the copy");
  const top = (oas.control_flow_connections ?? []).map((e) => [refOf(e.from_node), refOf(e.to_node)]);
  assert.ok(top.some(([f, t]) => f === "sender_flow" && t === "send"), "the send does not follow the copy");
});

test("(8) the filing step is handed the run, the confirmed recipient list and the campaign", () => {
  const step = deliveryFlow.$referenced_components[FILING];
  assert.ok(step, "the delivery copy carries no recipient filing step");
  const titles = (step.inputs ?? []).map((i) => i.title);
  for (const input of ["agent_run_id", "confirmedRecipientsRef", "campaignId"]) {
    assert.ok(titles.includes(input), `the filing step takes no ${input}`);
    assert.ok(hasDataEdge("sender-start", input, FILING, input), `the filing step is not handed ${input}`);
  }
  assert.equal(step.data.tool, "extension_tool");
  assert.equal(step.data.input.name, TOOL);
  assert.equal(step.data.input.input.recipientsRef, "{{ confirmedRecipientsRef }}");
});

test("(8) the copies' tools are their agents' own, not shipped or declared by this package", () => {
  const declared = Array.isArray(pkg.cinatra.tools) ? pkg.cinatra.tools : [];
  const calls = toolCalls(oas);
  // The platform resolves a step of an embedded child flow against that child's
  // own installed package, so no copy of the delivery agent's tools is here.
  // The drafting copy's read step calls saved_drafts, which the drafting agent declares embeddable: a copy of its
  // module here would be a second, unpinned behaviour that the platform never runs for the embedded step.
  for (const tool of [TOOL, "send_contents", "saved_drafts"]) {
    assert.ok(calls.some((c) => c.name === tool), `the flow calls no ${tool} tool`);
    assert.ok(!declared.some((t) => t.name === tool), `${tool} is declared by this package`);
  }
  assert.ok(
    !existsSync(path.join(root, "cinatra/tools/recipient-records.mjs")),
    "the copy of the delivery agent's module is still in the package",
  );
  assert.ok(
    !existsSync(path.join(root, "cinatra/tools/send-contents.mjs")),
    "a copy of the delivery agent's module is in the package",
  );
  assert.ok(
    !existsSync(path.join(root, "cinatra/tools/saved-drafts.mjs")),
    "a copy of the drafting agent's module is in the package",
  );
  assert.ok(!existsSync(path.join(root, "cinatra/tools")) || readdirSync(path.join(root, "cinatra/tools")).length === 0, "a tool module is shipped");
  // Every tool call of the flow is a step of an embedded child copy: no step of
  // the outreach's own flow calls a tool by name.
  const own = Object.keys(oas.$referenced_components).filter((id) => oas.$referenced_components[id]?.data?.tool === "extension_tool");
  assert.deepEqual(own, [], "a step of the outreach's own flow calls a declared tool");
  assert.ok((pkg.files ?? []).includes("cinatra"), "the package does not publish its cinatra folder");
});
