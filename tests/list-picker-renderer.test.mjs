// The list step's component, mounted (cinatra-ai/cinatra#3562).
//
// The account scope step shows the CRM's lists that the step before it read
// (`{ lists: [{ id, name }], listsRead }`, the content the recipient selection
// flow hands the picker). The component draws one checkbox row per list,
// nothing ticked, and reports through `onValidityChange` whether its value may
// be sent: `false` while nothing is ticked, so the application keeps the step's
// Continue unavailable, and `true` from the first tick. Each tick or untick
// writes `{ listIds, listNames }` in the order ticked. With no list to pick it
// draws the empty-state message the binding declared, and no row and no link.
//
// The arms mount the component in a document (react-dom and jsdom are dev
// dependencies of this package) and record every write and every report.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ENTRY_URL = new URL("../src/renderers/list-picker.ts", import.meta.url);

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

  it("an empty list draws the declared message, no row and no link, and holds the step", async () => {
    const view = await mount({ value: { lists: [], listsRead: "ok" } });
    try {
      assert.equal(boxes(view.container).length, 0);
      assert.equal(view.container.querySelectorAll("a, [href]").length, 0);
      const status = view.container.querySelector('[role="status"]');
      assert.equal(status?.textContent, PARAMS.emptyState);
      assert.deepEqual(view.writes, []);
      assert.deepEqual(view.reports, [false]);
    } finally {
      await view.unmount();
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
