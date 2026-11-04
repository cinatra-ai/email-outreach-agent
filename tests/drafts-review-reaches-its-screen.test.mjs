// ---------------------------------------------------------------------------
// The drafts review reaches its screen - zero-dependency, runs under
// tests/run.mjs. cinatra-ai/cinatra#3089.
//
// The outreach runs its drafting as the embedded copy "email-drafting-subflow"
// of the drafting agent's flow, so its drafts review is that agent's review.
// The draft step saves the drafted emails as one draft bundle object and
// passes on only references: the bundle's id (`draftBundleRef`) and one body
// artifact reference per draft (`draftBodyArtifacts`). The drafts review's
// screen (@cinatra-ai/email-artifacts, src/renderers/email-drafts-review.tsx)
// reads the drafts only from the values the host hands it, under
// `draftBundle.draftedEmails` (or `drafts` / `emails`), and it fetches nothing
// itself. The design binds the same field: the conformance example
// `email-gate-drafts-review-field` of specs/app-artifact-review.html reads
// `drafts=gate.draftBundle.draftedEmails`. When the gate is handed only the
// references, the screen finds no drafts and shows its waiting line.
//
// This suite runs the road from the draft step to the screen in the
// outreach's copy without the runtime, with copies of each half:
//   - runSteps: the steps between the draft step and the review, run in
//     control-flow order. Each must be a call of a tool this package declares
//     (`extension_tool` on the platform's passthrough); its module is loaded
//     from this package and handed an objects port that answers the run's
//     saved bundle. Each step's declared outputs are read off its result by
//     name, as the runtime reads an ApiNode's outputs.
//   - gateMessage: the loader's gate template rule
//     (cinatra docker/wayflow/agent_loader.py, _reconcile_input_message_gates)
//     and the render of that template, copied from
//     tests/review-gates-reach-their-screens.test.mjs.
//   - hostValues: the host's read of the gate message into renderer values
//     (cinatra packages/agents/src/execution.ts), copied from the same suite.
// The read step's module is the drafting agent's own module, byte for byte at
// the commit scripts/embedded-copies.json pins for the drafting copy: the
// platform resolves a declared tool against the package whose run calls it,
// so this package declares the tool itself and ships the module.
//   - extractDraftSnapshot: the screen's own read, copied from
//     email-artifacts src/renderers/email-drafts-review.tsx at 1f8fb36b, the
//     commit the application pins.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const FLOW = oas.$referenced_components["email-drafting-subflow"];
const DRAFT = "drafts-draft";
const GATE = "drafts-approval_gate";
const PASSTHROUGH = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
const BUNDLE_TYPE = "@cinatra-ai/campaigns:email-draft-bundle";
const READ_TOOL = "saved_drafts";

const refs = FLOW.$referenced_components;
const refOf = (node) => (node && typeof node === "object" ? node.$component_ref : undefined);
const controlEdges = () => (FLOW.control_flow_connections ?? []).map((e) => [refOf(e.from_node), refOf(e.to_node)]);
const dataEdges = () =>
  (FLOW.data_flow_connections ?? []).map((e) => ({
    from: refOf(e.source_node),
    output: e.source_output,
    to: refOf(e.destination_node),
    input: e.destination_input,
  }));

// ---------------------------------------------------------------------------
// The steps between the draft step and the review, run in order.
// ---------------------------------------------------------------------------

/** The step ids strictly between `from` and `to`, following the one control edge out of each. */
function stepsBetween(from, to) {
  const out = [];
  let at = from;
  for (let hop = 0; hop < 16; hop++) {
    const next = controlEdges().filter(([f]) => f === at).map(([, t]) => t);
    assert.equal(next.length, 1, `step ${at} has ${next.length} successors on the way to ${to}`);
    if (next[0] === to) return out;
    out.push(next[0]);
    at = next[0];
  }
  assert.fail(`no road of at most 16 steps leads from ${from} to ${to}`);
}

/** Renders the one placeholder shape a step's call input carries: a whole `{{ name }}`. */
function renderCallInput(value, inputs) {
  if (typeof value === "string") {
    const m = /^\{\{ ([A-Za-z_][A-Za-z0-9_]*) \}\}$/.exec(value);
    if (m) return inputs[m[1]] === undefined || inputs[m[1]] === null ? "" : String(inputs[m[1]]);
    assert.ok(!/\{\{|\{%/.test(value), `a call input carries markup this copy does not know: ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => renderCallInput(v, inputs));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderCallInput(v, inputs)]));
  return value;
}

/** The value of each input of `stepId`, from the data edges into it, else the input's default. */
function inputsOf(stepId, values) {
  const step = refs[stepId];
  const out = {};
  for (const descriptor of step.inputs ?? []) {
    const edge = dataEdges().find((e) => e.to === stepId && e.input === descriptor.title);
    const key = edge ? `${edge.from}.${edge.output}` : undefined;
    if (key !== undefined && values.has(key)) out[descriptor.title] = values.get(key);
    else if (Object.hasOwn(descriptor, "default")) out[descriptor.title] = descriptor.default;
  }
  return out;
}

/** Runs the steps between the draft step and the review; returns the gate's input values. */
async function runToTheReview({ startValues, draftOutputs, ports }) {
  const values = new Map();
  const start = refOf(FLOW.start_node);
  for (const descriptor of refs[start].inputs ?? []) {
    values.set(`${start}.${descriptor.title}`, startValues[descriptor.title] ?? descriptor.default);
  }
  for (const [title, value] of Object.entries(draftOutputs)) values.set(`${DRAFT}.${title}`, value);

  for (const stepId of stepsBetween(DRAFT, GATE)) {
    const step = refs[stepId];
    assert.equal(step.component_type, "ApiNode", `step ${stepId} between the draft step and the review is no call`);
    assert.equal(step.url, PASSTHROUGH, `step ${stepId} does not call the platform's passthrough`);
    assert.equal(step.data?.tool, "extension_tool", `step ${stepId} calls ${step.data?.tool}, which this copy does not run`);
    const declared = (pkg.cinatra.tools ?? []).find((t) => t.name === step.data.input?.name);
    assert.ok(declared, `step ${stepId} calls ${step.data.input?.name}, which this package does not declare`);
    const mod = await import(pathToFileURL(path.join(root, declared.module.slice(2))).href);
    const result = await mod.extensionTool({ input: renderCallInput(step.data.input.input ?? {}, inputsOf(stepId, values)), ports });
    for (const output of step.outputs ?? []) {
      const has = result && typeof result === "object" && Object.hasOwn(result, output.title);
      values.set(`${stepId}.${output.title}`, has ? result[output.title] : output.default);
    }
  }
  return inputsOf(GATE, values);
}

// ---------------------------------------------------------------------------
// The loader half: the gate template and its render (copied, see above).
// ---------------------------------------------------------------------------

const GATE_INPUT_TITLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function gateTemplate(node) {
  const titles = (node.inputs ?? []).map((i) => (i && typeof i === "object" ? i.title : undefined));
  const allOk =
    titles.length > 0 &&
    titles.every((t) => typeof t === "string" && GATE_INPUT_TITLE.test(t)) &&
    new Set(titles).size === titles.length;
  if (!allOk || node.message_template) return null;
  const surface = node.metadata?.cinatra?.surfaceGateInputs === true;
  if (surface) {
    return "{" + titles.map((t) => `"${t}": {% if ${t} %}{{ ${t} | tojson }}{% else %}null{% endif %}`).join(", ") + "}";
  }
  return titles.map((t) => `{% if ${t} %}{% endif %}`).join("");
}

function truthy(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v) || typeof v === "string") return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

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

function gateMessage(node, values) {
  const template = gateTemplate(node);
  assert.notEqual(template, null, `the loader leaves gate ${node.id} without a template: it would not mount`);
  return renderTemplate(template, values);
}

// ---------------------------------------------------------------------------
// The host half: the gate message read into the renderer's values (copied).
// ---------------------------------------------------------------------------

function hostValues(messageText, inputParams = {}) {
  const interruptPayload = {};
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
// The screen half: the drafts review's own read (copied, types removed).
// ---------------------------------------------------------------------------

function extractDraftSnapshot(value) {
  if (!value || typeof value !== "object") return [];
  const v = value;
  const bundleCandidate = v.draftBundle ?? v.followupBundle ?? v;
  const bundle = bundleCandidate && typeof bundleCandidate === "object" ? bundleCandidate : {};
  const rawArray = bundle.draftedEmails ?? bundle.drafts ?? bundle.emails;
  const items = Array.isArray(rawArray) ? rawArray : [];
  return items.map((d, i) => ({
    id: String(d.id ?? d.recipientId ?? d.recipientEmail ?? `draft-${i}`),
    recipientId: String(d.recipientId ?? d.id ?? d.recipientEmail ?? `recipient-${i}`),
    recipientName: d.recipientName ?? null,
    recipientEmail: d.recipientEmail ?? null,
    subject: String(d.subject ?? ""),
    body: String(d.body ?? ""),
    ...(typeof d.followUpDay === "number" ? { followUpDay: d.followUpDay } : {}),
  }));
}

// ---------------------------------------------------------------------------
// A run: the bundle the draft step saved, and the references it passed on.
// ---------------------------------------------------------------------------

const SAVED_DRAFTS = [
  { recipientEmail: "ada@example.com", subject: "A short idea for Example One", body: "Hello Ada,\n\nOne idea.", status: "draft" },
  { recipientEmail: "ben@example.com", subject: "A short idea for Example Two", body: "Hello Ben,\n\nAnother idea.", status: "draft" },
];
const BUNDLE_REF = "6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b";
const DRAFT_OUTPUTS = {
  draftBundleRef: BUNDLE_REF,
  draftBodyArtifacts: [
    { artifactId: "artifact-1", representationRevisionId: "revision-1" },
    { artifactId: "artifact-2", representationRevisionId: "revision-2" },
  ],
  draftBundleTitle: "Email draft bundle (2 recipients)",
};
const START_VALUES = { agent_run_id: "run-1", confirmedRecipientsRef: "recipients-1" };
const RUN_INPUTS = {
  cinatra_run_id: "run-1",
  offeringCompanyWebsite: "https://example.com",
  callToAction: "Book a call",
  senderName: "Alex Example",
};

function savedRun(data = { cinatra_agent_run_id: "run-1", drafts: SAVED_DRAFTS }) {
  const reads = [];
  const ports = {
    objects: {
      async read(request) {
        reads.push(request);
        if (request?.objectId !== BUNDLE_REF) {
          const refusal = new Error("not an object of this run");
          refusal.name = "ExtensionToolRefusal";
          throw refusal;
        }
        return { objectId: BUNDLE_REF, type: BUNDLE_TYPE, data };
      },
      async save() {
        throw new Error("the road to the review saves nothing");
      },
    },
  };
  return { ports, reads };
}

async function screenOf(run) {
  const gateInputs = await runToTheReview({ startValues: START_VALUES, draftOutputs: DRAFT_OUTPUTS, ports: run.ports });
  return extractDraftSnapshot(hostValues(gateMessage(refs[GATE], gateInputs), RUN_INPUTS));
}

// ---------------------------------------------------------------------------
// The drafts reach the screen
// ---------------------------------------------------------------------------

test("the drafts the run saved reach the drafts review screen, one row each, with the subject and the body", async () => {
  const run = savedRun();
  const rows = (await screenOf(run)).map(({ recipientEmail, subject, body }) => ({ recipientEmail, subject, body }));
  assert.deepEqual(
    rows,
    SAVED_DRAFTS.map(({ recipientEmail, subject, body }) => ({ recipientEmail, subject, body })),
    "no drafts reach the drafts review screen: it is handed the bundle's reference, not the drafts, and shows its waiting line",
  );
  assert.deepEqual(run.reads, [{ objectId: BUNDLE_REF }], "the saved bundle is not read once, by its reference");
});

test("a bundle saved under draftedEmails reaches the screen the same way", async () => {
  const run = savedRun({ cinatra_agent_run_id: "run-1", draftedEmails: SAVED_DRAFTS });
  const rows = await screenOf(run);
  assert.deepEqual(rows.map((r) => r.subject), SAVED_DRAFTS.map((d) => d.subject));
});

test("each row keeps the recipient the review's write-back matches on, and nothing else of the saved object", async () => {
  const run = savedRun();
  const gateInputs = await runToTheReview({ startValues: START_VALUES, draftOutputs: DRAFT_OUTPUTS, ports: run.ports });
  const handed = gateInputs.draftBundle?.draftedEmails;
  assert.ok(Array.isArray(handed), "the review is not handed draftBundle.draftedEmails");
  assert.deepEqual(handed, SAVED_DRAFTS, "the handed drafts are not the saved drafts");
  assert.equal(JSON.stringify(gateInputs.draftBundle).includes("cinatra_agent_run_id"), false);
});

// ---------------------------------------------------------------------------
// The read step stands between the draft step and the review
// ---------------------------------------------------------------------------

const readSteps = () =>
  Object.values(refs).filter((n) => n.component_type === "ApiNode" && n.data?.tool === "extension_tool" && n.data?.input?.name === READ_TOOL);

test("no path from the start reaches the drafts review without passing the read step", () => {
  const steps = readSteps();
  assert.equal(steps.length, 1, `the flow carries ${steps.length} steps that read the saved drafts`);
  const readId = steps[0].id;
  assert.ok((FLOW.nodes ?? []).some((n) => refOf(n) === readId), `${readId} is not listed among the flow's steps`);
  const reach = (blocked) => {
    const seen = new Set();
    const queue = [refOf(FLOW.start_node)];
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id) || id === blocked) continue;
      seen.add(id);
      for (const [from, to] of controlEdges()) if (from === id) queue.push(to);
    }
    return seen;
  };
  assert.ok(reach(null).has(GATE));
  assert.ok(!reach(readId).has(GATE), "a path reaches the drafts review without the read step");
});

test("the read step is handed the run and the saved bundle's reference, and hands the review draftBundle", () => {
  const [step] = readSteps();
  assert.ok(step, "the flow carries no step that reads the saved drafts");
  const into = dataEdges().filter((e) => e.to === step.id).map((e) => `${e.from}.${e.output} -> ${e.input}`);
  assert.deepEqual(into.sort(), [`${DRAFT}.draftBundleRef -> draftBundleRef`, `${refOf(FLOW.start_node)}.agent_run_id -> agent_run_id`].sort());
  assert.equal(step.data.agent_run_id, "{{ agent_run_id }}");
  assert.deepEqual(step.data.input.input, { draftBundleRef: "{{ draftBundleRef }}" });
  assert.ok(
    dataEdges().some((e) => e.from === step.id && e.output === "draftBundle" && e.to === GATE && e.input === "draftBundle"),
    "the read step does not hand the review draftBundle",
  );
  assert.equal(step.metadata?.cinatra?.requiresApproval, false);
});

test("the drafts review declares draftBundle as a read-only input and keeps surfacing its inputs", () => {
  const gate = refs[GATE];
  assert.equal(gate.metadata.cinatra.surfaceGateInputs, true);
  const property = gate.metadata.cinatra.inputMessageSchema.properties.draftBundle;
  assert.ok(property, "the review's schema declares no draftBundle");
  assert.equal(property.type, "object");
  assert.equal(property.readOnly, true);
  assert.ok((gate.inputs ?? []).some((i) => i.title === "draftBundle" && i.type === "object"), "the review takes no draftBundle input");
});

// The git blob of the drafting agent's module at the pinned drafting commit.
const MODULE_BLOB = "9757adbaacb601eec5f400bbb713ec0d6d6b341c";

test("the read step's tool is declared by this package and its module is published with the flow", async () => {
  const [step] = readSteps();
  assert.ok(step, "the flow carries no step that reads the saved drafts");
  const tool = (pkg.cinatra.tools ?? []).find((t) => t.name === READ_TOOL);
  assert.ok(tool, `the package declares no ${READ_TOOL} tool`);
  assert.equal(tool.module, "./cinatra/tools/saved-drafts.mjs");
  assert.ok((pkg.files ?? []).includes("cinatra"), "the package does not publish its cinatra folder");
  const loaded = await import(pathToFileURL(path.join(root, tool.module.slice(2))).href);
  assert.equal(typeof loaded.extensionTool, "function");
  const bytes = readFileSync(path.join(root, tool.module.slice(2)));
  const blob = createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
  assert.equal(blob, MODULE_BLOB, `${tool.module} is not the drafting agent's module at the pinned commit`);
});
