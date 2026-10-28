// ---------------------------------------------------------------------------
// The review gates reach their screens — zero-dependency, runs under
// tests/run.mjs. cinatra-ai/cinatra#3089.
//
// A gate's declared inputs reach the screen that draws it by one road only.
// The pinned WayFlow runtime never writes the task's metadata, so the host's
// pendingApproval channel is always empty. What the host does read is the
// gate's own message: when that whole message is one JSON object, the host
// spreads its keys into the renderer's values. The loader writes that message
// as a JSON object of the gate's inputs only when the gate declares
// `metadata.cinatra.surfaceGateInputs: true`. Without the flag, the loader
// writes an empty template, the message is empty, and the screen receives
// nothing: the recipients review shows "Waiting for the agent to generate the
// recipient list…" while its Continue stays enabled, so one press approves
// recipients nobody saw.
//
// The two helpers below copy the two halves of that road, so this suite can
// hold the pack to it without the runtime:
//   - gateMessage: the loader's gate template rule
//     (cinatra docker/wayflow/agent_loader.py, _reconcile_input_message_gates)
//     and the render of that template with the gate's input values.
//   - hostValues: the host's read of the gate message into renderer values
//     (cinatra packages/agents/src/execution.ts, historyText → spreadFromOutput
//     → enrichedValues).
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const declaredList = JSON.parse(readFileSync(path.join(root, "scripts/embedded-copies.json"), "utf8"));

/** Every InputMessageNode in the composite, parent flow and inlined subflows. */
function collectPauses(node, out = new Map()) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectPauses(v, out);
    return out;
  }
  if (node.component_type === "InputMessageNode" && typeof node.id === "string") out.set(node.id, node);
  for (const v of Object.values(node)) collectPauses(v, out);
  return out;
}

const pauses = collectPauses(oas);

// ---------------------------------------------------------------------------
// The loader half: the gate template and its render.
// ---------------------------------------------------------------------------

const GATE_INPUT_TITLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The template the loader writes for a gate node (null when it leaves the node as it is). */
function gateTemplate(node) {
  const titles = (node.inputs ?? []).map((i) => (i && typeof i === "object" ? i.title : undefined));
  const allOk =
    titles.length > 0 &&
    titles.every((t) => typeof t === "string" && GATE_INPUT_TITLE.test(t)) &&
    new Set(titles).size === titles.length;
  if (!allOk || node.message_template) return null;
  const surface = node.metadata?.cinatra?.surfaceGateInputs === true; // strict, never truthy
  if (surface) {
    return "{" + titles.map((t) => `"${t}": {% if ${t} %}{{ ${t} | tojson }}{% else %}null{% endif %}`).join(", ") + "}";
  }
  return titles.map((t) => `{% if ${t} %}{% endif %}`).join("");
}

/** Jinja truthiness for the values a gate input can hold. */
function truthy(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v) || typeof v === "string") return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Renders exactly the two template shapes the loader writes; any other markup is an error. */
function renderTemplate(template, values) {
  const out = template
    .replace(
      /\{% if ([A-Za-z_][A-Za-z0-9_]*) %\}\{\{ \1 \| tojson \}\}\{% else %\}null\{% endif %\}/g,
      (_, t) => (truthy(values[t]) ? JSON.stringify(values[t]) : "null"),
    )
    .replace(/\{% if ([A-Za-z_][A-Za-z0-9_]*) %\}\{% endif %\}/g, "");
  assert.ok(!/\{%|\{\{/.test(out), `the template carries markup this copy does not know: ${template}`);
  return out;
}

/** The text of the message a gate sends the host, given its input values. */
function gateMessage(node, values) {
  const template = gateTemplate(node);
  assert.notEqual(template, null, `the loader leaves gate ${node.id} without a template: it would not mount`);
  return renderTemplate(template, values);
}

// ---------------------------------------------------------------------------
// The host half: the gate message read into the renderer's values.
// ---------------------------------------------------------------------------

/** The values the host hands the gate's screen, given the gate message and the run's inputs. */
function hostValues(messageText, inputParams = {}) {
  const interruptPayload = {}; // the pinned runtime never writes task.metadata
  const historyText = messageText && messageText.length > 0 ? messageText : undefined;
  const interruptOutput =
    historyText ?? (Object.keys(interruptPayload).length > 0 ? JSON.stringify(interruptPayload) : undefined);
  const spreadFromOutput = (() => {
    if (typeof interruptOutput !== "string") return {};
    const trimmed = interruptOutput.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
    try {
      const p = JSON.parse(trimmed);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  })();
  const reserved = new Set(["output", "stepNumber"]);
  const stripReserved = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !reserved.has(k)));
  const spreadSafe = historyText === undefined ? stripReserved(spreadFromOutput) : spreadFromOutput;
  return {
    ...inputParams,
    ...stripReserved(interruptPayload),
    ...spreadSafe,
    ...(interruptOutput !== undefined ? { output: interruptOutput } : {}),
  };
}

// ---------------------------------------------------------------------------
// The declared differences from the children.
// ---------------------------------------------------------------------------

/** Every declared difference that takes the surfacing flag off a child's gate. */
function flagOmissions(child, step) {
  return declaredList
    .flatMap((group) => group.declared ?? [])
    .filter(
      (d) =>
        d.child === child &&
        d.step === step &&
        typeof d.path === "string" &&
        d.path.split(".").includes("surfaceGateInputs"),
    );
}

const RECIPIENTS = {
  id: "recipients-review_gate",
  child: "cinatra-ai/email-recipient-selection-agent",
  step: "review_gate",
};
const DRAFTS = { id: "drafts-approval_gate", child: "cinatra-ai/email-drafting-agent", step: "approval_gate" };
const SENDER = { id: "sender-approval_gate", child: "cinatra-ai/email-delivery-agent", step: "approval_gate" };

// The run's own start values, which the host also spreads into every screen.
const RUN_INPUTS = {
  cinatra_run_id: "run-1",
  offeringCompanyWebsite: "https://example.com",
  callToAction: "Book a call",
  senderName: "Alex Example",
};

// ---------------------------------------------------------------------------
// The copies of the two halves tell the two cases apart.
// ---------------------------------------------------------------------------

test("a gate without the surfacing flag hands its screen none of its inputs", () => {
  const gate = structuredClone(pauses.get(RECIPIENTS.id));
  delete gate.metadata.cinatra.surfaceGateInputs;
  const values = hostValues(gateMessage(gate, { confirmedRecipients: [{ email: "a@example.com" }], recipientCount: 1 }));
  assert.equal(values.confirmedRecipients, undefined);
  assert.equal(values.recipientCount, undefined);
});

test("a gate on its first visit, before any input is set, still hands its screen a parseable message", () => {
  const gate = structuredClone(pauses.get(RECIPIENTS.id));
  gate.metadata.cinatra.surfaceGateInputs = true;
  const values = hostValues(gateMessage(gate, {}));
  assert.ok("confirmedRecipients" in values && values.confirmedRecipients === null);
  assert.ok("recipientCount" in values && values.recipientCount === null);
});

// ---------------------------------------------------------------------------
// The recipients review
// ---------------------------------------------------------------------------

test("the recipients review asks the loader to surface its inputs", () => {
  const gate = pauses.get(RECIPIENTS.id);
  assert.ok(gate, `${RECIPIENTS.id} is not a pause of the outreach`);
  assert.equal(gate.metadata.cinatra.surfaceGateInputs, true, `${RECIPIENTS.id} does not set surfaceGateInputs: true`);
});

test("the recipients the run generated reach the recipients review screen", () => {
  const gate = pauses.get(RECIPIENTS.id);
  const confirmedRecipients = [
    { contactId: "c-1", name: "Ada Example", email: "ada@example.com", company: "Example One" },
    { contactId: "c-2", name: "Ben Example", email: "ben@example.com", company: "Example Two" },
  ];
  const values = hostValues(gateMessage(gate, { confirmedRecipients, recipientCount: 2 }), RUN_INPUTS);
  assert.deepEqual(values.confirmedRecipients, confirmedRecipients, "the screen does not receive the recipients");
  assert.equal(values.recipientCount, 2, "the screen does not receive the recipient count");
});

test("the declared list does not take the surfacing flag off the recipients review", () => {
  assert.deepEqual(flagOmissions(RECIPIENTS.child, RECIPIENTS.step), []);
});

// ---------------------------------------------------------------------------
// The send confirmation
// ---------------------------------------------------------------------------

test("the send confirmation asks the loader to surface its inputs", () => {
  const gate = pauses.get(SENDER.id);
  assert.ok(gate, `${SENDER.id} is not a pause of the outreach`);
  assert.equal(gate.metadata.cinatra.surfaceGateInputs, true, `${SENDER.id} does not set surfaceGateInputs: true`);
});

test("the campaign and the mailbox reach the send confirmation screen", () => {
  const gate = pauses.get(SENDER.id);
  const values = hostValues(
    gateMessage(gate, { campaignId: "campaign-1", senderEmail: "sender@example.com" }),
    RUN_INPUTS,
  );
  assert.equal(values.campaignId, "campaign-1", "the screen does not receive the campaign");
  assert.equal(values.senderEmail, "sender@example.com", "the screen does not receive the mailbox");
});

test("the declared list does not take the surfacing flag off the send confirmation", () => {
  assert.deepEqual(flagOmissions(SENDER.child, SENDER.step), []);
});

// ---------------------------------------------------------------------------
// The drafts review — the flag only. Its declared inputs (draftBodyArtifacts,
// draftBundleRef) are not the names its screen reads, so it does not draw yet
// even with the flag; that is a separate change.
// ---------------------------------------------------------------------------

test("the drafts review asks the loader to surface its inputs", () => {
  const gate = pauses.get(DRAFTS.id);
  assert.ok(gate, `${DRAFTS.id} is not a pause of the outreach`);
  assert.equal(gate.metadata.cinatra.surfaceGateInputs, true, `${DRAFTS.id} does not set surfaceGateInputs: true`);
});
