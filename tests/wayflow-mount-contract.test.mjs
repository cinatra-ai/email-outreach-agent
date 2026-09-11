// The runtime's mount contract, held in this package's own suite.
//
// cinatra-ai/email-outreach-agent#55: at 64004621 the WayFlow runtime refused
// to mount this package —
//   ValueError: The flow requires the input descriptor
//   StringProperty(name='draftBundleRef') because some step requires it but
//   that is not available in the StartStep
// — and the host held its pin at the previous commit. Nothing in this package
// saw that: the suites read the declaration, never the two rules the loader
// itself applies when it turns the declaration into a runnable flow.
//
// Those two rules are re-stated here, over cinatra/oas.json, so a mount
// refusal is red HERE before the host's mount guard ever sees it:
//
// (A) Every input a step requires must have a source on EVERY control-flow
//     path that reaches the step — a data edge from a step already run on that
//     path, a declared default, or the flow's own StartNode. This mirrors
//     wayflowcore's `_resolve_inputs_and_outputs` (flow.py), which walks the
//     control-flow graph and raises the error above for the first input it
//     cannot source. The drafting subflow broke it when the "no recipients"
//     branch started reaching `drafts-end` without passing `drafts-draft`,
//     which is what produces `draftBundleRef`.
//
// (B) Every input an OutputMessageNode declares must be referenced by the
//     template it renders. pyagentspec derives the node's expected inputs from
//     the template's own variables and rejects any declared input it cannot
//     find there ("Unknown input descriptor specified"). A `{# ... #}` Jinja
//     COMMENT does not count — its contents are never parsed as expressions,
//     so a "pyagentspec-input-hint" comment names nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

/** Resolve a `$component_ref` against the innermost scope that declares it. */
const resolveIn = (scopes) => (ref) => {
  for (const scope of scopes) if (scope && Object.hasOwn(scope, ref)) return scope[ref];
  throw new Error(`unresolved $component_ref: ${ref}`);
};

/** Every Flow in the document — the composite itself and each inlined subflow. */
function collectFlows(flow, id, scopes, out = []) {
  const own = flow.$referenced_components ?? {};
  const inner = [own, ...scopes];
  out.push({ id, flow, resolve: resolveIn(inner) });
  for (const [childId, child] of Object.entries(own)) {
    if (child?.component_type === "Flow") collectFlows(child, childId, inner, out);
  }
  return out;
}

const flows = collectFlows(oas, oas.id, []);

/** The inputs a node CONSUMES: an EndNode names them under `outputs`, a
 *  FlowNode inherits its subflow's, every other node declares `inputs`. */
function consumedInputs(node, resolve) {
  if (node.component_type === "EndNode") return node.outputs ?? [];
  if (node.component_type === "FlowNode") return resolve(node.subflow.$component_ref).inputs ?? [];
  return node.inputs ?? [];
}

// ---------------------------------------------------------------------------
// (A) every required step input has a source on every path that reaches it
// ---------------------------------------------------------------------------

/** Re-walk one flow the way wayflowcore's `_resolve_inputs_and_outputs` does,
 *  returning the inputs it would demand from the StartStep. */
function unsourcedInputs({ flow, resolve }) {
  const steps = new Map();
  for (const ref of flow.nodes ?? []) steps.set(ref.$component_ref, resolve(ref.$component_ref));

  const beginId = flow.start_node.$component_ref;
  const startTitles = new Set((steps.get(beginId)?.inputs ?? []).map((i) => i.title));

  const dataEdges = (flow.data_flow_connections ?? []).map((e) => ({
    from: e.source_node.$component_ref,
    key: `${e.destination_node.$component_ref}.${e.destination_input}`,
  }));
  const successors = (id) =>
    (flow.control_flow_connections ?? [])
      .filter((e) => e.from_node.$component_ref === id)
      .map((e) => e.to_node.$component_ref);

  const violations = [];
  const visited = new Map();
  const queue = [[beginId, new Set()]];
  while (queue.length > 0) {
    const [id, incoming] = queue.pop();
    let produced = incoming;
    if (visited.has(id)) {
      const seen = visited.get(id);
      if ([...seen].every((k) => produced.has(k))) continue;
      produced = new Set([...produced].filter((k) => seen.has(k)));
    }
    visited.set(id, produced);

    const node = steps.get(id);
    if (!node) continue;
    if (id !== beginId) {
      for (const descriptor of consumedInputs(node, resolve)) {
        const key = `${id}.${descriptor.title}`;
        if (produced.has(key)) continue;
        if (Object.hasOwn(descriptor, "default")) continue;
        if (startTitles.has(descriptor.title)) continue;
        violations.push(key);
      }
    }

    const next = new Set(produced);
    for (const edge of dataEdges) if (edge.from === id) next.add(edge.key);
    for (const child of successors(id)) queue.push([child, new Set(next)]);
  }
  return violations;
}

test("every required step input has a source on every path that reaches it", () => {
  const found = [];
  for (const entry of flows) {
    for (const violation of unsourcedInputs(entry)) found.push(`${entry.id}: ${violation}`);
  }
  assert.deepEqual(
    found,
    [],
    "the runtime refuses to mount a flow whose step requires an input the StartStep does not carry: " +
      found.join(", "),
  );
});

test("the drafting subflow carries draftBundleRef past the branch that never drafts", () => {
  const drafts = oas.$referenced_components["email-drafting-subflow"];
  const start = drafts.$referenced_components["drafts-start"];

  const declared = start.inputs.find((i) => i.title === "draftBundleRef");
  assert.ok(declared, "the drafting StartStep does not declare draftBundleRef");
  assert.equal(declared.type, "string");
  assert.ok(Object.hasOwn(declared, "default"), "draftBundleRef has no default on the StartStep");

  assert.deepEqual(
    drafts.inputs.map((i) => i.title),
    start.inputs.map((i) => i.title),
    "the drafting subflow's own inputs no longer match its StartStep's",
  );

  assert.ok(
    start.metadata.cinatra.hidden.includes("draftBundleRef"),
    "draftBundleRef is a derived input and must stay hidden from the setup form",
  );
});

// ---------------------------------------------------------------------------
// (B) an OutputMessageNode declares only inputs its template actually reads
// ---------------------------------------------------------------------------

function collectNodes(node, type, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectNodes(v, type, out);
    return out;
  }
  if (node.component_type === type) out.push(node);
  for (const v of Object.values(node)) collectNodes(v, type, out);
  return out;
}

test("an output message declares only inputs its template reads", () => {
  const offenders = [];
  for (const node of collectNodes(oas, "OutputMessageNode")) {
    // A Jinja comment is never parsed as an expression, so a name that appears
    // ONLY inside one is invisible to pyagentspec's input inference.
    const rendered = String(node.message ?? "").replace(/\{#[\s\S]*?#\}/g, "");
    for (const { title } of node.inputs ?? []) {
      if (!new RegExp(`\\b${title}\\b`).test(rendered)) offenders.push(`${node.id}.${title}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "pyagentspec rejects an input the template never reads: " + offenders.join(", "),
  );
});
