// ---------------------------------------------------------------------------
// The send step runs the confirmed send - zero-dependency, runs under
// tests/run.mjs.
//
// The outreach flow runs an embedded copy of the delivery flow. Its send step
// `sender-send` is a model-bridge step that the person reaches only after
// approving the send at the send-confirmation gate. Its instructions come
// from the declared differences in scripts/embedded-copies.json, not from the
// delivery flow. This suite reads that step in cinatra/oas.json and pins what
// its instructions (S, `data.system`) owe the run after the person's
// decision:
//
//   1. the person already confirmed the send at the gate; no other
//      confirmation is asked for, and no approval boundary is enforced;
//   2. the two references are read at most once each;
//   3. the send start tool is called exactly once, with an empty sender
//      address left out;
//   4. the start result's status is used when it is terminal; only otherwise
//      the send status tool is polled, at most 2 times;
//   5. polls that end without a terminal status are a failed send with
//      POLL_BUDGET_EXHAUSTED;
//   6. the step ends with one final answer that is only the JSON sendResult,
//      with status completed or failed and a summary of one sentence.
//
// The step budget is pinned at the delivery step's 10: 2 reads, 1 start
// call, 2 polls and the final answer take 6 model steps. The closing
// message, the declared result members and the user text's input slots are
// pinned unchanged.
//
// Known limits
//   - The instructions are read as text. A test proves that the text says a
//     thing, not that a model does it.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));

const START = "email_outreach_send_initial_start";
const STATUS = "email_outreach_send_initial_status";

const send = oas.$referenced_components["email-delivery-subflow"].$referenced_components["sender-send"];
const S = send.data.system;
const U = send.data.user;
const has = (text) => assert.ok(S.includes(text), `the instructions do not say: ${text}`);

test("the send step is the model-bridge step the suite reads", () => {
  assert.equal(send.component_type, "ApiNode");
  assert.match(send.url, /\/api\/llm-bridge$/);
  assert.equal(typeof S, "string");
  assert.equal(typeof U, "string");
});

test("1. the instructions say the person already confirmed the send at the gate and not to ask again (red: they say neither)", () => {
  has("already confirmed this send at the send-confirmation gate");
  has("Do not ask for another confirmation");
});

test("2. the instructions carry no approval boundary of their own (red: they say to enforce an explicit human approval boundary before any real send)", () => {
  assert.equal(S.includes("enforce an explicit human approval boundary"), false, "the instructions tell the model to enforce an approval boundary");
  assert.doesNotMatch(S, /\benforce\b[^.;\n]*\bapproval\b/i, "the instructions tell the model to enforce an approval");
});

test("3. the instructions call the send start tool exactly once, never a second time (red: they name no send tool)", () => {
  has(`Call ${START} exactly once`);
  has("Never call the start tool a second time");
  assert.equal(S.split(START).length - 1, 1, "the start tool is named more than once");
});

test("4. the instructions leave out an empty sender address (red: they never say what to do with an empty senderEmail)", () => {
  has("Leave out senderEmail when it is empty");
});

test("5. the instructions use the start result's terminal status and poll the status tool at most 2 times otherwise (red: they name no status tool and set no poll limit)", () => {
  has(STATUS);
  has("at most 2 times");
  has("If the start result's status is \"completed\" or \"failed\", use it and do not poll");
});

test("6. the instructions make polls that end without a terminal status a failed send with POLL_BUDGET_EXHAUSTED (red: they say nothing about the end of the polls)", () => {
  has("POLL_BUDGET_EXHAUSTED");
  has("\"errorCode\": \"POLL_BUDGET_EXHAUSTED\"");
  has("the result of the send could not be confirmed");
});

test("7. the instructions return status completed or failed and a summary of one sentence (red: a failure is 'an error object' with no status)", () => {
  has("\"status\": \"completed\"");
  has("\"status\": \"failed\"");
  has("one sentence");
  assert.equal(S.includes("error object"), false, "the instructions still return an error object on a failure");
});

test("8. the instructions end with one final answer that is only the JSON sendResult (red: they ask for a structured result with no shape)", () => {
  has("only the JSON");
  has("{\"sendResult\": {");
});

test("9. the send step's budget is 10, the delivery step's own (red: the budget key is left out, so the bridge's default of 6 applies)", () => {
  assert.equal(send.data.max_steps, 10);
});

test("10. the send step's declared result keeps status and summary (a pin: holds before and after)", () => {
  const result = send.outputs.find((o) => o.title === "sendResult");
  assert.ok(result, "the send step declares no sendResult");
  assert.deepEqual(Object.keys(result.json_schema.properties).sort(), ["status", "summary"]);
});

test("11. the user text keeps its four input slots (a pin: holds before and after)", () => {
  for (const slot of ["campaignId", "approvedDraftBundleRef", "confirmedRecipientsRef", "senderEmail"]) {
    assert.ok(U.includes(`{{ ${slot} }}`), `the user text lost {{ ${slot} }}`);
  }
  assert.deepEqual(
    send.inputs.map((i) => i.title),
    ["campaignId", "approvedDraftBundleRef", "confirmedRecipientsRef", "senderEmail", "agent_run_id"],
  );
});

// The closing message as it stands; it reads the send step's result.
const CAMPAIGN_SUMMARY =
  "{# pyagentspec-input-hint (do not remove): {{ recipientCount }} {{ sendResult }} #}{% if not recipientCount %}This campaign ended without sending anything: no recipients came out of the contact source you picked, so there was nothing to draft or send.{% elif sendResult and sendResult.status == 'failed' %}The campaign reached {{ recipientCount }} recipients in drafting, but the emails could not be sent: {{ sendResult.summary }}. Nothing was delivered.{% else %}The campaign is finished: {{ recipientCount }} recipients were drafted and sent. {{ sendResult.summary }}{% endif %}";

test("the closing message campaign_summary is unchanged (a pin: holds before and after)", () => {
  assert.equal(oas.$referenced_components.campaign_summary.message, CAMPAIGN_SUMMARY);
});
