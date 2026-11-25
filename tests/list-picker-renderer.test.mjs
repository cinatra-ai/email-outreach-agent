// The list step's component, mounted (cinatra-ai/cinatra#3562).
//
// The account scope step shows the CRM's lists that the step before it read
// (`{ lists: [{ id, name }], listsRead }`, the content the recipient selection
// flow hands the picker). The component draws one checkbox row per list,
// nothing ticked, and reports through `onValidityChange` whether its value may
// be sent: `false` while nothing is ticked, so the application keeps the step's
// Continue unavailable, and `true` from the first tick. Each tick or untick
// writes `{ listIds, listNames }` in the order ticked. With no list to pick it
// draws the empty-state message the binding declared (or, for a failed read,
// the step's one failed-read alert), no row and no link, and Try again, which
// writes the declared refresh value so the flow reads the lists again.
//
// The last suite reproduces the host's lift of that write into the gate's
// answer and checks the lifted answer against the gate and the generation step
// in cinatra/oas.json.
//
// The arms mount the component in a document (react-dom and jsdom are dev
// dependencies of this package) and record every write and every report.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

const ENTRY_URL = new URL("../src/renderers/list-picker.ts", import.meta.url);
const OAS = JSON.parse(readFileSync(new URL("../cinatra/oas.json", import.meta.url), "utf8"));

const PARAMS = {
  selection: "multiple",
  minSelected: 1,
  question: "Which views or lists in your CRM should this run take its recipients from?",
  emptyState: "There are no views or lists in Twenty CRM to pick from yet. Create one in Twenty CRM.",
  refreshValue: "refresh",
};

const LISTS = [
  { id: "view-a", name: "Customers in Berlin" },
  { id: "view-b", name: "Trade fair leads" },
  { id: "view-c", name: "Newsletter" },
];

let dom;
let React;
let act;
let createRoot;
let Renderer;

/** Mount one reading; returns the recorded writes and reports, and the container. */
async function mount(props) {
  const writes = [];
  const reports = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const draw = (next) =>
    React.createElement(Renderer, {
      onChange: (value) => void writes.push(value),
      onValidityChange: (valid) => void reports.push(valid),
      bindingParams: PARAMS,
      ...next,
    });
  await act(async () => {
    root.render(draw(props));
  });
  const rerender = async (next) => {
    await act(async () => {
      root.render(draw(next));
    });
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { writes, reports, container, rerender, unmount };
}

const boxes = (container) => [...container.querySelectorAll('input[type="checkbox"]')];

async function click(element) {
  await act(async () => {
    element.click();
  });
}

describe("the list step, mounted", () => {
  // The hooks stay inside this suite: tests/run.mjs runs every suite in one
  // process, where a top-level hook would bind to every other suite too.
  before(async () => {
    const { JSDOM } = await import("jsdom");
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    // react-dom reads the document from the globals when it loads.
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    React = await import("react");
    act = React.act;
    ({ createRoot } = await import("react-dom/client"));
    Renderer = (await import(ENTRY_URL.href)).default;
    assert.equal(typeof Renderer, "function", "the module's default export is a function");
  });

  after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    dom?.window.close();
  });

  it("opens with one unticked checkbox row per list and reports the value unsendable", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      const rows = boxes(view.container);
      assert.equal(rows.length, 3);
      assert.ok(rows.every((box) => box.checked === false), "a row is ticked for the reader");
      assert.equal(view.container.textContent.includes("Customers in Berlin"), true);
      assert.equal(view.container.textContent.includes("Trade fair leads"), true);
      assert.deepEqual(view.writes, [], "the step writes a value before anything is ticked");
      assert.deepEqual(view.reports, [false]);
    } finally {
      await view.unmount();
    }
  });

  it("two ticks write both lists in the order ticked and report the value sendable", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[1]);
      await click(boxes(view.container)[0]);
      assert.deepEqual(view.writes.at(-1), {
        listIds: ["view-b", "view-a"],
        listNames: ["Trade fair leads", "Customers in Berlin"],
      });
      assert.equal(view.reports.at(-1), true);
      assert.deepEqual(
        boxes(view.container).map((box) => box.checked),
        [true, true, false],
      );
    } finally {
      await view.unmount();
    }
  });

  it("unticking the last row writes no list and reports the value unsendable again", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[2]);
      assert.equal(view.reports.at(-1), true);
      await click(boxes(view.container)[2]);
      assert.deepEqual(view.writes.at(-1), { listIds: [], listNames: [] });
      assert.equal(view.reports.at(-1), false);
    } finally {
      await view.unmount();
    }
  });

  it("an empty list draws the declared message, no row and no link, Try again, and holds the step", async () => {
    const view = await mount({ value: { lists: [], listsRead: "ok" } });
    try {
      assert.equal(boxes(view.container).length, 0);
      assert.equal(view.container.querySelectorAll("a, [href]").length, 0);
      const status = view.container.querySelector('[role="status"]');
      assert.equal(status?.textContent, PARAMS.emptyState);
      assert.equal(view.container.querySelector('[role="alert"]'), null, "an empty read is drawn as a failure");
      assert.ok(view.container.querySelector('[data-testid="list-picker-try-again"]'), "no recovery offered");
      assert.deepEqual(view.writes, []);
      assert.deepEqual(view.reports, [false]);
    } finally {
      await view.unmount();
    }
  });

  it("a failed read draws the one failed-read alert with Try again, never the empty message", async () => {
    for (const value of [
      { lists: [], listsRead: "failed" },
      JSON.stringify({ lists: [], listsRead: "failed" }),
      { lists: LISTS },
      "not json",
    ]) {
      const view = await mount({ value });
      try {
        assert.equal(boxes(view.container).length, 0);
        const alert = view.container.querySelector('[role="alert"]');
        assert.ok(alert, `no alert for ${JSON.stringify(value)}`);
        assert.equal(alert.textContent.includes("This list could not be read."), true);
        assert.equal(view.container.textContent.includes(PARAMS.emptyState), false);
        assert.ok(alert.querySelector('[data-testid="list-picker-try-again"]'), "no Try again in the alert");
        assert.deepEqual(view.reports, [false]);
      } finally {
        await view.unmount();
      }
    }
  });

  it("Try again writes the declared refresh value and keeps Continue unavailable", async () => {
    for (const listsRead of ["ok", "failed"]) {
      const view = await mount({ value: { lists: [], listsRead } });
      try {
        await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
        assert.deepEqual(view.writes, [{ listIds: [], listNames: [], refresh: PARAMS.refreshValue }]);
        assert.deepEqual(view.reports, [false], "the press reports the step sendable");
      } finally {
        await view.unmount();
      }
    }
  });

  it("offers no Try again without a declared refresh value, or on a read-only reading", async () => {
    const readings = [
      { bindingParams: { ...PARAMS, refreshValue: undefined } },
      { mode: "view" },
      { disabled: true },
    ];
    for (const reading of readings) {
      const view = await mount({ value: { lists: [], listsRead: "failed" }, ...reading });
      try {
        assert.equal(view.container.querySelector('[data-testid="list-picker-try-again"]'), null);
        assert.deepEqual(view.writes, []);
      } finally {
        await view.unmount();
      }
    }
  });

  it("the root carries the design example's conformance id on every reading", async () => {
    for (const value of [{ lists: LISTS, listsRead: "ok" }, { lists: [], listsRead: "ok" }, { listsRead: "failed" }]) {
      const view = await mount({ value });
      try {
        const root = view.container.firstElementChild;
        assert.equal(root?.getAttribute("data-conformance-id"), "run-list-step-multi-pick");
        assert.equal(view.container.children.length, 1, "the step draws more than one root");
      } finally {
        await view.unmount();
      }
    }
  });

  it("reads the content when it arrives as the JSON text of the step before", async () => {
    const view = await mount({ value: JSON.stringify({ lists: LISTS, listsRead: "ok" }) });
    try {
      assert.equal(boxes(view.container).length, 3);
    } finally {
      await view.unmount();
    }
  });

  it("draws an entry without an id as no row, and an id given twice as one row", async () => {
    const view = await mount({
      value: { lists: [{ name: "No id" }, LISTS[0], { ...LISTS[0] }, null, "view-x"], listsRead: "ok" },
    });
    try {
      assert.equal(boxes(view.container).length, 1);
    } finally {
      await view.unmount();
    }
  });

  it("draws the declared question and the waiting pill while the run waits", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      assert.equal(view.container.textContent.includes(PARAMS.question), true);
      assert.equal(view.container.textContent.includes("Awaiting your picks"), true);
    } finally {
      await view.unmount();
    }
  });

  it("on a read-only reading writes nothing, reports nothing and draws no pill", async () => {
    for (const reading of [{ mode: "view" }, { disabled: true }]) {
      const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, ...reading });
      try {
        await click(boxes(view.container)[0]);
        assert.deepEqual(view.writes, [], `a write on ${JSON.stringify(reading)}`);
        assert.deepEqual(view.reports, [], `a report on ${JSON.stringify(reading)}`);
        if (reading.mode === "view") {
          assert.equal(view.container.textContent.includes("Awaiting your picks"), false);
        }
      } finally {
        await view.unmount();
      }
    }
  });

  it("two lists with the same name are two rows told apart by their ids, and each tick writes its own id", async () => {
    const twins = [
      { id: "view-prospects-north", name: "Prospects" },
      { id: "view-prospects-south", name: "Prospects" },
    ];
    const view = await mount({ value: { lists: twins, listsRead: "ok" } });
    try {
      const rows = [...view.container.querySelectorAll("label")];
      assert.equal(rows.length, 2);
      const read = (row) => ({
        title: row.querySelector('[data-testid="list-picker-row-title"]')?.textContent,
        detail: row.querySelector('[data-testid="list-picker-row-detail"]')?.textContent,
      });
      assert.deepEqual(rows.map(read), [
        { title: "Prospects", detail: "view-prospects-north" },
        { title: "Prospects", detail: "view-prospects-south" },
      ]);
      assert.notEqual(rows[0].textContent, rows[1].textContent, "the two rows read the same");
      await click(boxes(view.container)[1]);
      assert.deepEqual(view.writes.at(-1), { listIds: ["view-prospects-south"], listNames: ["Prospects"] });
      await click(boxes(view.container)[0]);
      assert.deepEqual(view.writes.at(-1), {
        listIds: ["view-prospects-south", "view-prospects-north"],
        listNames: ["Prospects", "Prospects"],
      });
    } finally {
      await view.unmount();
    }
  });

  it("reopened on a completed step, draws the recorded picks by name and no failed-read alert", async () => {
    const note = { type: "list", listIds: ["view-b", "view-a"], listNames: ["Trade fair leads", ""], snapshotAt: "2026-11-24T00:00:00.000Z" };
    const readings = {
      "the write": { listIds: ["view-b", "view-a"], listNames: ["Trade fair leads", ""] },
      "the lifted note": note,
      "the lifted note as JSON text": JSON.stringify(note),
      "the recorded values with the note": {
        listIds: ["view-b", "view-a"],
        listNames: ["Trade fair leads", ""],
        approved: true,
        approvedAt: "2026-11-24T00:00:00.000Z",
        approvalNote: JSON.stringify(note),
      },
      "only the note under approvalNote": { approved: true, approvalNote: JSON.stringify(note) },
    };
    for (const [label, value] of Object.entries(readings)) {
      const view = await mount({ value, mode: "view", disabled: true });
      try {
        const text = view.container.textContent;
        assert.equal(text.includes("Trade fair leads"), true, `${label}: the picked name`);
        assert.deepEqual(
          [...view.container.querySelectorAll('[data-testid="list-picker-row-title"]')].map((title) => title.textContent),
          ["Trade fair leads", "view-a"],
          `${label}: the titles, the id for a blank name`,
        );
        assert.deepEqual(
          [...view.container.querySelectorAll('[data-testid="list-picker-row-detail"]')].map((detail) => detail.textContent),
          ["view-b", "view-a"],
          `${label}: each row's id as its detail line`,
        );
        assert.equal(view.container.querySelector('[role="alert"]'), null, `${label}: an alert`);
        assert.equal(view.container.querySelector('[data-testid="list-picker-try-again"]'), null, `${label}: Try again`);
        assert.equal(text.includes("could not be read"), false, `${label}: the failed-read words`);
        const ticks = boxes(view.container);
        assert.equal(ticks.length, 2, `${label}: one row per pick`);
        assert.equal(ticks.every((box) => box.checked && box.disabled), true, `${label}: ticked and disabled`);
        assert.equal(
          view.container.querySelector('[data-conformance-id="run-list-step-multi-pick"]') !== null,
          true,
          `${label}: the conformance root`,
        );
        await click(ticks[0]);
        assert.deepEqual(view.writes, [], `${label}: a write`);
        assert.deepEqual(view.reports, [], `${label}: a report`);
      } finally {
        await view.unmount();
      }
    }
  });

  it("reports once per change, not again on a re-render", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await view.rerender({ value: { lists: LISTS, listsRead: "ok" } });
      assert.deepEqual(view.reports, [false]);
    } finally {
      await view.unmount();
    }
  });
});

// THE HOST'S LIFT, REPRODUCED (finding: "the renderer emits { listIds, listNames }
// and not the gate's string scope with type: "list"").
//
// The component writes `{ listIds, listNames }`; the gate's answer is what the
// host makes of it on Continue. This fixture copies the several-picks branch of
// `liftRendererApprovalNote` from cinatra-ai/cinatra
// packages/agents/src/hitl-gate-submit.ts (with its `isUsableListId`), and the
// resume-text choice of packages/agents/src/review-task-actions.ts (the note is
// the resume text: the list step's lift drops any `userResponse`). Keep it in
// step with those files; it is a documented copy, not an import, because an
// extension never imports the host.
function hostLiftListPicker(buffered, now) {
  const isUsableListId = (id) => typeof id === "string" && id.trim().length > 0;
  const ticked = buffered.listIds;
  if (Array.isArray(ticked)) {
    const names = buffered.listNames;
    const listIds = [];
    const listNames = [];
    ticked.forEach((id, index) => {
      if (!isUsableListId(id) || listIds.includes(id)) return;
      listIds.push(id);
      const name = Array.isArray(names) ? names[index] : undefined;
      listNames.push(typeof name === "string" ? name : "");
    });
    if (listIds.length > 0) {
      return { approvalNote: JSON.stringify({ type: "list", listIds, listNames, snapshotAt: now }) };
    }
  }
  return null; // the host's single-pick fallback is not this step's shape
}

/** Every node of the embedded flows, by id. */
function nodesById() {
  const byId = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    if (typeof node.id === "string" && typeof node.component_type === "string") byId.set(node.id, node);
    Object.values(node).forEach(walk);
  };
  walk(OAS);
  return byId;
}

/** The generation step's Step 1 reading of `accountScope`, as its prompt states it. */
function generationAcceptsScope(accountScope) {
  let scope;
  try {
    scope = JSON.parse(accountScope);
  } catch {
    return false;
  }
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return false;
  if (scope.type !== "list") return false;
  const ids = Array.isArray(scope.listIds) ? scope.listIds : typeof scope.listId === "string" ? [scope.listId] : [];
  return ids.length > 0;
}

describe("the gate's answer is the host's lift of the list step's write", () => {
  const nodes = nodesById();
  const gate = nodes.get("recipients-scope_gate");
  const branch = nodes.get("recipients-scope_branch");
  const generate = nodes.get("recipients-generate");

  it("the flow declares the gate, its branch and the generation step this suite reads", () => {
    assert.ok(gate && branch && generate);
    assert.deepEqual(gate.outputs, [{ title: "accountScope", type: "string" }]);
    assert.equal(gate.metadata.cinatra.inputRenderers.accountScope, "@cinatra-ai/email-outreach-agent:list-picker");
    assert.match(generate.data.system, /ONLY type='list' is supported/);
    assert.match(generate.data.system, /`listIds`/);
  });

  it("two ticks lift to a string the gate takes and the generation accepts as type list", () => {
    const write = { listIds: ["view-b", "view-a"], listNames: ["Trade fair leads", "Customers in Berlin"] };
    const lift = hostLiftListPicker(write, "2026-11-24T00:00:00.000Z");
    assert.ok(lift, "the host lifts nothing from the step's write");
    const answer = lift.approvalNote;
    assert.equal(typeof answer, "string", "the gate declares accountScope as a string");
    assert.deepEqual(JSON.parse(answer), {
      type: "list",
      listIds: ["view-b", "view-a"],
      listNames: ["Trade fair leads", "Customers in Berlin"],
      snapshotAt: "2026-11-24T00:00:00.000Z",
    });
    assert.equal(generationAcceptsScope(answer), true);
    assert.equal(Object.hasOwn(branch.mapping, answer), false, "a pick would take the refresh branch");
  });

  it("the raw write, unlifted, is not an answer the generation accepts", () => {
    assert.equal(generationAcceptsScope(JSON.stringify({ listIds: ["view-a"], listNames: ["A"] })), false);
  });

  it("the Try again write names the value the branch maps to its refresh branch", () => {
    assert.equal(branch.mapping[PARAMS.refreshValue], "refresh");
    assert.equal(hostLiftListPicker({ listIds: [], listNames: [], refresh: PARAMS.refreshValue }, "x"), null,
      "the refresh request lifts as a pick");
    assert.equal(generationAcceptsScope(PARAMS.refreshValue), false);
  });
});

// HOW TRY AGAIN ADVANCES THE STEP (round 5 finding: "the refresh edge after the
// gate is unreachable ... never proves the flow advances").
//
// Try again does not advance the gate by a Continue, and it must not: nothing is
// picked, so Continue stays unavailable. The host advances it. cinatra-ai/cinatra
// #4772 reads the component's write with `listStepRefreshRequest` (a mid-run
// `:list-picker` step and a nonblank `refresh`), sends
// `buildListStepRefreshPayload(refresh)` at once as the step's answer, and the
// server takes it only when it equals the refresh value the binding declared
// (`params.refreshValue`, recorded with the pause), then resumes the gate with
// exactly that value as its text (packages/agents/src/hitl-gate-submit.ts,
// review-task-actions.ts). The fixtures below copy those readings; they are
// documented copies, not imports, because an extension never imports the host.
// This suite proves every link a package can hold: the declared value is the
// value the host sends, the gate takes it as its answer, the branch maps it to a
// branch that reads the CRM again, and that read returns to the SAME gate node
// (the host keeps the step by the signed node id, so a copy of the gate would be
// a new step).

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const LIST_PICKER_BINDING = (PKG.cinatra.fieldRenderers ?? []).find(
  (binding) => binding.id === "@cinatra-ai/email-outreach-agent:list-picker",
);
const HOST_REFRESH_KEY = "listStepRefresh";

/** Copy of `isMidRunListStepGate` (hitl-gate-submit.ts); a setup gate's task id starts with "setup-". */
const hostIsMidRunListStep = (xRenderer, reviewTaskId) =>
  xRenderer.endsWith(":list-picker") && !reviewTaskId.startsWith("setup-");

/** Copy of `listStepRefreshRequest` (hitl-gate-submit.ts): what the hosts read from the write. */
function hostRefreshRequest(xRenderer, reviewTaskId, written) {
  if (!hostIsMidRunListStep(xRenderer, reviewTaskId)) return null;
  if (written === null || typeof written !== "object" || Array.isArray(written)) return null;
  const refresh = written.refresh;
  return typeof refresh === "string" && refresh.trim().length > 0 ? refresh : null;
}

/** Copy of `buildListStepRefreshPayload` (hitl-gate-submit.ts). */
const hostRefreshPayload = (refresh) => ({
  approved: true,
  approvedAt: "2026-11-25T00:00:00.000Z",
  userResponse: refresh,
  [HOST_REFRESH_KEY]: refresh,
});

/**
 * Copy of the server's decision (review-task-actions.ts with
 * `listStepRefreshIsRequest`, `isListStepRefreshPayloadShape` and
 * `listStepRefreshAccepted`): the gate's resume text, or null when refused.
 */
function hostServerResumeText({ xRenderer, reviewTaskId, gateFields, declared, payload }) {
  if (!hostIsMidRunListStep(xRenderer, reviewTaskId)) return null;
  if (gateFields.includes(HOST_REFRESH_KEY)) return null;
  const allowed = new Set(["approved", "approvedAt", "userResponse", HOST_REFRESH_KEY]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) return null;
  const requested = payload[HOST_REFRESH_KEY];
  if (typeof requested !== "string" || requested.trim().length === 0 || payload.userResponse !== requested) return null;
  if (typeof declared !== "string" || declared.trim().length === 0 || requested !== declared) return null;
  return declared;
}

/** The flows that hold a node id among their `nodes`. */
function flowsHolding(nodeId) {
  const flows = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    if (node.component_type === "Flow" && Array.isArray(node.nodes)) {
      if (node.nodes.some((ref) => ref?.$component_ref === nodeId)) flows.push(node);
    }
    Object.values(node).forEach(walk);
  };
  walk(OAS);
  return flows;
}

/** How many nodes in the whole flow file carry an id. */
function nodeCount(nodeId) {
  let count = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    if (node.id === nodeId && typeof node.component_type === "string") count += 1;
    Object.values(node).forEach(walk);
  };
  walk(OAS);
  return count;
}

describe("Try again advances the list step through the host's refresh", () => {
  const nodes = nodesById();
  const GATE = "recipients-scope_gate";
  const BRANCH = "recipients-scope_branch";
  const gate = nodes.get(GATE);
  const branch = nodes.get(BRANCH);
  const declared = LIST_PICKER_BINDING?.params?.refreshValue;
  const reviewTaskId = "wayflow-task-1";
  const gateFields = () => gate.outputs.map((output) => output.title);

  it("the binding declares a refresh value where the host reads it (params.refreshValue)", () => {
    assert.ok(LIST_PICKER_BINDING, "package.json declares no list-picker binding");
    assert.equal(typeof declared, "string");
    assert.ok(declared.trim().length > 0, "the declared refresh value is blank");
    assert.ok(hostIsMidRunListStep(LIST_PICKER_BINDING.id, reviewTaskId), "the host does not read this binding as a list step");
    assert.equal(gate.metadata.cinatra.inputRenderers.accountScope, LIST_PICKER_BINDING.id);
  });

  it("the server takes the host's refresh answer for the declared value and resumes the gate with it", () => {
    const resume = hostServerResumeText({
      xRenderer: LIST_PICKER_BINDING.id,
      reviewTaskId,
      gateFields: gateFields(),
      declared,
      payload: hostRefreshPayload(declared),
    });
    assert.equal(resume, declared);
    // The gate's one output takes the resume text: a string, as the gate declares.
    assert.deepEqual(gate.outputs, [{ title: "accountScope", type: "string" }]);
    assert.equal(typeof resume, "string");
    assert.equal(
      hostServerResumeText({
        xRenderer: LIST_PICKER_BINDING.id,
        reviewTaskId,
        gateFields: gateFields(),
        declared,
        payload: hostRefreshPayload(`${declared}-other`),
      }),
      null,
      "the server takes a value the binding did not declare",
    );
  });

  it("the gate's answer reaches the branch, which maps the declared value to a branch that is not the pick's", () => {
    const [flow] = flowsHolding(GATE);
    assert.ok(flow, "no flow holds the gate");
    const feeds = flow.data_flow_connections.filter(
      (edge) => edge.source_node.$component_ref === GATE && edge.destination_node.$component_ref === BRANCH,
    );
    assert.deepEqual(
      feeds.map((edge) => [edge.source_output, edge.destination_input]),
      [["accountScope", "accountScope"]],
    );
    assert.deepEqual(branch.inputs.map((input) => input.title), ["accountScope"]);
    const taken = branch.mapping[declared];
    assert.equal(typeof taken, "string", "the branch maps no branch for the declared value");
    assert.notEqual(taken, "default");
    assert.ok(branch.branches.includes(taken), `the branch declares no "${taken}" branch`);
  });

  it("that branch reads the CRM again and returns to the same gate node, with no other pause on the way", () => {
    assert.equal(nodeCount(GATE), 1, "the flow file holds more than one node with the gate's id");
    const flows = flowsHolding(GATE);
    assert.equal(flows.length, 1, "more than one flow holds the gate");
    const [flow] = flows;
    const taken = branch.mapping[declared];
    const edgesFrom = (id) => flow.control_flow_connections.filter((edge) => edge.from_node.$component_ref === id);
    const first = edgesFrom(BRANCH).filter((edge) => edge.from_branch === taken);
    assert.equal(first.length, 1, `the "${taken}" branch has ${first.length} edges`);
    const path = [];
    let at = first[0].to_node.$component_ref;
    while (at !== GATE) {
      assert.ok(!path.includes(at), `the refresh path loops without the gate at ${at}`);
      path.push(at);
      const node = nodes.get(at);
      assert.ok(node, `the refresh path reaches ${at}, which is not a node`);
      assert.ok(
        !["InputMessageNode", "BranchingNode", "EndNode", "FlowNode"].includes(node.component_type),
        `the refresh path reaches a ${node.component_type} at ${at}`,
      );
      const next = edgesFrom(at);
      assert.equal(next.length, 1, `${at} has ${next.length} edges on the refresh path`);
      at = next[0].to_node.$component_ref;
    }
    const reads = path.filter((id) => (nodes.get(id).metadata?.cinatra?.tools ?? []).includes("crm_list_search"));
    assert.equal(reads.length, 1, "the refresh path does not read the CRM's lists once");
    const hands = path.filter((id) => nodes.get(id).metadata?.cinatra?.purpose === "list-picker-gate-content");
    assert.equal(hands.length, 1, "the refresh path does not hand the new lists to the picker");
    assert.ok(path.indexOf(reads[0]) < path.indexOf(hands[0]), "the lists are handed before they are read");
  });

  it("a pick never takes the refresh branch", () => {
    const pick = JSON.stringify({ type: "list", listIds: ["view-a"], listNames: ["A"], snapshotAt: "x" });
    assert.equal(Object.hasOwn(branch.mapping, pick), false);
  });

  describe("the component's Try again, as the hosts read it", () => {
    before(async () => {
      const { JSDOM } = await import("jsdom");
      dom = new JSDOM("<!doctype html><html><body></body></html>");
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      React = await import("react");
      act = React.act;
      ({ createRoot } = await import("react-dom/client"));
      Renderer = (await import(ENTRY_URL.href)).default;
    });

    after(() => {
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      dom?.window.close();
    });

    it("a press with the declared params writes what the hosts send as the declared refresh, and Continue stays unavailable", async () => {
      for (const listsRead of ["ok", "failed"]) {
        const view = await mount({ value: { lists: [], listsRead }, bindingParams: LIST_PICKER_BINDING.params });
        try {
          const button = view.container.querySelector('[data-testid="list-picker-try-again"]');
          assert.ok(button, `${listsRead}: no Try again`);
          assert.equal(button.getAttribute("type"), "button", "Try again would submit a form");
          await click(button);
          assert.equal(view.writes.length, 1, `${listsRead}: one press writes ${view.writes.length} times`);
          const refresh = hostRefreshRequest(LIST_PICKER_BINDING.id, reviewTaskId, view.writes[0]);
          assert.equal(refresh, declared, `${listsRead}: the hosts read no refresh of the declared value`);
          const resume = hostServerResumeText({
            xRenderer: LIST_PICKER_BINDING.id,
            reviewTaskId,
            gateFields: gateFields(),
            declared,
            payload: hostRefreshPayload(refresh),
          });
          assert.equal(branch.branches.includes(branch.mapping[resume]), true, `${listsRead}: the resume text takes no branch`);
          assert.notEqual(branch.mapping[resume], "default");
          assert.equal(hostLiftListPicker(view.writes[0], "x"), null, `${listsRead}: the press lifts as a pick`);
          assert.deepEqual(view.reports, [false], `${listsRead}: Continue becomes available`);
        } finally {
          await view.unmount();
        }
      }
    });
  });
});
