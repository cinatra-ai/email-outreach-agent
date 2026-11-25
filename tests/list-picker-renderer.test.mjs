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
// the step's one failed-read alert), no row and no link, and Try again when the
// host offers a new read (`onRequestRefresh`): a press draws the loading
// reading, then the new read in place of the value, and answers nothing.
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

/** The failed read the host hands back (`listsRead: "failed"`, no list). */
const FAILED = { lists: [], listsRead: "failed" };

/** A promise and its resolve, to hold a new read pending. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    const view = await mount({ value: { lists: [], listsRead: "ok" }, onRequestRefresh: async () => FAILED });
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
      const view = await mount({ value, onRequestRefresh: async () => FAILED });
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

  it("a press calls onRequestRefresh once, never onChange, and draws the loading reading while it waits", async () => {
    const pending = deferred();
    let calls = 0;
    const view = await mount({
      value: { lists: [], listsRead: "failed" },
      onRequestRefresh: () => {
        calls += 1;
        return pending.promise;
      },
    });
    try {
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      assert.equal(calls, 1);
      assert.ok(view.container.querySelector('[data-testid="list-picker-loading"]'), "no loading reading");
      assert.equal(view.container.querySelector('[role="alert"]'), null, "the failed reading stays while reading");
      assert.equal(view.container.querySelector('[data-testid="list-picker-try-again"]'), null, "Try again stays while reading");
      assert.equal(
        view.container.firstElementChild?.getAttribute("data-conformance-id"),
        "run-list-step-multi-pick",
      );
      await act(async () => {
        pending.resolve({ lists: LISTS, listsRead: "ok" });
      });
      assert.equal(calls, 1);
      assert.deepEqual(view.writes, [], "the press or the new read is written");
      assert.equal(view.container.querySelector('[data-testid="list-picker-loading"]'), null);
    } finally {
      await view.unmount();
    }
  });

  it("the rows of an ok read appear in place, and Continue stays unavailable until a list is ticked", async () => {
    const view = await mount({
      value: { lists: [], listsRead: "ok" },
      onRequestRefresh: async () => ({ lists: LISTS, listsRead: "ok" }),
    });
    try {
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      assert.deepEqual(
        [...view.container.querySelectorAll('[data-testid="list-picker-row-title"]')].map((title) => title.textContent),
        LISTS.map((list) => list.name),
      );
      assert.ok(boxes(view.container).every((box) => box.checked === false), "a row is ticked for the reader");
      assert.deepEqual(view.writes, []);
      assert.deepEqual(view.reports, [false]);
      await click(boxes(view.container)[2]);
      assert.deepEqual(view.writes, [{ listIds: ["view-c"], listNames: ["Newsletter"] }]);
      assert.deepEqual(view.reports, [false, true]);
    } finally {
      await view.unmount();
    }
  });

  it("a failed, rejected or malformed read draws the failed reading with Try again still offered", async () => {
    const results = {
      failed: () => Promise.resolve(FAILED),
      rejected: () => Promise.reject(new Error("no read")),
      "no object": () => Promise.resolve(null),
      "no outcome": () => Promise.resolve({ lists: LISTS }),
    };
    for (const [label, onRequestRefresh] of Object.entries(results)) {
      const view = await mount({ value: { lists: [], listsRead: "ok" }, onRequestRefresh });
      try {
        await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
        const alert = view.container.querySelector('[role="alert"]');
        assert.ok(alert, `${label}: no failed reading`);
        assert.equal(alert.textContent.includes("This list could not be read."), true, label);
        assert.ok(alert.querySelector('[data-testid="list-picker-try-again"]'), `${label}: no Try again`);
        assert.equal(boxes(view.container).length, 0, label);
        assert.deepEqual(view.writes, [], label);
        assert.deepEqual(view.reports, [false], label);
      } finally {
        await view.unmount();
      }
    }
  });

  it("offers no Try again without onRequestRefresh, on a read-only reading, or when disabled", async () => {
    const offer = async () => ({ lists: LISTS, listsRead: "ok" });
    const readings = [
      {},
      { onRequestRefresh: "not a function" },
      { mode: "view", onRequestRefresh: offer },
      { disabled: true, onRequestRefresh: offer },
    ];
    for (const reading of readings) {
      for (const listsRead of ["ok", "failed"]) {
        const view = await mount({ value: { lists: [], listsRead }, ...reading });
        try {
          assert.equal(view.container.querySelector('[data-testid="list-picker-try-again"]'), null, JSON.stringify(reading));
          assert.deepEqual(view.writes, []);
        } finally {
          await view.unmount();
        }
      }
    }
  });

  it("offers no Try again while there are lists to pick", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh: async () => FAILED });
    try {
      assert.equal(view.container.querySelector('[data-testid="list-picker-try-again"]'), null);
    } finally {
      await view.unmount();
    }
  });

  it("a second press while a read is pending does nothing", async () => {
    const pending = deferred();
    let calls = 0;
    const view = await mount({
      value: { lists: [], listsRead: "failed" },
      onRequestRefresh: () => {
        calls += 1;
        return pending.promise;
      },
    });
    try {
      const button = view.container.querySelector('[data-testid="list-picker-try-again"]');
      // The same button pressed twice before the step draws again.
      await act(async () => {
        button.click();
        button.click();
      });
      assert.equal(calls, 1);
      await click(button);
      assert.equal(calls, 1);
      await act(async () => {
        pending.resolve({ lists: LISTS, listsRead: "ok" });
      });
      assert.equal(calls, 1);
      assert.equal(boxes(view.container).length, 3);
    } finally {
      await view.unmount();
    }
  });

  it("a ticked list the new read no longer offers is dropped and the pick without it is written", async () => {
    let onRequestRefresh = async () => ({ lists: [LISTS[0], { id: "view-d", name: "Partners" }], listsRead: "ok" });
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh });
    try {
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[1]);
      assert.deepEqual(view.writes.at(-1), { listIds: ["view-a", "view-b"], listNames: ["Customers in Berlin", "Trade fair leads"] });
      assert.equal(view.reports.at(-1), true);
      // The step is drawn again with a failed read, then Try again reads anew.
      await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh });
      assert.equal(view.reports.at(-1), false);
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      assert.deepEqual(view.writes.at(-1), { listIds: ["view-a"], listNames: ["Customers in Berlin"] });
      assert.equal(view.writes.length, 3, "the drop is not written once");
      assert.deepEqual(boxes(view.container).map((box) => box.checked), [true, false]);
      assert.equal(view.reports.at(-1), true);
    } finally {
      await view.unmount();
    }
  });

  /** Ticks two lists, draws the step again with a failed read, then presses Try again for `next`. */
  async function rereadAfterTicks(next) {
    const onRequestRefresh = async () => next;
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh });
    await click(boxes(view.container)[1]);
    await click(boxes(view.container)[0]);
    await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh });
    const before = view.writes.length;
    await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
    return { view, after: view.writes.slice(before) };
  }

  it("a new read that renames a ticked list writes the pick with the new name once", async () => {
    const renamed = { id: "view-a", name: "Customers in Berlin and Potsdam" };
    const { view, after } = await rereadAfterTicks({ lists: [renamed, LISTS[1], LISTS[2]], listsRead: "ok" });
    try {
      assert.deepEqual(after, [
        { listIds: ["view-b", "view-a"], listNames: ["Trade fair leads", "Customers in Berlin and Potsdam"] },
      ]);
      assert.deepEqual(boxes(view.container).map((box) => box.checked), [true, true, false]);
    } finally {
      await view.unmount();
    }
  });

  it("a new read that changes nothing about the pick writes nothing", async () => {
    const { view, after } = await rereadAfterTicks({
      lists: [LISTS[2], LISTS[0], { id: "view-d", name: "Partners" }, LISTS[1]],
      listsRead: "ok",
    });
    try {
      assert.deepEqual(after, []);
      assert.equal(boxes(view.container).length, 4);
    } finally {
      await view.unmount();
    }
  });

  it("a new read that renames one ticked list and drops the other writes once", async () => {
    const { view, after } = await rereadAfterTicks({ lists: [{ id: "view-a", name: "Berlin customers" }], listsRead: "ok" });
    try {
      assert.deepEqual(after, [{ listIds: ["view-a"], listNames: ["Berlin customers"] }]);
      assert.equal(view.reports.at(-1), true);
    } finally {
      await view.unmount();
    }
  });

  it("a failed, rejected or malformed new read keeps the pick, writes nothing and holds Continue; a later ok read reconciles", async () => {
    const failures = {
      failed: () => Promise.resolve(FAILED),
      rejected: () => Promise.reject(new Error("no read")),
      malformed: () => Promise.resolve({ lists: LISTS }),
    };
    for (const [label, fail] of Object.entries(failures)) {
      for (const [ending, okRead, expected] of [
        ["still offered", { lists: LISTS, listsRead: "ok" }, []],
        ["gone", { lists: [LISTS[0]], listsRead: "ok" }, [{ listIds: [], listNames: [] }]],
      ]) {
        const reads = [fail, () => Promise.resolve(okRead)];
        const onRequestRefresh = () => reads.shift()();
        const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh });
        try {
          await click(boxes(view.container)[1]);
          assert.deepEqual(view.writes, [{ listIds: ["view-b"], listNames: ["Trade fair leads"] }]);
          await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh });
          await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
          assert.equal(view.writes.length, 1, `${label}: the failed read wrote ${JSON.stringify(view.writes.slice(1))}`);
          assert.equal(view.reports.at(-1), false, `${label}: Continue is available on a failed reading`);
          const alert = view.container.querySelector('[role="alert"]');
          assert.ok(alert, `${label}: no failed reading`);
          assert.ok(alert.querySelector('[data-testid="list-picker-try-again"]'), `${label}: no Try again`);
          await click(alert.querySelector('[data-testid="list-picker-try-again"]'));
          assert.deepEqual(view.writes.slice(1), expected, `${label}, ${ending}: the writes after an ok read`);
          if (ending === "still offered") {
            assert.deepEqual(boxes(view.container).map((box) => box.checked), [false, true, false], `${label}: the pick is lost`);
            assert.equal(view.reports.at(-1), true, `${label}: Continue stays unavailable with a pick`);
          } else {
            assert.deepEqual(boxes(view.container).map((box) => box.checked), [false]);
            assert.equal(view.reports.at(-1), false);
          }
        } finally {
          await view.unmount();
        }
      }
    }
  });

  it("a failed value drawn on a step that holds a pick never clears it", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[2]);
      await view.rerender({ value: { lists: [], listsRead: "failed" } });
      assert.equal(view.reports.at(-1), false);
      await view.rerender({ value: { lists: LISTS, listsRead: "ok" } });
      assert.deepEqual(view.writes, [{ listIds: ["view-c"], listNames: ["Newsletter"] }]);
      assert.deepEqual(boxes(view.container).map((box) => box.checked), [false, false, true]);
      assert.equal(view.reports.at(-1), true);
    } finally {
      await view.unmount();
    }
  });

  it("a new value from the host that no longer offers a ticked list drops it and writes once, and only once", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[1]);
      const before = view.writes.length;
      await view.rerender({ value: { lists: [LISTS[0]], listsRead: "ok" } });
      assert.deepEqual(view.writes.slice(before), [{ listIds: ["view-a"], listNames: ["Customers in Berlin"] }]);
      assert.deepEqual(boxes(view.container).map((box) => box.checked), [true]);
      assert.equal(view.reports.at(-1), true, "one pick meets the floor of one");
      // The host draws the step again with the same value (a new object): nothing more.
      await view.rerender({ value: { lists: [{ ...LISTS[0] }], listsRead: "ok" } });
      await view.rerender({ value: JSON.stringify({ lists: [LISTS[0]], listsRead: "ok" }) });
      assert.equal(view.writes.length, before + 1, "a second write for the same value");
    } finally {
      await view.unmount();
    }
  });

  it("a new value that drops a ticked list under a floor of two reports the value unsendable", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, bindingParams: { ...PARAMS, minSelected: 2 } });
    try {
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[1]);
      assert.equal(view.reports.at(-1), true);
      await view.rerender({ value: { lists: [LISTS[0], LISTS[2]], listsRead: "ok" }, bindingParams: { ...PARAMS, minSelected: 2 } });
      assert.deepEqual(view.writes.at(-1), { listIds: ["view-a"], listNames: ["Customers in Berlin"] });
      assert.equal(view.reports.at(-1), false);
    } finally {
      await view.unmount();
    }
  });

  it("a new value that renames a ticked list writes the new name once", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[0]);
      const before = view.writes.length;
      const renamed = [{ id: "view-a", name: "Berlin customers" }, LISTS[1], LISTS[2]];
      await view.rerender({ value: { lists: renamed, listsRead: "ok" } });
      await view.rerender({ value: { lists: renamed, listsRead: "ok" } });
      assert.deepEqual(view.writes.slice(before), [{ listIds: ["view-a"], listNames: ["Berlin customers"] }]);
    } finally {
      await view.unmount();
    }
  });

  it("a new value on a read-only or disabled step writes nothing, and a failed value keeps the pick", async () => {
    for (const lock of [{ mode: "view" }, { disabled: true }]) {
      const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
      try {
        await click(boxes(view.container)[0]);
        await click(boxes(view.container)[1]);
        const before = view.writes.length;
        await view.rerender({ value: { lists: [LISTS[0]], listsRead: "ok" }, ...lock });
        assert.equal(view.writes.length, before, `${JSON.stringify(lock)}: a write on a locked step`);
      } finally {
        await view.unmount();
      }
    }
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[0]);
      const before = view.writes.length;
      await view.rerender({ value: { lists: [], listsRead: "failed" } });
      await view.rerender({ value: { lists: LISTS } });
      assert.equal(view.writes.length, before, "a failed value wrote");
      await view.rerender({ value: { lists: LISTS, listsRead: "ok" } });
      assert.equal(view.writes.length, before, "an ok value that still offers the pick wrote");
      assert.deepEqual(boxes(view.container).map((box) => box.checked), [true, false, false]);
    } finally {
      await view.unmount();
    }
  });

  it("a step that becomes writable again reconciles a pick that a new value made stale while it was locked", async () => {
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" } });
    try {
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[1]);
      const before = view.writes.length;
      await view.rerender({ value: { lists: [LISTS[1]], listsRead: "ok" }, disabled: true });
      assert.equal(view.writes.length, before);
      await view.rerender({ value: { lists: [LISTS[1]], listsRead: "ok" } });
      assert.deepEqual(view.writes.slice(before), [{ listIds: ["view-b"], listNames: ["Trade fair leads"] }]);
    } finally {
      await view.unmount();
    }
  });

  it("the first value writes nothing: no pick is held yet", async () => {
    for (const value of [{ lists: LISTS, listsRead: "ok" }, { lists: [], listsRead: "ok" }, FAILED]) {
      const view = await mount({ value });
      try {
        assert.deepEqual(view.writes, []);
        assert.deepEqual(view.reports, [false]);
      } finally {
        await view.unmount();
      }
    }
  });

  it("a new value from the host replaces a read made on Try again", async () => {
    const onRequestRefresh = async () => ({ lists: LISTS, listsRead: "ok" });
    const view = await mount({ value: FAILED, onRequestRefresh });
    try {
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[2]);
      const before = view.writes.length;
      await view.rerender({ value: { lists: [LISTS[2]], listsRead: "ok" }, onRequestRefresh });
      assert.deepEqual(
        [...view.container.querySelectorAll('[data-testid="list-picker-row-title"]')].map((t) => t.textContent),
        ["Newsletter"],
      );
      assert.deepEqual(view.writes.slice(before), [{ listIds: ["view-c"], listNames: ["Newsletter"] }]);
    } finally {
      await view.unmount();
    }
  });

  it("a read that ends after the step is gone sets nothing", async () => {
    const pending = deferred();
    const errors = [];
    const original = console.error;
    console.error = (...args) => void errors.push(args.join(" "));
    try {
      const onRequestRefresh = () => pending.promise;
      const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh });
      await click(boxes(view.container)[1]);
      await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh });
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      const writesBefore = view.writes.length;
      const reportsBefore = view.reports.length;
      await view.unmount();
      // A read that no longer offers the ticked list would drop it and write
      // the pick without it, were the step still drawn.
      await act(async () => {
        pending.resolve({ lists: [LISTS[0]], listsRead: "ok" });
      });
      assert.equal(view.writes.length, writesBefore, "a write after the step is gone");
      assert.equal(view.reports.length, reportsBefore, "a report after the step is gone");
      assert.deepEqual(errors, []);
    } finally {
      console.error = original;
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

  it("reopened on a completed step, draws a legacy single-list scope as one row in every placement", async () => {
    const legacy = { type: "list", listId: "L", listName: "Prospects" };
    const readings = {
      "the scope": legacy,
      "the scope as JSON text": JSON.stringify(legacy),
      "the scope under approvalNote": { approved: true, approvalNote: legacy },
      "the scope as JSON text under approvalNote": { approved: true, approvalNote: JSON.stringify(legacy) },
    };
    for (const [label, value] of Object.entries(readings)) {
      const view = await mount({ value, mode: "view", disabled: true });
      try {
        assert.equal(view.container.querySelector('[role="alert"]'), null, `${label}: the failed-read alert`);
        const titles = [...view.container.querySelectorAll('[data-testid="list-picker-row-title"]')].map((t) => t.textContent);
        const details = [...view.container.querySelectorAll('[data-testid="list-picker-row-detail"]')].map((d) => d.textContent);
        assert.deepEqual(titles, ["Prospects"], `${label}: the title`);
        assert.deepEqual(details, ["L"], `${label}: the detail line`);
        const ticks = boxes(view.container);
        assert.equal(ticks.length, 1, label);
        assert.equal(ticks[0].checked && ticks[0].disabled, true, `${label}: ticked and disabled`);
      } finally {
        await view.unmount();
      }
    }
  });

  it("reopened on a completed step, a legacy scope with a blank name is titled by its id", async () => {
    const view = await mount({ value: { type: "list", listId: "L", listName: " " }, mode: "view" });
    try {
      assert.deepEqual(
        [...view.container.querySelectorAll('[data-testid="list-picker-row-title"]')].map((t) => t.textContent),
        ["L"],
      );
    } finally {
      await view.unmount();
    }
  });

  it("reopened on a completed step, a recorded answer with no readable pick is never the failed-read alert", async () => {
    for (const value of [
      { type: "list" },
      { type: "list", listId: "" },
      { approved: true, approvalNote: "not json" },
      { approved: true, approvalNote: { type: "list", listIds: [] } },
    ]) {
      const view = await mount({ value, mode: "view" });
      try {
        assert.equal(view.container.querySelector('[role="alert"]'), null, JSON.stringify(value));
        assert.equal(view.container.textContent.includes("No list was picked on this step."), true, JSON.stringify(value));
        assert.equal(boxes(view.container).length, 0);
      } finally {
        await view.unmount();
      }
    }
  });

  it("a lock that arrives while a read is pending takes nothing from it: no write and no redraw", async () => {
    for (const lock of [{ disabled: true }, { mode: "view" }]) {
      const pending = deferred();
      const onRequestRefresh = () => pending.promise;
      const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh });
      try {
        await click(boxes(view.container)[1]);
        await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh });
        await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
        const writesBefore = view.writes.length;
        await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh, ...lock });
        // The read no longer offers the ticked list: unlocked, it would drop it and write.
        await act(async () => {
          pending.resolve({ lists: [LISTS[0], { id: "view-d", name: "Partners" }], listsRead: "ok" });
        });
        assert.equal(view.writes.length, writesBefore, `${JSON.stringify(lock)}: a write after the lock`);
        assert.equal(view.container.querySelector('[data-testid="list-picker-loading"]'), null, `${JSON.stringify(lock)}: still loading`);
        assert.equal(view.container.textContent.includes("Partners"), false, `${JSON.stringify(lock)}: the read is drawn`);
        assert.equal(view.container.querySelector('[role="alert"]') !== null, true, `${JSON.stringify(lock)}: the step does not draw as before`);
      } finally {
        await view.unmount();
      }
    }
  });

  it("after a re-render, the write that drops a vanished list goes to the current onChange", async () => {
    const pending = deferred();
    const onRequestRefresh = () => pending.promise;
    const first = [];
    const current = [];
    const view = await mount({ value: { lists: LISTS, listsRead: "ok" }, onRequestRefresh, onChange: (v) => void first.push(v) });
    try {
      await click(boxes(view.container)[0]);
      await click(boxes(view.container)[1]);
      await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh, onChange: (v) => void first.push(v) });
      await click(view.container.querySelector('[data-testid="list-picker-try-again"]'));
      await view.rerender({ value: { lists: [], listsRead: "failed" }, onRequestRefresh, onChange: (v) => void current.push(v) });
      const firstBefore = first.length;
      await act(async () => {
        pending.resolve({ lists: [LISTS[0]], listsRead: "ok" });
      });
      assert.equal(first.length, firstBefore, "the onChange of the press was called");
      assert.deepEqual(current, [{ listIds: ["view-a"], listNames: ["Customers in Berlin"] }]);
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

// THE HOST'S LIFT, AS A COPY OF ITS CONTRACT (finding: "the renderer emits
// { listIds, listNames } and not the gate's string scope with type: "list"").
//
// What this proves, and what it does not. The component writes
// `{ listIds, listNames }`; the gate's answer is what the host makes of it on
// Continue. This package cannot import the host (an extension never imports
// it), so it cannot test against the host's real code. The fixture below is a
// hand copy of the several-picks branch of `liftRendererApprovalNote` in
// cinatra-ai/cinatra packages/agents/src/hitl-gate-submit.ts (with its
// `isUsableListId`) and of the resume-text choice in
// packages/agents/src/review-task-actions.ts (the note is the resume text),
// as they read at cinatra-ai/cinatra main 074655082f6f (hitl-gate-submit.ts last
// changed in fa2332384). It proves that this component's writes fit that
// copy, nothing more: a later change in the host is not seen here. The real
// path is tested in the host: cinatra-ai/cinatra#4797's
// packages/agents/src/__tests__/agentic-run-panel.list-step-refresh-3562.test.tsx
// ("the prop reaches a pack-shipped component through the registry"), with the
// stepper and standalone-card tests beside it, resolves a pack-shipped
// component through the real field renderer registry.
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
});
