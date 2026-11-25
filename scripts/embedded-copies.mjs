// Embedded copies generator — zero dependencies, node's own modules only.
//
// The outreach flow (cinatra/oas.json) carries one embedded copy of each child
// flow it runs: recipient selection, drafting and delivery. Each copy is written
// here from that child's committed flow at its pinned commit (a snapshot under
// scripts/children/), with the child's step ids prefixed, and with exactly the
// differences that scripts/embedded-copies.json declares — each declared entry
// names its child and its reason. Nothing else may differ: the parity suite
// (tests/embedded-copy-parity.test.mjs) fails whenever a committed copy is not
// what this generator writes.
//
//   node scripts/embedded-copies.mjs --write   rewrites the three copies inside
//                                               cinatra/oas.json and nothing else
//   node scripts/embedded-copies.mjs --check   exits 1 naming each copy that
//                                               differs from what --write writes
//
// A declared entry that no longer applies to its child (a step, key, input,
// output, text or edge endpoint the child does not have) THROWS, naming the
// child and the entry, so a stale declaration fails the suite as well.
//
// A group may also HOIST child steps (its field `hoist`, a list of
// { step, as, declared }): each is written as a component of the PARENT flow
// under the id `as`: the child's step byte for byte but for its id and the
// fields bound to it (a filing step's node_id, a name equal to the id), which
// take `as` (nothing else changes when `as` is the child's own id), and the
// differences its own `declared` list names (empty: none). The parent owns
// the node's place in its nodes list and its edges; the generator adds none. A
// hoisted step must be left out of the copy by an omit-step entry. A parent
// component under that id is replaced only when it is provably the hoist's own
// output: the step it generates now, or the step whose git blob the hoist
// records as last written (its `blob`, which --write keeps in the list and
// --check verifies); any other component under that id is refused.
//
// A generated copy, and a hoisted step, whose steps name an input or an output
// they do not have (a dangling reference) THROWS as well; see danglingNames.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIST_PATH = "scripts/embedded-copies.json";
export const FLOW_PATH = "cinatra/oas.json";

export const KINDS = Object.freeze([
  "omit-flow-key",
  "omit-step",
  "omit-output",
  "omit-input",
  "add-output",
  "omit-key",
  "omit-text",
  "copy-value",
  "add-value",
  "control-edge",
  "data-edge",
  "rename-step",
]);

/**
 * The flow file's own serialization: two-space JSON, every character above
 * U+007E written as a four-digit lower-case \u escape, one closing newline.
 */
export function serialize(value) {
  return (
    JSON.stringify(value, null, 2).replace(
      /[\u007f-￿]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    ) + "\n"
  );
}

/**
 * Whether a text is a canonical array-index key: "0", or a digit string with no
 * leading zero, up to 2^32 - 2. JavaScript orders such keys before every other
 * key of an object, whatever order they were added in, so an id the generator
 * creates (a hoist's id, a renamed or prefixed step id) may not be one: the
 * place --write gives it and the place --check reads it in would differ.
 */
export function isArrayIndexKey(key) {
  return typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= 2 ** 32 - 2;
}

/** A member key as the flow file's serialization writes it (the same escapes as serialize). */
export function keyToken(key) {
  return serialize(key).trimEnd();
}

/** The git blob sha of a value's serialization: the identity a hoist records for the step it wrote. */
function blobOf(value) {
  return gitBlobSha(serialize(value));
}

/** The git blob sha of a buffer: sha1 over `blob <length>\0` and the bytes. */
export function gitBlobSha(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

export function loadList(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, LIST_PATH), "utf8"));
}

export function loadChildBuffer(group, root = ROOT) {
  return readFileSync(path.join(root, group.snapshot));
}

export function loadChild(group, root = ROOT) {
  return JSON.parse(loadChildBuffer(group, root).toString("utf8"));
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function refOf(node) {
  return node && typeof node === "object" ? node.$component_ref : undefined;
}

function edgeTouches(edge, stepId) {
  if (edge.component_type === "DataFlowEdge") {
    return refOf(edge.source_node) === stepId || refOf(edge.destination_node) === stepId;
  }
  return refOf(edge.from_node) === stepId || refOf(edge.to_node) === stepId;
}

function walkRefs(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, visit);
    return;
  }
  if (typeof node.$component_ref === "string") node.$component_ref = visit(node.$component_ref);
  for (const value of Object.values(node)) walkRefs(value, visit);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The value an object stores under `key` as its OWN member, or undefined: never one of Object.prototype's. */
const ownValue = (object, key) =>
  object !== null && typeof object === "object" && Object.hasOwn(object, key) ? object[key] : undefined;

/** Stores `value` as an own member `key` (in its place when present), never through a setter such as __proto__. */
function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The members of the JSON object that starts at `at`: each key (decoded) with
 * the [start, end) offsets of its value token, in the order written. The text
 * is known to parse; this walks it by position and changes nothing. */
function membersOf(text, at) {
  const members = [];
  let i = skipSpace(text, at + 1);
  if (text[i] === "}") return members;
  for (;;) {
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd));
    i = skipSpace(text, keyEnd);
    const start = skipSpace(text, i + 1);
    const end = skipValue(text, start);
    members.push({ key, keyStart, start, end });
    i = skipSpace(text, end);
    if (text[i] !== ",") return members;
    i = skipSpace(text, i + 1);
  }
}

/**
 * The [start, end) offsets of the value token of `node_id` inside the
 * `input` object of the top-level object of a JSON text, or null when there is
 * none. A member named `node_id` or `input` that is written twice at its level
 * throws: the text is not edited where it could be read two ways.
 */
function nodeIdSpan(text) {
  const only = (members, name, where) => {
    const found = members.filter((member) => member.key === name);
    if (found.length > 1) throw new Error(`${where} '${name}' is written more than once`);
    return found[0] ?? null;
  };
  const input = only(membersOf(text, skipSpace(text, 0)), "input", "the text's member");
  if (!input || text[input.start] !== "{") return null;
  const nodeId = only(membersOf(text, input.start), "node_id", "the input's member");
  return nodeId ? [nodeId.start, nodeId.end] : null;
}

/** A string token for `id`; written with \u escapes when the token it replaces used them. */
function tokenFor(id, replaced) {
  const token = JSON.stringify(id);
  if (!/\\u/.test(replaced)) return token;
  return token.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * The JSON text of a filing step with `input.node_id` changed from `from` to
 * `to` and every other byte kept as written (spaces, tabs, CR, LF, key order,
 * number formats, duplicate keys elsewhere). The edit is made by position, then
 * checked by parsing: the result must parse to the old value with only
 * `input.node_id` changed.
 */
function moveNodeId(text, from, to, fail) {
  const named = `step '${from}'`;
  let span;
  try {
    span = nodeIdSpan(text);
  } catch (error) {
    fail(`${named} carries its data as a text in which ${error.message}`);
  }
  if (!span) fail(`${named} carries its data as a text in which the input's node_id cannot be located`);
  const [start, end] = span;
  const moved = text.slice(0, start) + tokenFor(to, text.slice(start, end)) + text.slice(end);
  const expected = JSON.parse(text);
  expected.input.node_id = to;
  let actual;
  try {
    actual = JSON.parse(moved);
  } catch {
    fail(`${named} carries its data as a text that does not parse once its node_id moves`);
  }
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${named} carries its data as a text that changes in more than its node_id once it moves`);
  }
  return moved;
}

/**
 * A filing step (artifact_materialize) names its own step id in its input:
 * the host requires `data.input.node_id` to equal the ApiNode's id, because it
 * is the step's idempotency identity. When the step id changes, that input
 * changes with it. The step's `data` is an object or a JSON text (the kind
 * check reads both; its `input` must be an object). A text keeps every byte
 * as written but the one node_id token; a text that does not parse fails and
 * names the step.
 */
function moveStepId(step, to, fail) {
  let data = step.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      fail(`step '${step.id}' carries its data as a text that does not parse`);
    }
  }
  if (isObject(data) && data.tool === "artifact_materialize") {
    if (!isObject(data.input)) fail(`step '${step.id}' is a filing step whose input is not an object`);
    if (data.input.node_id === step.id) {
      if (typeof step.data === "string") step.data = moveNodeId(step.data, step.id, to, fail);
      else data.input.node_id = to;
    }
  }
  if (step.name === step.id) step.name = to;
  step.id = to;
}

function stepOf(flow, stepId, fail) {
  const step = ownValue(flow.$referenced_components, stepId);
  if (!step) fail(`step '${stepId}' is absent`);
  return step;
}

function pathParent(target, dotted, fail) {
  const keys = dotted.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      fail(`path '${dotted}' is absent`);
    }
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (node === null || typeof node !== "object" || !Object.hasOwn(node, last)) {
    fail(`path '${dotted}' is absent`);
  }
  return { node, key: last };
}

function titled(list, title) {
  return Array.isArray(list) ? list.findIndex((item) => item.title === title) : -1;
}

function applyEntry(flow, entry, fail) {
  const rc = flow.$referenced_components;
  switch (entry.kind) {
    case "omit-flow-key": {
      if (!Object.hasOwn(flow, entry.key)) fail(`flow key '${entry.key}' is absent`);
      delete flow[entry.key];
      return;
    }
    case "omit-step": {
      stepOf(flow, entry.step, fail);
      delete rc[entry.step];
      flow.nodes = flow.nodes.filter((node) => refOf(node) !== entry.step);
      flow.control_flow_connections = flow.control_flow_connections.filter((e) => !edgeTouches(e, entry.step));
      flow.data_flow_connections = flow.data_flow_connections.filter((e) => !edgeTouches(e, entry.step));
      return;
    }
    case "omit-output": {
      const step = stepOf(flow, entry.step, fail);
      const at = titled(step.outputs, entry.output);
      if (at < 0) fail(`output '${entry.step}.${entry.output}' is absent`);
      step.outputs.splice(at, 1);
      if (entry.step === "end") {
        const flowAt = titled(flow.outputs, entry.output);
        if (flowAt < 0) fail(`flow output '${entry.output}' is absent`);
        flow.outputs.splice(flowAt, 1);
      }
      flow.data_flow_connections = flow.data_flow_connections.filter(
        (e) =>
          !(
            (refOf(e.source_node) === entry.step && e.source_output === entry.output) ||
            (refOf(e.destination_node) === entry.step && e.destination_input === entry.output)
          ),
      );
      return;
    }
    case "omit-input": {
      const step = stepOf(flow, entry.step, fail);
      const at = titled(step.inputs, entry.input);
      if (at < 0) fail(`input '${entry.step}.${entry.input}' is absent`);
      if (step.component_type === "StartNode") {
        omitStartInput(flow, step, entry, fail);
        return;
      }
      step.inputs.splice(at, 1);
      flow.data_flow_connections = flow.data_flow_connections.filter(
        (e) => !(refOf(e.destination_node) === entry.step && e.destination_input === entry.input),
      );
      return;
    }
    case "add-output": {
      // The end hands on an output one of the flow's steps declares, with that step's own declaration.
      const end = stepOf(flow, entry.step, fail);
      if (end.component_type !== "EndNode") fail(`step '${entry.step}' is not the flow's end`);
      const source = stepOf(flow, entry.from, fail);
      const at = titled(source.outputs, entry.output);
      if (at < 0) fail(`output '${entry.from}.${entry.output}' is absent`);
      if (titled(end.outputs, entry.output) >= 0) fail(`the end '${entry.step}' already declares the output '${entry.output}'`);
      if (titled(flow.outputs, entry.output) >= 0) fail(`the flow already declares the output '${entry.output}'`);
      const declaration = source.outputs[at];
      end.outputs = [...(end.outputs ?? []), clone(declaration)];
      flow.outputs = [...(flow.outputs ?? []), clone(declaration)];
      return;
    }
    case "omit-key": {
      const { node, key } = pathParent(stepOf(flow, entry.step, fail), entry.path, fail);
      delete node[key];
      return;
    }
    case "omit-text": {
      const { node, key } = pathParent(stepOf(flow, entry.step, fail), entry.path, fail);
      const value = node[key];
      if (typeof value !== "string") fail(`'${entry.step}.${entry.path}' is not a text`);
      if (typeof entry.text !== "string" || entry.text.length === 0) fail("the declared text is empty");
      const first = value.indexOf(entry.text);
      if (first < 0) fail(`the declared text is absent from '${entry.step}.${entry.path}'`);
      if (value.indexOf(entry.text, first + 1) >= 0) {
        fail(`the declared text occurs more than once in '${entry.step}.${entry.path}'`);
      }
      node[key] = value.slice(0, first) + value.slice(first + entry.text.length);
      return;
    }
    case "copy-value": {
      if (!Object.hasOwn(entry, "value")) fail("the entry stores no value");
      const { node, key } = pathParent(stepOf(flow, entry.step, fail), entry.path, fail);
      if (JSON.stringify(node[key]) === JSON.stringify(entry.value)) {
        fail(`'${entry.step}.${entry.path}' already holds the declared value`);
      }
      node[key] = clone(entry.value);
      return;
    }
    case "add-value": {
      // A value the child does not carry: the parent path must exist, the last key must not.
      if (!Object.hasOwn(entry, "value")) fail("the entry stores no value");
      const keys = entry.path.split(".");
      let node = stepOf(flow, entry.step, fail);
      for (const key of keys.slice(0, -1)) {
        if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
          fail(`path '${entry.path}' is absent`);
        }
        node = node[key];
      }
      if (node === null || typeof node !== "object" || Array.isArray(node)) fail(`path '${entry.path}' is absent`);
      const last = keys[keys.length - 1];
      if (Object.hasOwn(node, last)) fail(`'${entry.step}.${entry.path}' is already present`);
      setOwn(node, last, clone(entry.value));
      return;
    }
    case "control-edge": {
      stepOf(flow, entry.from, fail);
      stepOf(flow, entry.to, fail);
      if (
        flow.control_flow_connections.some(
          (e) => refOf(e.from_node) === entry.from && refOf(e.to_node) === entry.to,
        )
      ) {
        fail(`the control edge '${entry.from}' to '${entry.to}' already exists`);
      }
      flow.control_flow_connections.push({
        component_type: "ControlFlowEdge",
        name: `${entry.from}_to_${entry.to}`,
        from_node: { $component_ref: entry.from },
        to_node: { $component_ref: entry.to },
      });
      return;
    }
    case "data-edge": {
      const source = stepOf(flow, entry.from, fail);
      const destination = stepOf(flow, entry.to, fail);
      if (titled(source.outputs, entry.output) < 0) fail(`output '${entry.from}.${entry.output}' is absent`);
      const takes =
        destination.component_type === "EndNode" ? destination.outputs : destination.inputs;
      if (titled(takes, entry.input) < 0) fail(`input '${entry.to}.${entry.input}' is absent`);
      if (
        flow.data_flow_connections.some(
          (e) => refOf(e.destination_node) === entry.to && e.destination_input === entry.input,
        )
      ) {
        fail(`'${entry.to}.${entry.input}' is already fed by a data edge`);
      }
      flow.data_flow_connections.push({
        component_type: "DataFlowEdge",
        name: `${entry.from}_to_${entry.to}_${entry.input}`,
        source_node: { $component_ref: entry.from },
        source_output: entry.output,
        destination_node: { $component_ref: entry.to },
        destination_input: entry.input,
      });
      return;
    }
    case "rename-step": {
      const step = stepOf(flow, entry.step, fail);
      if (Object.hasOwn(rc, entry.to)) fail(`step '${entry.to}' already exists`);
      if (isArrayIndexKey(entry.to)) fail(`the new step id '${entry.to}' is an array index, which JavaScript orders first`);
      const renamed = {};
      for (const [key, value] of Object.entries(rc)) setOwn(renamed, key === entry.step ? entry.to : key, value);
      flow.$referenced_components = renamed;
      moveStepId(step, entry.to, fail);
      const token = new RegExp(`(^|_to_)${escapeRegExp(entry.step)}(?=_|$)`, "g");
      for (const edge of [...flow.control_flow_connections, ...flow.data_flow_connections]) {
        if (edgeTouches(edge, entry.step)) edge.name = edge.name.replace(token, `$1${entry.to}`);
      }
      walkRefs(flow, (ref) => (ref === entry.step ? entry.to : ref));
      return;
    }
    default:
      fail(`unknown kind '${entry.kind}'`);
  }
}

/** The lists and maps of a start step's metadata.cinatra that the host reads by input name. */
const START_METADATA_LISTS = Object.freeze(["required", "hidden"]);
const START_METADATA_MAPS = Object.freeze(["inputRenderers", "inputTitles", "inputDataSources"]);

/**
 * omit-input on a START step removes every trace of the input: the start's
 * inputs, the flow's inputs, the start's outputs where it declares any of that
 * title, every data edge that leaves the start through it, and in the start's
 * metadata.cinatra the lists required and hidden and the maps inputRenderers,
 * inputTitles and inputDataSources (a list or map left empty is removed).
 */
function omitStartInput(flow, start, entry, fail) {
  const flowAt = titled(flow.inputs, entry.input);
  if (flowAt < 0) fail(`flow input '${entry.input}' is absent`);
  start.inputs.splice(titled(start.inputs, entry.input), 1);
  flow.inputs.splice(flowAt, 1);
  if (Array.isArray(start.outputs)) start.outputs = start.outputs.filter((output) => output.title !== entry.input);
  flow.data_flow_connections = flow.data_flow_connections.filter(
    (e) => !(refOf(e.source_node) === entry.step && e.source_output === entry.input),
  );
  const meta = start.metadata?.cinatra;
  if (!isObject(meta)) return;
  for (const key of START_METADATA_LISTS) {
    if (!Array.isArray(meta[key])) continue;
    meta[key] = meta[key].filter((name) => name !== entry.input);
    if (meta[key].length === 0) delete meta[key];
  }
  for (const key of START_METADATA_MAPS) {
    if (!isObject(meta[key])) continue;
    delete meta[key][entry.input];
    if (Object.keys(meta[key]).length === 0) delete meta[key];
  }
}

/** The step kinds whose inputs pyagentspec infers from their templates when the step declares none. */
const TEMPLATED = Object.freeze(["ApiNode", "OutputMessageNode", "PluginTemplateNode"]);

// pyagentspec's placeholder regex (pyagentspec/templating TEMPLATE_PLACEHOLDER_REGEXP), as the host mirrors it in
// cinatra packages/agents/src/validate-oas-runtime-invariants.ts (PLACEHOLDER_REGEX), with the host's filter for
// the all-caps names the loader substitutes from the environment (ENV_VAR_PLACEHOLDER). Applied to comments: a
// {# pyagentspec-input-hint: {{ name }} #} sentinel names an input.
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;
// The template tokenizer of the delivery pack's renderTemplate (email-delivery-agent
// tests/lifecycle-d-w8-flow.test.mjs): comments, tags and outputs.
const TEMPLATE_TOKEN = /\{#[\s\S]*?#\}|\{%([\s\S]*?)%\}|\{\{([\s\S]*?)\}\}/g;

// The template constructs the copy generator reads: exactly those the pinned children and the outreach flow use,
// plus the tests named below. Anything else is refused, so a flow that needs more extends this list deliberately.
const PIECE = /\s*('[^'\\]*'|"[^"\\]*"|\d+|[A-Za-z_]\w*|==|!=|<=|>=|[<>.|()[\]])/y;
const WORDS = new Set(["and", "or", "not", "in", "is", "true", "false", "none", "True", "False", "None"]);
const FILTERS = new Set(["tojson", "length"]);
const TESTS = new Set(["defined", "none"]);

/** The names one expression reads, or the construct in it the generator does not read. */
function readExpression(expression, found) {
  const pieces = [];
  PIECE.lastIndex = 0;
  let end = 0;
  for (let m; (m = PIECE.exec(expression)); end = PIECE.lastIndex) pieces.push(m[1]);
  const rest = expression.slice(end).trim();
  if (rest !== "") {
    const piece = /^\S/.exec(rest)[0];
    found.problems.push(/[-+*/%~{},:=!]/.test(piece) ? `'${piece}'` : `an expression it cannot read: ${expression.trim()}`);
  }
  pieces.forEach((piece, at) => {
    if (!/^[A-Za-z_]/.test(piece)) return;
    const before = pieces[at - 1];
    if (before === "|" && !FILTERS.has(piece)) found.problems.push(`filter '${piece}'`);
    else if (pieces[at + 1] === "(" && !WORDS.has(piece)) found.problems.push(`call of '${piece}'`);
    else if (before === "." || before === "|") return;
    else if (before === "is" || (before === "not" && pieces[at - 2] === "is")) {
      if (piece !== "not" && !TESTS.has(piece)) found.problems.push(`test '${piece}'`);
    } else if (piece === "if" || piece === "else") found.problems.push(`'${piece}'`);
    else if (!WORDS.has(piece)) found.names.add(piece);
  });
}

/** The names one template text reads: comments' bare placeholders, outputs, and the if, elif, else and endif tags. */
function readTemplate(text, found) {
  for (const m of text.matchAll(TEMPLATE_TOKEN)) {
    if (m[0].startsWith("{#")) {
      for (const hint of m[0].matchAll(PLACEHOLDER)) if (!ENV_VAR.test(hint[1])) found.names.add(hint[1]);
      continue;
    }
    const body = m[1] ?? m[2];
    if (/^-|-$/.test(body)) {
      found.problems.push("whitespace control");
      continue;
    }
    if (m[2] !== undefined) {
      if (!ENV_VAR.test(body.trim())) readExpression(body, found);
      continue;
    }
    const [, tag, rest] = /^\s*(\w*)([\s\S]*)$/.exec(body);
    if (tag === "if" || tag === "elif") readExpression(rest, found);
    else if ((tag !== "else" && tag !== "endif") || rest.trim() !== "") found.problems.push(`tag '${tag}'`);
  }
}

/**
 * What a step's templates read: `names`, the names they render, and `problems`, the constructs the generator
 * does not read. Every text anywhere in the step's own definition counts (its data, message, template, mappings,
 * metadata, nested objects and lists), its inputs and outputs declarations and its $component_ref values aside.
 */
export function templateReading(step) {
  const found = { names: new Set(), problems: [] };
  const walk = (value, top) => {
    if (typeof value === "string") {
      if (/\{\{|\{%|\{#/.test(value)) readTemplate(value, found);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if ((top && (key === "inputs" || key === "outputs")) || key === "$component_ref") continue;
      walk(inner, false);
    }
  };
  walk(step, true);
  return found;
}

/** The names a step renders (see templateReading). */
function renderedNames(step) {
  return templateReading(step).names;
}

/**
 * The input names a step takes: the titles of its inputs list when it declares
 * one; a step of a kind whose inputs pyagentspec infers from its templates
 * takes the names it renders when it declares none; any other step that
 * declares none is not checked (null).
 */
function inputNames(step) {
  if (Array.isArray(step.inputs)) return new Set(step.inputs.map((input) => input.title));
  return TEMPLATED.includes(step.component_type) ? renderedNames(step) : null;
}

/** A step's own dangling names: its card rows and every name it renders against its own inputs. */
function stepDangling(step) {
  const found = [];
  const inputs = inputNames(step) ?? new Set();
  for (const row of step.metadata?.cinatra?.publishRows ?? []) {
    if (!inputs.has(row.input)) found.push(`${step.id} row ${row.label} names input ${row.input}`);
  }
  const { names, problems } = templateReading(step);
  for (const name of names) if (!inputs.has(name)) found.push(`${step.id} renders ${name}, which is no input of it`);
  for (const problem of problems) found.push(`${step.id} uses a template construct not supported by the copy generator: ${problem}`);
  return found;
}

/**
 * Every name a flow's steps use that the step does not have (the rule the
 * delivery pack's parity test applies to the copy it expects): the start's
 * metadata (required, hidden, and the maps keyed by input name) against the
 * start's inputs, the flow's inputs against the start's, a step's card rows
 * and its call and message templates against the step's own inputs, and each
 * data edge's two ends against the outputs and inputs of the steps it joins (a
 * start gives its inputs, an end takes its outputs). A step that declares no
 * inputs list takes what its templates render (see inputNames); a source that
 * declares no outputs list, or a destination whose inputs are not known, is
 * not checked at that end.
 */
export function danglingNames(flow) {
  const found = [];
  const steps = flow.$referenced_components ?? {};
  const names = (list) => new Set((list ?? []).map((entry) => entry.title));
  const start = Object.values(steps).find((step) => step.component_type === "StartNode");
  if (start) {
    const have = names(start.inputs);
    const meta = start.metadata?.cinatra ?? {};
    for (const key of START_METADATA_LISTS) {
      for (const name of Array.isArray(meta[key]) ? meta[key] : []) {
        if (!have.has(name)) found.push(`${start.id}.metadata.cinatra.${key} names ${name}`);
      }
    }
    for (const key of START_METADATA_MAPS) {
      for (const name of Object.keys(isObject(meta[key]) ? meta[key] : {})) {
        if (!have.has(name)) found.push(`${start.id}.metadata.cinatra.${key} names ${name}`);
      }
    }
    const own = [...names(flow.inputs)].sort().join();
    const startOwn = [...have].sort().join();
    if (own !== startOwn) found.push(`the flow's inputs (${own}) differ from the start's (${startOwn})`);
  }
  for (const step of Object.values(steps)) found.push(...stepDangling(step));
  for (const edge of flow.data_flow_connections ?? []) {
    const from = ownValue(steps, refOf(edge.source_node));
    const to = ownValue(steps, refOf(edge.destination_node));
    if (!from || !to) {
      found.push(`edge ${edge.name} joins a step that is absent`);
      continue;
    }
    const gives = from.component_type === "StartNode" ? names(from.inputs) : Array.isArray(from.outputs) ? names(from.outputs) : null;
    const takes = to.component_type === "EndNode" ? names(to.outputs) : inputNames(to);
    if (gives && !gives.has(edge.source_output)) found.push(`edge ${edge.name}: ${from.id} has no ${edge.source_output}`);
    if (takes && !takes.has(edge.destination_input)) found.push(`edge ${edge.name}: ${to.id} has no ${edge.destination_input}`);
  }
  return found;
}

/** The step-level kinds a hoist's own list may name: a difference inside the node itself. */
const HOIST_KINDS = Object.freeze(["omit-key", "omit-text", "copy-value", "add-value"]);

/**
 * The group's hoists, checked: each names a step the child has, a new id that
 * no other hoist of the group uses and that is not the group's copy, a list of
 * its own differences, and the step is left out of the copy by an omit-step
 * entry of the group.
 */
function checkedHoists(child, group) {
  if (group.hoist === undefined) return [];
  if (!Array.isArray(group.hoist)) throw new Error(`${group.repository}: the hoist field is not a list`);
  const seen = new Set();
  return group.hoist.map((item, index) => {
    const fail = (why) => {
      throw new Error(`${group.repository}: hoist ${index + 1} (step '${item?.step}' as '${item?.as}') no longer applies: ${why}`);
    };
    if (!isObject(item)) fail("it is not an object");
    if (typeof item.step !== "string" || item.step === "") fail("it names no step");
    if (typeof item.as !== "string" || item.as === "") fail("it names no id");
    if (!Array.isArray(item.declared)) fail("it carries no declared list");
    if (seen.has(item.as)) fail(`the id '${item.as}' is hoisted more than once`);
    seen.add(item.as);
    if (item.as === group.copyId) fail(`the id '${item.as}' collides with the group's copy`);
    if (isArrayIndexKey(item.as)) fail(`the id '${item.as}' is an array index, which JavaScript orders first`);
    if (!Object.hasOwn(child.$referenced_components ?? {}, item.step)) fail(`step '${item.step}' is absent`);
    const omitted = (group.declared ?? []).some((entry) => entry.kind === "omit-step" && entry.step === item.step);
    if (!omitted) fail(`step '${item.step}' is kept in the copy: a hoisted step is left out of it by an omit-step entry`);
    return { item, fail };
  });
}

/**
 * One child flow plus its group -> the steps the group hoists into the parent:
 * [{ as, node }], each node the child's step with its id, and the fields bound
 * to its id, set to `as`, and the differences its own declared list names, and
 * nothing else.
 */
export function generateHoists(child, group) {
  return checkedHoists(child, group).map(({ item, fail }) => {
    const node = clone(child.$referenced_components[item.step]);
    const holder = { $referenced_components: {} };
    setOwn(holder.$referenced_components, item.step, node);
    item.declared.forEach((entry, at) => {
      const failEntry = (why) => fail(`declared entry ${at + 1} (${entry?.kind}): ${why}`);
      if (!isObject(entry)) failEntry("it is not an object");
      if (entry.child !== group.repository) failEntry(`it names the child '${entry.child}'`);
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") failEntry("it carries no reason");
      if (!HOIST_KINDS.includes(entry.kind)) failEntry(`a hoist names only differences inside its node (${HOIST_KINDS.join(", ")})`);
      if (entry.step !== item.step) failEntry(`it names the step '${entry.step}', not the hoisted '${item.step}'`);
      applyEntry(holder, entry, failEntry);
    });
    // The id and the fields bound to it (a filing step's node_id, a name that is the id) follow `as`,
    // as they follow a copy's prefix; under the child's own id nothing else changes.
    if (item.as === node.id) node.id = item.as;
    else moveStepId(node, item.as, fail);
    const found = stepDangling(node);
    if (found.length > 0) fail(`the hoisted step names what it does not have: ${found.join("; ")}`);
    return { as: item.as, node };
  });
}

function prefixFlow(flow, prefix, fail) {
  const refs = {};
  for (const [key, step] of Object.entries(flow.$referenced_components)) {
    if (isArrayIndexKey(prefix + key)) fail(`the prefixed step id '${prefix + key}' is an array index, which JavaScript orders first`);
    moveStepId(step, prefix + step.id, fail);
    setOwn(refs, prefix + key, step);
  }
  flow.$referenced_components = refs;
  // Every $component_ref gets the prefix once, the ones inside the steps included.
  walkRefs(flow, (ref) => prefix + ref);
  for (const edge of [...flow.control_flow_connections, ...flow.data_flow_connections]) {
    edge.name = prefix + edge.name;
  }
}

/** One child flow plus its list entry -> the embedded copy the outreach carries. */
export function generateCopy(child, group) {
  checkedHoists(child, group);
  const flow = clone(child);
  (group.declared ?? []).forEach((entry, index) => {
    const fail = (why) => {
      throw new Error(`${group.repository}: declared entry ${index + 1} (${entry.kind}) no longer applies: ${why}`);
    };
    if (entry.child !== group.repository) fail(`it names the child '${entry.child}'`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") fail("it carries no reason");
    applyEntry(flow, entry, fail);
  });
  prefixFlow(flow, group.prefix, (why) => {
    throw new Error(`${group.repository}: ${why}`);
  });
  flow.id = group.copyId;
  const found = danglingNames(flow);
  if (found.length > 0) {
    throw new Error(`${group.repository}: the generated copy names what its steps do not have: ${found.join("; ")}`);
  }
  return flow;
}

/**
 * The parent flow with its embedded copies replaced by the generated ones and
 * each hoisted step written under its id: in its place when the parent already
 * carries it, else after the parent's other components.
 */
export function generateFlow(parent, list, children) {
  const flow = clone(parent);
  const rc = flow.$referenced_components;
  list.forEach((group, index) => {
    if (!Object.hasOwn(rc, group.copyId)) {
      throw new Error(`${group.repository}: the flow carries no copy '${group.copyId}'`);
    }
    setOwn(rc, group.copyId, generateCopy(children[index], group));
  });
  const copyIds = new Set(list.map((group) => group.copyId));
  const hoisted = new Set();
  list.forEach((group, index) => {
    generateHoists(children[index], group).forEach(({ as, node }, at) => {
      const fail = (why) => {
        throw new Error(`${group.repository}: hoist ${at + 1} (step '${group.hoist[at].step}' as '${as}') no longer applies: ${why}`);
      };
      if (copyIds.has(as)) fail(`the id '${as}' collides with an embedded copy of the parent`);
      if (hoisted.has(as)) fail(`the id '${as}' collides with another group's hoist`);
      hoisted.add(as);
      // The parent's component under this id is replaced only when it is provably this hoist's own
      // output: the step it generates now, or the one its recorded blob names (the step --write last
      // wrote). Anything else is the parent's own component and is refused.
      if (Object.hasOwn(rc, as)) {
        const existing = blobOf(ownValue(rc, as));
        const recorded = typeof group.hoist[at].blob === "string" ? group.hoist[at].blob : null;
        if (existing !== blobOf(node) && existing !== recorded) {
          fail(
            `the id '${as}' collides with the parent's component '${as}' (blob ${existing}), which is neither ` +
              `the step this hoist generates (blob ${blobOf(node)}) nor the one it recorded as written (${recorded ? `blob ${recorded}` : "no record"})`,
          );
        }
      }
      setOwn(rc, as, node);
    });
  });
  return flow;
}

/** Every id the generator writes into the parent's components: each copy, then each hoist. */
export function generatedIds(list) {
  return list.flatMap((group) => [group.copyId, ...(Array.isArray(group.hoist) ? group.hoist.map((item) => item.as) : [])]);
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function skipString(text, i) {
  for (i += 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error(`${FLOW_PATH}: unterminated text`);
}

function skipValue(text, i) {
  if (text[i] === '"') return skipString(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth += 1;
      if (c === "}" || c === "]") depth -= 1;
      i += 1;
      if (depth === 0) return i;
    }
    throw new Error(`${FLOW_PATH}: unbalanced value`);
  }
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i += 1;
  return i;
}

/** The [start, end) offsets of the value at an object key path in a JSON text. */
export function valueSpan(text, keys) {
  let i = skipSpace(text, 0);
  for (const [depth, target] of keys.entries()) {
    if (text[i] !== "{") throw new Error(`${FLOW_PATH}: '${keys.slice(0, depth).join(".")}' is not an object`);
    i = skipSpace(text, i + 1);
    for (;;) {
      if (text[i] !== '"') throw new Error(`${FLOW_PATH}: no key '${keys.slice(0, depth + 1).join(".")}'`);
      const keyEnd = skipString(text, i);
      const key = JSON.parse(text.slice(i, keyEnd));
      i = skipSpace(text, keyEnd);
      if (text[i] !== ":") throw new Error(`${FLOW_PATH}: malformed object`);
      const start = skipSpace(text, i + 1);
      const end = skipValue(text, start);
      if (key === target) {
        if (depth === keys.length - 1) return [start, end];
        i = start;
        break;
      }
      i = skipSpace(text, end);
      if (text[i] === ",") i = skipSpace(text, i + 1);
    }
  }
  throw new Error(`${FLOW_PATH}: empty key path`);
}

/**
 * The flow text with ONLY the copies and the hoisted steps replaced by the
 * generated ones; every other byte of the text is kept as it is. A hoisted step
 * the text does not carry yet is added as the last member of the components.
 */
export function writeCopies(text, generated, list) {
  // JSON strings cannot hold a raw CR, so a CR here is a line end; the generator writes LF only.
  if (text.includes("\r")) throw new Error(`${FLOW_PATH}: the text has CR line ends; the generator writes LF only`);
  const once = (members, name, where) => {
    if (members.filter((member) => member.key === name).length > 1) {
      throw new Error(`${FLOW_PATH}: ${where} '${name}' is written more than once`);
    }
  };
  const root = membersOf(text, skipSpace(text, 0));
  once(root, "$referenced_components", "the flow's member");
  const [componentsAt] = valueSpan(text, ["$referenced_components"]);
  const components = membersOf(text, componentsAt);
  for (const id of generatedIds(list)) once(components, id, "the component");
  let out = text;
  for (const id of generatedIds(list)) {
    if (!Object.hasOwn(JSON.parse(out).$referenced_components, id)) {
      out = appendComponent(out, id, ownValue(generated.$referenced_components, id));
      continue;
    }
    const [start, end] = valueSpan(out, ["$referenced_components", id]);
    const lineStart = out.lastIndexOf("\n", start) + 1;
    const indent = /^[ \t]*/.exec(out.slice(lineStart, start))[0];
    const copyText = serialize(ownValue(generated.$referenced_components, id)).trimEnd().split("\n").join(`\n${indent}`);
    out = out.slice(0, start) + copyText + out.slice(end);
  }
  return out;
}

/** The text with one member added after the last member of $referenced_components, in its indentation. */
function appendComponent(text, id, value) {
  const [start] = valueSpan(text, ["$referenced_components"]);
  const members = membersOf(text, start);
  if (members.length === 0) throw new Error(`${FLOW_PATH}: the flow carries no components to add '${id}' after`);
  const last = members[members.length - 1];
  // The last key's offset as the text writes it (escaped or not), read by position, never searched for.
  const lineStart = text.lastIndexOf("\n", last.keyStart) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, last.keyStart))[0];
  const valueText = serialize(value).trimEnd().split("\n").join(`\n${indent}`);
  const member = `,\n${indent}${keyToken(id)}: ${valueText}`;
  return text.slice(0, last.end) + member + text.slice(last.end);
}

/**
 * The list with each hoist's `blob` set to the git blob sha of the step it
 * generates (its serialization): the record --write keeps in the list, by
 * which a later run knows the parent's component under that id as this hoist's
 * own earlier output. The list passed in is not changed.
 */
export function recordHoists(list, children) {
  const recorded = clone(list);
  recorded.forEach((group, index) => {
    generateHoists(children[index], group).forEach(({ node }, at) => {
      group.hoist[at].blob = blobOf(node);
    });
  });
  return recorded;
}

/** Each hoist whose recorded blob is not the blob of the component the flow carries under its id. */
export function hoistRecordProblems(flow, list) {
  const problems = [];
  for (const group of list) {
    for (const item of Array.isArray(group.hoist) ? group.hoist : []) {
      const carried = Object.hasOwn(flow.$referenced_components ?? {}, item.as)
        ? blobOf(ownValue(flow.$referenced_components, item.as))
        : "none";
      if (typeof item.blob !== "string") problems.push(`hoist '${item.as}' records no blob; the flow carries ${carried}`);
      else if (item.blob !== carried) problems.push(`hoist '${item.as}' records blob ${item.blob}; the flow carries ${carried}`);
    }
  }
  return problems;
}

/**
 * What --check reports for a flow text: each hoist whose recorded blob is not
 * the step the flow carries, each generated component that differs from what
 * --write writes, and a text that is not written in the generator's
 * serialization (two-space JSON, LF line ends, one final newline, no trailing
 * spaces, no key written twice, keys in JavaScript's order). Empty: current.
 */
export function checkFlowText(text, list, children) {
  const committed = JSON.parse(text);
  const generated = generateFlow(committed, list, children);
  const problems = hoistRecordProblems(committed, list).map((problem) => `${problem} (run --write)`);
  for (const id of generatedIds(list)) {
    if (JSON.stringify(ownValue(committed.$referenced_components, id)) !== JSON.stringify(ownValue(generated.$referenced_components, id))) {
      problems.push(`${id} differs from its child`);
    }
  }
  if (serialize(committed) !== text) problems.push(`${FLOW_PATH} is not written in the generator's serialization`);
  return problems;
}

/**
 * The list text with each hoist's blob recorded (recordHoists), refusing a list
 * text that is not in the serialization: --write rewrites the list whole, so it
 * must change nothing but the recorded blobs.
 */
export function recordedListText(listText, list, children) {
  if (serialize(JSON.parse(listText)) !== listText) {
    throw new Error(`${LIST_PATH}: the list is not written in the generator's serialization; --write records the hoists' blobs only into one that is`);
  }
  return serialize(recordHoists(list, children));
}

function main(argv) {
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
  if (!mode) {
    process.stderr.write("usage: node scripts/embedded-copies.mjs --write | --check\n");
    return 2;
  }
  const list = loadList();
  const children = list.map((group) => loadChild(group));
  const flowFile = path.join(ROOT, FLOW_PATH);
  const committedText = readFileSync(flowFile, "utf8");
  const committed = JSON.parse(committedText);
  if (mode === "write") {
    const generated = generateFlow(committed, list, children);
    const written = writeCopies(committedText, generated, list);
    // Each hoist records the blob of the step it wrote, so the next run knows that step as its own.
    // Both texts are made before either file is written: a refusal leaves both files as they were.
    const listFile = path.join(ROOT, LIST_PATH);
    const listText = readFileSync(listFile, "utf8");
    const hoists = list.some((group) => Array.isArray(group.hoist));
    const recordedText = hoists ? recordedListText(listText, list, children) : listText;
    if (written !== committedText) writeFileSync(flowFile, written);
    process.stdout.write(`embedded-copies: wrote ${generatedIds(list).join(", ")} into ${FLOW_PATH}\n`);
    if (recordedText !== listText) {
      writeFileSync(listFile, recordedText);
      process.stdout.write(`embedded-copies: recorded the hoisted steps' blobs in ${LIST_PATH}\n`);
    }
    return 0;
  }
  const problems = checkFlowText(committedText, list, children);
  for (const problem of problems) process.stderr.write(`embedded-copies: ${problem}\n`);
  if (problems.length > 0) return 1;
  process.stdout.write(`embedded-copies: ${FLOW_PATH} carries exactly the generated copies\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
