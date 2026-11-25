// Lifecycle D W6 — this agent's declared state, asserted on the shipped
// manifest and the shipped service description.
//
// The declaration key: a dependency is a required `kind: "artifact"` entry in
// `cinatra.dependencies`; produces is `cinatra.produces` on the manifest, which
// is the only authority the host compiler reads; a binding is an end-node
// output's `cinatra.artifact` block. A produces mirror carried in the service
// description is optional, and when present must agree entry for entry with the
// manifest — the compiler refuses a mirror that disagrees.
//
// 6a for the composite is the PAUSE half: the pauses this flow draws with a
// screen of a package, each named by the one screen that draws it. Five pauses
// remain, but since cinatra#3089 two are drawn by the application itself (the
// drafts review on its review card, the send on its publish card), so the
// manifest's flow declares the other three. The setup pause is no longer
// declared (its fields move to the start form) and the intermediate output
// screen is not a pause at all, and a declared pause that is not a pause is a
// promise the run never keeps.
//
// The typed produces entry: the embedded drafting copy files each drafted body
// mid-run (its artifact_materialize step, drafts-file_drafts), and the
// application authorizes that write against the RUN package's
// cinatra.produces, the outreach's own. So the manifest declares the email body
// it files, the one entry its filing step names; the flow carries no binding
// and no produces mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const pkg = readJson("package.json");
const oas = readJson("cinatra/oas.json");
const cinatra = pkg.cinatra ?? {};
const flowMeta = oas.metadata.cinatra;
const components = oas.$referenced_components ?? {};

const THE_DRAWN = [
  "@cinatra-ai/email-outreach-agent:list-picker",
  "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
  "@cinatra-ai/context-selection-agent:context-selector",
];

test("6a — the composite declares the three pauses a package screen draws and no others", () => {
  assert.deepEqual(flowMeta.hitlScreens, THE_DRAWN);
});

test("6a — the setup pause is no longer declared", () => {
  assert.ok(!flowMeta.hitlScreens.includes("@cinatra-ai/email-outreach-agent:setup-form"));
});

test("6a — no intermediate output renderer is declared as a pause", () => {
  const outputs = flowMeta.hitlScreens.filter((id) => id.endsWith(":output"));
  assert.deepEqual(outputs, []);
});

test("6a — every declared pause names a package this manifest declares", () => {
  const declared = new Set([pkg.name, ...cinatra.dependencies.map((d) => d.packageName)]);
  for (const id of flowMeta.hitlScreens) {
    assert.ok(declared.has(id.slice(0, id.indexOf(":", 1))), `undeclared owner for ${id}`);
  }
});

test("6a — the body kind stays a required artifact dependency", () => {
  const edge = (cinatra.dependencies ?? []).find(
    (d) => d.kind === "artifact" && d.packageName === "@cinatra-ai/email-artifacts",
  );
  assert.ok(edge, "no artifact dependency on @cinatra-ai/email-artifacts");
  assert.equal(edge.requirement, "required");
});

test("6a — the manifest produces exactly the email body the embedded filing step writes", () => {
  assert.deepEqual(cinatra.produces, [{ extension: "@cinatra-ai/email-artifacts", objectTypeId: "@cinatra-ai/email:body" }]);
  assert.equal(flowMeta.produces, undefined);
  const filing = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.component_type === "ApiNode" && node.data?.tool === "artifact_materialize") filing.push(node);
    Object.values(node).forEach(walk);
  };
  walk(oas);
  assert.deepEqual(filing.map((n) => n.id), ["drafts-file_drafts"]);
  for (const node of filing) {
    assert.deepEqual(
      { extension: node.data.input.extension, objectTypeId: node.data.input.objectTypeId },
      cinatra.produces[0],
    );
  }
  const topLevelEnd = Object.values(components).filter((c) => c?.component_type === "EndNode");
  for (const end of topLevelEnd) {
    for (const out of end.outputs ?? []) assert.equal(out?.cinatra?.artifact, undefined);
  }
});

test("the produces mirror agrees with the manifest, entry for entry", () => {
  const mirror = flowMeta.produces;
  if (mirror === undefined) return;
  assert.deepEqual(mirror, cinatra.produces ?? []);
});
