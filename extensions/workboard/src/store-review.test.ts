// Workboard review data form: normalization bounds, the store round trip through the
// physical review_json column, and the two rules enforced at the write path (R14/A5,
// R16/A6) plus the metadata-budget rule that keeps a review from displacing card data
// (R27/A9).
import { DatabaseSync } from "node:sqlite";
import type { WorkboardMetadata, WorkboardReviewAnnotation } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";
import { MAX_WORKBOARD_REVIEW_BYTES } from "./store-review.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { SCHEMA_VERSION } from "./workboard-schema.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
const NOW = 1_700_000_000_000;

function annotation(overrides: Partial<WorkboardReviewAnnotation> = {}): WorkboardReviewAnnotation {
  return {
    id: "a-1",
    documentRef: "doc-1",
    anchor: { kind: "pdf-rect", page: 1, rect: [0, 0, 10, 10] },
    body: "tighten the retention clause",
    author: "operator",
    createdAt: NOW,
    ...overrides,
  };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "accept",
    decidedAt: NOW + 5,
    decidedBy: "operator",
    unresolvedAnnotationIds: [],
    documentHashes: { "doc-1": "hash-1" },
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    cardId: "card-1",
    documents: [{ ref: "doc-1", label: "Privacy package", sourceHash: "hash-1" }],
    annotations: [annotation()],
    ...overrides,
  };
}

type TestStore = ReturnType<typeof createWorkboardSqliteTestHarness>["store"];

/** Byte size of a metadata object exactly as the trim measures it. */
function metadataBytes(metadata: WorkboardMetadata | undefined): number {
  return Buffer.byteLength(JSON.stringify(metadata ?? {}), "utf8");
}

/**
 * A within-its-own-bound review whose size is set by `count` annotations of `bodyLength`
 * characters. The default body (1000) matches the size the earlier budget tests use; the
 * terminality tests below vary it to land a write in the window of one specific later trim.
 */
function sizedReview(cardId: string, count: number, bodyLength = 1000) {
  return {
    id: "review-1",
    cardId,
    documents: [{ ref: "doc-1", label: "Privacy package", sourceHash: "hash-1" }],
    annotations: Array.from({ length: count }, (_, index) =>
      annotation({ id: `a-${index}`, body: "z".repeat(bodyLength) }),
    ),
  };
}

/** Fills a card with `count` comments of ~2000 characters each, through the write path. */
async function fillComments(store: TestStore, id: string, count: number) {
  let card = await store.get(id);
  for (let index = 0; index < count; index += 1) {
    card = await store.addComment(id, { body: `note ${index} `.padEnd(2000, "y") });
  }
  return card;
}

/** A decision picker large enough that folding it in is a real metadata increase. */
const DECISION_PICKER = Array.from({ length: 6 }, (_, index) => ({
  label: `option ${index} `.padEnd(64, "o"),
  description: "".padEnd(240, "d"),
}));

/** The interaction stamp one card-bound turn records; `at` becomes its `updatedAt`. */
const INTERACTION_STAMP = {
  sessionKey: "agent:main:main",
  agentId: "main",
  surface: "chat" as const,
  at: NOW,
};

/** A running execution, which `updateCard` syncs into `metadata.attempts` after the guard. */
const RUNNING_EXECUTION = {
  status: "running" as const,
  engine: "codex",
  model: "gpt-6.2-sol",
  sessionKey: "s-1",
  runId: "r-1",
  startedAt: NOW,
  updatedAt: NOW,
};

/** A comment of the same ~2000-character size the filler uses, so it crosses the ceiling. */
function fullComment(index: number): string {
  return `late ${index} `.padEnd(2000, "w");
}

/** Writes `metadata.review` the way a store caller does, through the terminal write path. */
async function writeReview(store: TestStore, id: string, value: unknown) {
  return await store.update(id, { metadata: { review: value } });
}

describe("Workboard review normalization", () => {
  test("round-trips a review across a store close and reopen, through the physical column", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Review case", boardId: "alpha" });
    const stored = await writeReview(harness.store, created.id, {
      ...review({ cardId: created.id }),
      annotations: [
        annotation({ id: "a-1" }),
        annotation({
          id: "a-2",
          anchor: { kind: "text-quote", quote: "§ 7 Abs. 2", hash: "hash-1", page: 4 },
        }),
      ],
    });
    expect(stored.metadata?.review).toMatchObject({
      id: "review-1",
      documents: [{ ref: "doc-1" }],
      annotations: [{ id: "a-1" }, { id: "a-2" }],
    });
    await harness.store.close();

    // The physical column carries the JSON, not only the in-memory card.
    const raw = new DatabaseSync(harness.dbPath, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT review_json FROM workboard_cards WHERE id = ?")
        .get(created.id) as { review_json?: unknown } | undefined;
      expect(JSON.parse(String(row?.review_json))).toMatchObject({
        id: "review-1",
        annotations: [{ id: "a-1" }, { id: "a-2" }],
      });
    } finally {
      raw.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath: harness.dbPath, workerModuleUrl });
    try {
      const card = await reopened.cards.lookup(created.id);
      expect(card?.card.metadata?.review?.annotations).toHaveLength(2);
      expect(card?.card.metadata?.review?.documents).toEqual([
        { ref: "doc-1", label: "Privacy package", sourceHash: "hash-1" },
      ]);
    } finally {
      await reopened.close();
    }
  });

  test("reads a legacy row without review_json as absent, adds the column on open", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const legacy = await harness.store.create({ title: "Legacy", boardId: "alpha" });
    await harness.store.close();

    const downgrade = new DatabaseSync(harness.dbPath);
    try {
      downgrade.exec("ALTER TABLE workboard_cards DROP COLUMN review_json");
      downgrade.exec(
        `DELETE FROM workboard_schema_migrations WHERE id = 'schema-${SCHEMA_VERSION}'`,
      );
    } finally {
      downgrade.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath: harness.dbPath, workerModuleUrl });
    try {
      const card = await reopened.cards.lookup(legacy.id);
      expect(card?.card.title).toBe("Legacy");
      expect(card?.card.metadata?.review).toBeUndefined();
    } finally {
      await reopened.close();
    }

    const verified = new DatabaseSync(harness.dbPath, { readOnly: true });
    try {
      expect(
        verified
          .prepare("SELECT name FROM pragma_table_info('workboard_cards') WHERE name = ?")
          .get("review_json"),
      ).toEqual({ name: "review_json" });
    } finally {
      verified.close();
    }
  });

  test("drops an unreadable anchor or a wrongly typed member instead of storing half a record", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Bounds", boardId: "alpha" });
    const card = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      documents: [
        { ref: "doc-1", label: "ok", sourceHash: "hash-1" },
        { ref: "doc-2", label: "no hash" },
      ],
      annotations: [
        annotation({ id: "keep" }),
        // Three corners is not a rectangle, and a quote without its hash holds nothing.
        annotation({
          id: "drop-rect",
          anchor: { kind: "pdf-rect", page: 1, rect: [0, 0, 10] } as never,
        }),
        annotation({ id: "drop-quote", anchor: { kind: "text-quote", quote: "x" } as never }),
        annotation({ id: "drop-unknown", anchor: { kind: "video" } as never }),
        // A resolution without its own time is not a resolution; the annotation stays open.
        annotation({ id: "drop-resolution", resolution: "accepted" }),
      ],
    });
    expect(card.metadata?.review?.annotations?.map(({ id }) => id)).toEqual([
      "keep",
      "drop-resolution",
    ]);
    expect(card.metadata?.review?.annotations?.[1]?.resolution).toBeUndefined();
    expect(card.metadata?.review?.documents).toEqual([
      { ref: "doc-1", label: "ok", sourceHash: "hash-1" },
    ]);
  });

  test("an empty document or annotation list reads back as absent", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Empty", boardId: "alpha" });
    const card = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      documents: [],
      annotations: [],
    });
    expect(card.metadata?.review).toEqual({ id: "review-1", cardId: created.id });
  });
});

describe("Workboard review enforcement", () => {
  test("A5: a verdict names exactly the annotations open at that moment", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Verdict", boardId: "alpha" });
    const card = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      documents: [{ ref: "doc-1", label: "Package", sourceHash: "hash-1" }],
      annotations: [
        annotation({ id: "open-a" }),
        annotation({ id: "resolved-b", resolvedAt: NOW + 1, resolution: "accepted" }),
      ],
      overall: verdict({ unresolvedAnnotationIds: ["open-a"] }),
    });
    expect(card.metadata?.review?.overall?.unresolvedAnnotationIds).toEqual(["open-a"]);
    expect(card.metadata?.review?.overall?.verdict).toBe("accept");
  });

  test("A5 negative: a verdict that omits an open annotation is refused", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Refused", boardId: "alpha" });
    await expect(
      writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: [
          annotation({ id: "open-a" }),
          annotation({ id: "resolved-b", resolvedAt: NOW + 1, resolution: "accepted" }),
        ],
        // Claims nothing is open while `open-a` still is.
        overall: verdict({ unresolvedAnnotationIds: [] }),
      }),
    ).rejects.toThrow(/missing open-a/);
    // The refused write left the card untouched.
    expect((await harness.store.get(created.id))?.metadata?.review).toBeUndefined();
  });

  test("A5 negative: a verdict naming an annotation that is not open is refused", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Unknown", boardId: "alpha" });
    await expect(
      writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: [annotation({ id: "open-a" })],
        overall: verdict({ unresolvedAnnotationIds: ["open-a", "ghost"] }),
      }),
    ).rejects.toThrow(/not open: ghost/);
  });

  test.each([
    ["absent", undefined, /must be one of: accept, rework, reject, hold \(got undefined\)/],
    ["empty", "", /must be one of: accept, rework, reject, hold \(got ""\)/],
    ["null", null, /must be one of: accept, rework, reject, hold \(got null\)/],
    ["number", 7, /must be one of: accept, rework, reject, hold \(got 7\)/],
    ["uppercase", "ACCEPT", /must be one of: accept, rework, reject, hold \(got "ACCEPT"\)/],
  ])("A6: refuses a %s verdict value", async (_label, value, pattern) => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Value", boardId: "alpha" });
    await expect(
      writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: [annotation({ id: "open-a" })],
        overall: verdict({ verdict: value, unresolvedAnnotationIds: ["open-a"] }),
      }),
    ).rejects.toThrow(pattern);
  });

  test("A6 positive control: each allowed verdict still goes through", async () => {
    const harness = createWorkboardSqliteTestHarness();
    for (const value of ["accept", "rework", "reject", "hold"] as const) {
      const created = await harness.store.create({ title: `Allowed ${value}`, boardId: "alpha" });
      const card = await writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: [annotation({ id: "open-a" })],
        overall: verdict({ verdict: value, unresolvedAnnotationIds: ["open-a"] }),
      });
      expect(card.metadata?.review?.overall?.verdict).toBe(value);
    }
  });

  test("A9: an over-bound review is refused and the card's other data survives", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Budget", boardId: "alpha" });
    await harness.store.addComment(created.id, { body: "keep this comment" });
    await harness.store.addProof(created.id, { status: "passed", label: "keep this proof" });
    const before = await harness.store.get(created.id);
    expect(before?.metadata?.comments).toHaveLength(1);
    expect(before?.metadata?.proof).toHaveLength(1);

    // Each member is within its own bound, but the review as a whole is over its byte
    // bound: the write must fail by name rather than let the trim make room for it.
    const body = "x".repeat(1000);
    const count = Math.ceil(MAX_WORKBOARD_REVIEW_BYTES / body.length) + 1;
    await expect(
      writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: Array.from({ length: count }, (_, index) =>
          annotation({ id: `a-${index}`, body }),
        ),
      }),
    ).rejects.toThrow(/review exceeds its bound/);

    // The point of the check: the refused write displaced nothing.
    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.metadata?.comments?.map((comment) => comment.body)).toEqual([
      "keep this comment",
    ]);
    expect(after?.metadata?.proof?.map((proof) => proof.label)).toEqual(["keep this proof"]);
  });

  test("A9: a review that is within its own bound but crowds out other data is refused", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Crowded", boardId: "alpha" });
    // Card data that fits the metadata budget on its own, with a little room left.
    for (let index = 0; index < 10; index += 1) {
      await harness.store.addComment(created.id, { body: `note ${index} `.padEnd(2000, "x") });
    }
    await harness.store.addProof(created.id, { status: "passed", label: "must survive" });
    const before = await harness.store.get(created.id);
    expect(before?.metadata?.comments).toHaveLength(10);

    // Within the review's own bounds, but adding it would push the whole metadata past
    // the card budget - exactly where `trimMetadataToBudget` would start dropping
    // comments. The write is refused by name instead.
    await expect(
      writeReview(harness.store, created.id, {
        id: "review-1",
        cardId: created.id,
        annotations: Array.from({ length: 5 }, (_, index) =>
          annotation({ id: `a-${index}`, body: "y".repeat(1000) }),
        ),
      }),
    ).rejects.toThrow(/does not fit the card metadata budget/);

    // Nothing was displaced: every comment and the proof are still there.
    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.metadata?.comments).toHaveLength(10);
    expect(after?.metadata?.proof?.map((proof) => proof.label)).toEqual(["must survive"]);
  });

  test("A9: a review that fits beside the other data still writes", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Fits", boardId: "alpha" });
    await harness.store.addComment(created.id, { body: "survives" });
    const card = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [annotation()],
    });
    expect(card.metadata?.review?.annotations).toHaveLength(1);
    expect(card.metadata?.comments?.[0]?.body).toBe("survives");
    // The whole metadata stays inside the card budget the trim enforces.
    const bytes = Buffer.byteLength(JSON.stringify(card.metadata), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
  });

  test("clearing the verdict and clearing the review both work through the write path", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Clear", boardId: "alpha" });
    await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [annotation({ id: "open-a" })],
      overall: verdict({ unresolvedAnnotationIds: ["open-a"] }),
    });
    const clearedVerdict = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [annotation({ id: "open-a" })],
      overall: null,
    });
    expect(clearedVerdict.metadata?.review?.overall).toBeUndefined();
    expect(clearedVerdict.metadata?.review?.annotations).toHaveLength(1);

    const clearedReview = await harness.store.update(created.id, { metadata: { review: null } });
    expect(clearedReview.metadata?.review).toBeUndefined();
  });

  test("a verdict recorded after a resolution survives the later read", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "History", boardId: "alpha" });
    const stored = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [
        annotation({ id: "open-a" }),
        annotation({ id: "resolved-b", resolvedAt: NOW + 1, resolution: "accepted" }),
      ],
      overall: verdict({ unresolvedAnnotationIds: ["open-a"] }),
    });
    expect(stored.metadata?.review?.overall?.unresolvedAnnotationIds).toEqual(["open-a"]);

    // A later write carries the recorded verdict unchanged: it is history, not a new
    // decision, so it is neither re-checked nor rewritten.
    const carried = await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [
        annotation({ id: "open-a" }),
        annotation({ id: "resolved-b", resolvedAt: NOW + 1, resolution: "accepted" }),
      ],
      overall: verdict({ unresolvedAnnotationIds: ["open-a"] }),
    });
    expect(carried.metadata?.review?.overall?.unresolvedAnnotationIds).toEqual(["open-a"]);
  });

  test("a metadata write without a review keeps the stored one", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Keep", boardId: "alpha" });
    await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [annotation()],
    });
    const untouched: WorkboardMetadata | undefined = (
      await harness.store.addComment(created.id, { body: "another note" })
    ).metadata;
    expect(untouched?.review?.id).toBe("review-1");
    expect(untouched?.comments).toHaveLength(1);
  });

  test("an explicit `review: undefined` is absent, not a clear; `null` is the clear", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Undefined", boardId: "alpha" });
    await writeReview(harness.store, created.id, {
      id: "review-1",
      cardId: created.id,
      annotations: [annotation()],
    });
    // Every neighbouring field reads `undefined` as absent - `interaction`, `stale`,
    // `archivedAt` - so the review must too: a key nobody meaningfully set cannot throw
    // the stored review away.
    const viaUndefined = await harness.store.update(created.id, {
      metadata: { notes: "still here", review: undefined },
    });
    expect(viaUndefined.metadata?.review?.id).toBe("review-1");

    const viaAbsentKey = await harness.store.update(created.id, {
      metadata: { notes: "and here" },
    });
    expect(viaAbsentKey.metadata?.review?.id).toBe("review-1");

    // `null` remains the one documented way to clear it.
    const viaNull = await harness.store.update(created.id, { metadata: { review: null } });
    expect(viaNull.metadata?.review).toBeUndefined();
  });
});

describe("Workboard review budget guard is scoped to the review write", () => {
  test("an unrelated addComment over the ceiling is not refused", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Window", boardId: "alpha" });
    await harness.store.update(created.id, {
      metadata: { review: sizedReview(created.id, 4) },
    });
    const filled = await fillComments(harness.store, created.id, 9);
    const { review: _review, ...rest } = filled?.metadata ?? {};
    // The window the finding measured: the rest fits on its own, and the next full-size
    // comment is what pushes the *total* past the ceiling - the only place the guard can
    // fire at all. Without this margin the write never reaches it and the check is void.
    const before = metadataBytes(filled?.metadata);
    const beforeRest = metadataBytes(rest as WorkboardMetadata);
    expect(before).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
    expect(beforeRest).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
    expect(before + fullComment(9).length).toBeGreaterThan(MAX_CARD_METADATA_BYTES);

    // This write carries no review. It used to be refused by name - "store fewer or
    // shorter annotations" for a caller who only added a comment.
    const after = await harness.store.addComment(created.id, { body: fullComment(9) });
    expect(after.metadata?.review?.id).toBe("review-1");
    expect(after.metadata?.comments?.at(-1)?.body).toBe(fullComment(9));
    // The trim did its ordinary work: the card stays inside the ceiling.
    expect(metadataBytes(after.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
  });

  test("the review's mere presence does not change an unrelated write's outcome", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const bare = await harness.store.create({ title: "Bare", boardId: "alpha" });
    const judged = await harness.store.create({ title: "Judged", boardId: "alpha" });
    await harness.store.update(judged.id, {
      metadata: { review: sizedReview(judged.id, 4) },
    });
    // Each card is filled so the identical next comment crosses the ceiling on it - the
    // only place the guard can act. The judged card's `rest` (metadata minus the review)
    // stays inside the ceiling, which is precisely the window the finding measured: the
    // guard fires there, so under the old unconditional call this write was refused while
    // the identical write on the review-free card went through.
    const bareFilled = await fillComments(harness.store, bare.id, 11);
    const judgedFilled = await fillComments(harness.store, judged.id, 9);
    const { review: _review, ...judgedRest } = judgedFilled?.metadata ?? {};
    for (const filled of [bareFilled, judgedFilled]) {
      expect(metadataBytes(filled?.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
      expect(metadataBytes(filled?.metadata) + fullComment(99).length).toBeGreaterThan(
        MAX_CARD_METADATA_BYTES,
      );
    }
    expect(metadataBytes(judgedRest as WorkboardMetadata)).toBeLessThanOrEqual(
      MAX_CARD_METADATA_BYTES,
    );
    expect(judgedFilled?.metadata?.review?.id).toBe("review-1");

    // The identical write on both. The presence of the review must not decide it.
    const bareAfter = await harness.store.addComment(bare.id, { body: fullComment(99) });
    const judgedAfter = await harness.store.addComment(judged.id, { body: fullComment(99) });
    expect(bareAfter.metadata?.comments?.at(-1)?.body).toBe(fullComment(99));
    expect(judgedAfter.metadata?.comments?.at(-1)?.body).toBe(fullComment(99));
    expect(judgedAfter.metadata?.review?.id).toBe("review-1");
    expect(metadataBytes(bareAfter.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
    expect(metadataBytes(judgedAfter.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
  });
});

// The guard is *terminal* only when every metadata trim the write runs through carries
// `reviewWritten`, not just the one inside `normalizeMetadata`. `updateCard` trims again
// after folding in the interaction stamp, the automation patch, the execution-attempt
// sync and a settle notification; each of those adds card data of its own, so an
// unguarded later trim can still free room for the review by dropping a comment or a
// proof (R27/A9).
//
// Each of the four cases below is sized into the window of ONE later trim, and that is
// pinned twice: `expectReviewOnlyWriteResolves` proves the same review *without* the extra
// field still fits, so the refusal cannot come from the first trim, and
// `expectMetadataWithinBudget` proves the card data fits on its own. Without the first
// check a later byte change to any normalizer could move the refusal to `normalizeMetadata`
// and these tests would stay green while proving nothing about terminality.
describe("Workboard review budget guard holds to the end of the write", () => {
  /**
   * The reviewed card must already fit, and the *same* review on its own must still be
   * accepted: that is what makes the later refusal about the extra field, not the review.
   */
  async function expectReviewOnlyWriteResolves(
    harness: ReturnType<typeof createWorkboardSqliteTestHarness>,
    id: string,
    value: unknown,
  ): Promise<void> {
    const store = harness.store;
    const before = await store.get(id);
    expect(metadataBytes(before?.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
    const reviewOnly = await store.update(id, { metadata: { review: value } });
    expect(reviewOnly.metadata?.review).toBeDefined();
    // Clear it again, so the case under test starts from the measured card.
    await store.update(id, { metadata: { review: null } });
  }

  test("review + decisionOptions in one write is refused, not paid for with a comment", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Single write", boardId: "alpha" });
    // Card data that fits the ceiling on its own; the review alone still fits too, so the
    // refusal below is about the picker being written in the same call.
    await fillComments(harness.store, created.id, 9);
    await harness.store.addProof(created.id, { status: "passed", label: "must survive" });
    const beforeIds = (await harness.store.get(created.id))?.metadata?.comments?.map(
      ({ id }) => id,
    );
    await expectReviewOnlyWriteResolves(harness, created.id, sizedReview(created.id, 4));
    expect(metadataBytes((await harness.store.get(created.id))?.metadata)).toBeLessThanOrEqual(
      MAX_CARD_METADATA_BYTES,
    );

    // Before this fix the write succeeded and shed the 10th comment: the guard ran on the
    // metadata *before* `normalizeAutomationPatch` was folded in, so the automation trim
    // at the end of `updateCard` was free to make room for the review.
    await expect(
      harness.store.update(created.id, {
        metadata: { review: sizedReview(created.id, 4) },
        decisionOptions: DECISION_PICKER,
      }),
    ).rejects.toThrow(/does not fit the card metadata budget/);

    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.metadata?.comments?.map(({ id }) => id)).toEqual(beforeIds);
    expect(after?.metadata?.proof?.map(({ label }) => label)).toEqual(["must survive"]);
    expect(after?.metadata?.automation?.decisionOptions).toBeUndefined();
  });

  test("review + a card-bound interaction stamp in one write is refused as well", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Interaction", boardId: "alpha" });
    await fillComments(harness.store, created.id, 11);
    const beforeIds = (await harness.store.get(created.id))?.metadata?.comments?.map(
      ({ id }) => id,
    );
    // Sized into the interaction trim's own window: the same review *without* the stamp
    // still fits (pinned below), and the ~300 bytes the stamp adds at `store-core.ts:609`
    // are what push it over. Pre-fix that trim ran unguarded and shed a comment
    // (measured: comments 11 -> 10, not refused).
    await expectReviewOnlyWriteResolves(harness, created.id, sizedReview(created.id, 1, 1250));

    await expect(
      harness.store.update(
        created.id,
        { metadata: { review: sizedReview(created.id, 1, 1250) } },
        { interaction: INTERACTION_STAMP },
      ),
    ).rejects.toThrow(/does not fit the card metadata budget/);

    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.metadata?.interaction).toBeUndefined();
    expect(after?.metadata?.comments?.map(({ id }) => id)).toEqual(beforeIds);
  });

  test("review + an execution sync in one write is refused, not trimmed for", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Execution", boardId: "alpha" });
    await fillComments(harness.store, created.id, 11);
    const beforeIds = (await harness.store.get(created.id))?.metadata?.comments?.map(
      ({ id }) => id,
    );
    // `syncExecutionAttemptMetadata` appends an attempt at the very end of `updateCard`, so
    // this trim saw metadata that was *not* the one stored. Its own window: the same review
    // without the execution still fits (pinned below) and the attempt is what crosses it.
    // Pre-fix the write succeeded and bought the review by dropping that attempt.
    await expectReviewOnlyWriteResolves(harness, created.id, sizedReview(created.id, 1, 1200));

    await expect(
      harness.store.update(created.id, {
        execution: RUNNING_EXECUTION,
        metadata: { review: sizedReview(created.id, 1, 1200) },
      }),
    ).rejects.toThrow(/does not fit the card metadata budget/);

    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.metadata?.attempts).toBeUndefined();
    expect(after?.metadata?.comments?.map(({ id }) => id)).toEqual(beforeIds);
  });

  test("review + a status settle in one write is refused before the notification trim", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Settle", boardId: "alpha" });
    await fillComments(harness.store, created.id, 11);
    await harness.store.update(created.id, { execution: RUNNING_EXECUTION, status: "running" });
    const beforeIds = (await harness.store.get(created.id))?.metadata?.comments?.map(
      ({ id }) => id,
    );
    // `settleManualStatusTransition` appends its completion notification and trims again at
    // `store-status-write.ts`; that trim is inside the same write. The same review without
    // the settle still fits (pinned below). Pre-fix the notification trim ran unguarded and
    // shed a comment to make room for the review (measured: comments 11 -> 10).
    await expectReviewOnlyWriteResolves(harness, created.id, sizedReview(created.id, 1, 1100));

    await expect(
      harness.store.update(created.id, {
        status: "done",
        metadata: { review: sizedReview(created.id, 1, 1100) },
      }),
    ).rejects.toThrow(/does not fit the card metadata budget/);

    const after = await harness.store.get(created.id);
    expect(after?.metadata?.review).toBeUndefined();
    expect(after?.status).not.toBe("done");
    expect(after?.metadata?.comments?.map(({ id }) => id)).toEqual(beforeIds);
    expect(after?.metadata?.notifications).toBeUndefined();
  });

  test("the create path carries the flag too (review + a running execution)", async () => {
    const harness = createWorkboardSqliteTestHarness();
    // `create` normalizes the patch and then syncs the execution attempt through its own
    // trim (`store-core.ts:408`), which runs *after* the guarded normalization and adds
    // ~200 bytes of attempt data. Seed enough comments that the review alone still fits and
    // the attempt is what crosses the ceiling - the create path's own window (measured
    // 2026-11-20: at a 1550-char review body the pre-fix create resolved and stored no
    // attempt, the post-fix create is refused by name).
    const seedComments = (suffix: string) =>
      Array.from({ length: 11 }, (_, index) => ({
        id: `c-${suffix}-${index}`,
        body: fullComment(index),
        createdAt: NOW,
      }));
    const withReview = (suffix: string, reviewBody: number) => ({
      metadata: {
        comments: seedComments(suffix),
        review: sizedReview("placeholder", 1, reviewBody),
      },
    });
    // Control: the same seed with the review, no running execution -> accepted.
    const accepted = await harness.store.create({
      title: "Create control",
      boardId: "alpha",
      ...withReview("control", 1550),
    });
    expect(accepted.metadata?.review).toBeDefined();
    expect(accepted.metadata?.comments).toHaveLength(11);

    await expect(
      harness.store.create({
        title: "Create with execution",
        boardId: "alpha",
        status: "running",
        execution: RUNNING_EXECUTION,
        ...withReview("trial", 1550),
      }),
    ).rejects.toThrow(/does not fit the card metadata budget/);
  });

  test("the same write without a review is untouched by the guard", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Control", boardId: "alpha" });
    await fillComments(harness.store, created.id, 11);

    // Identical card, identical patch, no review: the write goes through and the ordinary
    // trim order does its work. Without this control the three refusals above would also
    // pass on a guard that refused every over-budget write.
    const after = await harness.store.update(created.id, {
      execution: RUNNING_EXECUTION,
      decisionOptions: DECISION_PICKER,
    });
    expect(after.metadata?.review).toBeUndefined();
    expect(after.metadata?.automation?.decisionOptions).toHaveLength(6);
    expect(metadataBytes(after.metadata)).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
  });
});
