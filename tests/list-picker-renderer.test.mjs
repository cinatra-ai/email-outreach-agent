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
