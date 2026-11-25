// ---------------------------------------------------------------------------
// Embedded copy parity — zero-dependency, runs under tests/run.mjs.
//
// cinatra-ai/cinatra#3096 item (7): the embedded copies of the three child
// flows are re-inlined from the children so they cannot drift again — at
// commit, checked in CI. The generator (scripts/embedded-copies.mjs) writes
// each copy from its child's committed flow at the pinned commit (a snapshot
// under scripts/children/), with the child's step ids prefixed, and with
// exactly the differences the declared list (scripts/embedded-copies.json)
// names, each with its child and its reason. These arms fail the pack's own
// suite whenever an embedded copy differs from its child in anything the
// list does not declare, and whenever a declared difference no longer applies.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FLOW_PATH,
  checkFlowText,
  KINDS,
  ROOT,
  generateCopy,
  generateFlow,
  gitBlobSha,
  loadChild,
  loadChildBuffer,
  loadList,
  serialize,
  writeCopies,
} from "../scripts/embedded-copies.mjs";

const list = loadList();
const children = list.map((group) => loadChild(group));
const flowText = readFileSync(path.join(ROOT, FLOW_PATH), "utf8");
const flow = JSON.parse(flowText);
const groupFor = (copyId) => list.findIndex((group) => group.copyId === copyId);

/** Every path at which two JSON values differ (object key order aside). */
function differingPaths(a, b, at = "", out = []) {
  const bothObjects =
    a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at || "/");
    return out;
  }
  const keys = Array.isArray(a)
    ? [...Array(Math.max(a.length, b.length)).keys()].map(String)
    : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) differingPaths(a[key], b[key], `${at}/${key}`, out);
  return out;
}

function assertCopyIsItsChild(copyId) {
  const index = groupFor(copyId);
  assert.ok(index >= 0, `the declared list carries no entry for ${copyId}`);
  const committed = flow.$referenced_components[copyId];
  assert.ok(committed, `${FLOW_PATH} carries no copy ${copyId}`);
  const generated = generateCopy(children[index], list[index]);
  const paths = differingPaths(committed, generated);
  assert.deepEqual(
    paths,
    [],
    `${copyId} differs from ${list[index].repository} at ${list[index].commit} beyond the declared list ` +
      `(run node scripts/embedded-copies.mjs --write): ${paths.join(", ")}`,
  );
}

test("(7) each child snapshot is that child's committed flow at its pinned commit", () => {
  assert.equal(list.length, 3);
  for (const group of list) {
    assert.match(group.commit, /^[0-9a-f]{40}$/, `${group.repository}: the pinned commit is not a full sha`);
    assert.match(group.blob, /^[0-9a-f]{40}$/, `${group.repository}: the snapshot blob is not a full sha`);
    assert.equal(
      gitBlobSha(loadChildBuffer(group)),
      group.blob,
      `${group.snapshot} is not ${group.repository}'s cinatra/oas.json at ${group.commit}`,
    );
  }
});

test("(7) every declared difference names its child and its reason and still applies", () => {
  for (const [index, group] of list.entries()) {
    assert.ok(Array.isArray(group.declared) && group.declared.length > 0, `${group.repository}: no declared list`);
    for (const [at, entry] of group.declared.entries()) {
      const label = `${group.repository} entry ${at + 1}`;
      assert.equal(entry.child, group.repository, `${label} does not name its child`);
      assert.ok(KINDS.includes(entry.kind), `${label} has an unknown kind ${entry.kind}`);
      assert.equal(typeof entry.reason, "string", `${label} carries no reason`);
      assert.ok(entry.reason.trim().length > 0, `${label} carries an empty reason`);
    }
    assert.doesNotThrow(() => generateCopy(children[index], group), `${group.repository}: a declared entry no longer applies`);
    // A stale declaration fails: an entry whose target the child does not have throws, naming the child.
    const stale = {
      ...group,
      declared: [...group.declared, { child: group.repository, kind: "omit-step", step: "absent_step", reason: "probe" }],
    };
    assert.throws(() => generateCopy(children[index], stale), (error) => error.message.includes(group.repository));
    // A declaration the child already meets fails too: a second copy of an edge or of a stored value.
    for (const entry of group.declared.filter((e) => ["control-edge", "data-edge", "copy-value", "add-value"].includes(e.kind))) {
      const redundant = { ...group, declared: [...group.declared, entry] };
      assert.throws(
        () => generateCopy(children[index], redundant),
        (error) => error.message.includes(group.repository) && error.message.includes(`(${entry.kind})`),
        `${group.repository}: a repeated ${entry.kind} entry is accepted`,
      );
    }
  }
});

test("(7) an add-value entry adds a value the child lacks, and refuses one the child has, a path it lacks or an entry with no value", () => {
  const child = {
    component_type: "Flow",
    id: "child",
    nodes: [],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      s: { component_type: "ApiNode", id: "s", name: "s", metadata: { cinatra: { riskClass: "write" } } },
    },
  };
  const group = { repository: "org/child", prefix: "p-", copyId: "copy", declared: [] };
  const entry = (extra = {}) => ({
    child: "org/child",
    kind: "add-value",
    step: "s",
    path: "metadata.cinatra.tools",
    value: ["a_b"],
    reason: "probe",
    ...extra,
  });
  const made = generateCopy(child, { ...group, declared: [entry()] });
  assert.deepEqual(made.$referenced_components["p-s"].metadata.cinatra.tools, ["a_b"]);
  assert.equal(made.$referenced_components["p-s"].metadata.cinatra.riskClass, "write");
  assert.equal(Object.hasOwn(child.$referenced_components.s.metadata.cinatra, "tools"), false, "the child is changed");
  const refused = (declared, text) =>
    assert.throws(
      () => generateCopy(child, { ...group, declared: [declared] }),
      (error) => error.message.includes("org/child") && error.message.includes("(add-value)") && error.message.includes(text),
      JSON.stringify(declared),
    );
  refused(entry({ path: "metadata.cinatra.riskClass" }), "already present");
  refused(entry({ path: "metadata.absent.tools" }), "is absent");
  refused(entry({ step: "absent_step" }), "is absent");
  const { value: _value, ...noValue } = entry();
  refused(noValue, "no value");
});

test("(7) a filing step's own node_id follows its step id through the prefix and a rename", () => {
  const filing = (id) => ({
    component_type: "ApiNode",
    id,
    name: id,
    data: { tool: "artifact_materialize", input: { content: "{{ x }}", node_id: id } },
  });
  const child = {
    component_type: "Flow",
    id: "child",
    nodes: [{ $component_ref: "file_a" }, { $component_ref: "file_b" }],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      file_a: filing("file_a"),
      file_b: filing("file_b"),
      other: { component_type: "ApiNode", id: "other", name: "other", data: { tool: "objects_save", input: { node_id: "other" } } },
    },
  };
  const group = {
    repository: "org/child",
    prefix: "p-",
    copyId: "copy",
    declared: [{ child: "org/child", kind: "rename-step", step: "file_b", to: "file_c", reason: "probe" }],
  };
  const made = generateCopy(child, group).$referenced_components;
  // The host requires the materialize input's node_id to equal its ApiNode's id.
  assert.equal(made["p-file_a"].data.input.node_id, "p-file_a");
  assert.equal(made["p-file_c"].data.input.node_id, "p-file_c");
  // Another tool's input is not a step identity and is kept as it is.
  assert.equal(made["p-other"].data.input.node_id, "other");
  assert.equal(child.$referenced_components.file_a.data.input.node_id, "file_a", "the child is changed");
});

/** A child flow whose steps carry their `data` as a JSON text. */
function stringFormChild(texts) {
  const steps = {};
  for (const [id, text] of Object.entries(texts)) {
    steps[id] = { component_type: "ApiNode", id, name: id, data: text(id) };
  }
  return {
    component_type: "Flow",
    id: "child",
    nodes: Object.keys(steps).map((id) => ({ $component_ref: id })),
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: steps,
  };
}

const filingText = (indent, tail = "") => (id) =>
  JSON.stringify({ tool: "artifact_materialize", input: { content: "{{ x }}", node_id: id } }, null, indent) + tail;
const otherText = () => '{ "tool": "objects_save",  "input": {"node_id": "other"} }';
const stringGroup = (declared = []) => ({ repository: "org/child", prefix: "p-", copyId: "copy", declared });

test("(7) a string-form filing step's own node_id follows its step id through the prefix and a rename, in the form it was written", () => {
  for (const [label, indent, tail] of [["compact", undefined, ""], ["two-space", 2, "\n"], ["four-space", 4, ""], ["tab", "\t", "\n"]]) {
    const child = stringFormChild({ file_a: filingText(indent, tail), file_b: filingText(indent, tail), other: otherText });
    const declared = [{ child: "org/child", kind: "rename-step", step: "file_b", to: "file_c", reason: "probe" }];
    const made = generateCopy(child, stringGroup(declared)).$referenced_components;
    for (const [from, to] of [["file_a", "p-file_a"], ["file_b", "p-file_c"]]) {
      assert.equal(typeof made[to].data, "string", `${label}: the data is no longer a text`);
      assert.equal(made[to].data, filingText(indent, tail)(to), `${label}: ${to} is not its input moved, in its own form`);
      assert.equal(made[to].id, to);
      assert.equal(child.$referenced_components[from].data, filingText(indent, tail)(from), "the child is changed");
    }
    // Another tool's input is not a step identity: its text is kept byte for byte.
    assert.equal(made["p-other"].data, otherText());
  }
});

test("(7) a string-form filing step whose text does not parse or whose input is not an object fails, naming the step", () => {
  const refused = (data, text) => {
    const child = stringFormChild({ file_a: () => data });
    assert.throws(
      () => generateCopy(child, stringGroup()),
      (error) => error.message.includes("org/child") && error.message.includes("file_a") && error.message.includes(text),
      data,
    );
  };
  refused('{"tool": "artifact_materialize", "input": {"node_id": "file_a"', "does not parse");
  refused('{"tool":"artifact_materialize","input":"{\\"node_id\\":\\"file_a\\"}"}', "input");
});

/** The data text of the one step `file_a` after a generator run with the prefix `p-`. */
const movedText = (data, id = "file_a") =>
  generateCopy(stringFormChild({ [id]: () => data }), stringGroup()).$referenced_components[`p-${id}`].data;

test("(7) a string-form filing step written with ordinary spaces on one line is accepted and its node_id moves", () => {
  const data = '{"tool": "artifact_materialize", "input": {"content": "{{ x }}", "node_id": "file_a"}, "mode": [1, 2]}';
  assert.equal(movedText(data), data.replace('"node_id": "file_a"', '"node_id": "p-file_a"'));
  const spaced = '  { "tool" : "artifact_materialize" ,"input":{ "node_id" :  "file_a" , "content":"c" } }  ';
  assert.equal(movedText(spaced), spaced.replace('"file_a"', '"p-file_a"'));
});

test("(7) a string-form filing step with CRLF line ends keeps every CR and LF", () => {
  const data = '{\r\n  "tool": "artifact_materialize",\r\n  "input": {\r\n    "node_id": "file_a"\r\n  }\r\n}\r\n';
  assert.equal(movedText(data), data.replace('"file_a"', '"p-file_a"'));
});

test("(7) a string-form filing step with mixed indentation keeps it", () => {
  const data = '{\n\t"tool": "artifact_materialize",\n  "input": {\n\t  "content": "c",\n    \t"node_id":\t"file_a"\n\n},\n \t"z": 1}\n\n';
  assert.equal(movedText(data), data.replace('"file_a"', '"p-file_a"'));
});

test("(7) only the node_id that is a direct member of the top-level input moves", () => {
  const data =
    '{"early": {"input": {"node_id": "file_a"}}, "node_id": "file_a", "note": "\\"input\\": {\\"node_id\\": \\"file_a\\"}", ' +
    '"tool": "artifact_materialize", "input": {"deep": {"node_id": "file_a", "input": {"node_id": "file_a"}}, ' +
    '"list": [{"node_id": "file_a"}], "text": "\\"node_id\\": \\"file_a\\"", "node_id": "file_a"}, "late": {"node_id": "file_a"}}';
  const made = movedText(data);
  const tail = '"node_id": "file_a"}, "late"';
  assert.ok(data.includes(tail));
  assert.equal(made, data.replace(tail, '"node_id": "p-file_a"}, "late"'));
  assert.equal(JSON.parse(made).input.node_id, "p-file_a");
});

test("(7) a number format, a duplicate key elsewhere and the key order survive byte for byte", () => {
  const data =
    '{"input": {"n": [1.0E+2, -0, 0.10, 1e5, 2E-0], "c": 1, "c": 2, "node_id": "file_a", "a": 0}, "tool": "artifact_materialize", "tool": "artifact_materialize"}';
  assert.equal(movedText(data), data.replace('"node_id": "file_a"', '"node_id": "p-file_a"'));
});

test("(7) a duplicate input or node_id member in a filing text fails, naming the step", () => {
  for (const data of [
    '{"tool": "artifact_materialize", "input": {"node_id": "file_a", "node_id": "file_a"}}',
    '{"tool": "artifact_materialize", "input": {"node_id": "file_a"}, "input": {"node_id": "file_a"}}',
    '{"tool": "artifact_materialize", "input": {"node_id": "file_a"}, "in\\u0070ut": {"node_id": "file_a"}}',
  ]) {
    assert.throws(
      () => movedText(data),
      (error) => error.message.includes("org/child") && error.message.includes("file_a") && error.message.includes("more than once"),
      data,
    );
  }
});

test("(7) a node_id token written with \\u escapes is replaced by a token in that style", () => {
  const data = '{"tool": "artifact_materialize", "input": {"node_id": "file\\u005fa"}}';
  assert.equal(movedText(data), '{"tool": "artifact_materialize", "input": {"node_id": "p-file_a"}}');
  const accented = '{"tool": "artifact_materialize", "input": {"node_id": "d\\u00e9"}}';
  assert.equal(movedText(accented, "d\u00e9"), '{"tool": "artifact_materialize", "input": {"node_id": "p-d\\u00e9"}}');
  const plain = '{"tool": "artifact_materialize", "input": {"node_id": "d\u00e9"}}';
  assert.equal(movedText(plain, "d\u00e9"), '{"tool": "artifact_materialize", "input": {"node_id": "p-d\u00e9"}}');
});

test("(7) a text of another tool, or a filing text whose node_id is not its own id, stays byte for byte", () => {
  const other = '{ "tool" : "objects_save" ,\r\n "input": {"node_id":   "file_a"} }';
  assert.equal(movedText(other), other);
  const foreign = '{ "tool": "artifact_materialize" ,\r\n "input": {"node_id":   "elsewhere"} }';
  assert.equal(movedText(foreign), foreign);
  const absent = '{ "tool": "artifact_materialize" , "input": {"content": "c"} }';
  assert.equal(movedText(absent), absent);
});

test("(7) a second generator run over an irregularly written filing text changes nothing", () => {
  const data = '{\r\n"tool": "artifact_materialize", "input": {"node_id": "file_a",\t"n": 1.50}\r\n}';
  const child = stringFormChild({ file_a: () => data, other: otherText });
  const group = stringGroup();
  const parent = {
    component_type: "Flow",
    id: "parent",
    $referenced_components: { copy: { component_type: "Flow", id: "stale" }, keep: { id: "keep" } },
  };
  const parentText = serialize(parent);
  const first = writeCopies(parentText, generateFlow(parent, [group], [child]), [group]);
  const second = writeCopies(first, generateFlow(JSON.parse(first), [group], [child]), [group]);
  assert.equal(second, first, "a second run changed the text");
  assert.equal(
    JSON.parse(first).$referenced_components.copy.$referenced_components["p-file_a"].data,
    data.replace('"file_a"', '"p-file_a"'),
  );
});

test("(7) a string-form filing step is generated byte for byte again by a second run", () => {
  const child = stringFormChild({ file_a: filingText(2, "\n"), other: otherText });
  const group = stringGroup();
  const parent = {
    component_type: "Flow",
    id: "parent",
    $referenced_components: { copy: { component_type: "Flow", id: "stale" }, keep: { id: "keep" } },
  };
  const parentText = serialize(parent);
  const first = writeCopies(parentText, generateFlow(parent, [group], [child]), [group]);
  const second = writeCopies(first, generateFlow(JSON.parse(first), [group], [child]), [group]);
  assert.notEqual(first, parentText, "the first run changed nothing");
  assert.equal(second, first, "a second run changed the text");
  assert.equal(
    JSON.parse(first).$referenced_components.copy.$referenced_components["p-file_a"].data,
    filingText(2, "\n")("p-file_a"),
  );
});

test("(7) the recipient selection copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-recipient-selection-subflow");
});

test("(7) the drafting copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-drafting-subflow");
});

test("(7) the delivery copy is its child but for the declared differences", () => {
  assertCopyIsItsChild("email-delivery-subflow");
});

test("(7) the committed flow is exactly what the generator writes", () => {
  const written = serialize(generateFlow(flow, list, children));
  assert.ok(
    written === flowText,
    `${FLOW_PATH} is not byte for byte what node scripts/embedded-copies.mjs --write writes`,
  );
  // --write replaces the three copies only: a byte outside them is kept as it is.
  const generated = generateFlow(flow, list, children);
  assert.equal(writeCopies(flowText, generated, list), flowText);
  const outside = flowText.replace('"agentspec_version": ', '"agentspec_version":  ');
  assert.notEqual(outside, flowText, "the probe changed nothing");
  assert.equal(writeCopies(outside, generated, list), outside, "--write rewrote bytes outside the three copies");
  // Every $component_ref of a copy carries the prefix once, the ones inside its steps included.
  const [group] = list;
  const nested = JSON.parse(JSON.stringify(children[0]));
  const [firstStep, secondStep] = Object.keys(nested.$referenced_components);
  nested.$referenced_components[firstStep].probe = { $component_ref: secondStep };
  const copy = generateCopy(nested, group);
  const renamed = (id) => group.declared.find((e) => e.kind === "rename-step" && e.step === id)?.to ?? id;
  assert.deepEqual(copy.$referenced_components[group.prefix + renamed(firstStep)].probe, {
    $component_ref: group.prefix + renamed(secondStep),
  });
});

test("(7) the parent hands each copy only inputs it takes and reads only outputs it hands on, the campaign id included", () => {
  const generated = generateFlow(flow, list, children);
  const refs = generated.$referenced_components;
  const copyOf = {};
  for (const stepId of ["recipients_flow", "drafts_flow", "sender_flow"]) {
    const step = refs[stepId];
    assert.equal(step?.component_type, "FlowNode", `${stepId} is not a flow step`);
    const copyId = step.subflow?.$component_ref;
    assert.ok(groupFor(copyId) >= 0, `${stepId} runs ${copyId}, which the declared list does not generate`);
    copyOf[stepId] = refs[copyId];
  }
  const titles = (items) => (items ?? []).map((item) => item.title);
  const problems = [];
  for (const edge of generated.data_flow_connections) {
    const into = copyOf[edge.destination_node.$component_ref];
    if (into && !titles(into.inputs).includes(edge.destination_input)) {
      problems.push(`${edge.name}: ${into.id} takes no input ${edge.destination_input}`);
    }
    const outOf = copyOf[edge.source_node.$component_ref];
    if (outOf && !titles(outOf.outputs).includes(edge.source_output)) {
      problems.push(`${edge.name}: ${outOf.id} hands on no output ${edge.source_output}`);
    }
  }
  for (const stepId of ["recipients_flow", "drafts_flow"]) {
    const rewired = generated.data_flow_connections.find(
      (edge) =>
        edge.source_node.$component_ref === "context_setup" &&
        edge.source_output === "campaignId" &&
        edge.destination_node.$component_ref === stepId &&
        edge.destination_input === "campaignId",
    );
    if (!rewired) problems.push(`the campaign id is not handed to ${stepId}`);
    else if (rewired.name !== `context_setup_to_${stepId}_campaignId`) problems.push(`${rewired.name} is misnamed`);
  }
  assert.deepEqual(problems, []);
});

// The drafting pack ships the copy it expects the outreach to carry, taken whole
// (cinatra-ai/email-drafting-agent c33072d749a3a088903795410771521d471e841c,
// tests/fixtures/email-outreach-drafting-subflow.json, blob
// e251f85f37b5c7d6306f32eea8fcb792e7a25bba, copied here under the same name).
test("(7) the drafting copy is exactly the copy the drafting pack expects at the pinned commit", () => {
  const index = groupFor("email-drafting-subflow");
  assert.equal(list[index].commit, "c33072d749a3a088903795410771521d471e841c");
  const expected = readFileSync(path.join(ROOT, "tests", "fixtures", "email-outreach-drafting-subflow.json"));
  assert.equal(gitBlobSha(expected), "e251f85f37b5c7d6306f32eea8fcb792e7a25bba");
  assert.equal(serialize(generateCopy(children[index], list[index])), expected.toString("utf8"));
  assert.equal(serialize(flow.$referenced_components["email-drafting-subflow"]), expected.toString("utf8"));
});

// The snapshot's source revision: the drafting pack's main at its pull request 64 (the campaign id is tested by a
// regex step, `campaign_match`, and the decision is a plain three-way choice).
test("(3562) the drafting snapshot is the drafting pack's flow file at c33072d, and nothing older", () => {
  const group = list[groupFor("email-drafting-subflow")];
  assert.equal(group.repository, "cinatra-ai/email-drafting-agent");
  assert.equal(group.commit, "c33072d749a3a088903795410771521d471e841c");
  assert.equal(group.blob, "9d314d356f38f6150f2682078d85590b96489e59");
  assert.equal(gitBlobSha(loadChildBuffer(group)), "9d314d356f38f6150f2682078d85590b96489e59");
  const child = loadChild(group);
  assert.equal(child.$referenced_components.campaign_match?.component_type, "PluginRegexNode");
  assert.equal(child.$referenced_components.check_inputs_predicate.inputs.some((i) => i.title === "campaignId"), false);
});

// --check names a copy that drifts from the pinned source: a hand edit of the copy in the flow, and a snapshot
// that no longer gives the committed copy, are both reported; the committed pair is current.
test("(3562) --check fails when the embedded drafting copy drifts from its pinned source", () => {
  assert.deepEqual(checkFlowText(flowText, list, children), []);
  const index = groupFor("email-drafting-subflow");
  // The copy is edited in the flow: the regex pattern loses its white-space allowance.
  const editedCopy = JSON.parse(flowText);
  const step = editedCopy.$referenced_components["email-drafting-subflow"].$referenced_components["drafts-campaign_match"];
  step.regex_pattern = step.regex_pattern.replace("[ \\t\\r\\n]*", "");
  assert.notEqual(step.regex_pattern, flow.$referenced_components["email-drafting-subflow"].$referenced_components["drafts-campaign_match"].regex_pattern);
  assert.match(checkFlowText(serialize(editedCopy), list, children).join("\n"), /email-drafting-subflow differs from its child/);
  // The source moves under the committed copy: the snapshot's pattern is changed, the flow is not.
  const movedChild = JSON.parse(JSON.stringify(children[index]));
  movedChild.$referenced_components.campaign_match.regex_pattern = "^[0-9a-f]{8}$";
  const moved = children.map((child, at) => (at === index ? movedChild : child));
  assert.match(checkFlowText(flowText, list, moved).join("\n"), /email-drafting-subflow differs from its child/);
  // The recipient and delivery copies are not reported for it.
  assert.doesNotMatch(checkFlowText(serialize(editedCopy), list, children).join("\n"), /recipient-selection-subflow|delivery-subflow/);
});

// A tool step of an embedded copy runs the CHILD's own module (the platform proves the step is, apart from its id, the
// verbatim copy of exactly one ApiNode of the child's installed flow, and that the child declares the tool embeddable).
// So the tool calls of every copy must be nodes of the pinned snapshot, byte for byte but for the prefixed id and the
// declared differences: a copy's tool step that drifts from its child would be refused by the platform at run time.
test("(3562) every tool step of a copy is the pinned child's own tool step, apart from its id", () => {
  const toolSteps = (steps) => Object.values(steps).filter((s) => s?.component_type === "ApiNode" && s.data?.tool === "extension_tool");
  const seen = [];
  for (const [index, group] of list.entries()) {
    const copy = flow.$referenced_components[group.copyId].$referenced_components;
    const child = children[index].$referenced_components;
    for (const step of toolSteps(copy)) {
      const own = Object.entries(child).filter(([id, node]) => group.prefix + id === step.id && node.component_type === "ApiNode");
      assert.equal(own.length, 1, `${step.id} is no step of ${group.repository} at ${group.commit}`);
      const strip = (node) => {
        const { id: _id, name: _name, ...rest } = node;
        return rest;
      };
      assert.deepEqual(strip(step), strip(own[0][1]), `${step.id} differs from ${group.repository}'s step ${own[0][0]}`);
      assert.equal(typeof own[0][1].data.input.name, "string");
      seen.push(`${group.prefix}${own[0][0]}:${own[0][1].data.input.name}`);
    }
  }
  assert.deepEqual(seen.sort(), ["drafts-read_drafts:saved_drafts", "sender-file_recipients:recipient_records", "sender-resolve_send:send_contents"]);
});

const DRAFTS = flow.$referenced_components["email-drafting-subflow"].$referenced_components;
const campaignPattern = DRAFTS["drafts-campaign_match"].regex_pattern;

test("(3562) the embedded copy carries the campaign regex step with the drafting pack's exact pattern, and no older check", () => {
  const step = DRAFTS["drafts-campaign_match"];
  assert.equal(step.component_type, "PluginRegexNode");
  assert.equal(step.return_first_match_only, false);
  assert.equal(
    step.regex_pattern,
    "^[ \\t\\r\\n]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \\t\\r\\n]*$",
  );
  const predicate = DRAFTS["drafts-check_inputs_predicate"];
  assert.deepEqual(predicate.inputs.map((i) => i.title), ["matches", "campaignMatches"]);
  assert.ok(!predicate.template.includes("{% set") && !predicate.template.includes("trim") && !predicate.template.includes("campaignId"));
  // The only model-driven step of the copy is the drafting step itself.
  const llmSteps = Object.values(DRAFTS).filter((s) => s.data && typeof s.data === "object" && (s.data.system !== undefined || s.data.cinatra_llm !== undefined));
  assert.deepEqual(llmSteps.map((s) => s.id), ["drafts-draft"]);
  const edge = (from, to) =>
    flow.$referenced_components["email-drafting-subflow"].control_flow_connections.some(
      (e) => e.from_node.$component_ref === from && e.to_node.$component_ref === to,
    );
  assert.ok(edge("drafts-uuid_match", "drafts-campaign_match") && edge("drafts-campaign_match", "drafts-check_inputs_predicate"));
  assert.ok(!edge("drafts-uuid_match", "drafts-check_inputs_predicate"));
  const data = flow.$referenced_components["email-drafting-subflow"].data_flow_connections.map(
    (e) => `${e.source_node.$component_ref}.${e.source_output} -> ${e.destination_node.$component_ref}.${e.destination_input}`,
  );
  assert.ok(data.includes("drafts-start.campaignId -> drafts-campaign_match.text"));
  assert.ok(data.includes("drafts-campaign_match.output -> drafts-check_inputs_predicate.campaignMatches"));
  assert.ok(!data.some((e) => e.endsWith("drafts-check_inputs_predicate.campaignId")));
});

/** Python's re.findall as the runtime's regex step calls it (no flags), empty matches dropped. */
function findall(pattern, text) {
  return [...String(text).matchAll(new RegExp(pattern, "g"))].map((m) => (m[1] === undefined ? m[0] : m[1])).filter((m) => m !== "");
}

// The pattern has the same meaning in Python and in JavaScript (no \A, \Z or named group). The runtime's step is not
// available to this repository's suite, so the call shape the drafting pack's own suite uses is repeated here.
test("(3562) the campaign pattern accepts a valid id, and refuses a wrong length, non-hex and invisible characters", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  const matches = (text) => findall(campaignPattern, text).length > 0;
  for (const ok of [U, U.toUpperCase(), "abcdef01-2345-6789-ABCD-EF0123456789", ` ${U}`, `\n${U}\r\n`, `  ${U} \t\r\n`]) {
    assert.ok(matches(ok), JSON.stringify(ok));
  }
  assert.deepEqual(findall(campaignPattern, `  ${U}\n`), [U]);
  const refused = {
    empty: "",
    "36 characters, 35 hex": U.slice(1),
    "37 characters": `${U}a`,
    "35 characters": U.slice(0, 35),
    "non-hex": `g${U.slice(1)}`,
    "hyphen misplaced": "1111111-11111-4111-8111-111111111111",
    "U+FEFF before": `\ufeff${U}`,
    "U+FEFF after": `${U}\ufeff`,
    "U+200B before": `\u200b${U}`,
    "U+200B inside": `${U.slice(0, 10)}\u200b${U.slice(11)}`,
    "NBSP before": `\u00a0${U}`,
    "vertical tab before": `\v${U}`,
    "two ids": `${U} ${U}`,
    "an id and text": `${U} x`,
    "a line and then text": `${U}\nx`,
  };
  for (const [name, text] of Object.entries(refused)) assert.equal(matches(text), false, name);
});

/** The decision template under the grammar's rules (a list is true when it holds an item), for the two lists it reads. */
function decide(template, lists) {
  const truthy = (list) => Array.isArray(list) && list.length > 0;
  const match = template.match(/^\{% if (.+?) %\}(\w+)\{% elif (.+?) %\}(\w+)\{% else %\}(\w+)\{% endif %\}$/);
  assert.ok(match, "the template is one if/elif/else");
  const run = (condition) =>
    Function(
      "T", "matches", "campaignMatches",
      `return ${condition.replace(/\bnot\b/g, "!").replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/(\w+)\|length/g, "$1.length").replace(/\b(matches|campaignMatches)\b(?!\.length)/g, "T($1)")};`,
    )(truthy, lists.matches, lists.campaignMatches);
  return run(match[1]) ? match[2] : run(match[3]) ? match[4] : match[5];
}

test("(3562) the three outcomes of the embedded drafting decision run to their own steps, and every one ends in the outreach's sender step", () => {
  const copy = flow.$referenced_components["email-drafting-subflow"];
  const U = "11111111-1111-4111-8111-111111111111";
  const recipientPattern = DRAFTS["drafts-uuid_match"].regex_pattern;
  const route = (recipients, campaign) => {
    const verdict = decide(DRAFTS["drafts-check_inputs_predicate"].template, {
      matches: findall(recipientPattern, recipients),
      campaignMatches: findall(campaignPattern, campaign),
    });
    const branch = DRAFTS["drafts-check_inputs"].mapping[verdict] ?? "default";
    const edge = copy.control_flow_connections.find((e) => e.from_node.$component_ref === "drafts-check_inputs" && e.from_branch === branch);
    return { verdict, to: edge.to_node.$component_ref };
  };
  assert.deepEqual(DRAFTS["drafts-check_inputs"].branches, ["default", "skip", "no_campaign"]);
  assert.deepEqual(route(U, U), { verdict: "present", to: "drafts-draft" });
  assert.deepEqual(route(U, ` ${U}\n`), { verdict: "present", to: "drafts-draft" });
  assert.deepEqual(route("", U), { verdict: "missing", to: "drafts-inputs_missing" });
  assert.deepEqual(route("", ""), { verdict: "missing", to: "drafts-inputs_missing" }, "the recipient list is asked first");
  for (const campaign of ["", "\ufeff", "\u200b", `\ufeff${U}`, `${U}a`, U.slice(1), 12345]) {
    assert.deepEqual(route(U, campaign), { verdict: "no_campaign", to: "drafts-campaign_missing" }, JSON.stringify(campaign));
  }
  // The copy's own continuation: drafting runs on through its review to the end, and the two stops go to the end at once.
  const next = (from) => copy.control_flow_connections.filter((e) => e.from_node.$component_ref === from).map((e) => e.to_node.$component_ref);
  assert.deepEqual(next("drafts-draft"), ["drafts-read_drafts"]);
  assert.deepEqual(next("drafts-read_drafts"), ["drafts-file_drafts"]);
  assert.deepEqual(next("drafts-file_drafts"), ["drafts-approval_gate"]);
  assert.deepEqual(next("drafts-approval_gate"), ["drafts-end"]);
  assert.deepEqual(next("drafts-inputs_missing"), ["drafts-end"]);
  assert.deepEqual(next("drafts-campaign_missing"), ["drafts-end"]);
  // Through the outreach: the one end of the copy is followed by the sender step, whichever outcome ran.
  const outer = flow.control_flow_connections.filter((e) => e.from_node.$component_ref === "drafts_flow");
  assert.deepEqual(outer.map((e) => [e.to_node.$component_ref, e.from_branch ?? null]), [["sender_flow", null]]);
});

// The delivery pack does the same for its copy and for its send step, which the
// group hoists to the outreach's top level (tests/embedded-copies-cut-and-hoist.test.mjs
// generates both from the snapshot; here the committed flow is read).
test("(7) the delivery copy and the hoisted send are exactly what the delivery pack expects at the pinned commit", () => {
  const index = groupFor("email-delivery-subflow");
  assert.equal(list[index].commit, "0505839ee69da8672c6b62d4d11ad7138809421e");
  const copy = readFileSync(path.join(ROOT, "tests", "fixtures", "email-outreach-delivery-subflow.json"), "utf8");
  const send = readFileSync(path.join(ROOT, "tests", "fixtures", "email-outreach-delivery-send.json"), "utf8");
  assert.equal(serialize(flow.$referenced_components["email-delivery-subflow"]), copy);
  assert.equal(serialize(flow.$referenced_components.send), send);
  assert.deepEqual(list[index].hoist, [{ step: "send", as: "send", declared: [], blob: "2afd560692886e6d45ec3dfab4bbfa4f47269792" }]);
});
