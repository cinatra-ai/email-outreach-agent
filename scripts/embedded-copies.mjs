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

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIST_PATH = "scripts/embedded-copies.json";
export const FLOW_PATH = "cinatra/oas.json";

export const KINDS = Object.freeze([
  "omit-flow-key",
  "omit-step",
  "omit-output",
  "omit-input",
  "omit-key",
  "omit-text",
  "copy-value",
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

function stepOf(flow, stepId, fail) {
  const step = flow.$referenced_components?.[stepId];
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
      step.inputs.splice(at, 1);
      flow.data_flow_connections = flow.data_flow_connections.filter(
        (e) => !(refOf(e.destination_node) === entry.step && e.destination_input === entry.input),
      );
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
      const renamed = {};
      for (const [key, value] of Object.entries(rc)) renamed[key === entry.step ? entry.to : key] = value;
      flow.$referenced_components = renamed;
      if (step.name === step.id) step.name = entry.to;
      step.id = entry.to;
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

function prefixFlow(flow, prefix) {
  const refs = {};
  for (const [key, step] of Object.entries(flow.$referenced_components)) {
    if (step.name === step.id) step.name = prefix + step.id;
    step.id = prefix + step.id;
    refs[prefix + key] = step;
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
  const flow = clone(child);
  (group.declared ?? []).forEach((entry, index) => {
    const fail = (why) => {
      throw new Error(`${group.repository}: declared entry ${index + 1} (${entry.kind}) no longer applies: ${why}`);
    };
    if (entry.child !== group.repository) fail(`it names the child '${entry.child}'`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") fail("it carries no reason");
    applyEntry(flow, entry, fail);
  });
  prefixFlow(flow, group.prefix);
  flow.id = group.copyId;
  return flow;
}

/** The parent flow with its three embedded copies replaced by the generated ones. */
export function generateFlow(parent, list, children) {
  const flow = clone(parent);
  list.forEach((group, index) => {
    if (!Object.hasOwn(flow.$referenced_components, group.copyId)) {
      throw new Error(`${group.repository}: the flow carries no copy '${group.copyId}'`);
    }
    flow.$referenced_components[group.copyId] = generateCopy(children[index], group);
  });
  return flow;
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
 * The flow text with ONLY the three copies replaced by the generated ones;
 * every other byte of the text is kept as it is.
 */
export function writeCopies(text, generated, list) {
  let out = text;
  for (const group of list) {
    const [start, end] = valueSpan(out, ["$referenced_components", group.copyId]);
    const lineStart = out.lastIndexOf("\n", start) + 1;
    const indent = /^[ \t]*/.exec(out.slice(lineStart, start))[0];
    const copyText = serialize(generated.$referenced_components[group.copyId]).trimEnd().split("\n").join(`\n${indent}`);
    out = out.slice(0, start) + copyText + out.slice(end);
  }
  return out;
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
  const generated = generateFlow(committed, list, children);
  const text = serialize(generated);
  if (mode === "write") {
    const written = writeCopies(committedText, generated, list);
    if (written !== committedText) writeFileSync(flowFile, written);
    process.stdout.write(`embedded-copies: wrote ${list.map((g) => g.copyId).join(", ")} into ${FLOW_PATH}\n`);
    return 0;
  }
  if (text === committedText) {
    process.stdout.write(`embedded-copies: ${FLOW_PATH} carries exactly the generated copies\n`);
    return 0;
  }
  const differing = list
    .map((group) => group.copyId)
    .filter(
      (id) =>
        JSON.stringify(committed.$referenced_components[id]) !== JSON.stringify(generated.$referenced_components[id]),
    );
  for (const id of differing) process.stderr.write(`embedded-copies: ${id} differs from its child\n`);
  if (differing.length === 0) {
    process.stderr.write(`embedded-copies: ${FLOW_PATH} is not written in the generator's serialization\n`);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
