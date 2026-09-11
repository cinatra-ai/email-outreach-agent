// ---------------------------------------------------------------------------
// Bridge-output member declarations (email-outreach-agent#53).
//
// The runtime asks the model for exactly the shape this flow declares: an
// object level with no declared members is sent CLOSED and EMPTY, so a bridge
// output that declares a list or object without member fields can carry
// nothing. These tests pin the members of the two bridge outputs that were
// measured free-form, so a future edit cannot silently drop them back to a
// bare `{"type": "object"}`.
//
// The declared members are the ones this repository's own consumers read:
//   - `recipients-generate / confirmedRecipients` — the per-row shape the
//     node's own system prompt spells out (Step 4 / the objects_save call in
//     Step 5).
//   - `sender-send / sendResult` — the fields the downstream campaign-summary
//     message dereferences (`sendResult.status`, `sendResult.summary`).
//
// Zero-dependency; runs on plain node:test via tests/run.mjs.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

const LLM_BRIDGE_PATH = "/api/llm-bridge";

/** Every ApiNode in the flow that targets the LLM bridge, by node id. */
function bridgeNodes(node, out = new Map()) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) bridgeNodes(v, out);
    return out;
  }
  if (
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    node.url.includes(LLM_BRIDGE_PATH)
  ) {
    out.set(String(node.id ?? node.name), node);
  }
  for (const v of Object.values(node)) bridgeNodes(v, out);
  return out;
}

const nodes = bridgeNodes(oas);

function bridgeOutput(nodeId, title) {
  const node = nodes.get(nodeId);
  assert.ok(node, `bridge ApiNode '${nodeId}' is missing from the flow`);
  const output = (node.outputs ?? []).find((o) => o && o.title === title);
  assert.ok(output, `bridge node '${nodeId}' declares no output '${title}'`);
  return output;
}

/** An object level counts as declared when it names at least one member. */
function assertDeclaredMembers(where, schema, expectedKeys) {
  assert.ok(
    schema && typeof schema === "object",
    `${where}: no schema object to carry member declarations`,
  );
  const properties = schema.properties;
  assert.ok(
    properties && typeof properties === "object" && Object.keys(properties).length > 0,
    `${where}: declares no members — the runtime sends this level CLOSED and EMPTY`,
  );
  for (const key of expectedKeys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(properties, key),
      `${where}: member '${key}' is read by a consumer but not declared`,
    );
    assert.equal(
      properties[key].type,
      "string",
      `${where}: member '${key}' should be declared as a string`,
    );
  }
}

test("recipients-generate / confirmedRecipients declares its item members", () => {
  const output = bridgeOutput("recipients-generate", "confirmedRecipients");
  assert.equal(output.type, "array");
  const items = output.json_schema?.items;
  assertDeclaredMembers(
    "recipients-generate / confirmedRecipients items",
    items,
    ["contactId", "name", "title", "email", "accountId", "accountName"],
  );
});

test("sender-send / sendResult declares the members its consumer reads", () => {
  const output = bridgeOutput("sender-send", "sendResult");
  assert.equal(output.type, "object");
  assertDeclaredMembers(
    "sender-send / sendResult",
    output.json_schema,
    ["status", "summary"],
  );
});
