// Workboard tests cover the external-placement boundary of the local dispatcher.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { workboardCardIsExternallyDispatched } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

async function read(store: WorkboardStore, id: string) {
  return expectDefined(await store.get(id), "card");
}

describe("Workboard external dispatch mode", () => {
  it("round-trips the mode through create and update, and defaults to native", async () => {
    const store = createWorkboardSqliteTestStore();
    const external = await store.create({
      title: "External mission",
      status: "ready",
      dispatchMode: "external",
    });
    const native = await store.create({ title: "Local card", status: "ready" });

    // The public optional field persists in metadata.automation and reads back.
    expect(external.metadata?.automation?.dispatchMode).toBe("external");
    expect(workboardCardIsExternallyDispatched(external)).toBe(true);
    // Omitted means native: nothing is written and nothing changes.
    expect(Object.hasOwn(native.metadata?.automation ?? {}, "dispatchMode")).toBe(false);
    expect(workboardCardIsExternallyDispatched(native)).toBe(false);

    const promoted = await store.update(external.id, { dispatchMode: "native" });
    expect(workboardCardIsExternallyDispatched(promoted)).toBe(false);
    expect(promoted.metadata?.automation?.dispatchMode).toBe("native");

    // An unknown mode is refused instead of silently becoming native.
    await expect(store.update(external.id, { dispatchMode: "remote" })).rejects.toThrow(
      "dispatch mode must be one of: native, external.",
    );
    expect(workboardCardIsExternallyDispatched(await read(store, external.id))).toBe(false);
  });

  it("never claims or starts an external ready card, and still starts a native sibling", async () => {
    const store = createWorkboardSqliteTestStore();
    const external = await store.create({
      title: "Externally placed mission",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      dispatchMode: "external",
    });
    const native = await store.create({
      title: "Locally placed worker",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-native" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 3,
        resolveAgentWorkspace: () => "/workspace",
        workspaceAccess: { unrestricted: true },
      },
    });

    // The external card is invisible to the local dispatcher: no claim, no run.
    expect(run).toHaveBeenCalledOnce();
    expect(result.started.map((entry) => entry.cardId)).toEqual([native.id]);
    const left = await read(store, external.id);
    expect(left.status).toBe("ready");
    expect(left.metadata?.claim).toBeUndefined();
    expect(run).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: expect.stringContaining(external.id) }),
    );
  });

  it("skips a promoted child that is external, and starts its native sibling child", async () => {
    const store = createWorkboardSqliteTestStore();
    const parent = await store.create({
      title: "Parent",
      status: "ready",
      agentId: "shared-worker",
    });
    const externalChild = await store.create({
      title: "Externally placed child",
      status: "todo",
      priority: "urgent",
      agentId: "shared-worker",
      dispatchMode: "external",
    });
    const nativeChild = await store.create({
      title: "Locally placed child",
      status: "todo",
      priority: "high",
      agentId: "shared-worker",
    });
    await store.linkCards(parent.id, externalChild.id);
    await store.linkCards(parent.id, nativeChild.id);
    // Complete the parent as the operator so it reaches `done`; a scoped worker
    // completion would land in `review` and leave both children held in `todo`.
    const claimedParent = await store.claim(parent.id, { ownerId: "shared-worker" });
    await store.complete(
      parent.id,
      {
        ownerId: "shared-worker",
        token: claimedParent.token,
        summary: "Parent done.",
      },
      null,
    );
    expect((await read(store, parent.id)).status).toBe("done");
    const nativeChildCard = await read(store, nativeChild.id);
    const externalChildCard = await read(store, externalChild.id);
    // The parent result is committed by another actor so the linked cards promote.
    expect(nativeChildCard.metadata?.links?.some((link) => link.type === "parent")).toBe(true);
    expect(externalChildCard.metadata?.links?.some((link) => link.type === "parent")).toBe(true);
    const run = vi.fn().mockResolvedValue({ runId: "run-native-child" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 3,
        resolveAgentWorkspace: () => "/workspace",
        workspaceAccess: { unrestricted: true },
      },
    });

    const promotedExternal = await read(store, externalChild.id);
    const promotedNative = await read(store, nativeChild.id);
    // Promotion is still allowed to make the external card ready for its controller.
    expect(promotedExternal.status).toBe("ready");
    expect(promotedExternal.metadata?.claim).toBeUndefined();
    expect(promotedNative.status).toBe("running");
    expect(run).toHaveBeenCalledOnce();
    expect(result.started.map((entry) => entry.cardId)).toEqual([nativeChild.id]);
  });

  it("refuses an explicitly targeted external start with an actionable message", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Targeted external card",
      status: "ready",
      dispatchMode: "external",
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        cardId: card.id,
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        workspaceAccess: { unrestricted: true },
      },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringContaining("dispatchMode: external"),
      }),
    ]);
    expect(result.startFailures[0]?.error).toContain(
      "The external controller claims, heartbeats, and completes it",
    );
    const untouched = await read(store, card.id);
    expect(untouched.status).toBe("ready");
    expect(untouched.metadata?.claim).toBeUndefined();
  });

  it("refuses a native claim when the card is switched to external after selection", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Racing external card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    const claim = vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
      // The operator flips the card to external between selection and claim.
      await store.update(id, { dispatchMode: "external" });
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    claim.mockRestore();
    expect(run).not.toHaveBeenCalled();
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "card workspace authority changed before claim.",
      }),
    ]);
    const untouched = await read(store, card.id);
    expect(untouched.status).toBe("ready");
    expect(untouched.metadata?.claim).toBeUndefined();
  });

  it("keeps the manual external claim, heartbeat, and completion flow working", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Controller-owned mission",
      status: "ready",
      dispatchMode: "external",
    });

    const { card: claimed, token } = await store.claim(card.id, {
      ownerId: "runner-controller",
    });
    expect(claimed.status).toBe("running");
    expect(claimed.metadata?.claim?.ownerId).toBe("runner-controller");

    const heartbeated = await store.heartbeat(card.id, {
      ownerId: "runner-controller",
      token,
      note: "Attempt running remotely.",
    });
    expect(heartbeated.metadata?.claim?.ownerId).toBe("runner-controller");

    const completed = await store.complete(card.id, {
      ownerId: "runner-controller",
      token,
      summary: "Remote attempt delivered.",
      proof: { status: "passed", label: "Remote proof", command: "remote-run" },
    });
    // Completion lands in review awaiting acceptance, exactly as for native work.
    expect(completed.status).toBe("review");
    expect(completed.metadata?.automation?.awaitingAcceptance).toBe(true);
    expect(completed.metadata?.claim).toBeUndefined();
    // The placement marker survives the whole lifecycle.
    expect(workboardCardIsExternallyDispatched(completed)).toBe(true);
  });

  it("refuses a Gateway mode flip after claim while the native launch is preparing", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Preparing native worker", status: "ready" });
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const buildContext = store.buildWorkerContext.bind(store);
    let modeUpdate: Awaited<ReturnType<typeof invoke>> | undefined;
    vi.spyOn(store, "buildWorkerContext").mockImplementationOnce(async (id) => {
      expect((await read(store, id)).metadata?.claim).toBeDefined();
      modeUpdate = await invoke("workboard.cards.update", {
        id,
        patch: { dispatchMode: "external" },
      });
      return await buildContext(id);
    });
    const run = vi.fn().mockResolvedValue({ runId: "native-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures).toEqual([]);
    expect(result.started).toEqual([expect.objectContaining({ cardId: card.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(modeUpdate).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("dispatch mode cannot change") }),
    );
    expect(workboardCardIsExternallyDispatched(await read(store, card.id))).toBe(false);
  });

  it.each(["released", "external", "replacement"] as const)(
    "does not launch or compensate an attempt whose claim was %s during preparation",
    async (handoff) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({ title: "Reclaimed preparation", status: "ready" });
      const buildContext = store.buildWorkerContext.bind(store);
      let handedOff: Awaited<ReturnType<typeof read>> | undefined;
      vi.spyOn(store, "buildWorkerContext").mockImplementationOnce(async (id) => {
        await store.reclaim(id, {}, null);
        if (handoff === "external") {
          await store.update(id, { dispatchMode: "external" });
        } else if (handoff === "replacement") {
          await store.claim(id, { ownerId: "workboard-dispatcher", token: "new-attempt-token" });
        }
        handedOff = await read(store, id);
        return await buildContext(id);
      });
      const run = vi.fn().mockResolvedValue({ runId: "must-not-launch" });
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
      });

      expect(run).not.toHaveBeenCalled();
      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([
        expect.objectContaining({
          cardId: card.id,
          error: expect.stringMatching(/claim changed|external/),
        }),
      ]);
      const current = await read(store, card.id);
      expect(current).toEqual(handedOff);
      expect(current.execution).toBeUndefined();
      expect(current.metadata?.automation?.launch).toBeUndefined();
    },
  );

  it("does not overwrite a handed-off workspace after managed worktree creation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-materialization-test-"));
    try {
      const source = path.join(root, "repo");
      const managed = path.join(root, "managed");
      const external = path.join(root, "external");
      for (const directory of [source, managed, external]) {
        fs.mkdirSync(directory);
      }
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: "Materializing old dispatch",
        status: "ready",
        workspace: { kind: "worktree", path: source },
        workspaceAccess: { unrestricted: true },
      });
      let handedOff: Awaited<ReturnType<typeof read>> | undefined;
      const worktrees = {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(async () => {
          await store.reclaim(card.id, {}, null);
          handedOff = await store.update(card.id, {
            dispatchMode: "external",
            workspace: { kind: "dir", path: external },
          });
          return { id: "old-worktree", path: managed, branch: "old-branch" };
        }),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      };
      const run = vi.fn();
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        worktrees,
        options: {
          maxStarts: 1,
          materializeWorktree: true,
          workspaceAccess: { unrestricted: true },
        },
      });
      expect(worktrees.create).toHaveBeenCalledOnce();
      expect(handedOff).toBeDefined();
      expect(run).not.toHaveBeenCalled();
      expect(result.started).toEqual([]);
      expect(await read(store, card.id)).toEqual(handedOff);
      expect((await read(store, card.id)).metadata?.automation?.launch).toBeUndefined();
      expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes the mode through the agent tools and refuses an external targeted dispatch", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = createWorkboardTools({ store, context: { agentId: "agent-b" } });
    const create = expectDefined(
      tools.find((tool) => tool.name === "workboard_create"),
      "workboard_create",
    );
    const setMode = expectDefined(
      tools.find((tool) => tool.name === "workboard_set_dispatch_mode"),
      "workboard_set_dispatch_mode",
    );

    const created = readPayload(
      await create.execute("create", {
        title: "Tool-made external card",
        dispatchMode: "external",
      }),
    );
    const createdCard = created.card as { id: string };
    expect(await read(store, createdCard.id)).toMatchObject({
      metadata: { automation: { dispatchMode: "external" } },
    });

    const flipped = readPayload(
      await setMode.execute("native", { id: createdCard.id, dispatchMode: "native" }),
    );
    expect((flipped.card as { metadata?: unknown }).metadata).toMatchObject({
      automation: { dispatchMode: "native" },
    });
  });

  it("does not report an external ready card as queued behind a busy lane", async () => {
    const store = createWorkboardSqliteTestStore();
    // A real lane holder: one running card of the owner already occupies the slot.
    const laneHolder = await store.create({
      title: "Lane holder",
      status: "running",
      agentId: "shared-worker",
    });
    expect(laneHolder.status).toBe("running");
    const external = await store.create({
      title: "External held card",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      dispatchMode: "external",
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 3, workspaceAccess: { unrestricted: true } },
    });

    // The external card is not a queue entry: it needs no lane slot from us.
    expect(result.skipped.map((entry) => entry.cardId)).not.toContain(external.id);
    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
