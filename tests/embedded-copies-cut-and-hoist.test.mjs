// ---------------------------------------------------------------------------
// The generator cuts a child flow in two — zero-dependency, runs under
// tests/run.mjs.
//
// cinatra-ai/cinatra#3089: the application releases a send only when it is a
// TOP-LEVEL step of the root flow, so the outreach embeds a child flow without
// its publishing step and carries that step, unchanged, to its own top level.
// The generator (scripts/embedded-copies.mjs) learns three things for it:
//
//   - the entry kind add-output: the copy's end hands on an output that one of
//     its steps declares, with that step's own declaration;
//   - omit-input on a START step removes every trace of the input;
//   - the group field hoist: a child step written as a component of the PARENT
//     flow, verbatim but for its id and the differences its own list names.
//
// It also refuses a copy whose steps name an input or an output they do not
// have (the "dangling reference" rule of the delivery pack's parity test).
//
// The end-to-end arm feeds the delivery pack's flow at its merged commit
// (cinatra-ai/email-delivery-agent 0505839ee69da8672c6b62d4d11ad7138809421e,
// cinatra/oas.json blob 3a91369cba0a30973847213854dea6aa5e92ba54, copied to
// tests/fixtures/email-delivery-agent-0505839-oas.json) through the generator
// and compares the result with the two fixtures the delivery pack ships at that
// commit (tests/fixtures/email-outreach-delivery-subflow.json, blob
// 9088997b3ba33352ec16404029e5d92eef580952, and
// tests/fixtures/email-outreach-delivery-send.json, blob
// 2afd560692886e6d45ec3dfab4bbfa4f47269792), byte for byte. The committed
// snapshot under scripts/children/ is not replaced here.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  KINDS,
  ROOT,
  generateCopy,
  generateFlow,
  generateHoists,
  hoistRecordProblems,
  recordHoists,
  gitBlobSha,
  loadChild,
  loadList,
  serialize,
  writeCopies,
} from "../scripts/embedded-copies.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const refOf = (node) => node?.$component_ref;
const fixture = (name) => readFileSync(path.join(ROOT, "tests", "fixtures", name), "utf8");

const R_DECL = { title: "r", type: "object", json_schema: { type: "object", properties: { k: { type: "string" } } } };
const R2_DECL = { title: "r2", type: "string", description: "The second result." };

/** A small child flow: start (a, b) -> work (a -> r, r2) -> pub (b, r -> done, publishing) -> end (done). */
function child() {
  return {
    component_type: "Flow",
    id: "child",
    name: "child",
    inputs: [
      { title: "a", type: "string" },
      { title: "b", type: "string" },
    ],
    outputs: [{ title: "done", type: "string" }],
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "start" }, { $component_ref: "work" }, { $component_ref: "pub" }, { $component_ref: "end" }],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "start_to_work", from_node: { $component_ref: "start" }, to_node: { $component_ref: "work" } },
      { component_type: "ControlFlowEdge", name: "work_to_pub", from_node: { $component_ref: "work" }, to_node: { $component_ref: "pub" } },
      { component_type: "ControlFlowEdge", name: "pub_to_end", from_node: { $component_ref: "pub" }, to_node: { $component_ref: "end" } },
    ],
    data_flow_connections: [
      dataEdge("start", "a", "work", "a"),
      dataEdge("start", "b", "pub", "b"),
      dataEdge("work", "r", "pub", "r"),
      dataEdge("pub", "done", "end", "done"),
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "start",
        inputs: [
          { title: "a", type: "string" },
          { title: "b", type: "string" },
        ],
        outputs: [
          { title: "a", type: "string" },
          { title: "b", type: "string" },
        ],
        metadata: {
          cinatra: {
            required: ["a", "b"],
            hidden: ["b"],
            inputRenderers: { b: "org/child:b-picker" },
            inputTitles: { a: "A", b: "B" },
            inputDataSources: { b: { kind: "list" } },
          },
        },
      },
      work: {
        component_type: "ApiNode",
        id: "work",
        name: "Do the work",
        url: "{{CINATRA_BASE_URL}}/api/work",
        http_method: "POST",
        data: { tool: "work_tool", input: { a: "{{ a }}" } },
        inputs: [{ title: "a", type: "string" }],
        outputs: [clone(R_DECL), clone(R2_DECL)],
      },
      pub: {
        component_type: "ApiNode",
        id: "pub",
        name: "Publish",
        url: "{{CINATRA_BASE_URL}}/api/publish",
        http_method: "POST",
        data: { tool: "publish_tool", input: { b: "{{ b }}" } },
        inputs: [
          { title: "b", type: "string" },
          { title: "r", type: "object" },
        ],
        outputs: [{ title: "done", type: "string" }],
        metadata: { cinatra: { publishes: true, publishRows: [{ label: "B", input: "b" }] } },
      },
      end: {
        component_type: "EndNode",
        id: "end",
        name: "end",
        outputs: [{ title: "done", type: "string" }],
      },
    },
  };
}

function dataEdge(from, output, to, input) {
  return {
    component_type: "DataFlowEdge",
    name: `${from}_to_${to}_${input}`,
    source_node: { $component_ref: from },
    source_output: output,
    destination_node: { $component_ref: to },
    destination_input: input,
  };
}

const entry = (kind, fields) => ({ child: "org/child", kind, ...fields, reason: "probe" });
const group = (declared, extra = {}) => ({ repository: "org/child", prefix: "p-", copyId: "copy", declared, ...extra });
const refused = (make, ...texts) =>
  assert.throws(make, (error) => {
    for (const text of texts) assert.ok(error.message.includes(text), `"${error.message}" does not name "${text}"`);
    return true;
  });

/** The entries that cut `pub` out of the small child and end the copy after `work`. */
const cut = (...more) => [
  entry("omit-step", { step: "pub" }),
  entry("omit-output", { step: "end", output: "done" }),
  ...more,
];

// --- add-output -------------------------------------------------------------

test("(3089) add-output hands on a step's output at the end, with that step's own declaration, in entry order", () => {
  const source = child();
  const declared = cut(
    entry("add-output", { step: "end", from: "work", output: "r2" }),
    entry("add-output", { step: "end", from: "work", output: "r" }),
    entry("data-edge", { from: "work", to: "end", output: "r2", input: "r2" }),
    entry("data-edge", { from: "work", to: "end", output: "r", input: "r" }),
    entry("control-edge", { from: "work", to: "end" }),
  );
  const made = generateCopy(source, group(declared));
  const end = made.$referenced_components["p-end"];
  assert.deepEqual(end.outputs, [R2_DECL, R_DECL]);
  assert.deepEqual(made.outputs, [R2_DECL, R_DECL]);
  assert.notEqual(end.outputs[1], made.outputs[1], "the end and the flow share one declaration object");
  assert.deepEqual(
    made.data_flow_connections.filter((e) => refOf(e.destination_node) === "p-end").map((e) => e.name),
    ["p-work_to_end_r2", "p-work_to_end_r"],
  );
  assert.deepEqual(made.control_flow_connections.map((e) => e.name), ["p-start_to_work", "p-work_to_end"]);
  assert.deepEqual(source, child(), "the child is changed");
  assert.ok(KINDS.includes("add-output"));
});

test("(3089) add-output refuses an absent source step or output, a title the end already declares, and a step that is not the end", () => {
  const make = (extra) => () => generateCopy(child(), group(cut(entry("add-output", { step: "end", from: "work", output: "r", ...extra }))));
  refused(make({ from: "absent_step" }), "org/child", "entry 3 (add-output)", "absent_step");
  refused(make({ output: "absent_output" }), "org/child", "entry 3 (add-output)", "absent_output");
  refused(make({ step: "work" }), "org/child", "entry 3 (add-output)", "not the flow's end");
  // The end already declares 'done' when the output is not omitted first.
  refused(
    () => generateCopy(child(), group([entry("add-output", { step: "end", from: "pub", output: "done" })])),
    "org/child",
    "entry 1 (add-output)",
    "already declares",
  );
});

// --- omit-input on a start step ---------------------------------------------

test("(3089) omit-input on a start step removes every trace of the input", () => {
  const made = generateCopy(child(), group([entry("omit-step", { step: "pub" }), entry("omit-input", { step: "start", input: "b" })]));
  const start = made.$referenced_components["p-start"];
  assert.deepEqual(start.inputs.map((i) => i.title), ["a"]);
  assert.deepEqual(start.outputs.map((i) => i.title), ["a"]);
  assert.deepEqual(made.inputs.map((i) => i.title), ["a"]);
  assert.deepEqual(start.metadata.cinatra, { required: ["a"], inputTitles: { a: "A" } });
  assert.ok(!JSON.stringify(start).includes('"b"'), "the start still names b");
  assert.ok(!made.data_flow_connections.some((e) => e.source_output === "b"), "a data edge still leaves through b");
});

test("(3089) omit-input on a start step that declares no outputs or metadata removes the input from the start and the flow", () => {
  const source = child();
  delete source.$referenced_components.start.outputs;
  delete source.$referenced_components.start.metadata;
  const made = generateCopy(source, group([entry("omit-step", { step: "pub" }), entry("omit-input", { step: "start", input: "b" })]));
  assert.deepEqual(made.$referenced_components["p-start"].inputs.map((i) => i.title), ["a"]);
  assert.deepEqual(made.inputs.map((i) => i.title), ["a"]);
});

test("(3089) omit-input on a step that is not the start stays as it was: the step's input and the edges into it", () => {
  const made = generateCopy(child(), group([entry("omit-input", { step: "pub", input: "r" })]));
  assert.deepEqual(made.$referenced_components["p-pub"].inputs.map((i) => i.title), ["b"]);
  assert.ok(!made.data_flow_connections.some((e) => e.name === "p-work_to_pub_r"));
  assert.deepEqual(made.$referenced_components["p-start"], generateCopy(child(), group([])).$referenced_components["p-start"]);
  assert.deepEqual(made.$referenced_components["p-work"].outputs, [R_DECL, R2_DECL], "the source's output is kept");
});

test("(3089) omit-input on a start step refuses an input the start or the flow does not have", () => {
  refused(() => generateCopy(child(), group([entry("omit-input", { step: "start", input: "zz" })])), "org/child", "(omit-input)", "zz");
  const source = child();
  source.inputs = source.inputs.filter((i) => i.title !== "b");
  refused(() => generateCopy(source, group([entry("omit-input", { step: "start", input: "b" })])), "org/child", "(omit-input)", "flow input 'b'");
});

test("(3089) no existing group uses omit-input on a start step, so the stricter rule changes no committed copy", () => {
  for (const group of loadList()) {
    const source = loadChild(group);
    for (const declared of group.declared.filter((e) => e.kind === "omit-input")) {
      assert.notEqual(source.$referenced_components[declared.step]?.component_type, "StartNode", `${group.repository} ${declared.step}`);
    }
  }
});

// --- the dangling reference rule ---------------------------------------------

test("(3089) a copy whose steps name an input or an output they do not have is refused", () => {
  // pub renders {{ b }} and its card row names b: leaving b out of pub leaves both names behind.
  refused(
    () => generateCopy(child(), group([entry("omit-input", { step: "pub", input: "b" })])),
    "org/child",
    "names what its steps do not have",
    "p-pub row B names input b",
    "p-pub renders b",
  );
  // The start's metadata names an input the start does not have.
  refused(
    () => generateCopy(child(), group([entry("copy-value", { step: "start", path: "metadata.cinatra.hidden", value: ["zz"] })])),
    "hidden names zz",
  );
  // The flow's inputs differ from the start's.
  const extra = child();
  extra.inputs.push({ title: "c", type: "string" });
  refused(() => generateCopy(extra, group([])), "the flow's inputs");
  // A data edge names an output its source does not have.
  const edge = child();
  edge.data_flow_connections[2].source_output = "zz";
  refused(() => generateCopy(edge, group([])), "has no zz");
});

test("(3089) a step that declares no inputs takes the names its templates render", () => {
  const source = child();
  delete source.$referenced_components.work.inputs;
  assert.doesNotThrow(() => generateCopy(source, group([])));
  source.data_flow_connections.push(dataEdge("start", "b", "work", "b"));
  refused(() => generateCopy(source, group([])), "p-work has no b");
});

// --- hoist --------------------------------------------------------------------

const parent = () => ({
  component_type: "Flow",
  id: "parent",
  nodes: [{ $component_ref: "start" }, { $component_ref: "run_copy" }, { $component_ref: "publish" }],
  control_flow_connections: [],
  data_flow_connections: [],
  $referenced_components: {
    start: { component_type: "StartNode", id: "start", name: "start" },
    run_copy: { component_type: "FlowNode", id: "run_copy", subflow: { $component_ref: "copy" } },
    copy: { component_type: "Flow", id: "stale" },
  },
});
const hoistGroup = (hoist = [{ step: "pub", as: "publish", declared: [] }], declared = cut(entry("control-edge", { from: "work", to: "end" }))) =>
  group(declared, { hoist });

test("(3089) a hoist writes the child step into the parent under its new id, verbatim, and --write and --check carry it", () => {
  const source = child();
  const g = hoistGroup();
  const [hoisted] = generateHoists(source, g);
  const expected = { ...clone(source.$referenced_components.pub), id: "publish" };
  assert.equal(hoisted.as, "publish");
  assert.equal(serialize(hoisted.node), serialize(expected));
  assert.deepEqual(source, child(), "the child is changed");

  const before = parent();
  const flow = generateFlow(before, [g], [source]);
  assert.equal(serialize(flow.$referenced_components.publish), serialize(expected));
  // The parent keeps its own nodes and edges: the generator adds none.
  assert.deepEqual(flow.nodes, before.nodes);
  assert.deepEqual(flow.control_flow_connections, []);
  assert.deepEqual(flow.data_flow_connections, []);
  assert.equal(Object.hasOwn(flow.$referenced_components.copy.$referenced_components, "p-pub"), false);

  // --write inserts it once and a second run changes nothing; --check reads the result as current.
  const text = serialize(before);
  const first = writeCopies(text, flow, [g]);
  assert.equal(first, serialize(flow), "--write does not write what --check compares against");
  const second = writeCopies(first, generateFlow(JSON.parse(first), [g], [source]), [g]);
  assert.equal(second, first, "a second run changed the text");
  // A stale hoisted component (one this hoist recorded as written) is replaced in its place, and bytes outside it are kept.
  const stale = JSON.parse(first);
  stale.$referenced_components.publish.name = "stale";
  stale.$referenced_components.after = { id: "after" };
  const staleGroup = { ...g, hoist: [{ ...g.hoist[0], blob: gitBlobSha(Buffer.from(serialize(stale.$referenced_components.publish))) }] };
  const staleText = serialize(stale).replace('"component_type": "Flow"', '"component_type":  "Flow"');
  assert.notEqual(staleText, serialize(stale), "the probe changed nothing");
  const rewritten = writeCopies(staleText, generateFlow(stale, [staleGroup], [source]), [staleGroup]);
  assert.ok(rewritten.startsWith('{\n  "component_type":  "Flow"'), "--write rewrote bytes outside the hoisted component");
  assert.equal(JSON.parse(rewritten).$referenced_components.publish.name, "Publish");
  assert.deepEqual(Object.keys(JSON.parse(rewritten).$referenced_components), ["start", "run_copy", "copy", "publish", "after"]);
});

test("(3089) a hoist applies only the differences its own list names", () => {
  const g = hoistGroup([
    { step: "pub", as: "pub", declared: [entry("copy-value", { step: "pub", path: "data.tool", value: "other_tool" })] },
  ]);
  const [hoisted] = generateHoists(child(), g);
  assert.equal(hoisted.node.data.tool, "other_tool");
  assert.equal(hoisted.node.id, "pub");
  refused(
    () => generateHoists(child(), hoistGroup([{ step: "pub", as: "pub", declared: [entry("omit-step", { step: "pub" })] }])),
    "org/child",
    "hoist 1",
    "(omit-step)",
  );
  refused(
    () => generateHoists(child(), hoistGroup([{ step: "pub", as: "pub", declared: [{ ...entry("omit-key", { step: "pub", path: "url" }), reason: " " }] }])),
    "hoist 1",
    "no reason",
  );
  // A hoisted step whose own card row would name an input it does not have is refused.
  refused(
    () =>
      generateHoists(
        child(),
        hoistGroup([{ step: "pub", as: "pub", declared: [entry("copy-value", { step: "pub", path: "metadata.cinatra.publishRows", value: [{ label: "Z", input: "zz" }] })] }]),
      ),
    "hoist 1",
    "row Z names input zz",
  );
});

test("(3089) a hoist refuses an absent step, a step kept in the copy, and an id that collides in the parent", () => {
  refused(() => generateHoists(child(), hoistGroup([{ step: "absent_step", as: "x", declared: [] }])), "org/child", "hoist 1", "absent_step");
  refused(() => generateCopy(child(), hoistGroup(undefined, [])), "org/child", "hoist 1", "kept in the copy");
  refused(() => generateHoists(child(), hoistGroup(undefined, [])), "org/child", "hoist 1", "kept in the copy");
  // The parent's own start, another kind of step, under the hoist's id.
  refused(() => generateFlow(parent(), [hoistGroup([{ step: "pub", as: "start", declared: [] }])], [child()]), "org/child", "hoist 1", "collides");
  // A hand-authored step of the same kind under the hoist's id, with other content.
  const handAuthored = parent();
  handAuthored.$referenced_components.publish = { component_type: "ApiNode", id: "publish", name: "Hand-authored", url: "x", http_method: "POST" };
  refused(() => generateFlow(handAuthored, [hoistGroup()], [child()]), "org/child", "hoist 1", "collides", "'publish'");
  // The copy itself.
  refused(() => generateFlow(parent(), [hoistGroup([{ step: "pub", as: "copy", declared: [] }])], [child()]), "hoist 1", "collides");
  // Two hoists under one id.
  refused(
    () => generateHoists(child(), hoistGroup([{ step: "pub", as: "x", declared: [] }, { step: "pub", as: "x", declared: [] }])),
    "hoist 2",
    "more than once",
  );
  refused(() => generateHoists(child(), hoistGroup([{ step: "pub", as: "", declared: [] }])), "hoist 1");
});

// --- end to end: the delivery pack at its merged commit -----------------------

const DELIVERY = "cinatra-ai/email-delivery-agent";
const d = (kind, fields, reason) => ({ child: DELIVERY, kind, ...fields, reason });
const SEND_ANSWER = "The send's answer is the hoisted send's, not the copy's; the copy ends once the send is prepared.";
const RESOLVED = "The copy hands on what the read step resolved, which the hoisted send takes as its inputs; the output declaration is the read step's own.";

/** The delivery group's 17 entries and its hoist, as the second part writes them into scripts/embedded-copies.json. */
const deliveryGroup = {
  copyId: "email-delivery-subflow",
  prefix: "sender-",
  package: "@cinatra-ai/email-delivery-agent",
  repository: DELIVERY,
  declared: [
    d("omit-flow-key", { key: "description" }, "It describes the child package; the outreach declares the run's screens and package once."),
    d("omit-flow-key", { key: "metadata" }, "It is the child package's own metadata; the outreach declares the run's screens and package once."),
    d("omit-step", { step: "delivery_summary" }, "The child's closing sentence; the outreach ends once, in its campaign summary."),
    d("omit-step", { step: "send" }, "The send is the child's one publishing step and is carried to the outreach's top level by the group's hoist."),
    ...["sendStatus", "sentCount", "sendErrorMessage", "alreadySentCount", "inDoubtCount"].map((output) =>
      d("omit-output", { step: "end", output }, SEND_ANSWER),
    ),
    d("omit-input", { step: "start", input: "senderEmail" }, "Only the send takes the sender; the copy needs none."),
    ...["recipients", "emailBodies", "callToAction"].map((output) => d("add-output", { step: "end", from: "resolve_send", output }, RESOLVED)),
    ...["recipients", "emailBodies", "callToAction"].map((output) =>
      d("data-edge", { from: "resolve_send", to: "end", output, input: output }, "Feeds the copy's end output from the read step."),
    ),
    d("control-edge", { from: "resolve_send", to: "end" }, "The copy ends after the read step; the hoisted send runs after the copy."),
  ],
  hoist: [{ step: "send", as: "send", declared: [] }],
};

test("(3089) the delivery flow at its merged commit gives exactly the delivery pack's two fixtures", () => {
  const source = readFileSync(path.join(ROOT, "tests", "fixtures", "email-delivery-agent-0505839-oas.json"));
  assert.equal(gitBlobSha(source), "3a91369cba0a30973847213854dea6aa5e92ba54", "the fixture is not the delivery flow at 0505839");
  const deliveryChild = JSON.parse(source.toString("utf8"));
  const subflowText = fixture("email-outreach-delivery-subflow.json");
  const sendText = fixture("email-outreach-delivery-send.json");
  assert.equal(gitBlobSha(Buffer.from(subflowText)), "9088997b3ba33352ec16404029e5d92eef580952");
  assert.equal(gitBlobSha(Buffer.from(sendText)), "2afd560692886e6d45ec3dfab4bbfa4f47269792");
  assert.equal(deliveryGroup.declared.length, 17);

  assert.equal(serialize(generateCopy(deliveryChild, deliveryGroup)), subflowText);
  const hoists = generateHoists(deliveryChild, deliveryGroup);
  assert.deepEqual(hoists.map((h) => h.as), ["send"]);
  assert.equal(serialize(hoists[0].node), sendText);

  // Through the parent: the outreach flow as it is today takes the copy in place and the send as a new
  // component of its own; the parent's node list is the parent's and stays as it is.
  const outreach = JSON.parse(readFileSync(path.join(ROOT, "cinatra", "oas.json"), "utf8"));
  assert.equal(Object.hasOwn(outreach.$referenced_components, "send"), false);
  const flow = generateFlow(outreach, [deliveryGroup], [deliveryChild]);
  assert.equal(serialize(flow.$referenced_components["email-delivery-subflow"]), subflowText);
  assert.equal(serialize(flow.$referenced_components.send), sendText);
  assert.deepEqual(flow.nodes, outreach.nodes, "the generator changed the parent's nodes");
  assert.ok(!flow.nodes.some((node) => refOf(node) === "send"), "the generator placed the send in the node list");
});

test("(3089) a hoist does not overwrite the outreach flow's own hand-authored step of the same kind", () => {
  const deliveryChild = JSON.parse(fixture("email-delivery-agent-0505839-oas.json"));
  const outreach = JSON.parse(readFileSync(path.join(ROOT, "cinatra", "oas.json"), "utf8"));
  assert.equal(outreach.$referenced_components.context_setup.component_type, "ApiNode");
  const onto = { ...deliveryGroup, hoist: [{ step: "send", as: "context_setup", declared: [] }] };
  refused(() => generateFlow(outreach, [onto], [deliveryChild]), DELIVERY, "hoist 1", "collides", "'context_setup'");
});

test("(3089) a re-run after a child change replaces the hoist's own earlier output, which --write records", () => {
  const g = hoistGroup();
  const first = writeCopies(serialize(parent()), generateFlow(parent(), [g], [child()]), [g]);
  const recorded = recordHoists([g], [child()]);
  assert.equal(recorded[0].hoist[0].blob, gitBlobSha(Buffer.from(serialize(JSON.parse(first).$referenced_components.publish))));
  assert.equal(Object.hasOwn(g.hoist[0], "blob"), false, "the list passed in is changed");
  assert.deepEqual(hoistRecordProblems(JSON.parse(first), recorded), []);
  assert.match(hoistRecordProblems(JSON.parse(first), [g]).join(), /hoist 'publish' records no blob/);

  const changed = child();
  changed.$referenced_components.pub.name = "Publish now";
  // Without the record the earlier output cannot be told from a hand-authored step: refused.
  refused(() => generateFlow(JSON.parse(first), [g], [changed]), "hoist 1", "collides");
  // With it, the earlier output is replaced in its place.
  const second = writeCopies(first, generateFlow(JSON.parse(first), recorded, [changed]), recorded);
  assert.equal(JSON.parse(second).$referenced_components.publish.name, "Publish now");
  const rerecorded = recordHoists(recorded, [changed]);
  assert.notEqual(rerecorded[0].hoist[0].blob, recorded[0].hoist[0].blob);
  assert.deepEqual(hoistRecordProblems(JSON.parse(second), rerecorded), []);
  assert.match(hoistRecordProblems(JSON.parse(second), recorded).join(), /hoist 'publish' records blob/);
});

test("(3089) a hoist appended after a last component with a non-ASCII id is written as --check reads it", () => {
  const before = parent();
  before.$referenced_components["dé"] = { id: "dé" };
  const g = hoistGroup();
  const text = serialize(before);
  assert.ok(text.includes('"d\\u00e9": {'));
  const first = writeCopies(text, generateFlow(before, [g], [child()]), [g]);
  assert.equal(first, serialize(generateFlow(JSON.parse(first), [g], [child()])), "--check does not accept what --write wrote");
  assert.equal(writeCopies(first, generateFlow(JSON.parse(first), [g], [child()]), [g]), first, "a second run changed the text");
  // A text that writes the id unescaped is found too, and keeps its own bytes.
  const raw = text.replace('"d\\u00e9": {', '"dé": {');
  const fromRaw = writeCopies(raw, generateFlow(before, [g], [child()]), [g]);
  assert.equal(fromRaw, first.replace('"d\\u00e9": {', '"dé": {'), "the unescaped key or the new member's layout changed");
  assert.match(fromRaw, /\n    "publish": \{\n      "component_type": "ApiNode"/);
});

test("(3089) each of the delivery group's entries is needed: leaving one out changes or refuses the copy", () => {
  const deliveryChild = JSON.parse(fixture("email-delivery-agent-0505839-oas.json"));
  const subflowText = fixture("email-outreach-delivery-subflow.json");
  for (const [at] of deliveryGroup.declared.entries()) {
    const fewer = { ...deliveryGroup, declared: deliveryGroup.declared.filter((_, i) => i !== at) };
    let text = null;
    try {
      text = serialize(generateCopy(deliveryChild, fewer));
    } catch {
      continue;
    }
    assert.notEqual(text, subflowText, `entry ${at + 1} changes nothing`);
  }
});

// --- id-bound fields and own names ----------------------------------------------

/** The small child with one filing step `file_a` (its data an object, or a text when `text` is set). */
function filingChild(text = null) {
  const source = child();
  const data = { tool: "artifact_materialize", input: { content: "{{ a }}", node_id: "file_a" } };
  source.$referenced_components.file_a = {
    component_type: "ApiNode",
    id: "file_a",
    name: "file_a",
    url: "{{CINATRA_BASE_URL}}/api/file",
    http_method: "POST",
    data: text ?? data,
    inputs: [{ title: "a", type: "string" }],
    outputs: [],
  };
  return source;
}
const fileGroup = (as) =>
  group([entry("omit-step", { step: "file_a" })], { hoist: [{ step: "file_a", as, declared: [] }] });

test("(3089) a hoisted filing step under a new id carries the new id into its node_id and its id-named name", () => {
  const [hoisted] = generateHoists(filingChild(), fileGroup("top_file"));
  assert.equal(hoisted.node.id, "top_file");
  assert.equal(hoisted.node.name, "top_file");
  assert.equal(hoisted.node.data.input.node_id, "top_file");
  // A text-form filing step keeps every byte but the node_id token.
  const text = '{\r\n  "tool": "artifact_materialize",\t"input": {"node_id": "file_a", "n": 1.50}\r\n}';
  const [fromText] = generateHoists(filingChild(text), fileGroup("top_file"));
  assert.equal(fromText.node.data, text.replace('"file_a"', '"top_file"'));
});

test("(3089) a hoist under the child's own id changes nothing but the id, byte for byte", () => {
  const escaped = '{"tool": "artifact_materialize", "input": {"node_id": "file\\u005fa"}}';
  const source = filingChild(escaped);
  const [hoisted] = generateHoists(source, fileGroup("file_a"));
  assert.equal(serialize(hoisted.node), serialize(source.$referenced_components.file_a));
});

test("(3089) a hoist under the id __proto__ is an own component of the parent, written and checked", () => {
  const g = group(cut(entry("control-edge", { from: "work", to: "end" })), { hoist: [{ step: "pub", as: "__proto__", declared: [] }] });
  const before = parent();
  const flow = generateFlow(before, [g], [child()]);
  const rc = flow.$referenced_components;
  assert.ok(Object.hasOwn(rc, "__proto__"), "the hoist is not an own component");
  assert.equal(Object.getPrototypeOf(rc), Object.prototype, "the components' prototype changed");
  assert.equal(rc.__proto__.id, "__proto__");
  const first = writeCopies(serialize(before), flow, [g]);
  assert.equal(first, serialize(flow));
  assert.ok(Object.hasOwn(JSON.parse(first).$referenced_components, "__proto__"));
  assert.equal(writeCopies(first, generateFlow(JSON.parse(first), [g], [child()]), [g]), first);
});

test("(3089) a step named __proto__ is hoisted, and absent names such as constructor are refused as absent", () => {
  const source = JSON.parse(JSON.stringify(child()).replaceAll('"pub"', '"__proto__"'));
  assert.ok(Object.hasOwn(source.$referenced_components, "__proto__"));
  const g = group([entry("omit-step", { step: "__proto__" }), entry("omit-output", { step: "end", output: "done" })], {
    hoist: [{ step: "__proto__", as: "top", declared: [] }],
  });
  const [hoisted] = generateHoists(source, g);
  assert.equal(hoisted.node.id, "top");
  assert.equal(hoisted.node.name, "Publish");
  for (const name of ["constructor", "hasOwnProperty", "__proto__"]) {
    refused(
      () => generateCopy(child(), group(cut(entry("add-output", { step: "end", from: name, output: "r" })))),
      `step '${name}' is absent`,
    );
    refused(() => generateHoists(child(), group([], { hoist: [{ step: name, as: "x", declared: [] }] })), `step '${name}' is absent`);
    const edge = child();
    edge.data_flow_connections[2].source_node = { $component_ref: name };
    refused(() => generateCopy(edge, group([])), "joins a step that is absent");
  }
});

test("(3089) a hoist's add-value under the key __proto__ stores an own member", () => {
  const g = hoistGroup([
    { step: "pub", as: "pub", declared: [entry("add-value", { step: "pub", path: "metadata.cinatra.__proto__", value: { x: 1 } })] },
  ]);
  const [hoisted] = generateHoists(child(), g);
  assert.ok(Object.hasOwn(hoisted.node.metadata.cinatra, "__proto__"));
  assert.equal(Object.getPrototypeOf(hoisted.node.metadata.cinatra), Object.prototype);
  assert.match(serialize(hoisted.node), /"__proto__": \{/);
});

test("(3089) omit-input on a start step removes an input named __proto__ from the start's own maps and lists", () => {
  const source = JSON.parse(JSON.stringify(child()).replaceAll('"b"', '"__proto__"'));
  const meta = source.$referenced_components.start.metadata.cinatra;
  assert.ok(Object.hasOwn(meta.inputTitles, "__proto__"));
  const made = generateCopy(source, group([entry("omit-step", { step: "pub" }), entry("omit-input", { step: "start", input: "__proto__" })]));
  const start = made.$referenced_components["p-start"];
  assert.deepEqual(start.metadata.cinatra, { required: ["a"], inputTitles: { a: "A" } });
  assert.deepEqual(made.inputs.map((i) => i.title), ["a"]);
});
