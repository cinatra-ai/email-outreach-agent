// ---------------------------------------------------------------------------
// The drafts the run saved reach their review, one review per body -
// zero-dependency, runs under tests/run.mjs. cinatra-ai/cinatra#3089.
//
// The outreach runs its drafting as the embedded copy "email-drafting-subflow"
// of the drafting agent's flow (scripts/embedded-copies.json pins the commit).
// Its draft step saves the drafted emails as one draft bundle object. Its read
// step reads that bundle by its reference and binds each draft to one recipient
// of the approved list; its filing step files each drafted body as its own
// email body (the body text, the subject as its title, the draft's contact and
// the campaign on its data) and hands the review the filed bodies as its review
// targets. The review declares those targets as its artifact-review marker, so
// the application pins exactly those revisions and opens one review per body,
// in draft order, on its own review card, while the run waits at the review.
//
// This suite holds the copy to that road: the read step and the filing step
// stand between the draft step and the review on every path, each is handed
// what it reads, and the review is handed the filed bodies and nothing a
// caller could supply instead.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const FLOW = oas.$referenced_components["email-drafting-subflow"];
const refs = FLOW.$referenced_components;
const START = "drafts-start";
const DRAFT = "drafts-draft";
const READ = "drafts-read_drafts";
const FILE = "drafts-file_drafts";
const GATE = "drafts-approval_gate";
const END = "drafts-end";
const refOf = (node) => (node && typeof node === "object" ? node.$component_ref : undefined);
const controlEdges = () => FLOW.control_flow_connections.map((e) => [refOf(e.from_node), refOf(e.to_node)]);
const into = (id) =>
  FLOW.data_flow_connections
    .filter((e) => refOf(e.destination_node) === id)
    .map((e) => `${refOf(e.source_node)}.${e.source_output} -> ${e.destination_input}`)
    .sort();

/** The steps reachable from the copy's start when `blocked` is taken out. */
function reach(blocked) {
  const seen = new Set();
  const queue = [refOf(FLOW.start_node)];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id) || id === blocked) continue;
    seen.add(id);
    for (const [from, to] of controlEdges()) if (from === id) queue.push(to);
  }
  return seen;
}

test("the draft step, the read step, the filing step and the review follow one another", () => {
  for (const [from, to] of [
    [DRAFT, READ],
    [READ, FILE],
    [FILE, GATE],
    [GATE, END],
  ]) {
    assert.ok(controlEdges().some(([f, t]) => f === from && t === to), `${to} does not follow ${from}`);
  }
});

test("no path from the start reaches the review without passing the read step and the filing step", () => {
  assert.ok(reach(null).has(GATE));
  assert.ok(!reach(READ).has(GATE), "a path reaches the review without the read step");
  assert.ok(!reach(FILE).has(GATE), "a path reaches the review without the filing step");
});

test("the read step reads the saved bundle by its reference, against the approved recipient list", () => {
  const step = refs[READ];
  assert.equal(step.url, "{{CINATRA_BASE_URL}}/api/agents/passthrough");
  assert.equal(step.data.tool, "extension_tool");
  assert.equal(step.data.input.name, "saved_drafts");
  assert.deepEqual(step.data.input.input, { draftBundleRef: "{{ draftBundleRef }}", confirmedRecipientsRef: "{{ confirmedRecipientsRef }}" });
  assert.deepEqual(into(READ), [
    `${DRAFT}.draftBundleRef -> draftBundleRef`,
    `${START}.agent_run_id -> agent_run_id`,
    `${START}.confirmedRecipientsRef -> confirmedRecipientsRef`,
  ].sort());
  assert.equal(step.metadata.cinatra.requiresApproval, false);
  assert.equal(step.metadata.cinatra.riskClass, "read_only");
});

test("the filing step files each drafted body as its own email body, with its contact, its campaign and its run", () => {
  const step = refs[FILE];
  assert.equal(step.data.tool, "artifact_materialize");
  const input = step.data.input;
  assert.equal(input.extension, "@cinatra-ai/email-artifacts");
  assert.equal(input.objectTypeId, "@cinatra-ai/email:body");
  assert.match(input.content, /\{\{ draftBundle\.draftedEmails \| tojson \}\}$/);
  assert.equal(input.memberContentField, "body");
  assert.equal(input.memberTitleField, "subject");
  assert.deepEqual(input.memberDataFields, ["contactId"]);
  assert.deepEqual(input.memberData, { campaignId: "{{ campaignId }}" });
  assert.equal(input.node_id, FILE, "the filing step's idempotency identity is not its own id");
  assert.deepEqual(into(FILE), [
    `${READ}.draftBundle -> draftBundle`,
    `${START}.agent_run_id -> agent_run_id`,
    `${START}.campaignId -> campaignId`,
  ].sort());
  // The outreach's manifest declares the body it files: the application
  // authorizes the filing against the run package's cinatra.produces.
  assert.ok((pkg.cinatra.produces ?? []).some((p) => p.extension === input.extension && p.objectTypeId === input.objectTypeId));
});

test("the review is handed the filed bodies as its review targets, and the application draws it", () => {
  const gate = refs[GATE];
  const meta = gate.metadata.cinatra;
  assert.deepEqual(meta.artifactReview, { targetsInput: "reviewTargets" });
  assert.equal(meta.surfaceGateInputs, true);
  assert.equal(meta.requiresApproval, true);
  assert.equal(meta.renderer, undefined, "the review names a screen of its own");
  assert.deepEqual(gate.inputs.map((i) => i.title), ["reviewTargets"]);
  assert.deepEqual(into(GATE), [`${FILE}.reviewTargets -> reviewTargets`]);
  // The targets are filed by a step of the copy: no input of the copy or of the
  // outreach carries that name, so nothing a caller hands in stands in for them.
  assert.ok(!FLOW.inputs.some((i) => i.title === "reviewTargets"));
  assert.ok(!oas.inputs.some((i) => i.title === "reviewTargets"));
});

test("the outreach's drafting step is one gateStep with one pause, and names the drafting package", () => {
  const node = oas.$referenced_components.drafts_flow;
  assert.equal(refOf(node.subflow), "email-drafting-subflow");
  assert.equal(node.metadata.cinatra.packageName, "@cinatra-ai/email-drafting-agent");
  const steps = node.metadata.cinatra.gateSteps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].gateCount, 1);
  // The review gate is the copy's only InputMessageNode.
  const gates = Object.values(refs).filter((n) => n.component_type === "InputMessageNode").map((n) => n.id);
  assert.deepEqual(gates, [GATE]);
});
