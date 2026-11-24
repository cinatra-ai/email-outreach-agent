// ---------------------------------------------------------------------------
// The outreach flow's top-level node `sender_flow` is its publishing step -
// zero-dependency, runs under tests/run.mjs.
//
// The host reads `metadata.cinatra.publishes: true` on a TOP-LEVEL node, and
// only there; its released publish decision then authorizes the send step
// nested below that node. This suite pins the mark on `sender_flow` and the
// send step it covers.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const refs = oas.$referenced_components;

test("sender_flow is a top-level node and declares metadata.cinatra.publishes === true", () => {
  assert.ok(oas.nodes.some((n) => n.$component_ref === "sender_flow"), "sender_flow is not a top-level node");
  assert.equal(refs.sender_flow.component_type, "FlowNode");
  assert.strictEqual(refs.sender_flow.metadata.cinatra.publishes, true);
});

test("only sender_flow carries a publishes mark among the top-level nodes", () => {
  for (const n of oas.nodes) {
    const node = refs[n.$component_ref];
    const has = Object.prototype.hasOwnProperty.call(node?.metadata?.cinatra ?? {}, "publishes");
    assert.equal(has, n.$component_ref === "sender_flow", `unexpected publishes mark state on ${n.$component_ref}`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(oas.metadata?.cinatra ?? {}, "publishes"), false, "the flow root must not declare publishes");
});

test("sender-send, nested under sender_flow, declares email_outreach_send_initial_start", () => {
  const sub = refs[refs.sender_flow.subflow.$component_ref];
  const send = sub.$referenced_components["sender-send"];
  assert.ok(send, "sender-send is not nested under sender_flow");
  assert.ok(send.metadata.cinatra.tools.includes("email_outreach_send_initial_start"));
  assert.ok(send.metadata.cinatra.confirmations.some((c) => c.tool === "email_outreach_send_initial_start"));
  assert.equal(Object.prototype.hasOwnProperty.call(send.metadata.cinatra, "publishes"), false, "a nested node must not declare publishes");
});
