// Quiet status reactions: one working reaction, then a terminal reaction that restoreInitial keeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  QUIET_STATUS_REACTION_EMOJIS,
  type StatusReactionAdapter,
  type StatusReactionController,
} from "./status-reactions.js";

const { working: WORKING, done: DONE, error: ERROR } = QUIET_STATUS_REACTION_EMOJIS;
const INTERMEDIATE_EMOJIS = [
  DEFAULT_EMOJIS.thinking,
  DEFAULT_EMOJIS.tool,
  DEFAULT_EMOJIS.coding,
  DEFAULT_EMOJIS.web,
  DEFAULT_EMOJIS.compacting,
  DEFAULT_EMOJIS.stallSoft,
  DEFAULT_EMOJIS.stallHard,
];

// WhatsApp, Signal, and Telegram: setting a reaction replaces the previous one.
function createSingleSlotAdapter() {
  const log: string[] = [];
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      log.push(`+${emoji}`);
    }),
    clearReaction: vi.fn(async () => {
      log.push("clear");
    }),
  };
  return { adapter, log, visible: () => log.findLast((entry) => entry.startsWith("+"))?.slice(1) };
}

// Slack and Discord: reactions accumulate and must be removed explicitly.
function createMultiSlotAdapter() {
  const active = new Set<string>();
  const log: string[] = [];
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      if (active.has(emoji)) {
        throw new Error("already_reacted");
      }
      active.add(emoji);
      log.push(`+${emoji}`);
    }),
    removeReaction: vi.fn(async (emoji: string) => {
      if (!active.delete(emoji)) {
        throw new Error("no_reaction");
      }
      log.push(`-${emoji}`);
    }),
  };
  return { adapter, log, visible: () => [...active].join("") };
}

async function driveActivity(ctrl: StatusReactionController, log: string[]) {
  void ctrl.setQueued();
  await vi.advanceTimersByTimeAsync(0);
  const afterQueued = [...log];
  for (const update of [
    ctrl.setThinking,
    () => ctrl.setTool("exec"),
    () => ctrl.setTool("web_search"),
    () => ctrl.setTool("unknown_tool"),
    ctrl.setCompacting,
    ctrl.setThinking,
  ]) {
    void update();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
  }
  await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1);
  return afterQueued;
}

const holdAndStallMs =
  DEFAULT_TIMING.doneHoldMs + DEFAULT_TIMING.errorHoldMs + DEFAULT_TIMING.stallHardMs + 1;

const adapterCases = [
  {
    name: "single-slot (WhatsApp/Signal/Telegram)",
    createAdapter: createSingleSlotAdapter,
    doneLog: [`+${WORKING}`, `+${DONE}`],
    errorLog: [`+${WORKING}`, `+${ERROR}`],
  },
  {
    name: "multi-slot acknowledgement-style (Slack/Discord)",
    createAdapter: createMultiSlotAdapter,
    doneLog: [`+${WORKING}`, `+${DONE}`, `-${WORKING}`],
    errorLog: [`+${WORKING}`, `+${ERROR}`, `-${WORKING}`],
  },
] as const;

// The working reaction is fixed even when ackReaction or caller emoji maps say otherwise.
const initialEmojiCases = [
  { label: "default ack", initialEmoji: "👀", emojis: undefined },
  { label: "configured 👍 ack", initialEmoji: "👍", emojis: undefined },
  {
    label: "Telegram-style resolved emoji map",
    initialEmoji: "👍",
    emojis: { ...DEFAULT_EMOJIS, queued: "👍" },
  },
] as const;

describe("quiet status reaction lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(adapterCases)("$name", ({ createAdapter, doneLog, errorLog }) => {
    it.each(initialEmojiCases)(
      "shows working then ✅ and keeps ✅ after restoreInitial ($label)",
      async ({ initialEmoji, emojis }) => {
        const { adapter, log, visible } = createAdapter();
        const ctrl = createStatusReactionController({
          enabled: true,
          adapter,
          initialEmoji,
          presentation: "quiet",
          emojis,
        });

        const afterQueued = await driveActivity(ctrl, log);
        // queued, thinking, every tool, compacting, and stalls all share the one working emoji.
        expect(afterQueued).toEqual([`+${WORKING}`]);
        expect(log).toEqual([`+${WORKING}`]);

        await ctrl.setDone();
        await ctrl.restoreInitial();
        await vi.advanceTimersByTimeAsync(holdAndStallMs);
        void ctrl.setThinking();
        await vi.advanceTimersByTimeAsync(holdAndStallMs);

        expect(log).toEqual(doneLog);
        expect(visible()).toBe(DONE);
        const forbidden =
          initialEmoji === WORKING ? INTERMEDIATE_EMOJIS : [...INTERMEDIATE_EMOJIS, initialEmoji];
        for (const emoji of forbidden) {
          expect(log).not.toContain(`+${emoji}`);
        }
      },
    );

    it("shows ❌ on error and keeps it after restoreInitial", async () => {
      const { adapter, log, visible } = createAdapter();
      const ctrl = createStatusReactionController({
        enabled: true,
        adapter,
        initialEmoji: "👍",
        presentation: "quiet",
      });

      await driveActivity(ctrl, log);
      await ctrl.setError();
      await ctrl.restoreInitial();
      await vi.advanceTimersByTimeAsync(holdAndStallMs);

      expect(log).toEqual(errorLog);
      expect(visible()).toBe(ERROR);
    });

    it("restoreInitial without a terminal keeps the working emoji (silent success)", async () => {
      const { adapter, log, visible } = createAdapter();
      const ctrl = createStatusReactionController({
        enabled: true,
        adapter,
        initialEmoji: "👍",
        presentation: "quiet",
      });

      await driveActivity(ctrl, log);
      await ctrl.restoreInitial();
      await vi.advanceTimersByTimeAsync(holdAndStallMs);

      expect(log).toEqual([`+${WORKING}`]);
      expect(visible()).toBe(WORKING);
    });
  });

  it("explicit clear still removes the terminal reaction", async () => {
    const { adapter, log } = createSingleSlotAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👍",
      presentation: "quiet",
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(0);
    await ctrl.setDone();
    await ctrl.clear();

    expect(log).toEqual([`+${WORKING}`, `+${DONE}`, "clear"]);
  });
});
