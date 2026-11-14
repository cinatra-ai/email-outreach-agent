// The lists the list step offers, read from the step's content
// (cinatra-ai/cinatra#3562). Zero-dependency apart from the component's own
// `react` import; runs under tests/run.mjs.
//
// The step before the gate hands the picker `{ lists: [{ id, name }], listsRead }`.
// The component offers a row only for a list read that reports `listsRead: "ok"`,
// and only for an entry with an id and a name that are both non-blank texts. A
// failed or unreported read offers no row, so nothing is selectable and the
// step draws its empty-state message; an entry without a usable name is no row,
// so no checkbox is drawn without a label.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const ENTRY_URL = new URL("../src/renderers/list-picker.ts", import.meta.url);

let offeredLists;

describe("the lists the list step offers", () => {
  before(async () => {
    ({ offeredLists } = await import(ENTRY_URL.href));
    assert.equal(typeof offeredLists, "function", "the module exports no offeredLists");
  });

  it("offers the lists of a read that reports ok, in order", () => {
    const value = { lists: [{ id: "a", name: "A" }, { id: "b", name: "B" }], listsRead: "ok" };
    assert.deepEqual(offeredLists(value), value.lists);
    assert.deepEqual(offeredLists(JSON.stringify(value)), value.lists);
  });

  it("offers no list when the read failed, whatever lists the content carries", () => {
    assert.deepEqual(offeredLists({ lists: [{ id: "x", name: "X" }], listsRead: "failed" }), []);
    assert.deepEqual(offeredLists(JSON.stringify({ lists: [{ id: "x", name: "X" }], listsRead: "failed" })), []);
  });

  it("offers no list when the read reports no outcome or an unknown one", () => {
    for (const listsRead of [undefined, null, "", "OK", "partial", true, 1]) {
      const value = listsRead === undefined ? { lists: [{ id: "x", name: "X" }] } : { lists: [{ id: "x", name: "X" }], listsRead };
      assert.deepEqual(offeredLists(value), [], `listsRead ${JSON.stringify(listsRead)} offers a list`);
    }
  });

  it("offers no row for an entry whose name is blank or not a text", () => {
    const lists = [
      { id: "blank", name: "" },
      { id: "spaces", name: "   " },
      { id: "missing" },
      { id: "number", name: 7 },
      { id: "null", name: null },
      { id: "kept", name: "Kept" },
    ];
    assert.deepEqual(offeredLists({ lists, listsRead: "ok" }), [{ id: "kept", name: "Kept" }]);
  });

  it("an id refused for its name does not hide a later entry with the same id and a name", () => {
    const lists = [{ id: "a", name: "" }, { id: "a", name: "A" }];
    assert.deepEqual(offeredLists({ lists, listsRead: "ok" }), [{ id: "a", name: "A" }]);
  });
});
