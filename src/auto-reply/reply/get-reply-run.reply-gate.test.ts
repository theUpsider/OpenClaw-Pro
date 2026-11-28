// Tests the reply gate wiring in prepared group replies.
import "./get-reply-run.runtime-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../config/zod-schema.agent-defaults-base.js";
import type { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams, createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationRunState,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn<typeof evaluateDecisionInRegistry>() }));
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
vi.mock("../../plugins/runtime/gateway-request-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime/gateway-request-scope.js")>()),
  getPluginRegistryForContext: () => null,
}));

const cfg = {
  session: {},
  channels: {},
  surfaces: { slack: { replyGate: { enabled: true, threshold: 0.5 } } },
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      experimental: { decisionAssistance: true },
      decisionModel: "fixture/model",
    }),
  },
} as unknown as OpenClawConfig;

const verdict = (reply: number, action = reply) =>
  mocks.evaluate.mockResolvedValue({
    status: "ok",
    provenance: { providerId: "f", rubricVersion: "2", runtimeGeneration: "t" },
    result: {
      model: "m",
      answers: {
        needs_reply: { type: "boolean", probabilityTrue: reply },
        needs_action: { type: "boolean", probabilityTrue: action },
      },
    },
  });

function groupParams(over: Partial<Parameters<typeof baseParams>[0]> = {}, chatType = "group") {
  const onDeliberateSilentTerminalReply = vi.fn();
  const params = baseParams({
    cfg,
    ctx: createInboundTurn("anyone know the answer?", "slack", chatType),
    sessionCtx: createSessionTurn("anyone know the answer?", "slack", chatType),
    opts: { onDeliberateSilentTerminalReply },
    ...over,
  });
  return { params, onDeliberateSilentTerminalReply };
}

const SCHEDULED_AUTOMATION = {
  assertCurrent: () => {},
  admissionSource: "system",
  job: {},
} as never;

beforeEach(() => {
  setRuntimeConfigSnapshot(cfg);
  mocks.evaluate.mockReset();
  vi.mocked(runReplyAgent).mockClear();
});
afterEach(clearRuntimeConfigSnapshot);

describe("reply gate in prepared reply", () => {
  it.each([
    [0.2, 0.2],
    [0.2, 0.9],
  ])(
    "still runs the turn (and its tool call) when needs_reply=false (action=%s) but marks the post suppressed",
    async (reply, action) => {
      verdict(reply, action);
      const toolEffect = vi.fn();
      const seen: { suppression?: string; typingMode?: string } = {};
      vi.mocked(runReplyAgent).mockImplementationOnce(async (args) => {
        toolEffect();
        seen.suppression = resolveReplyOperationRunState(
          (args as { opts?: object }).opts,
        )?.visibleReplySuppression;
        seen.typingMode = (args as { typingMode?: string }).typingMode;
        return { text: "ok" };
      });
      const { params, onDeliberateSilentTerminalReply } = groupParams();
      const state: ReplyOperationRunState = {};
      params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
      const result = await runPreparedReply(params);
      expect(mocks.evaluate).toHaveBeenCalledOnce();
      expect(runReplyAgent).toHaveBeenCalledOnce();
      expect(toolEffect).toHaveBeenCalledOnce();
      expect(result).toEqual({ text: "ok" });
      expect(state.visibleReplySuppression).toBe("reply-gate");
      expect(seen.suppression).toBe("reply-gate");
      expect(seen.typingMode).toBe("never");
      // Run preparation no longer ends the turn or records completion itself.
      expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
      expect(state.replyCompletion?.outcome).not.toBe("blocked");
    },
  );

  it.each([
    [0.9, 0.9],
    [0.9, 0.1],
  ])("does not suppress the post when needs_reply=true (action=%s)", async (reply, action) => {
    verdict(reply, action);
    const { params } = groupParams();
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    expect(state.visibleReplySuppression).toBeUndefined();
  });

  it("replies normally at the threshold and above it", async () => {
    for (const p of [0.5, 0.9]) {
      mocks.evaluate.mockReset();
      vi.mocked(runReplyAgent).mockClear();
      verdict(p);
      const { params, onDeliberateSilentTerminalReply } = groupParams();
      expect(await runPreparedReply(params)).toEqual({ text: "ok" });
      expect(runReplyAgent).toHaveBeenCalledOnce();
      expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    }
  });

  it("replies normally when the provider fails or is unavailable", async () => {
    mocks.evaluate.mockRejectedValue(new Error("down"));
    expect(await runPreparedReply(groupParams().params)).toEqual({ text: "ok" });
    mocks.evaluate.mockReset().mockResolvedValue({ status: "unavailable", reason: "transport" });
    expect(await runPreparedReply(groupParams().params)).toEqual({ text: "ok" });
  });

  it("does not call the decision runtime when disabled", async () => {
    verdict(0);
    const off = { ...cfg, surfaces: undefined } as OpenClawConfig;
    const { params } = groupParams({ cfg: off });
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("does not gate direct chats", async () => {
    verdict(0);
    expect(await runPreparedReply(groupParams({}, "direct").params)).toEqual({ text: "ok" });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  // Heartbeats run as scheduled automations (upstream #180563).
  it("does not gate scheduled-automation (heartbeat) turns", async () => {
    verdict(0);
    const { params } = groupParams();
    params.opts = { ...params.opts, scheduledAutomation: SCHEDULED_AUTOMATION };
    await runPreparedReply(params).catch(() => undefined);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("does not gate internal-event turns", async () => {
    verdict(0);
    const { params } = groupParams();
    params.opts = { ...params.opts, internalEventExecution: { assertCurrent: () => {} } as never };
    await runPreparedReply(params).catch(() => undefined);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("does not gate command turns", async () => {
    verdict(0);
    const body = "/status";
    const { params } = groupParams({
      ctx: { ...createInboundTurn(body, "slack", "group"), CommandSource: "native" },
      sessionCtx: createSessionTurn(body, "slack", "group"),
      command: { ...baseParams().command, rawBodyNormalized: body, commandBodyNormalized: body },
    });
    await runPreparedReply(params);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});

// Stage 2: the turn skip. Separate opt-in (`replyGate.skipTurn`), resolved independently of
// stage 1; `needs_action` decides only whether the turn starts.
const cfgWithSkip = (skipTurn: unknown, replyGate: Record<string, unknown> = {}) =>
  ({
    session: {},
    channels: {},
    surfaces: { slack: { replyGate: { ...replyGate, skipTurn } } },
    agents: {
      defaults: AgentDefaultsBaseSchema.parse({
        experimental: { decisionAssistance: true },
        decisionModel: "fixture/model",
      }),
    },
  }) as unknown as OpenClawConfig;

const skipArmed = cfgWithSkip({ enabled: true, actionThreshold: 0.5 });

describe("reply gate stage 2: skipping the whole turn", () => {
  it("does not start the turn when neither a reply nor an action is needed", async () => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.2, 0.2);
    const { params, onDeliberateSilentTerminalReply } = groupParams({ cfg: skipArmed });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toBeUndefined();
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(runReplyAgent).not.toHaveBeenCalled();
    expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
    expect(state.replyCompletion?.outcome).toBe("blocked");
    expect(params.typing.onReplyStart).not.toHaveBeenCalled();
    expect(params.typing.cleanup).toHaveBeenCalledOnce();
  });

  it("still runs the turn (so a tool can act) when needs_action=true, suppressing only the post", async () => {
    const both = cfgWithSkip(
      { enabled: true, actionThreshold: 0.5 },
      { enabled: true, threshold: 0.5 },
    );
    setRuntimeConfigSnapshot(both);
    verdict(0.2, 0.9);
    const { params } = groupParams({ cfg: both });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    // Stage 1 is armed here, so it suppresses the post while stage 2 lets the turn act.
    expect(state.visibleReplySuppression).toBe("reply-gate");
  });

  it.each([
    [0.9, 0.9],
    [0.9, 0.1],
  ])("never skips a turn that needs a reply (reply=%s action=%s)", async (reply, action) => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(reply, action);
    const { params, onDeliberateSilentTerminalReply } = groupParams({ cfg: skipArmed });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    expect(state.visibleReplySuppression).toBeUndefined();
  });

  it("honours the action-threshold boundary exactly (at the threshold does not skip)", async () => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.2, 0.5);
    const atThreshold = groupParams({ cfg: skipArmed });
    expect(await runPreparedReply(atThreshold.params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();

    verdict(0.2, 0.49);
    const below = groupParams({ cfg: skipArmed });
    expect(await runPreparedReply(below.params)).toBeUndefined();
    expect(runReplyAgent).toHaveBeenCalledOnce();
  });

  it("uses its own action threshold, independently of the reply threshold", async () => {
    // Action threshold 0.3 sits BELOW the reply threshold 0.5, so the two verdict facts disagree:
    // needs_action is false (0.4 < 0.5) while the probability is above its own cutoff (0.4 > 0.3).
    const cfg2 = cfgWithSkip(
      { enabled: true, actionThreshold: 0.3 },
      { enabled: true, threshold: 0.5 },
    );
    setRuntimeConfigSnapshot(cfg2);
    verdict(0.2, 0.4);
    const above = groupParams({ cfg: cfg2 });
    expect(await runPreparedReply(above.params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();

    // Just below that cutoff the turn is skipped again.
    verdict(0.2, 0.29);
    const below = groupParams({ cfg: cfg2 });
    expect(await runPreparedReply(below.params)).toBeUndefined();
    expect(runReplyAgent).toHaveBeenCalledOnce();
  });

  it("keeps stage-1 behaviour when the turn skip is not armed", async () => {
    verdict(0.2, 0.2);
    const { params, onDeliberateSilentTerminalReply } = groupParams();
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    expect(state.visibleReplySuppression).toBe("reply-gate");
  });

  it("works when only stage 2 is armed (stage-1 post suppression off)", async () => {
    const skipOnly = cfgWithSkip({ enabled: true, actionThreshold: 0.5 });
    setRuntimeConfigSnapshot(skipOnly);
    verdict(0.2, 0.9);
    const { params, onDeliberateSilentTerminalReply } = groupParams({ cfg: skipOnly });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    // Stage 1 is off, so stage 2 must not suppress the post on its own.
    expect(state.visibleReplySuppression).toBeUndefined();
    expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
  });

  it.each([
    ["provider throws", () => mocks.evaluate.mockRejectedValue(new Error("down"))],
    [
      "provider unavailable",
      () => mocks.evaluate.mockResolvedValue({ status: "unavailable", reason: "transport" }),
    ],
    [
      "malformed probability",
      () =>
        mocks.evaluate.mockResolvedValue({
          status: "ok",
          provenance: { providerId: "f", rubricVersion: "2", runtimeGeneration: "t" },
          result: {
            model: "m",
            answers: {
              needs_reply: { type: "boolean", probabilityTrue: Number.NaN },
              needs_action: { type: "boolean", probabilityTrue: 0.1 },
            },
          },
        }),
    ],
  ])("fails open with stage 2 armed when the %s", async (_name, arrange) => {
    setRuntimeConfigSnapshot(skipArmed);
    arrange();
    const { params, onDeliberateSilentTerminalReply } = groupParams({ cfg: skipArmed });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    expect(await runPreparedReply(params)).toEqual({ text: "ok" });
    expect(runReplyAgent).toHaveBeenCalledOnce();
    expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    expect(state.replyCompletion?.outcome).not.toBe("blocked");
  });

  it.each([["direct chat", {}, "direct"]])(
    "never skips a %s even with stage 2 armed",
    async (_name, _over, chatType) => {
      setRuntimeConfigSnapshot(skipArmed);
      verdict(0.1, 0.1);
      const { params } = groupParams({ cfg: skipArmed }, chatType);
      await runPreparedReply(params);
      expect(runReplyAgent).toHaveBeenCalledOnce();
      expect(mocks.evaluate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["scheduled-automation (heartbeat)", { scheduledAutomation: SCHEDULED_AUTOMATION }],
    ["internal event", { internalEventExecution: { assertCurrent: () => {} } as never }],
  ])("never skips a %s turn even with stage 2 armed", async (_name, over) => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.1, 0.1);
    const { params } = groupParams({ cfg: skipArmed });
    params.opts = { ...params.opts, ...over };
    await runPreparedReply(params).catch(() => undefined);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("never skips a command turn even with stage 2 armed", async () => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.1, 0.1);
    const body = "/status";
    const { params } = groupParams({
      cfg: skipArmed,
      ctx: { ...createInboundTurn(body, "slack", "group"), CommandSource: "native" },
      sessionCtx: createSessionTurn(body, "slack", "group"),
      command: { ...baseParams().command, rawBodyNormalized: body, commandBodyNormalized: body },
    });
    await runPreparedReply(params);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("carries no needs_action authority into the run state", async () => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.2, 0.2);
    const { params } = groupParams({ cfg: skipArmed });
    const state: ReplyOperationRunState = {};
    params.opts = { ...params.opts, [REPLY_OPERATION_RUN_STATE]: state };
    await runPreparedReply(params);
    // The skip decision is local to preparation: no action verdict reaches the per-turn facts.
    expect(Object.keys(state)).not.toContain("needsAction");
    expect(JSON.stringify(state)).not.toContain("needsAction");
    expect(state.visibleReplySuppression).toBeUndefined();
  });
});

// Remit configuration: an optional list of the systems the assistant operates. Absent it, the
// gate payload and rubric are byte-identical to the shipped behaviour.
describe("reply gate remit configuration", () => {
  const cfgWithRemit = (remit: unknown) =>
    ({
      session: {},
      channels: {},
      surfaces: {
        slack: {
          replyGate: {
            enabled: true,
            threshold: 0.5,
            skipTurn: { enabled: true, actionThreshold: 0.5 },
            remit,
          },
        },
      },
      agents: {
        defaults: AgentDefaultsBaseSchema.parse({
          experimental: { decisionAssistance: true },
          decisionModel: "fixture/model",
        }),
      },
    }) as unknown as OpenClawConfig;

  it("sends the configured remit and rubric version 3 through the real call path", async () => {
    const remitCfg = cfgWithRemit(["the import job", "the background worker"]);
    setRuntimeConfigSnapshot(remitCfg);
    verdict(0.2, 0.2);
    const { params } = groupParams({ cfg: remitCfg });
    await runPreparedReply(params);
    const [batch, options] = mocks.evaluate.mock.calls[0]!;
    expect((batch.state as Record<string, unknown>).remit).toEqual([
      "the import job",
      "the background worker",
    ]);
    expect(options).toMatchObject({ rubricVersion: "3" });
  });

  it("keeps the payload and the rubric version untouched when no remit is configured", async () => {
    setRuntimeConfigSnapshot(skipArmed);
    verdict(0.2, 0.2);
    const { params } = groupParams({ cfg: skipArmed });
    await runPreparedReply(params);
    const [batch, options] = mocks.evaluate.mock.calls[0]!;
    expect("remit" in (batch.state as Record<string, unknown>)).toBe(false);
    expect(options).toMatchObject({ rubricVersion: "2" });
  });
});
