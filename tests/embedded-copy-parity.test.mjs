// ---------------------------------------------------------------------------
// Embedded copy parity — zero-dependency, runs under tests/run.mjs.
//
// cinatra-ai/cinatra#3096 item (7): the embedded copies of the three child
// flows are re-inlined from the children so they cannot drift again — at
// commit, checked in CI. The generator (scripts/embedded-copies.mjs) writes
// each copy from its child's committed flow at the pinned commit (a snapshot
// under scripts/children/), with the child's step ids prefixed, and with
// exactly the differences the declared list (scripts/embedded-copies.json)
// names, each with its child and its reason. These arms fail the pack's own
// suite whenever an embedded copy differs from its child in anything the
// list does not declare, and whenever a declared difference no longer applies.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FLOW_PATH,
  KINDS,
  ROOT,
  generateCopy,
  generateFlow,
  gitBlobSha,
  loadChild,
  loadChildBuffer,
  loadList,
  serialize,
  writeCopies,
} from "../scripts/embedded-copies.mjs";

const list = loadList();
const children = list.map((group) => loadChild(group));
const flowText = readFileSync(path.join(ROOT, FLOW_PATH), "utf8");
const flow = JSON.parse(flowText);
const groupFor = (copyId) => list.findIndex((group) => group.copyId === copyId);

/** Every path at which two JSON values differ (object key order aside). */
function differingPaths(a, b, at = "", out = []) {
  const bothObjects =
    a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at || "/");
    return out;
  }
  const keys = Array.isArray(a)
    ? [...Array(Math.max(a.length, b.length)).keys()].map(String)
    : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) differingPaths(a[key], b[key], `${at}/${key}`, out);
  return out;
}

function assertCopyIsItsChild(copyId) {
  const index = groupFor(copyId);
  assert.ok(index >= 0, `the declared list carries no entry for ${copyId}`);
  const committed = flow.$referenced_components[copyId];
  assert.ok(committed, `${FLOW_PATH} carries no copy ${copyId}`);
  const generated = generateCopy(children[index], list[index]);
  const paths = differingPaths(committed, generated);
  assert.deepEqual(
    paths,
    [],
    `${copyId} differs from ${list[index].repository} at ${list[index].commit} beyond the declared list ` +
      `(run node scripts/embedded-copies.mjs --write): ${paths.join(", ")}`,
  );
}

test("(7) each child snapshot is that child's committed flow at its pinned commit", () => {
  assert.equal(list.length, 3);
  for (const group of list) {
    assert.match(group.commit, /^[0-9a-f]{40}$/, `${group.repository}: the pinned commit is not a full sha`);
    assert.match(group.blob, /^[0-9a-f]{40}$/, `${group.repository}: the snapshot blob is not a full sha`);
    assert.equal(
      gitBlobSha(loadChildBuffer(group)),
      group.blob,
      `${group.snapshot} is not ${group.repository}'s cinatra/oas.json at ${group.commit}`,
    );
  }
});

test("(7) every declared difference names its child and its reason and still applies", () => {
  for (const [index, group] of list.entries()) {
    assert.ok(Array.isArray(group.declared) && group.declared.length > 0, `${group.repository}: no declared list`);
    for (const [at, entry] of group.declared.entries()) {
      const label = `${group.repository} entry ${at + 1}`;
      assert.equal(entry.child, group.repository, `${label} does not name its child`);
      assert.ok(KINDS.includes(entry.kind), `${label} has an unknown kind ${entry.kind}`);
      assert.equal(typeof entry.reason, "string", `${label} carries no reason`);
      assert.ok(entry.reason.trim().length > 0, `${label} carries an empty reason`);
    }
    assert.doesNotThrow(() => generateCopy(children[index], group), `${group.repository}: a declared entry no longer applies`);
    // A stale declaration fails: an entry whose target the child does not have throws, naming the child.
    const stale = {
      ...group,
      declared: [...group.declared, { child: group.repository, kind: "omit-step", step: "absent_step", reason: "probe" }],
    };
    assert.throws(() => generateCopy(children[index], stale), (error) => error.message.includes(group.repository));
    // A declaration the child already meets fails too: a second copy of an edge or of a stored value.
    for (const entry of group.declared.filter((e) => ["control-edge", "data-edge", "copy-value"].includes(e.kind))) {
      const redundant = { ...group, declared: [...group.declared, entry] };
      assert.throws(
        () => generateCopy(children[index], redundant),
        (error) => error.message.includes(group.repository) && error.message.includes(`(${entry.kind})`),
        `${group.repository}: a repeated ${entry.kind} entry is accepted`,
      );
    }
  }
});

test("(7) the recipient selection copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-recipient-selection-subflow");
});

test("(7) the drafting copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-drafting-subflow");
});

test("(7) the delivery copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-delivery-subflow");
});

test("(7) the committed flow is exactly what the generator writes", () => {
  const written = serialize(generateFlow(flow, list, children));
  assert.ok(
    written === flowText,
    `${FLOW_PATH} is not byte for byte what node scripts/embedded-copies.mjs --write writes`,
  );
  // --write replaces the three copies only: a byte outside them is kept as it is.
  const generated = generateFlow(flow, list, children);
  assert.equal(writeCopies(flowText, generated, list), flowText);
  const outside = flowText.replace('"agentspec_version": ', '"agentspec_version":  ');
  assert.notEqual(outside, flowText, "the probe changed nothing");
  assert.equal(writeCopies(outside, generated, list), outside, "--write rewrote bytes outside the three copies");
  // Every $component_ref of a copy carries the prefix once, the ones inside its steps included.
  const [group] = list;
  const nested = JSON.parse(JSON.stringify(children[0]));
  const [firstStep, secondStep] = Object.keys(nested.$referenced_components);
  nested.$referenced_components[firstStep].probe = { $component_ref: secondStep };
  const copy = generateCopy(nested, group);
  const renamed = (id) => group.declared.find((e) => e.kind === "rename-step" && e.step === id)?.to ?? id;
  assert.deepEqual(copy.$referenced_components[group.prefix + renamed(firstStep)].probe, {
    $component_ref: group.prefix + renamed(secondStep),
  });
});

test("(7) the parent hands each copy only inputs it takes and reads only outputs it hands on, the campaign id included", () => {
  const generated = generateFlow(flow, list, children);
  const refs = generated.$referenced_components;
  const copyOf = {};
  for (const stepId of ["recipients_flow", "drafts_flow", "sender_flow"]) {
    const step = refs[stepId];
    assert.equal(step?.component_type, "FlowNode", `${stepId} is not a flow step`);
    const copyId = step.subflow?.$component_ref;
    assert.ok(groupFor(copyId) >= 0, `${stepId} runs ${copyId}, which the declared list does not generate`);
    copyOf[stepId] = refs[copyId];
  }
  const titles = (items) => (items ?? []).map((item) => item.title);
  const problems = [];
  for (const edge of generated.data_flow_connections) {
    const into = copyOf[edge.destination_node.$component_ref];
    if (into && !titles(into.inputs).includes(edge.destination_input)) {
      problems.push(`${edge.name}: ${into.id} takes no input ${edge.destination_input}`);
    }
    const outOf = copyOf[edge.source_node.$component_ref];
    if (outOf && !titles(outOf.outputs).includes(edge.source_output)) {
      problems.push(`${edge.name}: ${outOf.id} hands on no output ${edge.source_output}`);
    }
  }
  for (const stepId of ["recipients_flow", "drafts_flow"]) {
    const rewired = generated.data_flow_connections.find(
      (edge) =>
        edge.source_node.$component_ref === "context_setup" &&
        edge.source_output === "campaignId" &&
        edge.destination_node.$component_ref === stepId &&
        edge.destination_input === "campaignId",
    );
    if (!rewired) problems.push(`the campaign id is not handed to ${stepId}`);
    else if (rewired.name !== `context_setup_to_${stepId}_campaignId`) problems.push(`${rewired.name} is misnamed`);
  }
  assert.deepEqual(problems, []);
});
