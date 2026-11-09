// The declared module saved-drafts.mjs: it reads the run's saved draft bundle
// through the objects port and hands its drafts to the drafts review under
// draftBundle.draftedEmails; a missing reference, an object that is no draft
// bundle, a bundle without drafts, a draft without a recipient or without
// subject and body text, a draft whose id is empty or not text, two
// drafts the review cannot tell apart, and a bundle of more drafts than the
// write-back takes are refused by name - cinatra-ai/cinatra#3089.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = "cinatra/tools/saved-drafts.mjs";
const { extensionTool } = await import(new URL(`../${MODULE_PATH}`, import.meta.url));

const BUNDLE = "@cinatra-ai/campaigns:email-draft-bundle";
const everyOtherPort = [];

function makePorts({ saved, readError }) {
  const calls = { reads: [] };
  const other = (name) =>
    new Proxy({}, {
      get(_t, prop) {
        everyOtherPort.push(`${name}.${String(prop)}`);
        throw new Error(`port ${name} must not be used`);
      },
    });
  const ports = {
    objects: {
      async read(arg) {
        calls.reads.push(arg);
        if (readError) throw readError;
        return saved;
      },
      async save() {
        everyOtherPort.push("objects.save");
        throw new Error("the read step saves nothing");
      },
    },
    data: other("data"),
    artifacts: other("artifacts"),
    review: other("review"),
    clock: other("clock"),
  };
  return { ports, calls };
}

const bundleOf = (data, type = BUNDLE) => ({ objectId: "bundle-1", type, data });

function assertRefusal(error) {
  assert.equal(error.name, "ExtensionToolCallRefusal");
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0 && error.message.length <= 400);
  assert.ok(!/[\r\n]/.test(error.message));
  return true;
}

const DRAFTS = [
  { recipientEmail: "ada@example.com", subject: "Idea one", body: "Hello Ada", status: "draft" },
  { id: "d-2", recipientId: "c-2", recipientName: "Ben", recipientEmail: "ben@example.com", subject: "Idea two", body: "Hello Ben", status: "draft" },
];

test("D1 the saved drafts are handed under draftBundle.draftedEmails, in saved order, read once by the trimmed reference", async () => {
  const { ports, calls } = makePorts({ saved: bundleOf({ cinatra_agent_run_id: "run-1", drafts: DRAFTS }) });
  const answer = await extensionTool({ input: { draftBundleRef: " bundle-1 " }, ports });
  assert.deepEqual(calls.reads, [{ objectId: "bundle-1" }]);
  assert.deepEqual(answer, { ok: true, draftBundle: { draftedEmails: DRAFTS } });
});

test("D2 a bundle that saved its drafts under draftedEmails is read from there first", async () => {
  const { ports } = makePorts({ saved: bundleOf({ draftedEmails: [DRAFTS[1]], drafts: [DRAFTS[0]] }) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, [DRAFTS[1]]);
});

test("D3 each draft keeps only the fields the screen reads and the write-back matches on", async () => {
  const row = {
    recipientEmail: "cy@example.com",
    subject: "Idea three",
    body: "Hello Cy",
    status: "draft",
    followUpDay: 3,
    recipientName: null,
    cinatra_agent_run_id: "run-1",
    internal: { score: 0.4 },
    id: null,
  };
  const { ports } = makePorts({ saved: bundleOf({ drafts: [row] }) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, [
    { recipientEmail: "cy@example.com", subject: "Idea three", body: "Hello Cy", status: "draft", followUpDay: 3 },
  ]);
});

test("D4 a run that names no bundle is refused before any read", async () => {
  for (const input of [{}, { draftBundleRef: "" }, { draftBundleRef: "   " }, { draftBundleRef: 5 }, undefined]) {
    const { ports, calls } = makePorts({ saved: bundleOf({ drafts: DRAFTS }) });
    await assert.rejects(extensionTool({ input, ports }), assertRefusal);
    assert.deepEqual(calls.reads, []);
  }
});

test("D5 a refusal of the port reaches the caller unchanged", async () => {
  const refusal = new Error("extension_tool: objects.read: bundle-1 is not an object of this run or of a run it descends from");
  refusal.name = "ExtensionToolRefusal";
  const { ports } = makePorts({ readError: refusal });
  await assert.rejects(extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }), (e) => e === refusal);
});

test("D6 an object that is no draft bundle, or a bundle without drafts, is refused", async () => {
  const cases = [
    null,
    bundleOf({ drafts: DRAFTS }, "@cinatra-ai/campaigns:recipients"),
    bundleOf({ drafts: DRAFTS }, "@cinatra-ai/campaigns:email-followup-bundle"),
    bundleOf([DRAFTS]),
    bundleOf("drafts"),
    bundleOf({ cinatra_agent_run_id: "run-1" }),
    bundleOf({ drafts: [] }),
    bundleOf({ draftedEmails: [] }),
    bundleOf({ drafts: "none" }),
  ];
  for (const saved of cases) {
    const { ports } = makePorts({ saved });
    await assert.rejects(extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }), assertRefusal);
  }
});

test("D7 a draft that is not a draft, or names no recipient, is refused with its position", async () => {
  const cases = [
    [[DRAFTS[0], "text"], /Draft 2 /],
    [[DRAFTS[0], null], /Draft 2 /],
    [[["a"]], /Draft 1 /],
    [[{ subject: "No one", body: "Hello" }], /Draft 1 /],
    [[DRAFTS[0], { recipientEmail: "  ", subject: "Blank", body: "Hello" }], /Draft 2 /],
  ];
  for (const [drafts, position] of cases) {
    const { ports } = makePorts({ saved: bundleOf({ drafts }) });
    await assert.rejects(extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }), (e) => assertRefusal(e) && position.test(e.message));
  }
});

test("D8 a followUpDay that is not a finite number is not handed on", async () => {
  const rowOf = (i) => ({ recipientEmail: `dee${i}@example.com`, subject: "Idea four", body: "Hello Dee" });
  const days = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "3", null, true];
  const { ports } = makePorts({ saved: bundleOf({ drafts: days.map((followUpDay, i) => ({ ...rowOf(i), followUpDay })) }) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, days.map((_, i) => rowOf(i)));
});

test("D9 a draftedEmails that is not a list leaves the drafts to be read from drafts", async () => {
  for (const draftedEmails of ["Idea one", { 0: DRAFTS[0] }, null, 2]) {
    const { ports } = makePorts({ saved: bundleOf({ draftedEmails, drafts: DRAFTS }) });
    const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
    assert.deepEqual(answer.draftBundle.draftedEmails, DRAFTS);
  }
});

// The screen reads `draftedEmails ?? drafts`, so an empty draftedEmails list
// draws no draft there either: the module does not fill it from drafts.
test("D10 an empty draftedEmails list is not filled from drafts: the bundle holds no drafts to review", async () => {
  const { ports } = makePorts({ saved: bundleOf({ draftedEmails: [], drafts: DRAFTS }) });
  await assert.rejects(
    extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }),
    (e) => assertRefusal(e) && /holds no drafts to review/.test(e.message),
  );
});

test("D11 saved data that is null, a date or an instance of a class is no draft bundle", async () => {
  class SavedBundle {
    constructor() {
      this.drafts = DRAFTS;
    }
  }
  for (const data of [null, new Date(0), new SavedBundle()]) {
    const { ports } = makePorts({ saved: bundleOf(data) });
    await assert.rejects(
      extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }),
      (e) => assertRefusal(e) && /is not an email draft bundle/.test(e.message),
    );
  }
  // An object with a null prototype is a plain object, and it is read.
  const { ports } = makePorts({ saved: bundleOf(Object.assign(Object.create(null), { drafts: DRAFTS })) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, DRAFTS);
});

test("D12 a draft that names its recipient only by id is handed on", async () => {
  const row = { id: "d-9", subject: "Idea five", body: "Hello" };
  const { ports } = makePorts({ saved: bundleOf({ drafts: [row] }) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, [row]);
});

test("D13 a draft that names its recipient only by recipientId is handed on", async () => {
  const row = { recipientId: "c-9", subject: "Idea six", body: "Hello" };
  const { ports } = makePorts({ saved: bundleOf({ drafts: [row] }) });
  const answer = await extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
  assert.deepEqual(answer.draftBundle.draftedEmails, [row]);
});

test("D14 a draft whose id is no text, with no email and no recipientId, names no recipient", async () => {
  const cases = [
    { id: 7, subject: "Idea seven", body: "Hello" },
    { id: "  ", recipientId: "", subject: "Idea seven", body: "Hello" },
    { recipientId: 12, subject: "Idea seven", body: "Hello" },
  ];
  for (const row of cases) {
    const { ports } = makePorts({ saved: bundleOf({ drafts: [row] }) });
    await assert.rejects(
      extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }),
      (e) => assertRefusal(e) && /^Draft 1 of this run names no recipient/.test(e.message),
    );
  }
});

const refused = (pattern) => (e) => assertRefusal(e) && pattern.test(e.message);
const readOf = async (data) => {
  const { ports } = makePorts({ saved: bundleOf(data) });
  return extensionTool({ input: { draftBundleRef: "bundle-1" }, ports });
};

test("D17 saved data whose prototype is another object is no draft bundle, even with a null-prototype parent", async () => {
  const parent = Object.assign(Object.create(null), { drafts: DRAFTS });
  const inherited = Object.create(parent); // no own drafts: they are only inherited
  class SavedBundle {
    constructor() {
      this.drafts = DRAFTS;
    }
  }
  const reparented = Object.setPrototypeOf(new SavedBundle(), Object.create(null));
  for (const data of [inherited, reparented]) {
    await assert.rejects(readOf(data), refused(/is not an email draft bundle/));
  }
  const row = Object.setPrototypeOf({ ...DRAFTS[0] }, Object.create(null));
  await assert.rejects(readOf({ drafts: [row] }), refused(/^Draft 1 of this run is not a draft/));
});

test("D18 a getter or a setter on the saved data or on a draft is refused and never run", async () => {
  let runs = 0;
  const cases = [
    [{ get drafts() { runs += 1; return DRAFTS; } }, /is not an email draft bundle/],
    [{ get drafts() { runs += 1; throw new Error("the getter ran"); } }, /is not an email draft bundle/],
    [{ drafts: DRAFTS, set draftedEmails(_v) { runs += 1; } }, /is not an email draft bundle/],
    [{ drafts: [{ recipientEmail: "eve@example.com", get subject() { runs += 1; return "Made up"; }, body: "Hello" }] }, /^Draft 1 of this run is not a draft/],
  ];
  for (const [data, pattern] of cases) {
    await assert.rejects(readOf(data), refused(pattern));
  }
  assert.equal(runs, 0);
});

test("D19 a list of drafts with another prototype or an accessor entry is no list of drafts", async () => {
  let runs = 0;
  const made = [];
  const reparented = Object.setPrototypeOf([null], {
    *entries() {
      runs += 1;
      yield [0, { recipientEmail: "mallory@example.com", subject: "Made up", body: "Not saved" }];
    },
  });
  made.push(reparented);
  const accessor = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { runs += 1; return DRAFTS[0]; } });
  made.push(accessor);
  for (const drafts of made) {
    await assert.rejects(readOf({ drafts }), refused(/is not an email draft bundle/));
  }
  assert.equal(runs, 0);
});

test("D20 a draft whose subject or body is not text is refused with its position", async () => {
  const base = { recipientEmail: "fay@example.com" };
  const cases = [
    { ...base, subject: 7, body: "Hello" },
    { ...base, subject: "Idea eight", body: { text: "hello" } },
    { ...base, subject: null, body: "Hello" },
    { ...base, body: "Hello" },
    { ...base, subject: "Idea eight" },
  ];
  for (const row of cases) {
    await assert.rejects(readOf({ drafts: [DRAFTS[0], row] }), refused(/^Draft 2 of this run has a subject or a body that is not text/));
  }
  // Empty text is text: the screen shows it as saved, and the send reads the same.
  const empty = { ...base, subject: "", body: "" };
  const answer = await readOf({ drafts: [empty] });
  assert.deepEqual(answer.draftBundle.draftedEmails, [empty]);
});

test("D21 two drafts that the review would show under one id, or that name one recipient email, are refused", async () => {
  const text = { subject: "Idea nine", body: "Hello" };
  const cases = [
    [{ recipientEmail: "shared@example.com", ...text }, { recipientEmail: "shared@example.com", ...text, subject: "Second" }],
    [{ id: "x@example.com", recipientEmail: "gil@example.com", ...text }, { recipientEmail: "x@example.com", ...text }],
    [{ id: "d-1", ...text }, { recipientId: "d-1", ...text }],
    [{ recipientEmail: "hal@example.com", ...text }, { id: "d-2", recipientEmail: "hal@example.com", ...text }],
    [{ recipientId: "", recipientEmail: "ivy@example.com", ...text }, { recipientId: "", recipientEmail: "jon@example.com", ...text }],
  ];
  for (const drafts of cases) {
    await assert.rejects(readOf({ drafts }), refused(/^Drafts 1 and 2 of this run /));
  }
  // Distinct ids with distinct emails pass, whichever field names each one.
  const distinct = [{ id: "d-1", recipientEmail: "kim@example.com", ...text }, { recipientId: "d-2", ...text }, { recipientEmail: "lea@example.com", ...text }];
  const answer = await readOf({ drafts: distinct });
  assert.deepEqual(answer.draftBundle.draftedEmails, distinct);
});

test("D22 a draft that the review would show under the id __proto__ is refused", async () => {
  for (const row of [
    { id: "__proto__", recipientEmail: "max@example.com", subject: "Idea ten", body: "Hello" },
    { recipientId: "__proto__", subject: "Idea ten", body: "Hello" },
  ]) {
    await assert.rejects(readOf({ drafts: [row] }), refused(/^Draft 1 of this run has the id __proto__/));
  }
});

// The write-back edits the first list among draftedEmails, sequence, followups, drafts and confirmedRecipients that the
// bundle holds; the review shows draftedEmails or drafts. A bundle where those two differ shows one list and edits another.
test("D23 a bundle whose write-back would edit another list than the one the review shows is refused", async () => {
  for (const data of [
    { sequence: [DRAFTS[0]], drafts: DRAFTS },
    { followups: [], drafts: DRAFTS },
    { draftedEmails: "none", sequence: [DRAFTS[1]], drafts: DRAFTS },
  ]) {
    await assert.rejects(readOf(data), refused(/keeps its drafts in a list the drafts review does not show/));
  }
  // A list after drafts in that order is not the write-back's: the drafts are read.
  const answer = await readOf({ drafts: DRAFTS, confirmedRecipients: [{ email: "ada@example.com" }] });
  assert.deepEqual(answer.draftBundle.draftedEmails, DRAFTS);
});

test("D24 an unexpected failure of the read reaches the caller unchanged", async () => {
  const failure = new TypeError("the store did not answer");
  const { ports } = makePorts({ readError: failure });
  await assert.rejects(extensionTool({ input: { draftBundleRef: "bundle-1" }, ports }), (e) => e === failure);
});

// The write-back keys a saved row by `id ?? recipientId` when that is non-empty text, else by its email; the screen keys the
// handed draft by its id first. A draft whose id is present (not null) but empty or not text is keyed otherwise on the two
// sides: without an email, its edit is dropped (an empty id) or matches no row (an id that is not text), and the write-back
// answers 422. Such an id is refused also when the draft names an email that the write-back could match: one plain rule.
test("D25 a draft whose id is present but empty or not text is refused with its position", async () => {
  const text = { subject: "Idea eleven", body: "Hello" };
  const cases = [
    { id: "", recipientId: "r-1", ...text },
    { id: 7, recipientId: "r-1", ...text },
    { id: "", recipientEmail: "nia@example.com", ...text },
    { id: 7, recipientEmail: "nia@example.com", ...text },
    { id: false, recipientId: "r-1", ...text },
    { id: { value: "d-1" }, recipientId: "r-1", ...text },
    { id: ["d-1"], recipientEmail: "nia@example.com", ...text },
  ];
  for (const row of cases) {
    await assert.rejects(readOf({ drafts: [DRAFTS[0], row] }), refused(/^Draft 2 of this run has an id that is empty or not text/));
  }
  // A null id is no id on either side: the draft is handed on under its recipientId, without the id.
  const answer = await readOf({ drafts: [{ id: null, recipientId: "r-1", ...text }] });
  assert.deepEqual(answer.draftBundle.draftedEmails, [{ recipientId: "r-1", ...text }]);
});

// The write-back refuses an answer of more than 2000 reviewed drafts (DRAFTS_PERSIST_MAX_BATCH of the platform's
// drafts-persist-handler.ts), and the screen answers with every draft it shows. A bundle of more drafts would show a
// review whose answer the write-back refuses, so the review could never complete.
test("D26 a bundle of more drafts than the write-back takes (2000) is refused before the review", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `d-${i + 1}`, subject: "", body: "" }));
  await assert.rejects(readOf({ drafts: many(2001) }), refused(/^The saved draft bundle of this run holds 2001 drafts, more than the 2000 /));
  await assert.rejects(readOf({ draftedEmails: many(2500) }), refused(/ holds 2500 drafts, /));
  // Exactly 2000 drafts pass, each as saved.
  const answer = await readOf({ drafts: many(2000) });
  assert.equal(answer.draftBundle.draftedEmails.length, 2000);
  assert.deepEqual(answer.draftBundle.draftedEmails[1999], { id: "d-2000", subject: "", body: "" });
});

test("D15 no other port is touched", () => {
  assert.deepEqual(everyOtherPort, []);
});

test("D16 the module names no run or external key and imports nothing", () => {
  const source = readFileSync(join(root, MODULE_PATH), "utf8");
  for (const word of ["agent_run_id", "cinatra_agent_run_id", "cinatra_run_id", "cinatraAgentRunId", "externalId", "external_id"]) {
    assert.ok(!source.includes(word), word);
  }
  assert.ok(!/^\s*import[\s({"']/m.test(source));
  assert.ok(!/\bimport\s*\(/.test(source));
  assert.equal(extensionTool.length, 1);
});
