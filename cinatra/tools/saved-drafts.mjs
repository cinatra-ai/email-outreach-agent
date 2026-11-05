// Declared module of the drafting agent: hands the drafts review the drafts
// the run saved.
//
// The draft step saves the drafted emails as one draft bundle object and
// passes on only its reference. The drafts review's screen reads the drafts
// from the gate's `draftBundle.draftedEmails` and fetches nothing itself. The
// flow calls this module through its read step, between the draft step and
// the review: the module reads the saved bundle through the objects port and
// returns it as `draftBundle`, with the drafts under `draftedEmails`, in the
// order the bundle saved them. So the review shows exactly the drafts that the
// approval and the send act on.
//
// Each draft keeps the fields the screen reads and the review's write-back
// matches on, as the bundle saved them: the id, the recipient, the subject and
// the body. Nothing else of the saved object reaches the screen.
//
// A missing reference, an object that is not a draft bundle, a bundle with no
// drafts and a draft that names no recipient are refused by name, so the run
// ends with the reason before the review instead of showing an empty review.
//
// Neither the run nor the scope is ever in this file: the port admits only an
// object of this run or of a run it descends from. A refusal of the port
// reaches the caller unchanged.

const DRAFT_BUNDLE_TYPE = "@cinatra-ai/campaigns:email-draft-bundle";
const TEXT_FIELDS = ["id", "recipientId", "recipientName", "recipientEmail", "subject", "body", "status"];

class ExtensionToolCallRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionToolCallRefusal";
  }
}

// A plain object is one made by an object literal or with a null prototype;
// an array, a date, a map or an instance of a class is not one.
const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

const trimmedOrNone = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

export async function extensionTool({ input, ports }) {
  const bundleRef = trimmedOrNone(input?.draftBundleRef);
  if (bundleRef === undefined) {
    throw new ExtensionToolCallRefusal("The run names no saved draft bundle to show in the drafts review.");
  }

  const saved = await ports.objects.read({ objectId: bundleRef });
  if (!saved || saved.type !== DRAFT_BUNDLE_TYPE || !isPlainObject(saved.data)) {
    throw new ExtensionToolCallRefusal("The saved draft bundle of this run is not an email draft bundle.");
  }

  const rows = Array.isArray(saved.data.draftedEmails)
    ? saved.data.draftedEmails
    : Array.isArray(saved.data.drafts)
      ? saved.data.drafts
      : undefined;
  if (rows === undefined || rows.length === 0) {
    throw new ExtensionToolCallRefusal("The saved draft bundle of this run holds no drafts to review.");
  }

  const draftedEmails = [];
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    if (!isPlainObject(row)) {
      throw new ExtensionToolCallRefusal(`Draft ${position} of this run is not a draft, so the drafts review is not shown.`);
    }
    if (!nonEmpty(row.recipientEmail) && !nonEmpty(row.id) && !nonEmpty(row.recipientId)) {
      throw new ExtensionToolCallRefusal(
        `Draft ${position} of this run names no recipient, so the drafts review is not shown.`,
      );
    }
    const draft = {};
    for (const field of TEXT_FIELDS) {
      if (typeof row[field] === "string") draft[field] = row[field];
    }
    if (typeof row.followUpDay === "number" && Number.isFinite(row.followUpDay)) draft.followUpDay = row.followUpDay;
    draftedEmails.push(draft);
  }

  return { ok: true, draftBundle: { draftedEmails } };
}
