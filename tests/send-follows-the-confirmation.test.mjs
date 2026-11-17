// ---------------------------------------------------------------------------
// The send follows the confirmation - zero-dependency, runs under
// tests/run.mjs. cinatra-ai/cinatra#3745 (the pack's side).
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
//      model-bridge step's declaration from `metadata.cinatra.tools`. The
//      send step declares the three tools of the delivery step it is
//      re-inlined from (the read, the send start and the send status), so the
//      host offers it those and no other; no other step declares a list. The
//      suite pins that reading, and it reads the tool names every step's call
//      data carries against explicit lists: a name that is not on a list
//      fails, so a tool added to any step turns the suite red until the list
//      names it.
//
// The pins hold at the base: they guard it. Each test names the change that
// turns it red.
//
// Known limits
//   - A tool name is read as a snake_case word (it has an underscore) or as
//     a name followed directly by "(". A tool named by one plain word with no
//     parenthesis in the text is not seen. Every tool of this flow's
//     vocabulary has an underscore.
//   - Only the call data of ApiNode steps is read. A tool named in another
//     kind of step is not seen.
//   - A name the flow supplies is looked up in a table with no prototype and
//     read as text; see the test of flatten on names that only Object has.
//   - The copy of the host's declaration reader below is checked against its
//     rule as the PR describes it, not against the host's source.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

// A name the flow supplies (a component ref, a sub-flow ref, an edge end) is
// read as text, and it is looked up in a table with no prototype: a name such
// as "constructor", "__proto__" or "toString" finds an own entry of the flow or
// nothing, never a member inherited from Object.
// A name is a non-empty text: a missing, empty or non-text name is never a
// member of anything, so two missing names never match each other.
const isName = (v) => typeof v === "string" && v !== "";
const refOf = (r) => (isName(r?.$component_ref) ? r.$component_ref : undefined);
const table = (obj) => Object.assign(Object.create(null), obj ?? {});
const lookup = (t, key) => (isName(key) ? t[key] : undefined);
const TOP = table(oas.$referenced_components);

/**
 * One graph over a flow and the sub-flows it inlines. A node of a sub-flow is
 * named `<flow node>/<its id>`. An edge into a flow node enters that
 * sub-flow's start node; an edge out of one leaves from every end node of the
 * sub-flow. A node with no component, or an edge with an end that is not a
 * node of its flow, throws: the graph is never read in part.
 */
function flatten(flow, scope = "") {
  const refs = table(flow.$referenced_components);
  const nodes = new Map();
  const edges = [];
  const entry = new Map();
  const exits = new Map();
  for (const n of flow.nodes ?? []) {
    const id = refOf(n);
    const comp = lookup(refs, id);
    if (!comp || typeof comp !== "object") throw new Error(`${scope}${id} is a node of the flow with no component`);
    const global = scope + id;
    if (comp.component_type === "FlowNode") {
      const subflow = lookup(refs, refOf(comp.subflow));
      if (!subflow || typeof subflow !== "object") throw new Error(`${global} names a sub-flow that is not there`);
      const sub = flatten(subflow, global + "/");
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
    const from = refOf(e.from_node);
    const to = refOf(e.to_node);
    if (!exits.has(from) || !entry.has(to)) throw new Error(`${scope}${e.name} has an end that is not a node of its flow`);
    for (const f of exits.get(from)) edges.push({ from: f, to: entry.get(to), branch: e.from_branch });
  }
  const ends = [...nodes.entries()]
    .filter(([k, c]) => c.component_type === "EndNode" && k.startsWith(scope) && !k.slice(scope.length).includes("/"))
    .map(([k]) => k);
  if (!entry.has(refOf(flow.start_node))) throw new Error(`${scope} has a start node that is not one of its nodes`);
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

test("a name the flow supplies that only Object inherits is not a component, a sub-flow or a node (red: a lookup of flow data through the prototype chain)", () => {
  const start = { component_type: "StartNode" };
  const flowOf = (extra) => ({
    start_node: { $component_ref: "s" },
    nodes: [{ $component_ref: "s" }, ...extra.nodes],
    control_flow_connections: extra.edges ?? [],
    $referenced_components: { s: start, ...(extra.refs ?? {}) },
  });
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => flatten(flowOf({ nodes: [{ $component_ref: name }] })), /no component/, `${name} as a node`);
    assert.throws(
      () => flatten(flowOf({ nodes: [{ $component_ref: "f" }], refs: { f: { component_type: "FlowNode", subflow: { $component_ref: name } } } })),
      /sub-flow that is not there/,
      `${name} as a sub-flow`,
    );
    assert.throws(
      () => flatten(flowOf({ nodes: [], edges: [{ name: "e", from_node: { $component_ref: "s" }, to_node: { $component_ref: name } }] })),
      /not a node of its flow/,
      `${name} as an edge end`,
    );
  }
  // A component the flow really stores under such a name is its own and is read.
  const own = JSON.parse('{"s":{"component_type":"StartNode"},"__proto__":{"component_type":"EndNode"},"constructor":{"component_type":"EndNode"}}');
  const g = flatten({ start_node: { $component_ref: "s" }, nodes: [{ $component_ref: "s" }, { $component_ref: "__proto__" }, { $component_ref: "constructor" }], $referenced_components: own });
  assert.deepEqual([...g.nodes.keys()].sort(), ["__proto__", "constructor", "s"]);
});

test("the steps this suite names are the ones the flow has", () => {
  assert.equal(graph.nodes.get(GATE)?.component_type, "InputMessageNode");
  assert.equal(graph.nodes.get(FILING)?.component_type, "ApiNode");
  assert.equal(graph.nodes.get(SEND)?.component_type, "ApiNode");
  assert.match(graph.nodes.get(SEND).url, /\/api\/llm-bridge$/);
  assert.equal(graph.nodes.get("campaign_summary")?.component_type, "OutputMessageNode");
});

test("the send step is the only step of the flow with the send risk class", () => {
  const sending = [...graph.nodes.entries()]
    .filter(([, c]) => c.metadata?.cinatra?.riskClass === "email_send")
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

test("the confirmation has one edge out, the affirmative one, and nothing routes on its answer (red: a second edge out of the confirmation, a branching step in the send sub-flow, or a step that reads the confirmation's answer)", () => {
  const out = outOf(GATE);
  assert.equal(out.length, 1, "the confirmation has more than one way out");
  assert.equal(out[0].to, FILING);
  assert.equal(out[0].branch, undefined, "the confirmation's edge is a named branch");
  const branching = [...graph.nodes.entries()].filter(
    ([k, c]) => k.startsWith("sender_flow/") && c.component_type === "BranchingNode",
  );
  assert.deepEqual(branching.map(([k]) => k), [], "a step of the send sub-flow branches");
  // The one place the confirmation's answer goes is the sub-flow's end node.
  const sub = TOP["email-delivery-subflow"];
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

// -- the tool names a step's call data carries ------------------------------

const TEMPLATE = /\{\{[\s\S]*?\}\}|\{#[\s\S]*?#\}/g;
const SNAKE_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CALLED_NAME = /\b([A-Za-z_][A-Za-z0-9_]*)\(/g;

function stringsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

/** Every tool-shaped name in a step's call data: its `tool`, every snake_case word and every name followed by "(" in its text. Template slots and comments are left out. */
function namesIn(step) {
  const names = new Set();
  for (const raw of stringsOf(step.data ?? {})) {
    const text = raw.replace(TEMPLATE, " ");
    for (const m of text.matchAll(SNAKE_NAME)) names.add(m[0]);
    for (const m of text.matchAll(CALLED_NAME)) names.add(m[1]);
  }
  if (typeof step.data?.tool === "string") names.add(step.data.tool);
  return [...names].sort();
}

// What the send step's text names: the read tool, the send start tool and the
// send status tool, and nothing else. Any other name fails the suite until it
// is listed here, and listing a tool the send step may call is a change of
// this list.
const SEND_STEP_NAMES = ["email_outreach_send_initial_start", "email_outreach_send_initial_status", "objects_get"];
// Snake_case words of the delivery step's text that are not tools.
const SEND_STEP_CHILD_WORDS = ["agent_run", "agent_run_id", "max_steps"];

// What every other model or passthrough step of the flow names today. The
// ids are exactly the flow's ApiNode steps but the send step. A tool-shaped
// name added to one of them, or a step added or removed, fails the suite
// until this list is changed in the same commit. None of these names is a
// send tool; a send tool named by any step but the send step is therefore a
// name that is not on this list.
const OTHER_STEP_NAMES = table({
  "context_setup": ["email_outreach_context_setup", "objects_save"],
  "recipients_flow/recipients-fetch_lists": ["agent_run_id", "crm_list_search"],
  "recipients_flow/recipients-generate": [
    "agent_run_id",
    "cinatra_agent_run_id",
    "crm_account_get",
    "crm_contact_get",
    "crm_list_get",
    "crm_list_members_get",
    "objects_save",
    "unsupported_account_scope",
  ],
  "recipients_flow/recipients-apply": ["email_outreach_recipients_update"],
  "context_offeringContext/ctx-offeringContext-resolve_context": [],
  "context_offeringContext/ctx-offeringContext-finalize_interactive": [],
  "context_offeringContext/ctx-offeringContext-finalize_autonomous": [],
  "drafts_flow/drafts-draft": [
    "agent_run_id",
    "artifact_representation_get",
    "cinatra_agent_run_id",
    "objects_get",
    "objects_save",
  ],
  "drafts_flow/drafts-read_drafts": ["extension_tool", "saved_drafts"],
  "drafts_flow/drafts-apply": ["email_outreach_initial_drafts_update"],
  "sender_flow/sender-file_recipients": ["extension_tool", "recipient_records"],
});

test("the send step's text names the tools this suite lists and no other (red: any new snake_case name or name( call in the send step's call data outside its template slots and comments)", () => {
  assert.deepEqual(namesIn(graph.nodes.get(SEND)), SEND_STEP_NAMES);
});

test("every other step names the tools this suite lists for it and no other (red: a new tool-shaped name in a step's call data outside its template slots and comments, or an API step added or removed)", () => {
  const apiSteps = [...graph.nodes.entries()].filter(([k, c]) => c.component_type === "ApiNode" && k !== SEND);
  assert.deepEqual(apiSteps.map(([k]) => k).sort(), Object.keys(OTHER_STEP_NAMES).sort());
  for (const [id, step] of apiSteps) assert.deepEqual(namesIn(step), lookup(OTHER_STEP_NAMES, id), id);
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

const withTools = (tools) => ({ metadata: { cinatra: { tools } } });

test("the copy of the host's declaration reader reads the cases its rule names", () => {
  assert.deepEqual(readDeclaration({}), { kind: "undeclared" });
  assert.deepEqual(readDeclaration({ metadata: { cinatra: {} } }), { kind: "undeclared" });
  assert.deepEqual(readDeclaration(withTools([])), { kind: "declared", tools: [] });
  assert.deepEqual(readDeclaration(withTools(["objects_get", "b_c"])), { kind: "declared", tools: ["objects_get", "b_c"] });
  for (const bad of ["objects_get", null, [1], [""], ["  "], ["a b"], ["Objects_get"], ["a_b", "a_b"]]) {
    assert.deepEqual(readDeclaration(withTools(bad)), { kind: "invalid" }, JSON.stringify(bad));
  }
});

// What this flow declares for the send step: the three tools of the delivery
// step this step is re-inlined from. The step's own text names the same three
// (SEND_STEP_NAMES), and the declaration is what limits the step's offer to
// the read, the send start and the send status and to nothing else.
// This is a change detector: a change of the list changes this constant in the
// same commit.
const SEND_STEP_DECLARED = ["email_outreach_send_initial_start", "email_outreach_send_initial_status", "objects_get"];
const SEND_STEP_DECLARATION = { kind: "declared", tools: SEND_STEP_DECLARED };

test("the send step's declaration reads as this suite pins it (a change detector: red on a changed list, or on none, for the send step)", () => {
  assert.deepEqual(readDeclaration(graph.nodes.get(SEND)), SEND_STEP_DECLARATION);
});

test("the send step's declared list is exactly the tools of the delivery step it is re-inlined from, and holds every tool its own text names (red: no list, a tool the delivery step calls and the list lacks, or a tool the list holds and the delivery step does not call)", () => {
  const reading = readDeclaration(graph.nodes.get(SEND));
  assert.equal(reading.kind, "declared", "the send step declares no list");
  const child = JSON.parse(readFileSync(path.join(root, "scripts/children/email-delivery-agent.oas.json"), "utf8"));
  const childSend = child.$referenced_components.send;
  assert.match(childSend.url, /\/api\/llm-bridge$/, "the delivery flow's send step is not a model step");
  const needs = namesIn(childSend).filter((name) => !SEND_STEP_CHILD_WORDS.includes(name));
  assert.deepEqual([...reading.tools].sort(), needs);
  for (const name of SEND_STEP_NAMES) assert.ok(reading.tools.includes(name), `${name} is named by the send step and is not declared`);
});

// The steps that declare a tool list: the list step's own lookup and the send
// step. A `tools` key on any other step is a change of this list.
const DECLARING_STEPS = ["recipients_flow/recipients-fetch_lists", SEND];

test("the send list sits on the send step only, a model step, under the id the host reads it by (red: a `tools` key on a step not in DECLARING_STEPS, or a send tool on another step's list)", () => {
  const withKey = [...graph.nodes.entries()]
    .filter(([, c]) => Object.hasOwn(c.metadata?.cinatra ?? {}, "tools"))
    .map(([k]) => k);
  assert.deepEqual(withKey, DECLARING_STEPS);
  for (const key of withKey.filter((k) => k !== SEND)) {
    const reading = readDeclaration(graph.nodes.get(key));
    assert.equal(reading.kind, "declared", `${key} carries a list the host refuses`);
    for (const name of SEND_STEP_DECLARED) assert.ok(!reading.tools.includes(name), `${key} declares the send tool ${name}`);
  }
  assert.match(graph.nodes.get(SEND).url, /\/api\/llm-bridge$/);
  assert.equal(graph.nodes.get(SEND).id, "sender-send", "the host reads a declaration by the step's id");
  const sameId = [...graph.nodes.values()].filter((c) => c.component_type === "ApiNode" && c.id === "sender-send");
  assert.equal(sameId.length, 1, "two model steps share the send step's id");
});

test("no model step of the flow carries a declaration the host refuses", () => {
  for (const [id, comp] of graph.nodes) {
    if (comp.component_type !== "ApiNode" || !/\/api\/llm-bridge$/.test(comp.url ?? "")) continue;
    assert.notEqual(readDeclaration(comp).kind, "invalid", `${id} carries a declaration the host refuses`);
  }
});
