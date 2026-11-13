"use client";

import { createElement, Fragment, useEffect, useRef, useState } from "react";

// The list step's own component (cinatra-ai/cinatra#3562). The
// `@cinatra-ai/email-outreach-agent:list-picker` binding names this module as
// its `component.entry`, so the application mounts it for the account scope
// step and hands it the binding's declared params.
//
// WHAT IT READS. The step before the gate hands the picker the CRM's lists as
// `{ lists: [{ id, name }], listsRead }` (the recipient selection flow's
// `emit_lists` step). The value may arrive as that object or as its JSON text.
// An entry without an id that is not blank is no row; an id given twice is one
// row, the first.
//
// WHAT IT WRITES. One checkbox row per list, nothing ticked for the reader.
// Each tick or untick writes `{ listIds, listNames }`, the ticked lists in the
// order they were ticked, with their names in the same order. Unticking the
// last row writes both arrays empty.
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
// as declared, and no row and no link.
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

/** The lists the step's content offers, in its order. */
export function offeredLists(value: unknown): OfferedList[] {
  let content = value;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return [];
    }
  }
  const lists =
    content !== null && typeof content === "object" && !Array.isArray(content)
      ? (content as { lists?: unknown }).lists
      : undefined;
  if (!Array.isArray(lists)) return [];
  const seen = new Set<string>();
  const offered: OfferedList[] = [];
  for (const entry of lists as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id.trim().length === 0 || seen.has(id)) continue;
    seen.add(id);
    offered.push({ id, name: typeof name === "string" ? name : "" });
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

  if (lists.length === 0) {
    return createElement(
      Fragment,
      null,
      header,
      createElement(
        "p",
        { role: "status", className: "text-sm text-foreground" },
        declaredWords(props.bindingParams, "emptyState") ?? NOTHING_TO_PICK_READING,
      ),
    );
  }

  return createElement(
    Fragment,
    null,
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
          createElement(
            "span",
            { className: "min-w-0 flex-1 font-sans text-[13px] font-bold text-foreground" },
            list.name,
          ),
        ),
      ),
    ),
  );
}
