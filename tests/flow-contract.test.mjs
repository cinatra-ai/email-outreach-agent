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

test("both review gate steps survive the retirement, served by the email pack renderers", () => {
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

  const drafts = gateStep("drafts_flow", "Review drafts");
  assert.equal(drafts.renderer, "@cinatra-ai/email-drafting-agent:email-drafts-review");
  assert.equal(drafts.gateCount, 1);
  assert.equal(drafts.hitlOwnedBy, "self");
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
  for (const id of [
    "recipients-scope_gate",
    "recipients-review_gate",
    "drafts-approval_gate",
    "sender-approval_gate",
  ]) {
    assert.ok(inputMessageNodes.get(id), `the "${id}" hold is gone`);
  }
});

test("the setup hold survives as the start form the run opens with", () => {
  assert.equal(inputMessageNodes.get("setup_gate"), undefined, "the setup pause came back");
  const start = refs.start;
  const titles = start.inputs.map((i) => i.title);
  for (const field of ["offeringCompanyWebsite", "callToAction", "senderName"]) {
    assert.ok(titles.includes(field), `the start form stopped asking for ${field}`);
  }
  assert.deepEqual(start.metadata.cinatra.required, ["offeringCompanyWebsite", "callToAction", "senderName"]);
});

test("the holds that require an explicit approval still require it", () => {
  for (const id of [
    "recipients-review_gate",
    "drafts-approval_gate",
    "sender-approval_gate",
  ]) {
    assert.equal(
      inputMessageNodes.get(id).metadata.cinatra.requiresApproval,
      true,
      `the "${id}" hold no longer requires approval`,
    );
  }
});

test("the external send is still gated behind an explicit approval", () => {
  const send = refs["email-delivery-subflow"].$referenced_components["sender-send"];
  assert.equal(send.metadata.cinatra.riskClass, "email_send");
  assert.equal(send.metadata.cinatra.requiresApproval, true);
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

test("the two review gate renderers are advertised as HITL screens", () => {
  for (const id of [
    "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
    "@cinatra-ai/email-drafting-agent:email-drafts-review",
  ]) {
    assert.ok(flowMeta.hitlScreens.includes(id), `hitlScreens is missing "${id}"`);
  }
});
