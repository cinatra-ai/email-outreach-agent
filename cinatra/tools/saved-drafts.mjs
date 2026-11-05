// Declared module of the drafting agent: hands the drafts review the drafts
// the run saved.
//
// The draft step saves the drafted emails as one draft bundle object and
// passes on only its reference. The drafts review's screen reads the drafts
// from the gate's `draftBundle.draftedEmails` and fetches nothing itself. The
// flow calls this module through its read step, between the draft step and
// the review: the module reads the saved bundle through the objects port and
// returns it as `draftBundle`, with the drafts under `draftedEmails`, in the
// order the bundle saved them.
//
// Each draft keeps the fields the screen reads and the review's write-back
// matches on, as the bundle saved them: the id, the recipient, the subject and
// the body. Nothing else of the saved object reaches the screen. The module
// reads only data fields that the saved object holds itself: an object or a
// list with another prototype, an inherited field, or a getter or a setter is
// refused, and no getter is run. The port answers with data parsed from
// storage; a Proxy, which can report any field, is not one this module can
// tell apart from data.
//
// The review shows a draft's subject and body as text, and the write-back
// compares the edits with the saved text, so a draft whose subject or body is
// not text is refused. The screen keys each draft by its id, else its
// recipientId, else its recipient email, and the write-back matches the edits
// by id and by recipient email, so two drafts under one such key, two drafts
// with one recipient email, and the key __proto__ are refused. The write-back
// keys a saved row by its id, else its recipientId, when that is non-empty
// text, else by its email; a draft whose id is present (not null) but is
// empty or not text could get an edit that the write-back drops or matches to
// no row, so it is refused, also when it names an email. The write-back
// edits the first list among draftedEmails, sequence, followups, drafts and
// confirmedRecipients that the bundle holds; a bundle where that list is not
// the one shown here is refused.
//
// A missing reference, an object that is not a draft bundle, a bundle with no
// drafts and a draft that names no recipient are refused by name too, so the
// run ends with the reason before the review instead of showing an empty or a
// different review.
//
// Neither the run nor the scope is ever in this file: the port admits only an
// object of this run or of a run it descends from. A refusal of the port, and
// any other failure of its read, reaches the caller unchanged. The module sets
// no time limit of its own on the read.

const DRAFT_BUNDLE_TYPE = "@cinatra-ai/campaigns:email-draft-bundle";
const TEXT_FIELDS = ["id", "recipientId", "recipientName", "recipientEmail", "subject", "body", "status"];
// The order in which the screen takes a draft's key, and the lists the write-back looks for, in its order.
const KEY_FIELDS = ["id", "recipientId", "recipientEmail"];
const WRITE_BACK_LISTS = ["draftedEmails", "sequence", "followups", "drafts", "confirmedRecipients"];
const SHOWN_LISTS = ["draftedEmails", "drafts"];

class ExtensionToolCallRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionToolCallRefusal";
  }
}

// The object's own fields as data, read from their descriptors (so no getter
// runs), or undefined when one of them is a getter or a setter.
const ownData = (value) => {
  const fields = new Map();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) return undefined;
    fields.set(key, descriptor.value);
  }
  return fields;
};

// A record is an object made by an object literal, by JSON parsing or with a
// null prototype, holding only data fields: its fields, or undefined. An
// array, a date, a map, an instance of a class and an object whose prototype
// is any other object are not records.
const recordOf = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return ownData(value);
};

// A list is an array with the array prototype, holding only data entries: its
// length and its entry at an index (a hole reads as undefined), or undefined.
const listOf = (value) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const fields = ownData(value);
  if (fields === undefined) return undefined;
  return { length: fields.get("length"), at: (index) => fields.get(String(index)) };
};

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

export async function extensionTool({ input, ports }) {
  const ref = input?.draftBundleRef;
  const bundleRef = nonEmpty(ref) ? ref.trim() : undefined;
  if (bundleRef === undefined) {
    throw new ExtensionToolCallRefusal("The run names no saved draft bundle to show in the drafts review.");
  }

  const saved = await ports.objects.read({ objectId: bundleRef });
  const notABundle = () =>
    new ExtensionToolCallRefusal("The saved draft bundle of this run is not an email draft bundle.");
  const answer = saved === null || saved === undefined ? undefined : recordOf(saved);
  if (answer === undefined || answer.get("type") !== DRAFT_BUNDLE_TYPE) throw notABundle();
  const data = recordOf(answer.get("data"));
  if (data === undefined) throw notABundle();

  // The list the write-back edits: the first of its lists that is an array.
  const listKey = WRITE_BACK_LISTS.find((key) => Array.isArray(data.get(key)));
  if (listKey !== undefined && !SHOWN_LISTS.includes(listKey)) {
    throw new ExtensionToolCallRefusal(
      "The saved draft bundle of this run keeps its drafts in a list the drafts review does not show.",
    );
  }
  const rows = listKey === undefined ? { length: 0 } : listOf(data.get(listKey));
  if (rows === undefined) throw notABundle();
  if (rows.length === 0) {
    throw new ExtensionToolCallRefusal("The saved draft bundle of this run holds no drafts to review.");
  }

  const draftedEmails = [];
  const byKey = new Map();
  const byEmail = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const position = index + 1;
    const fields = recordOf(rows.at(index));
    if (fields === undefined) {
      throw new ExtensionToolCallRefusal(`Draft ${position} of this run is not a draft, so the drafts review is not shown.`);
    }
    if (!KEY_FIELDS.some((field) => nonEmpty(fields.get(field)))) {
      throw new ExtensionToolCallRefusal(
        `Draft ${position} of this run names no recipient, so the drafts review is not shown.`,
      );
    }
    const id = fields.get("id");
    if (id !== undefined && id !== null && (typeof id !== "string" || id.length === 0)) {
      throw new ExtensionToolCallRefusal(
        `Draft ${position} of this run has an id that is empty or not text, so the drafts review is not shown.`,
      );
    }
    if (typeof fields.get("subject") !== "string" || typeof fields.get("body") !== "string") {
      throw new ExtensionToolCallRefusal(
        `Draft ${position} of this run has a subject or a body that is not text, so the drafts review is not shown.`,
      );
    }
    const draft = {};
    for (const field of TEXT_FIELDS) {
      if (typeof fields.get(field) === "string") draft[field] = fields.get(field);
    }
    const followUpDay = fields.get("followUpDay");
    if (typeof followUpDay === "number" && Number.isFinite(followUpDay)) draft.followUpDay = followUpDay;

    // The key the screen shows this draft under: the first of its key fields that the draft holds.
    const key = draft[KEY_FIELDS.find((field) => draft[field] !== undefined)];
    if (key === "__proto__") {
      throw new ExtensionToolCallRefusal(
        `Draft ${position} of this run has the id __proto__, which the drafts review cannot show.`,
      );
    }
    if (byKey.has(key)) {
      throw new ExtensionToolCallRefusal(
        `Drafts ${byKey.get(key)} and ${position} of this run have one id in the drafts review, so it is not shown.`,
      );
    }
    byKey.set(key, position);
    if (draft.recipientEmail !== undefined) {
      if (byEmail.has(draft.recipientEmail)) {
        throw new ExtensionToolCallRefusal(
          `Drafts ${byEmail.get(draft.recipientEmail)} and ${position} of this run name one recipient email, so the drafts review is not shown.`,
        );
      }
      byEmail.set(draft.recipientEmail, position);
    }
    draftedEmails.push(draft);
  }

  return { ok: true, draftBundle: { draftedEmails } };
}
