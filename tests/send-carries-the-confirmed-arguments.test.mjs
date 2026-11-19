// The send carries exactly the arguments the person confirmed - cinatra-ai/cinatra#3745.
// Zero-dependency, runs under tests/run.mjs. The steps read here are the
// embedded delivery copy's: "email-delivery-subflow", ids prefixed "sender-".
//
// The host serves the send start on a run only with the person's recorded
// decision on the gate the send step names. The step names it under
// metadata.cinatra.confirmations: the tool, the renderer of the gate, and for
// every argument of the call the place of its decided value, "/gate/<input>"
// (a value the gate carried when the person decided) or "/answer/<field>".
// The host builds the complete argument object from that declaration and
// compares it with the call's: a missing, added or changed key refuses the
// send, and a declared key that finds no value refuses it too.
//
// So the copy has to hold four things, and these arms hold them:
// - the declaration has the form the host reads, and names the confirmation
//   gate of the copy;
// - every bound value is an input of the gate, fed from the same source as the
//   send step's input of that name, so the person decides on the values the
//   send receives;
// - the two references and the content digest reach the gate without becoming
//   a field of its form: the screen's schema stays as it is, and the gate takes
//   no summary, so the confirmation shows what it showed before;
// - the texts of the prepare and send steps name the read-only preview tool and
//   the five arguments; a failed preview hands on an empty digest, never a
//   computed one; and the send passes an empty input as JSON null, which is
//   what the gate carries for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const flow = oas.$referenced_components["email-delivery-subflow"];
const refs = flow.$referenced_components ?? {};

const SEND_TOOL = "email_outreach_send_initial_start";
const PREVIEW_TOOL = "email_outreach_send_initial_preview";
const GATE = "sender-approval_gate";
const SEND = "sender-send";
const PREPARE = "sender-prepare";
const BOUND = ["approvedDraftBundleRef", "campaignId", "confirmedRecipientsRef", "contentDigest", "senderEmail"];
// The form of a decided value's place, as the host reads it.
const POINTER = /^\/(gate|answer)(\/[A-Za-z0-9_.-]+)+$/;

const refOf = (node) => node?.$component_ref;
const titles = (list) => (list ?? []).map((entry) => entry.title);
const dataEdges = flow.data_flow_connections ?? [];

/** The one data-flow edge into a step's input, as "<source step>.<output>". */
function sourceOf(step, input) {
  const into = dataEdges.filter((e) => refOf(e.destination_node) === step && e.destination_input === input);
  assert.equal(into.length, 1, `${step}.${input} is fed by ${into.length} data-flow edges, not one`);
  return `${refOf(into[0].source_node)}.${into[0].source_output}`;
}

function confirmations() {
  const declared = refs[SEND]?.metadata?.cinatra?.confirmations;
  assert.ok(Array.isArray(declared), "the send step declares no confirmations");
  return declared;
}

function sendConfirmation() {
  const entries = confirmations().filter((entry) => entry?.tool === SEND_TOOL);
  assert.equal(entries.length, 1, "the send step does not confirm the send start exactly once");
  return entries[0];
}

test("the send step declares one confirmation, in the form the host reads", () => {
  const declared = confirmations();
  assert.equal(declared.length, 1, "the send step confirms more than the send start");
  const entry = sendConfirmation();
  assert.equal(Object.keys(entry).sort().join(","), "arguments,gateRenderer,tool");
  assert.equal(entry.tool, entry.tool.toLowerCase());
  assert.doesNotMatch(entry.tool, /\s/);
  assert.equal(typeof entry.gateRenderer, "string");
  assert.equal(entry.gateRenderer, entry.gateRenderer.trim());
  assert.notEqual(entry.gateRenderer, "");
  assert.ok(
    (refs[SEND].metadata.cinatra.tools ?? []).includes(SEND_TOOL),
    "the send step does not offer the tool it confirms",
  );
});

test("the confirmation names the renderer of the copy's confirmation gate", () => {
  const gate = refs[GATE].metadata.cinatra;
  const entry = sendConfirmation();
  assert.equal(entry.gateRenderer, gate.renderer);
  assert.equal(entry.gateRenderer, gate.inputMessageSchema["x-renderer"]);
  const gates = Object.values(refs).filter(
    (node) => node.component_type === "InputMessageNode" && node.metadata?.cinatra?.renderer === entry.gateRenderer,
  );
  assert.equal(gates.length, 1, "more than one gate of the copy carries the confirming renderer");
  const everywhere = JSON.stringify(oas).split(JSON.stringify(entry.gateRenderer)).length - 1;
  const inCopy = JSON.stringify(flow).split(JSON.stringify(entry.gateRenderer)).length - 1;
  assert.equal(
    everywhere - inCopy,
    (oas.metadata?.cinatra?.hitlScreens ?? []).filter((id) => id === entry.gateRenderer).length,
    "a step outside the delivery copy carries the confirming renderer",
  );
});

test("the confirmation binds exactly the five arguments of the send, each to a value of the gate", () => {
  const bound = sendConfirmation().arguments;
  assert.deepEqual(Object.keys(bound).sort(), BOUND);
  const gateInputs = titles(refs[GATE].inputs);
  for (const name of BOUND) {
    assert.match(bound[name], POINTER, `${name} is not bound to a /gate/ or /answer/ path`);
    assert.equal(bound[name], `/gate/${name}`, `${name} is not bound to the gate's value of that name`);
    assert.ok(gateInputs.includes(name), `the gate takes no input ${name}`);
  }
});

test("the gate and the send read every bound value from the same source", () => {
  const sendInputs = titles(refs[SEND].inputs);
  for (const name of BOUND) {
    assert.ok(sendInputs.includes(name), `the send step takes no input ${name}`);
    assert.equal(sourceOf(GATE, name), sourceOf(SEND, name), `the gate and the send read ${name} from two sources`);
  }
  for (const name of ["approvedDraftBundleRef", "campaignId", "confirmedRecipientsRef", "senderEmail"]) {
    assert.equal(sourceOf(GATE, name), `sender-start.${name}`);
  }
  assert.equal(sourceOf(GATE, "contentDigest"), `${PREPARE}.contentDigest`);
});

test("the references and the digest are values of the gate, not fields of its form", () => {
  const schema = refs[GATE].metadata.cinatra.inputMessageSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["campaignId", "decision", "senderEmail"]);
  assert.deepEqual(schema.required, ["decision"]);
  assert.equal(refs[GATE].metadata.cinatra.surfaceGateInputs, true);
  assert.deepEqual(titles(refs[GATE].inputs).sort(), BOUND);
  assert.ok(
    !dataEdges.some((e) => refOf(e.source_node) === PREPARE && e.source_output === "summary"),
    "the prepare step's summary is handed on, which changes what the confirmation shows",
  );
  for (const name of ["approvedDraftBundleRef", "confirmedRecipientsRef", "contentDigest"]) {
    const input = refs[GATE].inputs.find((entry) => entry.title === name);
    assert.equal(input.type, "string");
    assert.equal(input.default, "");
  }
  assert.deepEqual(titles(refs[GATE].outputs), ["userResponse"]);
});

test("the prepare step takes the digest from the read-only preview tool and never computes one", () => {
  const prepare = refs[PREPARE];
  const output = (prepare.outputs ?? []).find((entry) => entry.title === "contentDigest");
  assert.ok(output, "the prepare step declares no contentDigest output");
  assert.equal(output.type, "string");
  const system = prepare.data.system;
  assert.ok(system.includes(PREVIEW_TOOL), "the prepare text does not name the preview tool");
  assert.ok(system.includes('"contentDigest"'), "the prepare text does not name the contentDigest key");
  assert.ok(
    system.includes("exactly as the tool returned it"),
    "the prepare text does not say that the digest is handed on unchanged",
  );
  assert.ok(
    system.includes('set "contentDigest" to the empty string ""'),
    "the prepare text does not say what a failed preview hands on",
  );
  assert.ok(system.includes("NEVER compute"), "the prepare text does not forbid a computed digest");
  assert.equal(prepare.metadata.cinatra.riskClass, "read_only");
  assert.ok(!system.includes(SEND_TOOL), "the prepare text names the send start");
});

test("the send texts name the five arguments and no other key", () => {
  const { system, user } = refs[SEND].data;
  const named = system.match(/exactly these five arguments and no other key: ([A-Za-z, ]+)\./);
  assert.ok(named, "the send text does not list the five arguments of the send start");
  assert.deepEqual(named[1].split(/, | and /).sort(), BOUND);
  // The host's loader writes a gate's empty input as JSON null, so the decided
  // value of an empty input is null and the call has to carry null for it.
  assert.ok(system.includes("pass JSON null for that key"), "the send text does not say how an empty value is passed");
  assert.ok(!/leave out|omit/i.test(system), "the send text tells the step to leave a key out");
  for (const name of BOUND) {
    assert.ok(user.includes(`- ${name}: {{ ${name} }}`), `the send's input text carries no line for ${name}`);
  }
  assert.ok(!system.includes(PREVIEW_TOOL), "the send text names the preview tool, which the step does not offer");
});
