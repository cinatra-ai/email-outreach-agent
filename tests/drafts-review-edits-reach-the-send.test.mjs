// ---------------------------------------------------------------------------
// An edit made on the drafts review reaches the send - zero-dependency, runs
// under tests/run.mjs. cinatra-ai/cinatra#3089.
//
// The drafts review lets the operator edit each draft's subject and body. The
// review's answer carries every reviewed draft; the platform writes the edits
// back only when a step after the review calls its drafts persist,
// `email_outreach_initial_drafts_update`, with that answer. The persist writes
// the reviewed subjects and bodies into the run's own draft bundle object, in
// place. The send reads that object through `approvedDraftBundleRef`, the
// drafting copy's `draftBundleRef`, so it mails the reviewed drafts only if the
// persist ran before it.
//
// This suite runs the outreach's drafting copy ("email-drafting-subflow") as
// declared in cinatra/oas.json, from its draft step to its end (each step in
// control order, each step's inputs from its data edges), with:
//   - a stand-in for the draft step, which saves the draft bundle as the step's
//     instructions tell it to (`@cinatra-ai/campaigns:email-draft-bundle`, the
//     drafts under `drafts`, each with its recipient, subject and body),
//   - the read step's own module, the one this package declares and ships,
//     over a store that answers the run's objects,
//   - the operator's answer, in the shape the review screen sends
//     (cinatra-ai/email-artifacts src/renderers/email-drafts-review.tsx at
//     1f8fb36b, extractDraftSnapshot and buildResumePayload, copied below with
//     the types removed). The screen reads the drafts from `draftBundle`, which
//     the host hands it from the review's input; the suite
//     tests/drafts-review-reaches-its-screen.test.mjs holds that road.
//   - a copy of the platform's drafts persist (cinatra
//     src/app/api/agents/passthrough/drafts-review-seam.ts and
//     packages/agents/src/mcp/drafts-persist-handler.ts at c55a2c6d): it admits
//     only a run whose package is the id scope of an `email-drafts-review`
//     binding with `midRunHitl`; it parses the answer verbatim from the step's
//     input and needs its `drafts` array; it picks the run's latest draft-shaped
//     object; it matches each reviewed row to one saved row by id, then by
//     recipient email, and refuses an answer whose rows do not all match one to
//     one; and it writes the reviewed subjects and bodies in place. A refusal
//     answers HTTP 422, so the step fails the run; here it throws.
// Then it follows `draftBundleRef` from the drafting copy into the delivery
// copy's send step and reads the drafts that step would mail.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const oas = JSON.parse(readFileSync(path.join(root, "cinatra/oas.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const refs = oas.$referenced_components;

const FLOW = refs["email-drafting-subflow"];
const STEPS = FLOW.$referenced_components;
const DRAFT = "drafts-draft";
const GATE = "drafts-approval_gate";
const END = "drafts-end";
const BUNDLE_TYPE = "@cinatra-ai/campaigns:email-draft-bundle";
const RECIPIENTS_TYPE = "@cinatra-ai/campaigns:recipients";
const PERSIST_TOOL = "email_outreach_initial_drafts_update";
const REVIEW_KIND = "email-drafts-review";
const RUN_ID = "run-1";
const BUNDLE_REF = "6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b";

const SAVED_DRAFTS = [
  { recipientEmail: "ada@example.com", subject: "A short idea for Example One", body: "Hello Ada,\n\nOne idea.", status: "draft" },
  { recipientEmail: "ben@example.com", subject: "A short idea for Example Two", body: "Hello Ben,\n\nAnother idea.", status: "draft" },
];

const refOf = (n) => (n && typeof n === "object" ? n.$component_ref : undefined);
const persistSteps = () => Object.entries(STEPS).filter(([, n]) => n.component_type === "ApiNode" && n.data?.tool === PERSIST_TOOL);

// ---------------------------------------------------------------------------
// The screen's answer (copied from email-drafts-review.tsx, types removed).
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

function buildResumePayload(drafts, edits, campaignId) {
  const editedIds = drafts
    .filter((d) => {
      const e = edits[d.id];
      if (!e) return false;
      return e.subject !== d.subject || e.body !== d.body;
    })
    .map((d) => d.id);
  return {
    ...(campaignId ? { campaignId } : {}),
    approvedDraftIds: drafts.map((d) => d.id),
    edited: editedIds.length > 0,
    editedIds,
    drafts: drafts.map((d) => ({
      id: d.id,
      recipientId: d.recipientId,
      recipientEmail: d.recipientEmail,
      subject: edits[d.id]?.subject ?? d.subject,
      body: edits[d.id]?.body ?? d.body,
      status: "draft",
      ...(typeof d.followUpDay === "number" ? { followUpDay: d.followUpDay } : {}),
    })),
  };
}

/** The review's answer: the screen's payload over the drafts it was handed, with the operator's edits. */
function reviewAnswer(gateInputs, edits, mangle = (p) => p) {
  const drafts = extractDraftSnapshot({ draftBundle: gateInputs.draftBundle });
  return JSON.stringify(mangle(buildResumePayload(drafts, edits, undefined)));
}

// ---------------------------------------------------------------------------
// The platform's drafts persist (copied, see above).
// ---------------------------------------------------------------------------

class PersistRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "PersistRefusal";
  }
}

/** Packages the platform's persist admits: the id scope of every mid-run drafts review binding. */
function admittedPackages() {
  return new Set(
    (manifest.cinatra?.fieldRenderers ?? [])
      .filter((b) => b && b.kind === REVIEW_KIND && b.midRunHitl === true && typeof b.id === "string")
      .map((b) => b.id.split(":")[0])
      .filter((pkg) => pkg.length > 0),
  );
}

/** Replaces each `{{ name }}` with the step's input of that name; any other markup is an error. */
function render(template, inputs) {
  const out = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name) => {
    assert.ok(Object.hasOwn(inputs, name), `the template reads '${name}', which no data edge feeds`);
    return String(inputs[name]);
  });
  assert.ok(!/\{\{|\{%/.test(out), `unknown template markup: ${template}`);
  return out;
}

const BUNDLE_ARRAY_KEYS = ["draftedEmails", "sequence", "followups", "drafts", "confirmedRecipients"];
const CAMPAIGN_BUNDLE_TYPES = new Set([BUNDLE_TYPE, "@cinatra-ai/campaigns:email-followup-bundle"]);

function arrayKeyOf(o) {
  if (CAMPAIGN_BUNDLE_TYPES.has(o.type)) return BUNDLE_ARRAY_KEYS.find((k) => Array.isArray(o.data[k])) ?? null;
  return (
    BUNDLE_ARRAY_KEYS.find((k) => {
      const arr = o.data[k];
      const first = Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
      return first && typeof first === "object" && ("body" in first || "subject" in first);
    }) ?? null
  );
}

function normalizeEdits(raw) {
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const id = typeof d.id === "string" && d.id.length > 0 ? d.id : "";
    const recipientEmail = typeof d.recipientEmail === "string" && d.recipientEmail.length > 0 ? d.recipientEmail : null;
    if (!id && !recipientEmail) continue;
    out.push({ id, recipientEmail, subject: typeof d.subject === "string" ? d.subject : "", body: typeof d.body === "string" ? d.body : "" });
  }
  return out;
}

function applyEdits(rows, edits) {
  const byId = new Map();
  const byEmail = new Map();
  for (const e of edits) {
    if (e.id) byId.set(e.id, e);
    if (e.recipientEmail) byEmail.set(e.recipientEmail, e);
  }
  const consumed = new Set();
  let changed = 0;
  const next = rows.map((row) => {
    const idRaw = row.id ?? row.recipientId;
    const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : null;
    const emailRaw = row.recipientEmail ?? row.email ?? row.contactEmail;
    const email = typeof emailRaw === "string" && emailRaw.length > 0 ? emailRaw : null;
    const edit = (id && byId.get(id)) || (email && byEmail.get(email)) || undefined;
    if (!edit || consumed.has(edit)) return row;
    consumed.add(edit);
    const curSubject = typeof row.subject === "string" ? row.subject : "";
    const curBody = typeof row.body === "string" ? row.body : "";
    if (edit.subject === curSubject && edit.body === curBody) return row;
    changed += 1;
    return { ...row, subject: edit.subject, body: edit.body };
  });
  return { next, changed, matched: consumed.size };
}

function persist(store, node, inputs) {
  if (!admittedPackages().has(manifest.name)) {
    throw new PersistRefusal(
      `${PERSIST_TOOL} refuses a run of ${manifest.name}: its package declares no ${REVIEW_KIND} binding with midRunHitl`,
    );
  }
  assert.equal(render(node.data.agent_run_id, inputs), RUN_ID, "the persist is not called for this run");
  let payload;
  try {
    payload = JSON.parse(render(node.data.input.resumePayloadJson, inputs));
  } catch {
    throw new PersistRefusal(`${PERSIST_TOOL}: resumePayloadJson is not valid JSON`);
  }
  if (payload && typeof payload === "object" && typeof payload.text === "string" && Array.isArray(payload.attachments)) {
    payload = JSON.parse(payload.text);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.drafts)) {
    throw new PersistRefusal(`${PERSIST_TOOL}: resume payload \`drafts\` must be a present array`);
  }
  const edits = normalizeEdits(payload.drafts);
  const candidates = [...store.entries()]
    .filter(([, o]) => o.runId === RUN_ID)
    .map(([objectId, o]) => ({ objectId, o, key: arrayKeyOf(o) }))
    .filter((c) => c.key !== null)
    .sort((a, b) => b.o.createdAt.localeCompare(a.o.createdAt));
  if (candidates.length === 0) throw new PersistRefusal(`${PERSIST_TOOL}: the run has no draft-bundle object`);
  const [{ objectId, o, key }] = candidates;
  const { next, changed, matched } = applyEdits(o.data[key], edits);
  if (matched !== edits.length || edits.length !== payload.drafts.length) {
    throw new PersistRefusal(
      `${PERSIST_TOOL}: ${payload.drafts.length - matched} of ${payload.drafts.length} reviewed draft row(s) did not map one-to-one onto a stored bundle row`,
    );
  }
  if (changed > 0) store.set(objectId, { ...o, data: { ...o.data, [key]: next } });
  const { cinatra_agent_run_id: _provenance, ...kept } = o.data;
  // The reviewed document is left out of this copy: no step of the outreach reads it (a test below holds that).
  return { ok: true, reviewedBundle: { ...kept, [key]: next }, reviewedDocument: "" };
}

// ---------------------------------------------------------------------------
// A run of the drafting copy, from its draft step to its end.
// ---------------------------------------------------------------------------

/** A store holding what the run saved before drafting: the recipients object. */
function runStore() {
  const store = new Map();
  store.set("recipients-1", {
    runId: RUN_ID,
    type: RECIPIENTS_TYPE,
    createdAt: "2026-11-04T10:00:00.000Z",
    data: { confirmedRecipients: SAVED_DRAFTS.map((d, i) => ({ contactId: `c-${i + 1}`, email: d.recipientEmail })) },
  });
  return store;
}

function objectsPort(store) {
  return {
    objects: {
      async read(request) {
        const o = store.get(request?.objectId);
        if (!o || o.runId !== RUN_ID) {
          const refusal = new Error("not an object of this run");
          refusal.name = "ExtensionToolRefusal";
          throw refusal;
        }
        return { objectId: request.objectId, type: o.type, data: structuredClone(o.data) };
      },
      async save() {
        throw new Error("the drafting copy saves nothing after its draft step");
      },
    },
  };
}

/** Runs the drafting copy from its draft step; returns its end values. `answer` builds the review's answer from the review's inputs. */
async function runDrafting(store, answer) {
  const values = new Map(); // "<step>.<output>" -> value
  const start = refOf(FLOW.start_node);
  const startValues = { agent_run_id: RUN_ID, confirmedRecipientsRef: "recipients-1" };
  for (const descriptor of STEPS[start].inputs ?? []) {
    values.set(`${start}.${descriptor.title}`, startValues[descriptor.title] ?? descriptor.default);
  }
  const inputsOf = (id) => {
    const out = {};
    for (const e of FLOW.data_flow_connections) {
      if (refOf(e.destination_node) !== id) continue;
      const key = `${refOf(e.source_node)}.${e.source_output}`;
      assert.ok(values.has(key), `${id}.${e.destination_input} reads ${key} before it is written`);
      out[e.destination_input] = values.get(key);
    }
    return out;
  };
  let id = DRAFT;
  for (let guard = 0; guard < 20; guard++) {
    const node = STEPS[id];
    const inputs = inputsOf(id);
    let outputs;
    if (id === DRAFT) {
      store.set(BUNDLE_REF, {
        runId: RUN_ID,
        type: BUNDLE_TYPE,
        createdAt: "2026-11-04T10:05:00.000Z",
        data: { cinatra_agent_run_id: RUN_ID, drafts: SAVED_DRAFTS.map((d) => ({ ...d })) },
      });
      outputs = {
        draftBundleRef: BUNDLE_REF,
        draftBodyArtifacts: SAVED_DRAFTS.map((_, i) => ({ artifactId: `artifact-${i + 1}`, representationRevisionId: `revision-${i + 1}` })),
      };
    } else if (node.component_type === "ApiNode" && node.data?.tool === "extension_tool") {
      const declared = (manifest.cinatra.tools ?? []).find((t) => t.name === node.data.input?.name);
      assert.ok(declared, `step ${id} calls ${node.data.input?.name}, which this package does not declare`);
      const mod = await import(pathToFileURL(path.join(root, declared.module.slice(2))).href);
      const callInput = Object.fromEntries(
        Object.entries(node.data.input.input ?? {}).map(([k, v]) => [k, render(v, inputs)]),
      );
      const result = await mod.extensionTool({ input: callInput, ports: objectsPort(store) });
      outputs = Object.fromEntries((node.outputs ?? []).map((o) => [o.title, Object.hasOwn(result, o.title) ? result[o.title] : o.default]));
    } else if (node.component_type === "InputMessageNode" && id === GATE) {
      outputs = { userResponse: answer(inputs) };
    } else if (node.component_type === "ApiNode" && node.data?.tool === PERSIST_TOOL) {
      outputs = persist(store, node, inputs);
    } else if (node.component_type === "EndNode") {
      return inputs;
    } else {
      assert.fail(`step ${id} (${node.component_type}) is not modelled by this suite`);
    }
    for (const [k, v] of Object.entries(outputs)) values.set(`${id}.${k}`, v);
    const next = FLOW.control_flow_connections.filter((e) => refOf(e.from_node) === id);
    assert.equal(next.length, 1, `step ${id} has ${next.length} next steps`);
    id = refOf(next[0].to_node);
  }
  assert.fail("the drafting copy does not reach its end");
}

/** The drafts the send step mails: followed from the drafting copy's end to the send's approvedDraftBundleRef. */
function draftsTheSendMails(store, draftingEnd) {
  const into = oas.data_flow_connections.filter(
    (e) => refOf(e.source_node) === "drafts_flow" && refOf(e.destination_node) === "sender_flow",
  );
  assert.equal(into.length, 1, "the delivery is not fed one value of the drafting copy");
  const delivery = refs[refOf(refs.sender_flow.subflow)];
  const start = refOf(delivery.start_node);
  const edge = delivery.data_flow_connections.find(
    (e) =>
      refOf(e.source_node) === start &&
      e.source_output === into[0].destination_input &&
      refOf(e.destination_node) === "sender-send" &&
      e.destination_input === "approvedDraftBundleRef",
  );
  assert.ok(edge, `sender-send.approvedDraftBundleRef does not read sender_flow.${into[0].destination_input}`);
  const ref = draftingEnd[into[0].source_output];
  const o = store.get(ref);
  assert.ok(o, `the send reads no object at ${ref}`);
  return o.data.drafts.map(({ recipientEmail, subject, body }) => ({ recipientEmail, subject, body }));
}

const EDIT_BEN = {
  "ben@example.com": { subject: "One question for Example Two", body: "Hello Ben,\n\nThe operator rewrote this." },
};

// ---------------------------------------------------------------------------
// The edits reach the send
// ---------------------------------------------------------------------------

test("an edit made on the drafts review reaches the drafts the send mails", async () => {
  const store = runStore();
  const end = await runDrafting(store, (inputs) => reviewAnswer(inputs, EDIT_BEN));
  assert.deepEqual(
    draftsTheSendMails(store, end),
    [
      { recipientEmail: "ada@example.com", subject: SAVED_DRAFTS[0].subject, body: SAVED_DRAFTS[0].body },
      { recipientEmail: "ben@example.com", ...EDIT_BEN["ben@example.com"] },
    ],
    "an edit made on the drafts review does not reach the send: the send mails the drafts as the draft step saved them",
  );
});

test("a review that edits nothing leaves the saved drafts as the draft step wrote them", async () => {
  const store = runStore();
  const end = await runDrafting(store, (inputs) => reviewAnswer(inputs, {}));
  assert.deepEqual(
    draftsTheSendMails(store, end),
    SAVED_DRAFTS.map(({ recipientEmail, subject, body }) => ({ recipientEmail, subject, body })),
  );
  assert.equal(store.get("recipients-1").data.confirmedRecipients.length, 2, "the recipients object changed");
});

test("an answer whose drafts do not all match the saved drafts stops the run before the send", async () => {
  const store = runStore();
  const unmatched = (p) => ({ ...p, drafts: [...p.drafts, { ...p.drafts[0], id: "nobody@example.com", recipientEmail: "nobody@example.com" }] });
  await assert.rejects(
    runDrafting(store, (inputs) => reviewAnswer(inputs, EDIT_BEN, unmatched)),
    (error) => error instanceof PersistRefusal && /did not map one-to-one/.test(error.message),
    "the run reaches the send with an answer the persist cannot write back",
  );
  assert.deepEqual(store.get(BUNDLE_REF).data.drafts, SAVED_DRAFTS, "a refused answer changed the saved drafts");
});

// ---------------------------------------------------------------------------
// The persist step and the binding that admits it
// ---------------------------------------------------------------------------

test("the platform admits the outreach's own run to the drafts persist", () => {
  assert.ok(
    admittedPackages().has(manifest.name),
    `${manifest.name} declares no ${REVIEW_KIND} binding with midRunHitl under its own scope`,
  );
});

test("the review's answer reaches the persist verbatim, and the persist follows the review", () => {
  const steps = persistSteps();
  assert.equal(steps.length, 1, `the drafting copy carries ${steps.length} drafts persist steps`);
  const [applyId, node] = steps[0];
  assert.ok((FLOW.nodes ?? []).some((n) => refOf(n) === applyId), `${applyId} is not listed among the copy's steps`);
  assert.equal(node.url, "{{CINATRA_BASE_URL}}/api/agents/passthrough");
  assert.equal(node.data.input.resumePayloadJson, "{{ resumePayload }}");
  assert.equal(node.data.agent_run_id, "{{ agent_run_id }}");
  const into = FLOW.data_flow_connections
    .filter((e) => refOf(e.destination_node) === applyId)
    .map((e) => `${refOf(e.source_node)}.${e.source_output} -> ${e.destination_input}`);
  assert.deepEqual(into.sort(), [`${GATE}.userResponse -> resumePayload`, `${refOf(FLOW.start_node)}.agent_run_id -> agent_run_id`].sort());
  assert.ok(
    FLOW.control_flow_connections.some((e) => refOf(e.from_node) === GATE && refOf(e.to_node) === applyId),
    "the persist does not follow the review",
  );
});

test("no path from the drafts review reaches the end of the drafting copy without passing the persist", () => {
  const steps = persistSteps();
  assert.equal(steps.length, 1, `the drafting copy carries ${steps.length} drafts persist steps`);
  const [applyId] = steps[0];
  const seen = new Set();
  const queue = [GATE];
  while (queue.length > 0) {
    const at = queue.shift();
    if (seen.has(at) || at === applyId) continue;
    seen.add(at);
    for (const e of FLOW.control_flow_connections) if (refOf(e.from_node) === at) queue.push(refOf(e.to_node));
  }
  assert.ok(!seen.has(END), "a path reaches the end of the drafting copy from the review without the persist");
});

// The review screen's binding, @cinatra-ai/email-drafting-agent:email-drafts-review, is declared
// by @cinatra-ai/email-artifacts at priority 80. Every binding of the kind also answers to the
// kind's bare name, and the higher priority wins it.
const SCREEN_BINDING_PRIORITY = 80;

test("the outreach's own binding never outranks the review screen's binding", () => {
  const own = (manifest.cinatra?.fieldRenderers ?? []).filter((b) => b?.kind === REVIEW_KIND);
  assert.equal(own.length, 1, `${manifest.name} declares ${own.length} ${REVIEW_KIND} bindings`);
  assert.equal(own[0].id, `${manifest.name}:${REVIEW_KIND}`);
  assert.equal(own[0].midRunHitl, true);
  assert.ok(Number.isInteger(own[0].priority) && own[0].priority < SCREEN_BINDING_PRIORITY, `priority ${own[0].priority}`);
  assert.equal(own[0].component, undefined, "the outreach ships no display of its own");
  assert.ok(!(oas.metadata?.cinatra?.hitlScreens ?? []).includes(own[0].id), "the outreach's binding is declared as a pause");
});

test("the send still reads the drafts by the saved bundle's reference, and nothing else reads the persist's result", () => {
  assert.deepEqual(
    (STEPS[END].outputs ?? []).map((o) => o.title),
    ["userResponse", "draftBundleRef"],
    "the drafting copy's end hands on other values than before",
  );
  assert.ok(
    oas.data_flow_connections.some(
      (e) =>
        refOf(e.source_node) === "drafts_flow" &&
        e.source_output === "draftBundleRef" &&
        refOf(e.destination_node) === "sender_flow" &&
        e.destination_input === "approvedDraftBundleRef",
    ),
    "the send is not handed the saved bundle's reference",
  );
  for (const [applyId] of persistSteps()) {
    const out = FLOW.data_flow_connections.filter((e) => refOf(e.source_node) === applyId).map((e) => e.name);
    assert.deepEqual(out, [], `a step reads the persist's result: ${out.join(", ")}`);
  }
});
