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
// 6a for the composite is the PAUSE half: the five pauses this flow has, each
// named by the one screen that draws it. The setup pause is no longer declared
// (its fields move to the start form) and the two intermediate output screens
// are not pauses at all — they are the renderers two inner steps carry, and a
// declared pause that is not a pause is a promise the run never keeps.
//
// The typed produces entry the plan puts on this parent is NOT here, and that
// is a decision, not an omission: the road that would resolve it is the
// embedded drafting step's mid-run write of each body, and the binding
// collector reads TOP-LEVEL end nodes only — a subflow end node cannot bind.
// The embedded copy carries no binding of its own today. From this wave on a
// produces entry no materialization road reaches is refused at publish, so a
// declaration landed here now would make this package unpublishable. It travels
// with the re-inlining of the embedded copies and the ledgered mid-run write.

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

const THE_FIVE = [
  "@cinatra-ai/email-outreach-agent:list-picker",
  "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
  "@cinatra-ai/context-selection-agent:context-selector",
  "@cinatra-ai/email-drafting-agent:email-drafts-review",
  "@cinatra-ai/email-delivery-agent:send-confirmation",
];

test("6a — the composite declares its five pauses and no others", () => {
  assert.deepEqual(flowMeta.hitlScreens, THE_FIVE);
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

test("6a — no produces entry stands ahead of a road that resolves it", () => {
  assert.equal(cinatra.produces, undefined);
  assert.equal(flowMeta.produces, undefined);
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
