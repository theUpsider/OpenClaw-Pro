import { describe, expect, it } from "vitest";
import { normalizeMetadata } from "./metadata-normalization.ts";

describe("Workboard automation metadata boundary", () => {
  it("keeps valid fields and filters malformed optional fields without losing string bytes", () => {
    expect(
      normalizeMetadata({
        automation: {
          tenant: "  tenant  ",
          boardId: "ops",
          summary: 1,
          skills: ["", " ", "  review ", 1],
          createdCardIds: ["card", null],
          workspace: { kind: "worktree", path: " /work ", sourceBranch: "main", unknown: true },
          workspaceAccess: { unrestricted: false, roots: ["", " /work ", 42], writable: true },
          maxRetries: 3,
          unknown: true,
        },
      }),
    ).toEqual({
      automation: {
        tenant: "  tenant  ",
        boardId: "ops",
        skills: ["  review "],
        createdCardIds: ["card"],
        workspace: { kind: "worktree", path: " /work ", sourceBranch: "main" },
        workspaceAccess: { unrestricted: false, roots: ["", " /work "], writable: true },
        maxRetries: 3,
      },
    });
  });

  it.each([
    {
      value: { skills: [null, " "], workspace: { kind: "invalid", path: "/work" } },
      expected: undefined,
    },
    {
      // A recognized mode survives the browser projection; an unknown one drops
      // so the UI never renders a mode the server would not accept back.
      value: { dispatchMode: "external" },
      expected: { dispatchMode: "external" },
    },
    {
      value: { dispatchMode: "remote" },
      expected: undefined,
    },
    {
      value: { workspaceAccess: { unrestricted: true, roots: ["/ignored"], writable: false } },
      expected: { workspaceAccess: { unrestricted: true } },
    },
    {
      value: { workspaceAccess: { unrestricted: false, roots: [], writable: true } },
      expected: { workspaceAccess: { unrestricted: false, roots: [], writable: true } },
    },
    {
      value: { workspaceAccess: { unrestricted: false, roots: [], writable: "yes" } },
      expected: undefined,
    },
    {
      value: {
        decisionOptions: [
          { label: " A ", description: 1, recommended: "yes" },
          { label: "" },
          "B",
          { label: "C", description: "Why C.", recommended: true },
        ],
      },
      expected: {
        decisionOptions: [{ label: "A" }, { label: "C", description: "Why C.", recommended: true }],
      },
    },
    {
      value: { maxRuntimeSeconds: Number.NaN, maxRetries: Number.POSITIVE_INFINITY },
      expected: { maxRuntimeSeconds: Number.NaN, maxRetries: Number.POSITIVE_INFINITY },
    },
  ])("preserves optional-field tolerance for $value", ({ value, expected }) => {
    expect(normalizeMetadata({ automation: value })).toEqual(
      expected ? { automation: expected } : undefined,
    );
  });
});

describe("Workboard interaction metadata boundary", () => {
  const valid = {
    sessionKey: "agent:main:voice",
    agentId: "main",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    surface: "plugin-dock" as const,
  };

  it("keeps a well-formed interaction link whole", () => {
    expect(normalizeMetadata({ interaction: valid })).toEqual({ interaction: valid });
    // Drops the optional members when they are absent, keeps the required pair.
    expect(
      normalizeMetadata({
        interaction: { sessionKey: "agent:main:voice", startedAt: 1, updatedAt: 2 },
      }),
    ).toEqual({ interaction: { sessionKey: "agent:main:voice", startedAt: 1, updatedAt: 2 } });
    expect(normalizeMetadata({ interaction: { ...valid, agentId: "  main  " } })).toEqual({
      interaction: { ...valid, agentId: "main" },
    });
  });

  it("never reads updatedAt as earlier than startedAt", () => {
    expect(normalizeMetadata({ interaction: { ...valid, startedAt: 50, updatedAt: 10 } })).toEqual({
      interaction: { ...valid, startedAt: 50, updatedAt: 50 },
    });
  });

  it.each([
    ["missing sessionKey", { startedAt: 1, updatedAt: 2 }],
    ["empty sessionKey", { sessionKey: "   ", startedAt: 1, updatedAt: 2 }],
    ["non-numeric startedAt", { sessionKey: "agent:main:voice", startedAt: "now", updatedAt: 2 }],
    ["zero startedAt", { sessionKey: "agent:main:voice", startedAt: 0, updatedAt: 2 }],
    [
      "infinite updatedAt",
      {
        sessionKey: "agent:main:voice",
        startedAt: 1,
        updatedAt: Number.POSITIVE_INFINITY,
      },
    ],
    ["missing timestamps", { sessionKey: "agent:main:voice" }],
    ["a string instead of an object", "agent:main:voice"],
    ["an array instead of an object", ["agent:main:voice"]],
  ])("drops malformed input: %s", (_label, interaction) => {
    expect(normalizeMetadata({ interaction })).toBeUndefined();
  });

  it("drops an unknown surface but keeps the rest of the link", () => {
    expect(normalizeMetadata({ interaction: { ...valid, surface: "mobile" } })).toEqual({
      interaction: {
        sessionKey: valid.sessionKey,
        agentId: "main",
        startedAt: valid.startedAt,
        updatedAt: valid.updatedAt,
      },
    });
    expect(normalizeMetadata({ interaction: { ...valid, surface: "chat" } })).toEqual({
      interaction: { ...valid, surface: "chat" },
    });
    expect(normalizeMetadata({ interaction: undefined })).toBeUndefined();
  });
});

describe("Workboard operator-ask metadata boundary", () => {
  it("keeps a short single-line ask and a declared blocker kind", () => {
    expect(
      normalizeMetadata({ automation: { ask: "  Which tenant?  ", askKind: "input" } }),
    ).toEqual({ automation: { ask: "  Which tenant?  ", askKind: "input" } });
  });

  it.each([
    // The server refuses these; the UI drops them instead of rendering text it
    // would have to truncate.
    { value: { ask: "x".repeat(121) }, expected: undefined },
    { value: { ask: "first\nsecond" }, expected: undefined },
    { value: { ask: 7 }, expected: undefined },
    { value: { askKind: "decision" }, expected: undefined },
    { value: { askKind: "blocked" }, expected: undefined },
  ])("drops ask text or a kind the server would refuse: $value", ({ value, expected }) => {
    expect(normalizeMetadata({ automation: value })).toEqual(
      expected ? { automation: expected } : undefined,
    );
  });
});

describe("Workboard review metadata boundary", () => {
  const anchor = { kind: "pdf-rect" as const, page: 2, rect: [1, 2, 3, 4] as const };
  const annotation = {
    id: "a-1",
    documentRef: "doc-1",
    anchor,
    body: "retention clause",
    author: "operator",
    createdAt: 1_700_000_000_000,
  };
  const document = { ref: "doc-1", label: "Package", sourceHash: "hash-1" };
  const overall = {
    verdict: "accept" as const,
    decidedAt: 1_700_000_005_000,
    decidedBy: "operator",
    unresolvedAnnotationIds: ["a-1"],
    documentHashes: { "doc-1": "hash-1" },
  };
  const review = {
    id: "review-1",
    cardId: "card-1",
    documents: [document],
    annotations: [annotation],
  };

  it("keeps a well-formed review whole, including its verdict", () => {
    expect(normalizeMetadata({ review })).toEqual({ review });
    expect(normalizeMetadata({ review: { ...review, overall } })).toEqual({
      review: { ...review, overall },
    });
  });

  it("drops an annotation whose anchor cannot be read, keeping the readable ones", () => {
    expect(
      normalizeMetadata({
        review: {
          ...review,
          annotations: [
            annotation,
            {
              ...annotation,
              id: "bad-rect",
              anchor: { kind: "pdf-rect", page: 1, rect: [0, 0, 1] },
            },
            { ...annotation, id: "bad-quote", anchor: { kind: "text-quote", quote: "x" } },
            { ...annotation, id: "unknown", anchor: { kind: "video" } },
            "not-an-object",
          ],
        },
      }),
    ).toEqual({ review: { ...review, annotations: [annotation] } });
  });

  it("drops a resolution word that carries no resolution time", () => {
    expect(
      normalizeMetadata({
        review: { ...review, annotations: [{ ...annotation, resolution: "accepted" }] },
      }),
    ).toEqual({ review });
    expect(
      normalizeMetadata({
        review: {
          ...review,
          annotations: [{ ...annotation, resolvedAt: 1_700_000_001_000, resolution: "answered" }],
        },
      }),
    ).toEqual({
      review: {
        ...review,
        annotations: [{ ...annotation, resolvedAt: 1_700_000_001_000, resolution: "answered" }],
      },
    });
  });

  it.each([
    ["a string instead of an object", "review-1"],
    ["an array instead of an object", ["review-1"]],
    ["a missing id", { ...review, id: undefined }],
    ["a missing cardId", { ...review, cardId: undefined }],
  ])("drops a review the board cannot render: %s", (_label, value) => {
    expect(normalizeMetadata({ review: value })).toBeUndefined();
  });

  it("drops an unknown verdict word but keeps the card's other data", () => {
    // The mirror is tolerant by design: the store refuses the write, so the board only
    // has to keep rendering a foreign payload rather than break on it.
    const metadata = normalizeMetadata({
      review: { ...review, overall: { ...overall, verdict: "ACCEPT" } },
      comments: [{ id: "c-1", body: "kept", createdAt: 1 }],
    });
    expect(metadata?.comments).toHaveLength(1);
    expect(metadata?.review?.id).toBe("review-1");
    expect(metadata?.review?.overall).toBeUndefined();
  });

  it("reads an empty review list as absent and an absent review as nothing", () => {
    expect(normalizeMetadata({ review: { ...review, documents: [], annotations: [] } })).toEqual({
      review: { id: "review-1", cardId: "card-1" },
    });
    expect(normalizeMetadata({})).toBeUndefined();
  });
});
