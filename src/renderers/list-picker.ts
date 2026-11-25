"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";

// The list step's own component (cinatra-ai/cinatra#3562). The
// `@cinatra-ai/email-outreach-agent:list-picker` binding names this module as
// its `component.entry`, so the application mounts it for the account scope
// step and hands it the binding's declared params.
//
// WHAT IT READS. The step before the gate hands the picker the CRM's lists as
// `{ lists: [{ id, name }], listsRead }` (the recipient selection flow's
// `emit_lists` step). The value may arrive as that object or as its JSON text.
// It offers rows only when the read reports `listsRead: "ok"`: a failed read,
// or one that reports no outcome or another one, offers no row, so nothing is
// selectable. A read that reports `ok` with no row draws the declared
// empty-state message; any other read draws the step's one failed-read alert
// (design specs/app-artifact-review.html I.1). An entry is a row only
// when its id and its name are both texts that are not blank; an id given twice
// is one row, the first that is a row.
//
// WHAT IT WRITES. One checkbox row per list, nothing ticked for the reader.
// Each row is titled by the list's name over its detail line, the list's CRM
// id, so two lists that share a name are told apart (design I.1).
// Each tick or untick writes `{ listIds, listNames }`, the ticked lists in the
// order they were ticked, with their names in the same order. Unticking the
// last row writes both arrays empty.
//
// THE GATE'S ANSWER IS THE HOST'S LIFT OF THIS WRITE, NOT THE WRITE ITSELF. The
// gate (`recipients-scope_gate`, cinatra/oas.json) declares `accountScope` as a
// string, and the generation step reads that string as JSON and refuses any
// scope without `type: "list"`. This component does not write that string: the
// host does. On Continue, the host's `liftRendererApprovalNote`
// (cinatra-ai/cinatra packages/agents/src/hitl-gate-submit.ts) turns a
// `:list-picker` buffer's `{ listIds, listNames }` into the approval note
// `JSON.stringify({ type: "list", listIds, listNames, snapshotAt })` (each id
// once, blank ids dropped), and that note is the resume text the gate receives
// (review-task-actions.ts). So `{ listIds, listNames }` is the shape the host
// reads; do not write the string here. tests/list-picker-renderer.test.mjs
// reproduces the lift and checks its result against the gate and the generation.
//
// THE RECOVERY. With no row to pick (an empty read or a failed one) the run
// would wait on this step for good, because nothing can be ticked. When the
// binding declares `refreshValue`, the step draws Try again; a press writes
// `{ listIds: [], listNames: [], refresh: <refreshValue> }`. The declared value
// ("refresh") is the answer the flow's `recipients-scope_branch` maps to its
// `refresh` branch, which reads the CRM's lists again and comes back to this
// step. The empty `listIds` keep the host's pick check false, so the press is
// never sent as a pick, and the report stays `false`, so Continue stays
// unavailable (design I.1: "The Continue stays unavailable").
//
// WHAT IT REPORTS. Through `onValidityChange` (props contract 1, an optional
// prop): `false` while fewer lists are ticked than the declared `minSelected`
// (one when not declared), and also when there is no list to pick; `true` once
// enough are ticked. While the report is `false` the application keeps the
// step's Continue unavailable. It reports when the reading opens and again only
// when the answer changes.
//
// IT WRITES AND REPORTS ONLY WHILE THE RUN WAITS ON THE STEP: `mode` absent or
// exactly "edit", and `disabled` absent or exactly false. On any other reading
// (a read-only replay, a locked step) it writes nothing, reports nothing and a
// click ticks nothing.
//
// WITH NO LIST TO PICK it draws the empty-state message the binding declared,
// as declared (or, for a failed read, its one failed-read alert), no row and
// no link, and Try again when the binding declares a refresh value.
//
// A COMPLETED STEP, REOPENED. On `mode="view"` the value may be the step's
// recorded answer rather than its input: the write `{ listIds, listNames }`,
// the host's lifted note `{ type: "list", listIds, listNames, snapshotAt }`, or
// the recorded Continue values that carry that note as JSON text under
// `approvalNote` (cinatra-ai/cinatra packages/agents/src/orchestrator-stepper-panel.tsx
// ReadOnlyHitlReplay hands the recorded values as they are). Any of them may
// arrive as JSON text. The step then draws the recorded picks as read-only
// rows, ticked, each titled by its name, or by its id when the name is blank,
// over its id as the detail line; it
// never draws the failed-read alert or Try again for a recorded answer. The
// design (specs/app-artifact-review.html I.1) draws no separate completed
// state, so the rows keep the pick's own markup with the inputs disabled.
//
// The root element carries `data-conformance-id="run-list-step-multi-pick"`,
// the design example this step implements, for the shared UI grader.
//
// The module is plain `.ts` written with `createElement` and imports nothing but
// `react`, so this package's own test runner loads it as it is.

/** The props the application hands a field renderer (props contract 1), as far as this step reads them. */
export type ListPickerProps = {
  value?: unknown;
  onChange: (next: unknown) => unknown;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  mode?: "edit" | "view";
  bindingParams?: Readonly<Record<string, unknown>>;
};

/** One list the step offers. */
export type OfferedList = { id: string; name: string };

const WAITING_WORDS = "Awaiting your picks";

/** What the step says with no list to pick when the binding declared no message. */
const NOTHING_TO_PICK_READING = "There is no list to pick on this step yet.";

/** The step's one message for a failed list read (design I.1, run-list-step-error). */
const FAILED_READ_READING = "This list could not be read.";

const TRY_AGAIN_WORDS = "Try again";

/** What a reopened step says when its recorded answer holds no pick. */
const NOTHING_PICKED_READING = "No list was picked on this step.";

/** The design example this component implements (design specs/app-artifact-review.html I.1). */
export const CONFORMANCE_ID = "run-list-step-multi-pick";

/** The step's content as an object (it may arrive as its JSON text), else null. */
function readContent(value: unknown): { lists?: unknown; listsRead?: unknown } | null {
  let content = value;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (content === null || typeof content !== "object" || Array.isArray(content)) return null;
  return content as { lists?: unknown; listsRead?: unknown };
}

/** A value read as an object (JSON text is parsed), else null. */
function objectOf(value: unknown): Record<string, unknown> | null {
  let content = value;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (content === null || typeof content !== "object" || Array.isArray(content)) return null;
  return content as Record<string, unknown>;
}

/**
 * The picks a recorded answer holds, in their order, else null when the value
 * is no recorded answer. A recorded answer is an object with a `listIds` array
 * (the write, or the host's lifted note), or one whose `approvalNote` is such
 * an object or its JSON text. Each usable id counts once; its name is the
 * recorded name at the same place, or the id when that name is blank.
 */
export function recordedPicks(value: unknown): OfferedList[] | null {
  const outer = objectOf(value);
  if (outer === null) return null;
  const answer = Array.isArray(outer.listIds) ? outer : objectOf(outer.approvalNote);
  if (answer === null || !Array.isArray(answer.listIds)) return null;
  const names = Array.isArray(answer.listNames) ? answer.listNames : [];
  const seen = new Set<string>();
  const picks: OfferedList[] = [];
  (answer.listIds as unknown[]).forEach((id, index) => {
    if (typeof id !== "string" || id.trim().length === 0 || seen.has(id)) return;
    seen.add(id);
    const name = names[index];
    picks.push({ id, name: typeof name === "string" && name.trim().length > 0 ? name : id });
  });
  return picks;
}

/** Whether the step's content reports a list read that succeeded (`listsRead: "ok"`). */
export function readSucceeded(value: unknown): boolean {
  const content = readContent(value);
  return content !== null && content.listsRead === "ok" && Array.isArray(content.lists);
}

/** The lists the step's content offers, in its order. */
export function offeredLists(value: unknown): OfferedList[] {
  if (!readSucceeded(value)) return [];
  const lists = readContent(value)?.lists as unknown[];
  const seen = new Set<string>();
  const offered: OfferedList[] = [];
  for (const entry of lists as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id.trim().length === 0 || seen.has(id)) continue;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    seen.add(id);
    offered.push({ id, name });
  }
  return offered;
}

/** A declared param that is a string and not blank, else null. */
function declaredWords(params: ListPickerProps["bindingParams"], key: string): string | null {
  const words = params?.[key];
  return typeof words === "string" && words.trim() !== "" ? words : null;
}

/** The declared floor of picks: a positive integer, else one. */
function declaredFloor(params: ListPickerProps["bindingParams"]): number {
  const floor = params?.minSelected;
  return typeof floor === "number" && Number.isInteger(floor) && floor >= 1 ? floor : 1;
}

const ROW_CLASSES =
  "flex cursor-pointer gap-2.5 rounded-lg border border-line bg-surface-strong px-3 py-2.5";
const CHECKBOX_CLASSES = "mt-[3px] size-3.5 flex-none accent-primary";
const TRY_AGAIN_CLASSES =
  "flex-none rounded-md border border-line bg-surface-strong px-3 py-1 text-xs font-semibold text-foreground";

/**
 * A row's words: the list's name as its title, over the row's detail line
 * (design specs/app-artifact-review.html I.1: "each row carrying the title the
 * declaration binds over the entry's own detail line"). The detail line is the
 * list's CRM id, the one fact the read hands the step that no two lists share,
 * so two lists with the same name are told apart by it.
 */
function rowWords(list: OfferedList) {
  return createElement(
    "span",
    { className: "min-w-0 flex-1" },
    createElement(
      "span",
      { className: "block font-sans text-[13px] font-bold text-foreground", "data-testid": "list-picker-row-title" },
      list.name,
    ),
    createElement(
      "span",
      {
        className: "mt-[5px] block break-all font-mono text-[10px] tracking-[0.04em] text-muted-foreground",
        "data-testid": "list-picker-row-detail",
      },
      list.id,
    ),
  );
}

/** The list step. */
export default function ListPickerRenderer(props: ListPickerProps) {
  const lists = offeredLists(props.value);
  const writes =
    (props.mode === undefined || props.mode === "edit") &&
    (props.disabled === undefined || props.disabled === false);
  const [ticked, setTicked] = useState<string[]>([]);
  const offeredIds = new Set(lists.map((list) => list.id));
  const tickedOffered = ticked.filter((id) => offeredIds.has(id));
  const valid = lists.length > 0 && tickedOffered.length >= declaredFloor(props.bindingParams);

  // Report on opening and whenever the answer changes; a new callback identity
  // from the application is no change.
  const report = useRef(props.onValidityChange);
  report.current = props.onValidityChange;
  useEffect(() => {
    if (writes) report.current?.(valid);
  }, [writes, valid]);

  const toggle = (id: string) => {
    if (!writes) return;
    const next = tickedOffered.includes(id)
      ? tickedOffered.filter((tickedId) => tickedId !== id)
      : [...tickedOffered, id];
    setTicked(next);
    const nameOf = new Map(lists.map((list) => [list.id, list.name]));
    void props.onChange({ listIds: next, listNames: next.map((tickedId) => nameOf.get(tickedId) ?? "") });
  };

  const question = declaredWords(props.bindingParams, "question");
  const waiting = props.mode !== "view";
  const header =
    question !== null || waiting
      ? createElement(
          "div",
          { className: "mb-2.5 flex flex-wrap items-center gap-2.5", "data-testid": "list-picker-gate-header" },
          question !== null
            ? createElement(
                "span",
                { className: "font-sans text-sm font-bold text-foreground", "data-testid": "list-picker-gate-question" },
                question,
              )
            : null,
          waiting
            ? createElement(
                "span",
                {
                  "data-testid": "list-picker-gate-waiting",
                  className:
                    "inline-flex items-center gap-1.5 rounded-full border border-brand-mustard/40 bg-brand-mustard/15 px-2.5 py-0.5 text-xs font-semibold text-mustard-ink",
                },
                createElement("span", { className: "size-[7px] rounded-full bg-brand-mustard", "aria-hidden": "true" }),
                WAITING_WORDS,
              )
            : null,
        )
      : null;

  const root = (...children: ReactNode[]) =>
    createElement("div", { "data-conformance-id": CONFORMANCE_ID, "data-testid": "list-picker-step" }, ...children);

  const recorded = props.mode === "view" ? recordedPicks(props.value) : null;
  if (recorded !== null) {
    if (recorded.length === 0) {
      return root(header, createElement("p", { role: "status", className: "text-sm text-foreground" }, NOTHING_PICKED_READING));
    }
    return root(
      header,
      createElement(
        "div",
        { className: "grid gap-2", role: "group", "aria-label": question ?? "Lists", "data-testid": "list-picker-recorded" },
        recorded.map((list) =>
          createElement(
            "label",
            { key: list.id, className: `${ROW_CLASSES} pointer-events-none opacity-60` },
            createElement("input", {
              type: "checkbox",
              className: CHECKBOX_CLASSES,
              checked: true,
              disabled: true,
              readOnly: true,
            }),
            rowWords(list),
          ),
        ),
      ),
    );
  }

  if (lists.length === 0) {
    const refreshValue = declaredWords(props.bindingParams, "refreshValue");
    const tryAgain =
      refreshValue !== null && writes
        ? createElement(
            "button",
            {
              type: "button",
              className: TRY_AGAIN_CLASSES,
              "data-testid": "list-picker-try-again",
              onClick: () => {
                if (!writes) return;
                void props.onChange({ listIds: [], listNames: [], refresh: refreshValue });
              },
            },
            TRY_AGAIN_WORDS,
          )
        : null;
    if (!readSucceeded(props.value)) {
      return root(
        header,
        createElement(
          "div",
          {
            role: "alert",
            "data-testid": "list-picker-read-failed",
            className: "flex items-start gap-2.5 rounded-lg border border-destructive bg-surface-strong px-3.5 py-3",
          },
          createElement("p", { className: "m-0 min-w-0 flex-1 text-sm text-foreground" }, FAILED_READ_READING),
          tryAgain,
        ),
      );
    }
    return root(
      header,
      createElement(
        "p",
        { role: "status", className: "text-sm text-foreground" },
        declaredWords(props.bindingParams, "emptyState") ?? NOTHING_TO_PICK_READING,
      ),
      tryAgain !== null ? createElement("div", { className: "mt-2.5 flex" }, tryAgain) : null,
    );
  }

  return root(
    header,
    createElement(
      "div",
      { className: "grid gap-2", role: "group", "aria-label": question ?? "Lists" },
      lists.map((list) =>
        createElement(
          "label",
          { key: list.id, className: `${ROW_CLASSES} ${writes ? "" : "pointer-events-none opacity-60"}` },
          createElement("input", {
            type: "checkbox",
            className: CHECKBOX_CLASSES,
            checked: tickedOffered.includes(list.id),
            disabled: !writes,
            onChange: () => toggle(list.id),
          }),
          rowWords(list),
        ),
      ),
    ),
  );
}
