// The copy's prepare step and its declared list say what the copy does -
// cinatra-ai/cinatra#3745. Zero-dependency, runs under tests/run.mjs. The
// steps read here are the embedded delivery copy's: "email-delivery-subflow",
// ids prefixed "sender-".
//
// The copy keeps the delivery flow's read-only prepare step for the content
// digest only: its summary is not handed to the confirmation, so the screen
// shows no recipient or draft count. Texts that say the operator sees that
// summary at the gate are not true in the copy.
//
// The summary's three members are all required by the structured-output
// contract the runtime derives from its declaration, so a text that tells the
// model to leave a count out asks for an answer that contract refuses, and the
// step then hands on no digest. An unreadable count is reported as 0.
//
// The copy does not check the digest; refusing a send whose contents changed
// after the confirmation is the job of the application's send start.
//
// The declared list's reasons say what the copy does: the confirmation shows
// no counts, and the child's closing sentence is left out of the copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(join(root, "cinatra", "oas.json"), "utf8"));
const list = JSON.parse(readFileSync(join(root, "scripts", "embedded-copies.json"), "utf8"));
const flow = oas.$referenced_components["email-delivery-subflow"];
const refs = flow.$referenced_components ?? {};
const prepare = refs["sender-prepare"];
const group = list.find((g) => g.copyId === "email-delivery-subflow");

const output = (title) => {
  const hits = (prepare?.outputs ?? []).filter((o) => o.title === title);
  assert.equal(hits.length, 1, `sender-prepare has ${hits.length} outputs named ${title}`);
  return hits[0];
};

function entry(match) {
  const hits = group.declared.filter((e) => Object.entries(match).every(([k, v]) => e[k] === v));
  assert.equal(hits.length, 1, `the list has ${hits.length} entries for ${JSON.stringify(match)}`);
  return hits[0];
}

test("the copy's gate takes no summary, and no prepare text says the gate shows one", () => {
  assert.ok(!(refs["sender-approval_gate"].inputs ?? []).some((i) => i.title === "summary"));
  const texts = {
    "data.system": prepare.data.system,
    "summary description": output("summary").description,
    "metadata description": prepare.metadata.cinatra.description,
  };
  for (const [where, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /confirmation gate/i, `sender-prepare ${where} says the confirmation gate shows its summary`);
  }
});

test("an unreadable count is reported as 0, because every summary key is required", () => {
  const required = output("summary").json_schema?.required ?? [];
  assert.deepEqual([...required].sort(), ["draftCount", "recipientCount", "scheduledAt"]);
  assert.doesNotMatch(prepare.data.system, /\bOMIT\b/i, "the text tells the model to leave a required key out");
  assert.match(prepare.data.system, /cannot be read, set that count to 0/);
});

test("the digest's description leaves the refusal to the application's send start", () => {
  const text = output("contentDigest").description;
  assert.doesNotMatch(text, /so the send is refused/i, "the description states a refusal this flow does not make");
  assert.match(text, /This flow does not check the digest itself/);
});

test("the declared list's reasons say what the copy does", () => {
  const summary = entry({ kind: "omit-input", step: "approval_gate", input: "summary" }).reason;
  assert.doesNotMatch(summary, /mailbox only/i, "the reason says the confirmation shows the campaign and the mailbox only");
  assert.match(summary, /Recipients and Drafts rows show a dash/);
  const end = entry({ kind: "control-edge", from: "send", to: "end" }).reason;
  assert.doesNotMatch(end, /runs its closing sentence/i, "the reason says the child's closing sentence runs");
  assert.match(end, /closing sentence is left out/);
});
