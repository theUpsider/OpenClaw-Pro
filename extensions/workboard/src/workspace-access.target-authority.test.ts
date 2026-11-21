// Workboard tests cover cross-agent card workspace authority.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  type WorkboardTargetWorkspaceRuntime,
} from "./workspace-access.js";

type WorkboardToolContext = NonNullable<
  Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]
>;
type WorkboardTestStore = ReturnType<typeof createWorkboardSqliteTestStore>;

const CREATOR_WORKSPACE = "/workspace-creator";
const TARGET_WORKSPACE = "/workspace-target";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function guardedTools(params: { store: WorkboardTestStore; context: WorkboardToolContext }) {
  return new Map(
    guardWorkboardToolsForWorkspaceAccess(
      createWorkboardTools({ store: params.store, context: params.context }),
      params.context,
    ).map((tool) => [tool.name, tool]),
  );
}

/** The live shape: a workspace-only creator assigns a card to another agent. */
function workspaceOnlyCreator(
  params: { targetSandboxMode?: "off" | "non-main" | "all" } = {},
): WorkboardToolContext {
  return {
    agentId: "creator",
    workspaceDir: CREATOR_WORKSPACE,
    fsPolicy: { workspaceOnly: true },
    config: {
      agents: {
        entries: {
          // The live creator entry names its delegation targets; the widening gate
          // reads that same allowlist when a confined creator hands work out.
          creator: {
            workspace: CREATOR_WORKSPACE,
            subagents: { allowAgents: ["caretaker"] },
          },
          caretaker: {
            workspace: TARGET_WORKSPACE,
            ...(params.targetSandboxMode ? { sandbox: { mode: params.targetSandboxMode } } : {}),
          },
        },
      },
    },
  };
}

/** A confined creator whose live delegation allowlist does not name the unconfined target. */
function confinedCreatorWithUnconfinedTarget(): WorkboardToolContext {
  return {
    agentId: "creator",
    workspaceDir: CREATOR_WORKSPACE,
    fsPolicy: { workspaceOnly: true },
    config: {
      agents: {
        entries: {
          creator: {
            workspace: CREATOR_WORKSPACE,
            subagents: { allowAgents: ["caretaker"] },
          },
          main: { workspace: "/workspace-main" },
          caretaker: { workspace: TARGET_WORKSPACE, sandbox: { mode: "off" } },
        },
      },
    },
  };
}

/** The measured working path: an unrestricted creator assigns to an unconfined target. */
function unrestrictedCreator(): WorkboardToolContext {
  return {
    agentId: "main",
    workspaceDir: "/workspace-main",
    config: {
      agents: {
        entries: {
          // Live shape: main.subagents.allowAgents has no caretaker.
          main: {
            workspace: "/workspace-main",
            subagents: { allowAgents: ["main", "creator"], delegationMode: "prefer" },
          },
          caretaker: { workspace: TARGET_WORKSPACE, sandbox: { mode: "off" } },
        },
      },
    },
  };
}

function unrestrictedTargetRuntime(): WorkboardTargetWorkspaceRuntime {
  return { sandboxed: false, workspaceAccess: { unrestricted: true } };
}

describe("Workboard cross-agent card authority", () => {
  it("starts a card assigned to another unsandboxed agent", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "off" }),
    });
    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-assigned", {
        title: "Caretaker work",
        agentId: "caretaker",
        status: "ready",
      }),
    ).card as { id: string };
    const run = vi.fn().mockResolvedValue({ runId: "run-caretaker" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: true },
        resolveAgentWorkspace: (agentId) =>
          agentId === "caretaker" ? TARGET_WORKSPACE : CREATOR_WORKSPACE,
        resolveAgentWorkspaceRuntime: unrestrictedTargetRuntime,
      },
    });

    expect(result.startFailures).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    // A non-sandboxed target resolves to unrestricted authority, so the dispatcher
    // pins no cwd; the worker's caretaker session inherits the target agent
    // workspace instead (spawn workspace inheritance).
    const runParams = run.mock.calls[0]?.[0] as { sessionKey?: string; cwd?: string };
    expect(runParams.sessionKey).toEqual(expect.stringContaining("agent:caretaker:"));
    expect(runParams.cwd).toBeUndefined();
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "running",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
  });

  it("records a sandboxed target's own workspace root, not the creator's", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "non-main" }),
    });
    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-sandboxed-assigned", {
        title: "Sandboxed caretaker work",
        agentId: "caretaker",
        status: "ready",
      }),
    ).card as { id: string };

    await expect(store.get(created.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: [TARGET_WORKSPACE], writable: true },
        },
      },
    });

    const run = vi.fn().mockResolvedValue({ runId: "run-sandboxed" });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: true },
        resolveAgentWorkspace: (agentId) =>
          agentId === "caretaker" ? TARGET_WORKSPACE : CREATOR_WORKSPACE,
        resolveAgentWorkspaceRuntime: (agentId) =>
          agentId === "caretaker"
            ? {
                sandboxed: true,
                workspaceAccess: {
                  unrestricted: false,
                  roots: [TARGET_WORKSPACE],
                  writable: true,
                },
              }
            : unrestrictedTargetRuntime(),
      },
    });

    expect(result.startFailures).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: TARGET_WORKSPACE }));
  });

  it("keeps an explicit workspace outside the creator's boundary rejected for an assigned card", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "off" }),
    });

    await expect(
      tools.get("workboard_create")?.execute("outside-creator", {
        title: "Outside creator",
        agentId: "caretaker",
        workspace: { kind: "dir", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
    expect(await store.list()).toEqual([]);
  });

  it("refuses an assigned explicit workspace outside a restricted target root", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "non-main" }),
    });

    // The path clears the creator's own boundary but not the restricted target's
    // root, so the write is refused with the same semantics the dispatcher applies.
    await expect(
      tools.get("workboard_create")?.execute("outside-target", {
        title: "Inside creator, outside target",
        agentId: "caretaker",
        workspace: { kind: "dir", path: `${CREATOR_WORKSPACE}/repo` },
      }),
    ).rejects.toThrow(/outside the caller/);
    expect(await store.list()).toEqual([]);
  });

  it("keeps the creator's own boundary for cards without another target", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "non-main" }),
    });
    const own = readPayload(
      await tools.get("workboard_create")?.execute("own-agent", {
        title: "Own agent work",
        agentId: "creator",
      }),
    ).card as { id: string };
    const unassigned = readPayload(
      await tools.get("workboard_create")?.execute("unassigned", {
        title: "Unassigned work",
      }),
    ).card as { id: string };

    for (const id of [own.id, unassigned.id]) {
      await expect(store.get(id)).resolves.toMatchObject({
        metadata: {
          automation: {
            workspaceAccess: { unrestricted: false, roots: [CREATOR_WORKSPACE], writable: true },
          },
        },
      });
    }
  });

  it("stamps each decomposed child with its own target's authority", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "off" }),
    });
    const parent = await store.create({ title: "Decompose parent", status: "todo" });

    await tools.get("workboard_decompose")?.execute("decompose", {
      id: parent.id,
      children: [
        { title: "Child of creator", agentId: "creator" },
        { title: "Child for caretaker", agentId: "caretaker" },
        { title: "Unassigned child" },
      ],
    });

    const byTitle = new Map((await store.list()).map((card) => [card.title, card]));
    const creatorBoundary = {
      unrestricted: false,
      roots: [CREATOR_WORKSPACE],
      writable: true,
    };
    expect(byTitle.get("Child of creator")?.metadata?.automation?.workspaceAccess).toEqual(
      creatorBoundary,
    );
    expect(byTitle.get("Child for caretaker")?.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: true,
    });
    expect(byTitle.get("Unassigned child")?.metadata?.automation?.workspaceAccess).toEqual(
      creatorBoundary,
    );
  });

  it("stamps a specified card with its newly assigned target's authority", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({
      store,
      context: workspaceOnlyCreator({ targetSandboxMode: "off" }),
    });
    const card = await store.create({ title: "Rough card", status: "triage" });

    // A specify carrying a workspace mutation is the shape that records authority.
    await tools.get("workboard_specify")?.execute("specify-assigned", {
      id: card.id,
      agentId: "caretaker",
      title: "Specified for caretaker",
      workspace: { kind: "dir", path: `${CREATOR_WORKSPACE}/repo` },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      title: "Specified for caretaker",
      status: "todo",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
  });

  it("refuses a card assigned to an unknown or misspelled target agent id", async () => {
    const store = createWorkboardSqliteTestStore();
    // An unrestricted caller keeps the widening gate out of the path, so only the roster
    // check itself can refuse this write; removing it makes the card record unrestricted.
    const tools = guardedTools({ store, context: unrestrictedCreator() });

    // An id with no configured agent entry cannot be resolved as a worker target;
    // it must fail closed instead of inheriting the "not sandboxed" default.
    await expect(
      tools.get("workboard_create")?.execute("unknown-target", {
        title: "Typo target",
        agentId: "caretakeer",
        status: "ready",
      }),
    ).rejects.toThrow(/not a configured agent/i);
    expect(await store.list()).toEqual([]);
  });

  it("gates a confined creator assigning to a less-confined target", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({ store, context: confinedCreatorWithUnconfinedTarget() });

    // Widening beyond the creator's own filesystem boundary needs the creator's
    // existing subagent delegation policy to admit the target; creator only names caretaker.
    await expect(
      tools.get("workboard_create")?.execute("widen-to-main", {
        title: "Widen to main",
        agentId: "main",
        status: "ready",
      }),
    ).rejects.toThrow(/confined|delegat|allowAgents/i);
    expect(await store.list()).toEqual([]);

    // The same confined creator may still delegate to the target its policy names.
    const admitted = readPayload(
      await tools.get("workboard_create")?.execute("admitted-target", {
        title: "Admitted target",
        agentId: "caretaker",
        status: "ready",
      }),
    ).card as { id: string };
    await expect(store.get(admitted.id)).resolves.toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
  });

  it("still starts a card from an unconfined creator to a target outside its allowlist", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({ store, context: unrestrictedCreator() });

    // Regression for the measured working path: main -> caretaker is a same-level
    // assignment (no widening), so main's allowAgents listing no caretaker is irrelevant.
    const created = readPayload(
      await tools.get("workboard_create")?.execute("main-to-caretaker", {
        title: "Caretaker work",
        agentId: "caretaker",
        status: "ready",
      }),
    ).card as { id: string };
    await expect(store.get(created.id)).resolves.toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const run = vi.fn().mockResolvedValue({ runId: "run-main-caretaker" });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: true },
        resolveAgentWorkspace: (agentId) =>
          agentId === "caretaker" ? TARGET_WORKSPACE : "/workspace-main",
        resolveAgentWorkspaceRuntime: unrestrictedTargetRuntime,
      },
    });

    expect(result.startFailures).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    const runParams = run.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(runParams.sessionKey).toEqual(expect.stringContaining("agent:caretaker:"));
    await expect(store.get(created.id)).resolves.toMatchObject({ status: "running" });
  });

  it("refuses an unrepresentable target agent id instead of silently keeping the caller boundary", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({ store, context: confinedCreatorWithUnconfinedTarget() });
    const card = await store.create({ title: "Existing", agentId: "creator", status: "ready" });

    // "*" cannot name an agent. Accepting it would store the raw id while recording the
    // caller's boundary, and `workboardSessionKeyForCard` would then launch the sanitized
    // "agent" lane that this caller's own policy refuses.
    await expect(
      tools.get("workboard_create")?.execute("wildcard-create", {
        title: "Wildcard target",
        agentId: "*",
      }),
    ).rejects.toThrow(/not a valid agent id/i);
    await expect(
      tools.get("workboard_reassign")?.execute("wildcard-reassign", {
        id: card.id,
        agentId: "*",
      }),
    ).rejects.toThrow(/not a valid agent id/i);
    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "creator" });
  });

  it("gates an assignee change on reassign and agentId-only specify", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = guardedTools({ store, context: confinedCreatorWithUnconfinedTarget() });
    const card = await store.create({ title: "Existing card", agentId: "creator", status: "todo" });

    // Reassign and a specify that carries no workspace mutation still change the
    // card's lane, so the same widening gate must apply to them.
    await expect(
      tools.get("workboard_reassign")?.execute("reassign-widen", {
        id: card.id,
        agentId: "main",
      }),
    ).rejects.toThrow(/admitted|allowAgents/i);
    await expect(
      tools.get("workboard_specify")?.execute("specify-widen", {
        id: card.id,
        agentId: "main",
        title: "Retargeted",
      }),
    ).rejects.toThrow(/admitted|allowAgents/i);
    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "creator" });

    // The admitted target still passes on both paths.
    await tools.get("workboard_reassign")?.execute("reassign-ok", {
      id: card.id,
      agentId: "caretaker",
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "caretaker" });
    // A separate creator card proves the successful specify leg retargets on its own.
    const specifyCard = await store.create({
      title: "Specify target",
      agentId: "creator",
      status: "triage",
    });
    await tools.get("workboard_specify")?.execute("specify-ok", {
      id: specifyCard.id,
      agentId: "caretaker",
      title: "Specified for caretaker",
    });
    await expect(store.get(specifyCard.id)).resolves.toMatchObject({ agentId: "caretaker" });
    await tools.get("workboard_specify")?.execute("specify-ok", {
      id: card.id,
      agentId: "caretaker",
      title: "Specified for caretaker",
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "caretaker" });
  });

  it("does not widen a restricted dispatcher through an unrestricted card", async () => {
    const store = createWorkboardSqliteTestStore();
    // Unrestricted creator: the card records the target's (unrestricted) authority.
    const tools = guardedTools({
      store,
      context: {
        agentId: "main",
        workspaceDir: "/workspace",
        config: {
          agents: {
            entries: { caretaker: { workspace: TARGET_WORKSPACE, sandbox: { mode: "off" } } },
          },
        },
      },
    });
    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-for-target", {
        title: "Caretaker work",
        agentId: "caretaker",
        status: "ready",
      }),
    ).card as { id: string };
    await expect(store.get(created.id)).resolves.toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const run = vi.fn();
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/workspace-operator"], writable: true },
        resolveAgentWorkspace: (agentId) =>
          agentId === "caretaker" ? TARGET_WORKSPACE : "/workspace-operator",
        resolveAgentWorkspaceRuntime: unrestrictedTargetRuntime,
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: created.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(created.id)).resolves.toMatchObject({ status: "ready" });
  });
});
