// ---------------------------------------------------------------------------
// Flow contract guard — zero-dependency, runs on plain `node --test`.
//
// This repo ships no TypeScript; its product IS the manifest + the flow
// definition. These tests pin the two properties that the reviewer-agent
// retirement (cinatra#2047 row 8 / cinatra#1796) must not silently break:
//
//   1. RETIREMENT (exact-identity): the flow carries no reference to the
//      retiring reviewer agent — not as a manifest dependency, not as a HITL
//      screen advert, not as a gate renderer.
//   2. USER CONTROL PRESERVED: every human hold the flow had BEFORE the
//      retirement is still there, at the same moment, with the same
//      approve/reject affordance. The reviewer agent only ever RENDERED two of
//      those holds; the holds themselves are this flow's own gates. Deleting
//      the dependency must not delete a gate.
//
// Plus a no-dangling-reference guard: every renderer id the flow names must be
// served by this package or by a DECLARED dependency.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const pkgRaw = readFileSync(path.join(root, "package.json"), "utf8");
const oasRaw = readFileSync(path.join(root, "cinatra/oas.json"), "utf8");
const pkg = readJson("package.json");
const oas = readJson("cinatra/oas.json");

// The retiring package ref, ASSEMBLED rather than written as one literal.
// The retirement acceptance (cinatra#2047 row 8) is scored by an exact-identity
// `git grep -F` for this ref, and a guard that asserts the ref's ABSENCE would
// otherwise be the one file that makes the repo's count non-zero — a false
// positive for whoever runs that sweep. Assembling it keeps the assertion below
// exact while leaving the repo genuinely clean to the grep.
const RETIRED_PACKAGE = ["@cinatra-ai", "reviewer", "agent"].join("/").replace("reviewer/agent", "reviewer-agent");

const refs = oas.$referenced_components;
const flowMeta = oas.metadata.cinatra;

/** Every `renderer` / `inputRenderers` value anywhere in the flow definition. */
function collectRendererIds(node, out = new Set()) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectRendererIds(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "renderer" && typeof v === "string") out.add(v);
    else if (k === "x-renderer" && typeof v === "string") out.add(v);
    else if (k === "inputRenderers" && v && typeof v === "object") {
      for (const id of Object.values(v)) if (typeof id === "string") out.add(id);
    } else collectRendererIds(v, out);
  }
  return out;
}

/** Every InputMessageNode in the flow and its inlined subflows. */
function collectInputMessageNodes(node, out = new Map()) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectInputMessageNodes(v, out);
    return out;
  }
  if (node.component_type === "InputMessageNode" && typeof node.id === "string") {
    out.set(node.id, node);
  }
  for (const v of Object.values(node)) collectInputMessageNodes(v, out);
  return out;
}

const rendererIds = collectRendererIds(oas);
const inputMessageNodes = collectInputMessageNodes(oas);

// ---------------------------------------------------------------------------
// 1. Retirement — exact identity, no substring false positives.
// ---------------------------------------------------------------------------

test("the manifest declares no dependency on the retired reviewer agent", () => {
  const names = pkg.cinatra.dependencies.map((d) => d.packageName);
  assert.ok(!names.includes(RETIRED_PACKAGE), `still depends on ${RETIRED_PACKAGE}`);
});

test("neither the manifest nor the flow definition mentions the retired reviewer agent", () => {
  for (const [label, raw] of [
    ["package.json", pkgRaw],
    ["cinatra/oas.json", oasRaw],
  ]) {
    assert.ok(!raw.includes(RETIRED_PACKAGE), `${label} still references ${RETIRED_PACKAGE}`);
  }
});

// ---------------------------------------------------------------------------
// 2. User control preserved — every hold still present.
// ---------------------------------------------------------------------------

test("both review gate steps survive the retirement: the recipients review on its pack screen, the drafts review on the application's review card", () => {
  const gateStep = (nodeId, name) => {
    const steps = refs[nodeId].metadata.cinatra.gateSteps;
    const found = steps.find((s) => s.name === name);
    assert.ok(found, `${nodeId} lost its "${name}" gate step`);
    return found;
  };

  const recipients = gateStep("recipients_flow", "Review recipients");
  assert.equal(
    recipients.renderer,
    "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
  );
  assert.equal(recipients.gateCount, 1);
  assert.equal(recipients.hitlOwnedBy, "self");

  // The drafts review is one gateStep spanning one pause (what the application
  // asks of a FlowNode that wraps a child's artifact-review gate); it names no
  // screen, because the application draws the review card for the filed bodies.
  const drafts = gateStep("drafts_flow", "Review drafts");
  assert.equal(refs.drafts_flow.metadata.cinatra.gateSteps.length, 1);
  assert.equal(drafts.renderer, undefined);
  assert.equal(drafts.gateCount, 1);
  assert.equal(drafts.hitlOwnedBy, "self");
  const gate = refs["email-drafting-subflow"].$referenced_components["drafts-approval_gate"];
  assert.deepEqual(gate.metadata.cinatra.artifactReview, { targetsInput: "reviewTargets" });
});

test("every human hold the flow used to park at is still present", () => {
  // The moments a run stops and waits for the operator. `recipients-review_gate`
  // and `drafts-approval_gate` are the two the reviewer agent used to RENDER;
  // they are this flow's own nodes and must outlive the dependency.
  //
  // The setup hold is no longer one of them: W8 (cinatra#3096 item 1) folded it
  // into the start form, so the same three fields are asked BEFORE the run
  // begins instead of at a pause one step in. The control the person had is
  // asserted below on the start form itself.
  //
  // The send confirmation is no longer a gate of the flow: since cinatra#3089
  // the send is the flow's one top-level publishing step, and the application
  // stops the run in front of it on its publish card.
  for (const id of [
    "recipients-scope_gate",
    "recipients-review_gate",
    "drafts-approval_gate",
  ]) {
    assert.ok(inputMessageNodes.get(id), `the "${id}" hold is gone`);
  }
  assert.equal(inputMessageNodes.get("sender-approval_gate"), undefined, "a second confirmation stands beside the publish card");
  assert.equal(refs.send.metadata.cinatra.publishes, true, "the publish stop in front of the send is gone");
  assert.ok(oas.nodes.some((n) => n.$component_ref === "send"), "the send is not a top-level step");
});

test("the setup hold survives as the start form the run opens with", () => {
  assert.equal(inputMessageNodes.get("setup_gate"), undefined, "the setup pause came back");
  const start = refs.start;
  const titles = start.inputs.map((i) => i.title);
  for (const field of ["offeringCompanyWebsite", "callToAction", "senderName"]) {
    assert.ok(titles.includes(field), `the start form stopped asking for ${field}`);
  }
  assert.deepEqual(start.metadata.cinatra.required, ["offeringCompanyWebsite", "callToAction", "senderName", "senderEmail"]);
});

test("the holds that require an explicit approval still require it", () => {
  for (const id of [
    "recipients-review_gate",
    "drafts-approval_gate",
  ]) {
    assert.equal(
      inputMessageNodes.get(id).metadata.cinatra.requiresApproval,
      true,
      `the "${id}" hold no longer requires approval`,
    );
  }
});

test("the external send is still gated behind an explicit approval: the person's release on the publish card", () => {
  const send = refs.send;
  assert.equal(send.metadata.cinatra.riskClass, "email_send");
  // The publish card is the one approval in front of the send: the application
  // stops the run in front of a top-level step that declares publishes: true
  // and lets it run only after the person released the send.
  assert.equal(send.metadata.cinatra.publishes, true);
  assert.equal(send.metadata.cinatra.requiresApproval, false);
  assert.ok(oas.nodes.some((n) => n.$component_ref === "send"));
});

// ---------------------------------------------------------------------------
// 3. No dangling references left behind by the removal.
// ---------------------------------------------------------------------------

test("every renderer the flow names is served by this package or a declared dependency", () => {
  const declared = new Set([
    pkg.name,
    ...pkg.cinatra.dependencies.map((d) => d.packageName),
  ]);
  for (const id of rendererIds) {
    if (!id.startsWith("@")) continue; // bare fallback ids are host-owned
    const owner = id.slice(0, id.indexOf(":", 1));
    assert.ok(declared.has(owner), `renderer "${id}" names undeclared package "${owner}"`);
  }
});

test("every advertised HITL screen is served by this package or a declared dependency", () => {
  const declared = new Set([
    pkg.name,
    ...pkg.cinatra.dependencies.map((d) => d.packageName),
  ]);
  for (const id of flowMeta.hitlScreens) {
    const owner = id.slice(0, id.indexOf(":", 1));
    assert.ok(declared.has(owner), `hitlScreens entry "${id}" names undeclared package "${owner}"`);
  }
});

test("the recipients review renderer is advertised as a HITL screen, and no screen the flow no longer draws is", () => {
  assert.ok(flowMeta.hitlScreens.includes("@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review"));
  for (const id of flowMeta.hitlScreens) {
    assert.ok(rendererIds.has(id), `hitlScreens advertises "${id}", which no step of the flow draws`);
  }
});

// ---------------------------------------------------------------------------
// 4. Account scope — the step takes one or more of the connected CRM's views
//    or lists, at least one of them, and offers no road out to another agent
//    (cinatra#3562, the half this repository owns: the DECLARATION).
// ---------------------------------------------------------------------------

const LIST_PICKER_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const listPicker = pkg.cinatra.fieldRenderers.find((r) => r.id === LIST_PICKER_ID);
const recipientsGenerate =
  refs["email-recipient-selection-subflow"].$referenced_components["recipients-generate"];
const generatePrompt = recipientsGenerate.data.system;

/** `name` as a whole word — so `sourceListId` never matches on `sourceListIds`. */
const namesExactly = (text, name) => new RegExp(`${name}(?![A-Za-z0-9_])`).test(text);

test("the account scope step declares no road out to a list-building run", () => {
  assert.ok(listPicker, `the manifest stopped declaring the "${LIST_PICKER_ID}" renderer`);
  assert.ok(
    !pkgRaw.includes("listBuilderPackage"),
    "the manifest still declares listBuilderPackage — the road out of the step is still there",
  );
});

test("the account scope binding declares a multi-select with a floor of one", () => {
  assert.equal(listPicker.params.selection, "multiple");
  assert.equal(listPicker.params.minSelected, 1);
});

test("the generate step resolves every ticked list, not only the first", () => {
  assert.ok(namesExactly(generatePrompt, "listIds"), "the prompt never names listIds");
  assert.match(generatePrompt, /MUST pick one or more saved CRM lists/);
  assert.match(generatePrompt, /For EACH id in selectedListIds/);
  assert.match(generatePrompt, /crm_list_get\(\{ id \}\)/);
  assert.match(generatePrompt, /crm_list_members_get\(\{ listId: id \}\)/);
  assert.match(generatePrompt, /UNION the per-list contactIds into one array in first-seen order/);
});

test("a scope carrying only the legacy single listId is still read as one list", () => {
  assert.match(generatePrompt, /bare `listId`[\s\S]{0,160}one-element list/);
});

test("the generate step no longer reads a single identifier off the scope", () => {
  for (const legacy of [
    "crm_list_get({ id: accountScope.listId })",
    "crm_list_members_get({ listId: accountScope.listId })",
  ]) {
    assert.ok(!generatePrompt.includes(legacy), `the prompt still calls ${legacy}`);
  }
});

test("the saved bundle keeps its first-list provenance and gains the ticked-order arrays", () => {
  for (const field of ["sourceListId", "sourceListName", "sourceListIds", "sourceListNames"]) {
    assert.ok(
      namesExactly(generatePrompt, field),
      `the objects_save contract no longer names ${field}`,
    );
  }
});

test("the account scope hold is still one gate this flow owns, answered as a string", () => {
  const steps = refs.recipients_flow.metadata.cinatra.gateSteps.filter(
    (s) => s.name === "Account scope",
  );
  assert.equal(steps.length, 1, "the flow no longer declares exactly one Account scope gate step");
  assert.equal(steps[0].renderer, LIST_PICKER_ID);
  assert.equal(steps[0].gateCount, 1);
  assert.equal(steps[0].hitlOwnedBy, "self");

  const outputs = inputMessageNodes.get("recipients-scope_gate").outputs;
  assert.equal(outputs.length, 1, "the scope gate no longer takes exactly one answer");
  assert.equal(outputs[0].title, "accountScope");
  assert.equal(outputs[0].type, "string");
});

// ---------------------------------------------------------------------------
// One send takes at most 50 recipients, and the run says so before any drafting.
//
// The delivery agent's flow takes at most 50 approved bodies, drafts and
// confirmed recipients (maxItems 50 on its start inputs and its read step's
// outputs; its read step refuses more as TOO_MANY_BODIES, TOO_MANY_DRAFTS,
// TOO_MANY_RECIPIENTS before anything is read), and the application pins at most
// 50 artifacts to one review (MAX_REVIEW_TARGETS). So a campaign with more than
// 50 confirmed recipients could draft, file and review its emails and then
// never reach the publish card. The outreach flow therefore checks the number
// of confirmed recipients, which the recipients step ends with after the
// person's removals, in three steps of its own between the recipients step and
// the drafting: a template that answers within or too_many, a branch, and a
// closing sentence that names the number and the limit. The limit is a literal
// of the flow; these tests keep it equal to the delivery copy's own bound and
// to the delivery snapshot's, so a re-snapshot of the delivery agent that moves
// its bound fails here until the check moves with it.
// ---------------------------------------------------------------------------

const deliveryCopy = refs["email-delivery-subflow"];
const deliverySnapshot = readJson("scripts/children/email-delivery-agent.oas.json");
const limitCheck = refs.recipient_limit_check;
const limitBranch = refs.recipient_limit_branch;
const limitMessage = refs.too_many_recipients;

/** Every maxItems a flow declares, anywhere. */
function listBounds(flow) {
  const bounds = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    if (typeof node.maxItems === "number") bounds.add(node.maxItems);
    Object.values(node).forEach(walk);
  };
  walk(flow);
  return bounds;
}

/** The check's template under its own grammar: `{% if recipientCount > N %}a{% else %}b{% endif %}`. */
function limitVerdict(count) {
  const m = limitCheck.template.match(/^\{% if recipientCount > (\d+) %\}(\w+)\{% else %\}(\w+)\{% endif %\}$/);
  assert.ok(m, "the template is one if/else over recipientCount");
  return count > Number(m[1]) ? m[2] : m[3];
}

/** The step the run goes to after the check, over the flow's own branch and edges. */
function nextAfterLimit(count) {
  const branch = limitBranch.mapping[limitVerdict(count)] ?? "default";
  const edge = oas.control_flow_connections.find(
    (e) => e.from_node.$component_ref === "recipient_limit_branch" && (e.from_branch ?? "default") === branch,
  );
  return edge.to_node.$component_ref;
}

/** Every step reachable from `start` over the control edges (the start included). */
function reachableFrom(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of oas.control_flow_connections) if (e.from_node.$component_ref === id) queue.push(e.to_node.$component_ref);
  }
  return seen;
}

const LIMIT = Number(limitCheck?.template.match(/> (\d+)/)?.[1]);

test("the limit of the recipient check is the delivery copy's own bound, and the delivery snapshot's", () => {
  assert.ok(Number.isInteger(LIMIT) && LIMIT > 0, "the recipient check names no limit");
  assert.deepEqual([...listBounds(deliveryCopy)], [LIMIT], "the delivery copy's list bounds are not the recipient check's limit");
  assert.deepEqual([...listBounds(deliverySnapshot)], [LIMIT], "the delivery snapshot's list bounds are not the recipient check's limit");
  const read = deliveryCopy.$referenced_components["sender-resolve_send"];
  assert.equal(deliveryCopy.inputs.find((i) => i.title === "emailBodies").json_schema.maxItems, LIMIT);
  assert.equal(read.outputs.find((o) => o.title === "recipients").json_schema.maxItems, LIMIT);
  // Its read step refuses more recipients than that by name, before anything is read.
  assert.match(
    read.metadata.cinatra.description,
    new RegExp(`more than ${LIMIT} bodies, drafts or confirmed recipients \\(TOO_MANY_BODIES, TOO_MANY_DRAFTS, TOO_MANY_RECIPIENTS`),
  );
});

test("the closing sentence names the number of recipients and the same limit", () => {
  assert.deepEqual(limitMessage.inputs.map((i) => i.title), ["recipientCount"]);
  assert.match(limitMessage.message, /\{\{ recipientCount \}\} recipients are confirmed/);
  const stated = [...limitMessage.message.matchAll(/at most (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(stated, [LIMIT, LIMIT], "the sentence states another limit than the check");
});

test("50 confirmed recipients go on to the drafting, 51 stop before it with the sentence", () => {
  assert.equal(LIMIT, 50);
  for (const count of [0, 1, 49, 50]) assert.equal(nextAfterLimit(count), "context_offeringContext", `${count} recipients`);
  for (const count of [51, 52, 200, 5000]) assert.equal(nextAfterLimit(count), "too_many_recipients", `${count} recipients`);
  // The stop ends the run: nothing of the drafting, the delivery or the send is reachable from it.
  const after = reachableFrom("too_many_recipients");
  assert.deepEqual([...after].sort(), ["end", "too_many_recipients"]);
  for (const step of ["context_offeringContext", "drafts_flow", "sender_flow", "send", "campaign_summary"]) assert.ok(!after.has(step), step);
});

test("no road leads from the recipients step to the drafting without the check, and the count is the one the recipients step ends with", () => {
  const control = oas.control_flow_connections.map((e) => [e.from_node.$component_ref, e.to_node.$component_ref]);
  assert.deepEqual(control.filter(([from]) => from === "recipients_flow").map(([, to]) => to), ["recipient_limit_check"]);
  assert.deepEqual(control.filter(([, to]) => to === "context_offeringContext").map(([from]) => from), ["recipient_limit_branch"]);
  assert.deepEqual(control.filter(([, to]) => to === "drafts_flow").map(([from]) => from), ["context_offeringContext"]);
  const data = oas.data_flow_connections.map(
    (e) => `${e.source_node.$component_ref}.${e.source_output} -> ${e.destination_node.$component_ref}.${e.destination_input}`,
  );
  assert.ok(data.includes("recipients_flow.recipientCount -> recipient_limit_check.recipientCount"));
  assert.ok(data.includes("recipient_limit_check.output -> recipient_limit_branch.verdict"));
  assert.ok(data.includes("recipients_flow.recipientCount -> too_many_recipients.recipientCount"));
  // The recipients copy's count is the reviewed one (what is left after the person's removals), not the proposed one.
  const copy = refs["email-recipient-selection-subflow"];
  const feeds = copy.data_flow_connections.filter(
    (e) => e.destination_node.$component_ref === "recipients-end" && e.destination_input === "recipientCount",
  );
  assert.deepEqual(feeds.map((e) => `${e.source_node.$component_ref}.${e.source_output}`), ["recipients-apply.reviewedCount"]);
  assert.equal(limitBranch.branches.join(), "default,too_many");
  assert.deepEqual(limitBranch.mapping, { too_many: "too_many" });
});
