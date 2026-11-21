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
