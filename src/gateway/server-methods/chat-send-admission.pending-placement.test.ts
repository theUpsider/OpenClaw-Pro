import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { stagePlacementTurnClaimWorkerPublication } from "../worker-environments/placement-turn-authority.js";
import { admitChatSend } from "./chat-send-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

it.each([
  {
    name: "ineligible internal backend",
    external: false,
    initialRequired: false,
    required: false,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "required-profile external backend",
    external: true,
    initialRequired: true,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required policy reload",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required during placement preparation",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: true,
  },
  {
    name: "required-to-local policy reload",
    external: true,
    initialRequired: true,
    required: false,
    allowed: false,
    reloadDuringRead: false,
  },
])("preserves pending placement fences for $name", async (testCase) => {
  await withOpenClawTestState({ label: "backend-chat-pending-placement" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    let cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...(testCase.initialRequired ? { cloudWorkers: { requiredProfile: "native" } } : {}),
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:backend-pending-placement",
      sessionId: "backend-pending-placement",
    };
    const runId = "backend-pending-placement-send";
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    const requested = await placements.startDispatch(scope);
    const client = sharingPolicyClient({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    client.connect.client = {
      id: "gateway-client",
      version: "test",
      platform: "test",
      mode: "backend",
    };
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: placements,
    });
    const request = await normalizeChatSendRequest({
      client,
      params: { sessionKey: scope.sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const prepared = await prepareChatSendSession({
      request: request.value,
      client,
      context,
      isDirectExternalUser: testCase.external,
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    expect(Boolean(prepared.value.restartSafeRequest)).toBe(testCase.external);
    const session = await qualifyChatSendSession(prepared.value);
    const reloadPolicy = () => {
      cfg = {
        ...cfg,
        cloudWorkers: testCase.required ? { requiredProfile: "native" } : undefined,
      };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    if (testCase.required !== testCase.initialRequired && !testCase.reloadDuringRead) {
      reloadPolicy();
    }
    const read = await placements.prepareSessionPlacement(scope.sessionId);
    const pending = stagePlacementTurnClaimWorkerPublication(
      requireOpenClawStateDatabaseIdentity({ db: openOpenClawStateDatabase().db }),
      requested,
      undefined,
      requested.state,
      requested,
    );
    const preparePlacement = placements.prepareSessionPlacement.bind(placements);
    const reloadingRead = testCase.reloadDuringRead
      ? vi
          .spyOn(placements, "prepareSessionPlacement")
          .mockImplementationOnce(async (sessionId) => {
            const facts = await preparePlacement(sessionId);
            reloadPolicy();
            return facts;
          })
      : undefined;
    const respond = vi.fn();
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      expect(() => read.current()).toThrow("placement authority changed");
      admitted = await admitChatSend({
        request: request.value,
        session,
        client,
        context,
        respond,
      });
      expect(admitted.ok, JSON.stringify(respond.mock.calls)).toBe(testCase.allowed);
      expect(context.chatAbortControllers.has(runId)).toBe(testCase.allowed);
      if (!testCase.allowed) {
        expect(respond.mock.calls[0]?.[2]?.message).toContain("placement authority changed");
      }
      expect(() => read.current()).toThrow("placement authority changed");
    } finally {
      reloadingRead?.mockRestore();
      pending.rollback();
      read.release();
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(runId);
    }
  });
});

it("refuses a Goal start with a typed honest reason when an admission hook owns admission", async () => {
  await withOpenClawTestState({ label: "goal-admission-hook-read" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );
    try {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:goal-admission-hook-read",
        sessionId: "goal-admission-hook-read",
      };
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        status: "done",
        agentHarnessId: "openclaw",
      });
      const client = sharingPolicyClient({
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const runId = "goal-admission-hook-read-run";
      const request = await normalizeChatSendRequest({
        client,
        params: {
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          message: "Finish the release checklist",
          idempotencyKey: runId,
          intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
        },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const prepared = await prepareChatSendSession({ request: request.value, client, context });
      if (!prepared.ok) {
        throw new Error("Session preparation failed");
      }
      const session = await qualifyChatSendSession(prepared.value);
      const respond = vi.fn();
      const admitted = await admitChatSend({
        request: request.value,
        session,
        client,
        context,
        respond,
      });
      expect(admitted.ok).toBe(false);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("active execution hook"),
          details: { code: "GOAL_OPERATION_REJECTED", reason: "admission-gate" },
        }),
      );
      expect(respond.mock.calls[0]?.[2]?.message).not.toContain("native Codex");
      clearAgentRunContext(runId);
    } finally {
      resetGlobalHookRunner();
    }
  });
});

it("keeps the runtime message when an admission hook and other unsafe work both block a Goal", async () => {
  await withOpenClawTestState({ label: "goal-admission-hook-busy" }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );
    const busyRunId = "goal-admission-hook-busy-active";
    try {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:goal-admission-hook-busy",
        sessionId: "goal-admission-hook-busy",
      };
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        status: "done",
        agentHarnessId: "openclaw",
      });
      registerAgentRunContext(busyRunId, {
        agentId: "main",
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        projectSessionActive: true,
      });
      const client = sharingPolicyClient({
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const runId = "goal-admission-hook-busy-run";
      const request = await normalizeChatSendRequest({
        client,
        params: {
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          message: "Finish the release checklist",
          idempotencyKey: runId,
          intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
        },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const prepared = await prepareChatSendSession({ request: request.value, client, context });
      if (!prepared.ok) {
        throw new Error("Session preparation failed");
      }
      const session = await qualifyChatSendSession(prepared.value);
      const respond = vi.fn();
      const admitted = await admitChatSend({
        request: request.value,
        session,
        client,
        context,
        respond,
      });
      expect(admitted.ok).toBe(false);
      // The hook is not the sole blocker here, so the historical runtime message stays.
      expect(respond.mock.calls[0]?.[2]?.details).toBeUndefined();
      expect(respond.mock.calls[0]?.[2]?.message).not.toContain("active execution hook");
      clearAgentRunContext(runId);
    } finally {
      clearAgentRunContext(busyRunId);
      resetGlobalHookRunner();
    }
  });
});
