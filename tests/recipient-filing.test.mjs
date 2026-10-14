// The outreach's send files one recipient record per confirmed recipient
// after the send is confirmed and before any email is sent.
//
// The delivery copy inside cinatra/oas.json carries the delivery agent's
// filing step between its confirmation and its send, handed the run, the
// confirmed recipient list and the campaign. The step calls a declared tool by
// name, and the platform resolves that name against the manifest of the package
// whose run calls it, so this package declares the tool itself and ships the
// module beside its flow, byte for byte the delivery agent's module at the
// commit scripts/embedded-copies.json pins for the delivery copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const deliveryFlow = oas.$referenced_components["email-delivery-subflow"];
const FILING = "sender-file_recipients";
const TOOL = "recipient_records";
const MODULE = "./cinatra/tools/recipient-records.mjs";
// The git blob of the delivery agent's module at the pinned delivery commit.
const MODULE_BLOB = "45548ed05896f752c0cbe70a521097cb87a34a29";

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

test("(8) the delivery copy files the recipient records after the confirmation and before the send", () => {
  assert.ok(
    (deliveryFlow.nodes ?? []).some((n) => refOf(n) === FILING),
    "the delivery copy has no recipient filing step",
  );
  assert.ok(hasEdge("sender-approval_gate", FILING), "the filing step does not follow the confirmation");
  assert.ok(hasEdge(FILING, "sender-send"), "the send does not follow the filing step");
  assert.ok(!hasEdge("sender-approval_gate", "sender-send"), "the confirmation still leads straight to the send");
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

test("(8) every declared tool the flow calls is declared by this package, its module shipped beside the flow", () => {
  const declared = Array.isArray(pkg.cinatra.tools) ? pkg.cinatra.tools : [];
  const calls = toolCalls(oas);
  assert.ok(calls.some((c) => c.name === TOOL), `the flow calls no ${TOOL} tool`);
  for (const call of calls) {
    assert.ok(
      declared.some((t) => t.name === call.name),
      `the step ${call.id} calls ${call.name}, which this package does not declare`,
    );
  }
  const tool = declared.find((t) => t.name === TOOL);
  assert.equal(tool.module, MODULE);
  const file = path.join(root, MODULE);
  assert.ok(existsSync(file), `${MODULE} is not in the package`);
  const bytes = readFileSync(file);
  const blob = createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
  assert.equal(blob, MODULE_BLOB, `${MODULE} is not the delivery agent's module at the pinned commit`);
  assert.ok((pkg.files ?? []).includes("cinatra"), "the package does not publish its cinatra folder");
});
