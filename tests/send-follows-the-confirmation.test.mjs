// ---------------------------------------------------------------------------
// The send follows the confirmation — zero-dependency, runs under
// tests/run.mjs. cinatra-ai/cinatra#3745 (acceptance 5, the pack's side).
//
// A run of this agent sends mail on a person's behalf. The platform holds a
// send until the person has decided, and it offers a step only the tools its
// flow declares for it. This suite pins the two things the FLOW itself owes
// that rule, over cinatra/oas.json (the parent flow and its inlined
// sub-flows, followed as one graph):
//
//   1. The step that sends is reached only through the confirmation's one
//      affirmative edge. The confirmation has one edge out and no branch, and
//      nothing routes on its answer, so every other outcome has no edge to
//      follow and the run ends at the confirmation.
//   2. The send step's tool offer is the flow's declaration. The host reads a
//      model-bridge step's declaration from `metadata.cinatra.tools`. This
//      flow declares none for any step today, so the host offers each step
//      every tool it serves; the suite pins that reading and the names the
//      send step's own text calls.
//
// These pins hold at the base: they guard it. Each test names the change that
// turns it red.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

const refOf = (r) => r?.$component_ref;

/**
 * One graph over a flow and the sub-flows it inlines. A node of a sub-flow is
 * named `<flow node>/<its id>`. An edge into a flow node enters that
 * sub-flow's start node; an edge out of one leaves from every end node of the
 * sub-flow.
 */
function flatten(flow, scope = "") {
  const refs = flow.$referenced_components ?? {};
  const nodes = new Map();
  const edges = [];
  const entry = new Map();
  const exits = new Map();
  for (const n of flow.nodes ?? []) {
    const id = refOf(n);
    const comp = refs[id];
    const global = scope + id;
    if (comp?.component_type === "FlowNode" && comp.subflow) {
      const sub = flatten(refs[refOf(comp.subflow)], global + "/");
      for (const [k, v] of sub.nodes) nodes.set(k, v);
      edges.push(...sub.edges);
      entry.set(id, sub.start);
      exits.set(id, sub.ends);
    } else {
      nodes.set(global, comp);
      entry.set(id, global);
      exits.set(id, [global]);
    }
  }
  for (const e of flow.control_flow_connections ?? []) {
    for (const from of exits.get(refOf(e.from_node)) ?? []) {
      edges.push({ from, to: entry.get(refOf(e.to_node)), branch: e.from_branch });
    }
  }
  const ends = [...nodes.entries()]
    .filter(([k, c]) => c?.component_type === "EndNode" && k.startsWith(scope) && !k.slice(scope.length).includes("/"))
    .map(([k]) => k);
  return { nodes, edges, start: entry.get(refOf(flow.start_node)), ends };
}

const graph = flatten(oas);
const SEND = "sender_flow/sender-send";
const FILING = "sender_flow/sender-file_recipients";
const GATE = "sender_flow/sender-approval_gate";
const SUB_END = "sender_flow/sender-end";

const into = (id) => graph.edges.filter((e) => e.to === id);
const outOf = (id) => graph.edges.filter((e) => e.from === id);
function reach(without = null) {
  const seen = new Set();
  const todo = [graph.start];
  while (todo.length) {
    const id = todo.pop();
    if (id === without || seen.has(id)) continue;
    seen.add(id);
    for (const e of outOf(id)) todo.push(e.to);
  }
  return seen;
}

test("the steps this suite names are the ones the flow has", () => {
  assert.equal(graph.nodes.get(GATE)?.component_type, "InputMessageNode");
  assert.equal(graph.nodes.get(FILING)?.component_type, "ApiNode");
  assert.equal(graph.nodes.get(SEND)?.component_type, "ApiNode");
  assert.match(graph.nodes.get(SEND).url, /\/api\/llm-bridge$/);
});

test("the send step is the only step of the flow with the send risk class", () => {
  const sending = [...graph.nodes.entries()]
    .filter(([, c]) => c?.metadata?.cinatra?.riskClass === "email_send")
    .map(([k]) => k);
  assert.deepEqual(sending, [SEND]);
});

test("the send step is reached only through the confirmation (red: an edge into the send or the filing from any other step)", () => {
  assert.deepEqual(into(SEND).map((e) => e.from), [FILING], "the send has another way in");
  assert.deepEqual(into(FILING).map((e) => e.from), [GATE], "the filing before the send has another way in");
  assert.ok(reach().has(SEND), "the send is not reachable at all");
  assert.equal(reach(GATE).has(SEND), false, "the send is reachable around the confirmation");
  assert.equal(reach(GATE).has(FILING), false, "the filing is reachable around the confirmation");
});

test("the confirmation has one edge out, the affirmative one, and nothing routes on its answer (red: a second edge out of the confirmation, or a branching step)", () => {
  const out = outOf(GATE);
  assert.equal(out.length, 1, "the confirmation has more than one way out");
  assert.equal(out[0].to, FILING);
  assert.equal(out[0].branch, undefined, "the confirmation's edge is a named branch");
  const branching = [...graph.nodes.entries()].filter(
    ([k, c]) => k.startsWith("sender_flow/") && c?.component_type === "BranchingNode",
  );
  assert.deepEqual(branching.map(([k]) => k), [], "a step of the send sub-flow branches");
  // The one place the confirmation's answer goes is the sub-flow's end node.
  const sub = oas.$referenced_components["email-delivery-subflow"];
  const readers = sub.data_flow_connections
    .filter((e) => refOf(e.source_node) === "sender-approval_gate" && e.source_output === "userResponse")
    .map((e) => refOf(e.destination_node));
  assert.deepEqual(readers, ["sender-end"], "a step reads the confirmation's answer");
});

test("the confirmation offers the three decisions and requires one", () => {
  const gate = graph.nodes.get(GATE);
  const schema = gate.metadata.cinatra.inputMessageSchema;
  assert.deepEqual(schema.properties.decision.enum, ["approve", "revise", "reject"]);
  assert.ok(schema.required.includes("decision"));
  assert.equal(gate.metadata.cinatra.requiresApproval, true);
});

test("after the send the run ends through the closing statement (red: an edge from the send to anything else)", () => {
  assert.deepEqual(outOf(SEND).map((e) => e.to), [SUB_END]);
  assert.deepEqual(outOf(SUB_END).map((e) => e.to), ["campaign_summary"]);
  assert.deepEqual(outOf("campaign_summary").map((e) => e.to), ["end"]);
});

test("no step but the confirmed send names a send tool (red: a passthrough step or another model step that names one)", () => {
  const SEND_TOOL = /\b(?:email_send|gmail_email_send|email_outreach_send_[a-z_]+|social_media_publish|linkedin_post_publish)\b/g;
  const named = [];
  for (const [id, comp] of graph.nodes) {
    if (id === SEND || !comp || comp.component_type !== "ApiNode") continue;
    const text = JSON.stringify(comp.data ?? {});
    for (const hit of text.match(SEND_TOOL) ?? []) named.push(`${id}: ${hit}`);
  }
  assert.deepEqual(named, []);
});

// -- the send step's tool offer ---------------------------------------------

/** The host's reading of a model-bridge step's declaration, `metadata.cinatra.tools`. */
function readDeclaration(node) {
  const cinatra = node?.metadata?.cinatra;
  if (!cinatra || typeof cinatra !== "object" || !Object.hasOwn(cinatra, "tools")) return { kind: "undeclared" };
  const list = cinatra.tools;
  if (!Array.isArray(list)) return { kind: "invalid" };
  const seen = new Set();
  for (const name of list) {
    if (typeof name !== "string" || name.trim() === "" || /\s/.test(name) || name !== name.toLowerCase() || seen.has(name)) {
      return { kind: "invalid" };
    }
    seen.add(name);
  }
  return { kind: "declared", tools: [...list] };
}

// What this flow declares for the send step. Nothing is declared today, so
// the host offers the step every tool it serves. Declaring a list is a change
// of this constant in the same change (red: a `tools` key on the send step).
const SEND_STEP_DECLARATION = { kind: "undeclared" };
// The tool names the send step's own text (system and user message) calls.
const SEND_STEP_CALLS = ["objects_get"];

test("the send step's declaration reads as this suite pins it", () => {
  assert.deepEqual(readDeclaration(graph.nodes.get(SEND)), SEND_STEP_DECLARATION);
});

test("no model step of the flow carries a declaration the host refuses", () => {
  for (const [id, comp] of graph.nodes) {
    if (comp?.component_type !== "ApiNode" || !/\/api\/llm-bridge$/.test(comp.url ?? "")) continue;
    assert.notEqual(readDeclaration(comp).kind, "invalid", `${id} carries a declaration the host refuses`);
  }
});

test("the send step's text calls the tools this suite names and no other (red: the text starts to call another tool)", () => {
  const send = graph.nodes.get(SEND);
  const text = `${send.data.system}\n${send.data.user}`;
  const calls = [...new Set(text.match(/\b(?:objects|email|gmail|social|linkedin|artifact|extension)_[a-z0-9_]+\b/g) ?? [])].sort();
  assert.deepEqual(calls, [...SEND_STEP_CALLS].sort());
});
