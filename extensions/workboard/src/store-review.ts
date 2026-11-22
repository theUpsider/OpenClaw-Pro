// Workboard review family: the card's annotated documents, each annotation's own
// resolution, and the one overall verdict that names what was still open. Own field
// family (`metadata.review` -> `review_json`), own file and own bounds, so
// `WorkboardComment`/`WorkboardAttachment` and the existing trim order stay untouched.
import { isDeepStrictEqual } from "node:util";
import {
  WORKBOARD_REVIEW_RESOLUTIONS,
  WORKBOARD_REVIEW_VERDICT_VALUES,
  type WorkboardMetadata,
  type WorkboardReviewAnchor,
  type WorkboardReviewAnnotation,
  type WorkboardReviewResolution,
  type WorkboardReviewSession,
  type WorkboardReviewVerdict,
  type WorkboardReviewVerdictValue,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { definedFields } from "../record-fields.js";

/**
 * Bounds of the review family. A review over them is *refused by name*, never trimmed:
 * `trimMetadataToBudget` does not know this family and would otherwise drop a comment or
 * a proof to make room for review data (R27/A9). The byte bound stays well below
 * `MAX_CARD_METADATA_BYTES`, so a within-bounds review leaves that trim its room.
 *
 * Precisely (R27/A9), the rule holds for a *review-bearing* write: a write that carries
 * review data and would push the metadata past the card budget while the rest of the
 * data fits on its own is refused, so the trim never makes room for that review. A write
 * that carries no review is left to the existing trim order untouched - a stored review
 * is not itself ground for refusing a comment, proof, heartbeat or status write.
 */
export const MAX_WORKBOARD_REVIEW_ANNOTATIONS = 200;
export const MAX_WORKBOARD_REVIEW_DOCUMENTS = 40;
export const MAX_WORKBOARD_REVIEW_BYTES = 8 * 1024;

const MAX_REVIEW_ID = 120;
const MAX_REVIEW_REF = 200;
const MAX_REVIEW_LABEL = 200;
const MAX_REVIEW_HASH = 128;
const MAX_REVIEW_BODY = 2000;
const MAX_REVIEW_AUTHOR = 120;
const MAX_REVIEW_QUOTE = 2000;
const MAX_REVIEW_NOTE = 2000;

/**
 * A present string member over its bound refuses the write instead of being truncated:
 * R13 keeps an annotation's wording byte-identical, so silently shortening review prose
 * would be a silent data change. An absent member returns undefined for the caller to
 * treat as "missing" (a structural problem on a required member, "not set" on an
 * optional one).
 */
function strictText(value: unknown, max: number, field: string): string | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }
  if (text.length > max) {
    throw new Error(`review ${field} exceeds its bound: at most ${max} characters.`);
  }
  return text;
}

function timestamp(value: unknown): number | undefined {
  return resolveOptionalIntegerOption(value, { min: 0 }) || undefined;
}

function normalizeResolution(value: unknown): WorkboardReviewResolution | undefined {
  // The resolution word is descriptive: an unknown one is dropped while `resolvedAt`
  // - the member that actually decides "open" - still stands. The annotation is kept.
  return (WORKBOARD_REVIEW_RESOLUTIONS as readonly string[]).includes(value as string)
    ? (value as WorkboardReviewResolution)
    : undefined;
}

/**
 * The anchor is what makes an annotation findable, so an anchor that cannot be stored
 * intact drops the whole annotation instead of being repaired: a quote without its hash,
 * a rectangle with three corners, or a page that is not a page points at nothing, and an
 * inert anchor would be a silent claim about the document. Dropping the entry follows the
 * neighbouring list fields (`normalizeComment`, `normalizeProof`), which also drop
 * malformed members rather than storing a half-record.
 */
function normalizeAnchor(value: unknown): WorkboardReviewAnchor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind === "pdf-rect") {
    const page = resolveOptionalIntegerOption(value.page, { min: 1 });
    const rect = Array.isArray(value.rect) ? value.rect : undefined;
    if (
      !page ||
      rect?.length !== 4 ||
      rect.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      return undefined;
    }
    const [left, top, right, bottom] = rect as [number, number, number, number];
    return { kind: "pdf-rect", page, rect: [left, top, right, bottom] };
  }
  if (value.kind === "text-quote") {
    const quote = strictText(value.quote, MAX_REVIEW_QUOTE, "anchor quote");
    const hash = strictText(value.hash, MAX_REVIEW_HASH, "anchor hash");
    const page = resolveOptionalIntegerOption(value.page, { min: 1 });
    if (!quote || !hash) {
      return undefined;
    }
    return definedFields({ kind: "text-quote" as const, quote, hash, page });
  }
  if (value.kind === "text-range") {
    const start = resolveOptionalIntegerOption(value.start, { min: 0 });
    const end = resolveOptionalIntegerOption(value.end, { min: 0 });
    const hash = strictText(value.hash, MAX_REVIEW_HASH, "anchor hash");
    if (start === undefined || end === undefined || end < start || !hash) {
      return undefined;
    }
    return { kind: "text-range", start, end, hash };
  }
  // Unknown anchor kind: not one of the three the requirements define, so the
  // annotation has no usable pointer. Dropped whole, like the malformed cases above.
  return undefined;
}

function normalizeAnnotation(value: unknown): WorkboardReviewAnnotation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = strictText(value.id, MAX_REVIEW_ID, "annotation id");
  const documentRef = strictText(value.documentRef, MAX_REVIEW_REF, "annotation documentRef");
  const anchor = normalizeAnchor(value.anchor);
  const body = strictText(value.body, MAX_REVIEW_BODY, "annotation body");
  const author = strictText(value.author, MAX_REVIEW_AUTHOR, "annotation author");
  const createdAt = timestamp(value.createdAt);
  if (!id || !documentRef || !anchor || !body || !author || !createdAt) {
    return undefined;
  }
  // `resolvedAt` alone decides "open"; a resolution word without it is dropped, and a
  // resolution time without a word keeps the time and loses only the description.
  const resolvedAt = timestamp(value.resolvedAt);
  return definedFields({
    id,
    documentRef,
    anchor,
    body,
    author,
    createdAt,
    resolvedAt,
    resolution: resolvedAt ? normalizeResolution(value.resolution) : undefined,
  });
}

function normalizeDocument(
  value: unknown,
): NonNullable<WorkboardReviewSession["documents"]>[number] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ref = strictText(value.ref, MAX_REVIEW_REF, "document ref");
  const label = strictText(value.label, MAX_REVIEW_LABEL, "document label");
  const sourceHash = strictText(value.sourceHash, MAX_REVIEW_HASH, "document sourceHash");
  if (!ref || !label || !sourceHash) {
    return undefined;
  }
  return { ref, label, sourceHash };
}

function normalizeVerdictValue(value: unknown): WorkboardReviewVerdictValue {
  // No coercion and no default: a value outside the four allowed ones is refused, and so
  // is an absent, empty, wrongly typed or unknown one (R16/A6).
  if (
    typeof value !== "string" ||
    !(WORKBOARD_REVIEW_VERDICT_VALUES as readonly string[]).includes(value)
  ) {
    throw new Error(
      `review verdict must be one of: ${WORKBOARD_REVIEW_VERDICT_VALUES.join(", ")} (got ${JSON.stringify(value)}).`,
    );
  }
  return value as WorkboardReviewVerdictValue;
}

function normalizeDocumentHashes(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("review verdict must record the document hashes it fell against.");
  }
  const hashes: Record<string, string> = {};
  for (const [ref, hash] of Object.entries(value)) {
    const normalized = strictText(hash, MAX_REVIEW_HASH, "verdict document hash");
    if (!ref || !normalized) {
      throw new Error(
        `review verdict documentHashes must map each document ref to its source hash (got ${JSON.stringify(ref)}).`,
      );
    }
    hashes[ref] = normalized;
  }
  return hashes;
}

/**
 * The overall verdict, checked against the annotations open *here* - derived from the
 * annotations being stored, never from the caller's claim (R14/A5). A verdict that does
 * not name exactly that set is refused by name; the stored list is the derived one, in
 * annotation order.
 */
function normalizeOverall(value: unknown, openIds: readonly string[]): WorkboardReviewVerdict {
  if (!isRecord(value)) {
    throw new Error("review verdict must be an object.");
  }
  const verdict = normalizeVerdictValue(value.verdict);
  if (!Array.isArray(value.unresolvedAnnotationIds)) {
    throw new Error(
      "review verdict must name the annotations that were open (unresolvedAnnotationIds).",
    );
  }
  const claimed = value.unresolvedAnnotationIds.map((id) =>
    strictText(id, MAX_REVIEW_ID, "verdict annotation id"),
  );
  if (claimed.some((id) => !id)) {
    throw new Error("review verdict must name the open annotations as a list of ids.");
  }
  const claimedIds = claimed as string[];
  const open = new Set(openIds);
  const missing = openIds.filter((id) => !claimedIds.includes(id));
  const unknown = claimedIds.filter((id) => !open.has(id));
  if (missing.length > 0) {
    throw new Error(
      `review verdict must name the annotations still open; missing ${missing.join(", ")}.`,
    );
  }
  if (unknown.length > 0) {
    throw new Error(`review verdict names annotations that are not open: ${unknown.join(", ")}.`);
  }
  const decidedAt = timestamp(value.decidedAt);
  const decidedBy = strictText(value.decidedBy, MAX_REVIEW_AUTHOR, "verdict decidedBy");
  if (!decidedAt || !decidedBy) {
    throw new Error("review verdict must carry decidedAt and the identity that decided.");
  }
  return definedFields({
    verdict,
    note: strictText(value.note, MAX_REVIEW_NOTE, "verdict note"),
    decidedAt,
    decidedBy,
    unresolvedAnnotationIds: openIds,
    documentHashes: normalizeDocumentHashes(value.documentHashes),
  });
}

/**
 * Normalize one `metadata.review` write. Members the write does not carry fall back to
 * the stored review, so recording a verdict on an existing review keeps its annotations -
 * and the open set a new verdict is checked against is derived from those same stored
 * annotations.
 *
 * A verdict is validated when the write *decides*: an `overall` that deep-equals the
 * stored one is a recorded historical fact (resolving an annotation after the verdict
 * moves the open set but must not invalidate or rewrite that record), while a new or
 * changed `overall` is a new decision and must name the open set derived now. `null`
 * clears the verdict.
 */
export function normalizeWorkboardReview(
  value: unknown,
  stored?: WorkboardReviewSession,
): WorkboardReviewSession {
  if (!isRecord(value)) {
    throw new Error("review must be an object.");
  }
  const id = strictText(value.id, MAX_REVIEW_ID, "review id");
  const cardId = strictText(value.cardId, MAX_REVIEW_ID, "review cardId");
  if (!id || !cardId) {
    throw new Error("review id and cardId are required.");
  }
  const annotations = Object.hasOwn(value, "annotations")
    ? Array.isArray(value.annotations)
      ? value.annotations
          .map(normalizeAnnotation)
          .filter((entry): entry is WorkboardReviewAnnotation => entry !== undefined)
      : refuseList("annotations")
    : (stored?.annotations ?? []);
  if (annotations.length > MAX_WORKBOARD_REVIEW_ANNOTATIONS) {
    throw new Error(
      `review exceeds its bound: at most ${MAX_WORKBOARD_REVIEW_ANNOTATIONS} annotations (got ${annotations.length}).`,
    );
  }
  const documents = Object.hasOwn(value, "documents")
    ? Array.isArray(value.documents)
      ? value.documents
          .map(normalizeDocument)
          .filter(
            (entry): entry is NonNullable<WorkboardReviewSession["documents"]>[number] =>
              entry !== undefined,
          )
      : refuseList("documents")
    : (stored?.documents ?? []);
  if (documents.length > MAX_WORKBOARD_REVIEW_DOCUMENTS) {
    throw new Error(
      `review exceeds its bound: at most ${MAX_WORKBOARD_REVIEW_DOCUMENTS} documents (got ${documents.length}).`,
    );
  }
  const openIds = annotations
    .filter((annotation) => !annotation.resolvedAt)
    .map(({ id: key }) => key);
  const overall = resolveOverall(value, stored, openIds);
  const review = definedFields({
    id,
    cardId,
    documents: documents.length ? documents : undefined,
    annotations: annotations.length ? annotations : undefined,
    overall,
  });
  const bytes = Buffer.byteLength(JSON.stringify(review), "utf8");
  if (bytes > MAX_WORKBOARD_REVIEW_BYTES) {
    throw new Error(
      `review exceeds its bound: at most ${MAX_WORKBOARD_REVIEW_BYTES} bytes of review data (got ${bytes}).`,
    );
  }
  return review;
}

function refuseList(field: string): never {
  throw new Error(`review ${field} must be a list.`);
}

function resolveOverall(
  value: Record<string, unknown>,
  stored: WorkboardReviewSession | undefined,
  openIds: readonly string[],
): WorkboardReviewVerdict | undefined {
  if (!Object.hasOwn(value, "overall")) {
    return stored?.overall;
  }
  if (value.overall === null || value.overall === undefined) {
    return undefined;
  }
  // An unchanged verdict is the recorded history of an earlier moment, not a new
  // decision: it is carried through even though the open set has moved since.
  if (stored?.overall && isDeepStrictEqual(value.overall, stored.overall)) {
    return stored.overall;
  }
  return normalizeOverall(value.overall, openIds);
}

/**
 * What one metadata write resolves to for the review family.
 */
export type ResolvedWorkboardReview = {
  /** The review to store, or `undefined` when the write carries none or clears it. */
  review: WorkboardReviewSession | undefined;
  /**
   * Whether *this write* introduced or changed review data, as opposed to keeping or
   * clearing a stored one. The budget guard is gated on it: a write with nothing to do
   * with the review must never be refused with a review-named error just because the
   * card holds one.
   *
   * Comparing against the stored review is load-bearing, not a nicety: callers build a
   * metadata patch by spreading the card's existing metadata (`addComment`, `addProof`,
   * the heartbeat and the status writers all do), so the `review` member is present on
   * every such write while introducing nothing. "The patch has a review member" would
   * therefore be true for exactly the writes this guard must not touch.
   */
  reviewWritten: boolean;
};

/**
 * Resolve the `review` member of a metadata write. Both card writers funnel through
 * `normalizeMetadata`, so the two rules sit at the write path rather than in a caller:
 * a verdict cannot be stored without naming the open annotations, and a review over its
 * bounds fails by name instead of letting the metadata trim shorten other card data.
 *
 * A write that does not mention `review` keeps the stored one - the same fallback shape
 * as every neighbouring field. An explicit `null` clears it, and so does `undefined`
 * treated as absent, which is how `interaction`, `stale` and `archivedAt` already read
 * it; neither form introduces review data, so neither trips the budget guard.
 */
export function resolveWorkboardReview(
  patchMetadata: Record<string, unknown>,
  stored: WorkboardReviewSession | undefined,
): ResolvedWorkboardReview {
  if (!Object.hasOwn(patchMetadata, "review")) {
    return { review: stored, reviewWritten: false };
  }
  const patch = patchMetadata.review;
  // `null` clears, and clearing only removes bytes: never a review write, never guarded.
  if (patch === null) {
    return { review: undefined, reviewWritten: false };
  }
  // `undefined` is absent, not a clear - the same reading `interaction`, `stale` and
  // `archivedAt` give it - so a key nobody set cannot silently throw the review away.
  if (patch === undefined) {
    return { review: stored, reviewWritten: false };
  }
  const review = normalizeWorkboardReview(patch, stored);
  // Re-stating the stored review byte-for-byte is what a spread patch looks like: the
  // write touches no review data, so it gets today's trim behaviour rather than the
  // refuse-by-name guard.
  return { review, reviewWritten: !stored || !isDeepStrictEqual(review, stored) };
}

/**
 * Whether a metadata *patch* introduces review data. This is the flag the card writers
 * carry to every metadata trim that runs *after* `normalizeMetadata` (R27/A9): those
 * trims add card data of their own - an interaction stamp, an automation patch, the
 * execution-attempt sync, a settle notification - so re-running the guard only where the
 * patch was normalized would leave it seeing a metadata that is not the one stored.
 *
 * Same inputs and same predicate as the resolution inside `normalizeMetadata`, so both
 * answer alike for one write; kept here so the review family owns the reading.
 */
export function reviewWrittenInPatch(
  patchMetadata: unknown,
  stored?: WorkboardReviewSession,
): boolean {
  return resolveWorkboardReview(isRecord(patchMetadata) ? patchMetadata : {}, stored).reviewWritten;
}

/**
 * The guard that the metadata trim runs for a *review-bearing* write only: a review that
 * does not fit *alongside* card data that fits on its own is refused by name. Otherwise
 * the trim would be free to drop a comment or a proof to make room for review data, which
 * R27 forbids. When the rest of the metadata is over budget on its own the review is not
 * to blame, so the normal trim order runs unchanged.
 *
 * A write that carries no review is not passed through here at all: the caller passes
 * `reviewWritten: false`, so the condition is "this write introduced review data", never
 * "this card happens to hold a review".
 */
export function assertReviewFitsMetadataBudget(
  metadata: WorkboardMetadata,
  metadataByteSize: (value: WorkboardMetadata) => number,
  budget: number,
): void {
  const review = metadata.review;
  if (!review) {
    return;
  }
  if (metadataByteSize(metadata) <= budget) {
    return;
  }
  const { review: _review, ...rest } = metadata;
  if (metadataByteSize(rest as WorkboardMetadata) > budget) {
    return;
  }
  throw new Error(
    "review does not fit the card metadata budget alongside the card's other data; " +
      "store fewer or shorter annotations rather than displacing a comment, proof or artifact.",
  );
}
