import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

// Tool-specific reaction emojis are independent of graphical tool display metadata.
const TOOL_REACTION_EMOJIS = new Map([
  ["bash", "🛠️"],
  ["computer", "🖱️"],
  ["mobile_ui", "📱"],
  ["screen", "🖥️"],
  ["theme", "🎨"],
  ["terminal", "⌨️"],
  ["portal", "🌐"],
  ["process", "🧰"],
  ["gateway_process", "🧰"],
  ["read", "📖"],
  ["write", "✍️"],
  ["edit", "📝"],
  ["personal_instructions", "📝"],
  ["presence", "🧩"],
  ["attach", "📎"],
  ["api", "🌐"],
  ["browser", "🌐"],
  ["canvas", "🖼️"],
  ["dashboard", "📋"],
  ["nodes", "📱"],
  ["cron", "⏰"],
  ["get_goal", "🎯"],
  ["create_goal", "🎯"],
  ["update_goal", "🎯"],
  ["progress_card", "🗺️"],
  ["ask_user", "❓"],
  ["secrets", "🔑"],
  ["suggest_task", "✨"],
  ["dismiss_task", "🗑️"],
  ["skill_workshop", "🧰"],
  ["skill_library", "🧰"],
  ["openclaw", "🦀"],
  ["gateway", "🔌"],
  ["plugins", "🧩"],
  ["exec", "🛠️"],
  ["tool_call", "🧰"],
  ["dispatch_action", "🧰"],
  ["tool_call_update", "🧰"],
  ["session_status", "📊"],
  ["github_publish", "🔀"],
  ["github_identity_status", "🔐"],
  ["sessions", "🗂️"],
  ["sessions_list", "🗂️"],
  ["conversations_list", "💬"],
  ["conversations_send", "📨"],
  ["conversations_turn", "↔️"],
  ["sessions_send", "📨"],
  ["sessions_history", "🧾"],
  ["sessions_search", "🔎"],
  ["transcripts", "🎙️"],
  ["sessions_spawn", "🧑‍🔧"],
  ["agents_wait", "⏳"],
  ["structured_output", "🧾"],
  ["subagents", "🤖"],
  ["agents_list", "🧭"],
  ["memory_search", "🧠"],
  ["memory_get", "📓"],
  ["skills_search", "🔍"],
  ["skills_read", "📖"],
  ["web_search", "🔎"],
  ["web_fetch", "📄"],
  ["code_execution", "🧮"],
  ["decision_evaluate", "⚖️"],
  ["message", "✉️"],
  ["apply_patch", "🩹"],
  ["image", "🖼️"],
  ["view_image", "🖼️"],
  ["image_generate", "🎨"],
  ["music_generate", "🎵"],
  ["video_generate", "🎬"],
  ["pdf", "📑"],
  ["sessions_yield", "⏸️"],
  ["tts", "🔊"],
]);

export type StatusReactionAdapter = {
  setReaction: (emoji: string) => Promise<void>;
  /** Clear all status reactions for single-slot platforms such as WhatsApp. */
  clearReaction?: () => Promise<void>;
  /** Remove a specific reaction emoji (optional — needed for Discord-style platforms). */
  removeReaction?: (emoji: string) => Promise<void>;
};

export type StatusReactionEmojis = Partial<typeof DEFAULT_EMOJIS>;

export type StatusReactionTiming = Partial<typeof DEFAULT_TIMING>;

export type StatusReactionController = {
  setQueued: () => Promise<void> | void;
  setThinking: () => Promise<void> | void;
  setTool: (toolName?: string) => Promise<void> | void;
  setCompacting: () => Promise<void> | void;
  /** Cancel any pending debounced emoji (useful before forcing a state transition). */
  cancelPending: () => void;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
};

export const DEFAULT_EMOJIS = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  deploy: "🛫",
  build: "🏗️",
  concierge: "💁",
  done: "✅",
  error: "❌",
  stallSoft: "⏳",
  stallHard: "⚠️",
  compacting: "🗜️",
};

/** Quiet presentation: one working reaction for every phase, then a terminal reaction that stays. */
export const QUIET_STATUS_REACTION_EMOJIS = {
  working: "👀",
  done: "✅",
  error: "❌",
} as const;

export const DEFAULT_TIMING = {
  debounceMs: 700,
  stallSoftMs: 10_000,
  stallHardMs: 30_000,
  doneHoldMs: 1500,
  errorHoldMs: 2500,
};

export const CODING_TOOL_TOKENS: string[] = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "session_status",
  "bash",
];

export const WEB_TOOL_TOKENS: string[] = [
  "web_search",
  "web-search",
  "web_fetch",
  "web-fetch",
  "browser",
];

export const DEPLOY_TOOL_TOKENS: string[] = [
  "fastlane",
  "deploy",
  "upload",
  "testflight",
  "ship",
  "release",
  "publish",
  "distribute",
];

export const BUILD_TOOL_TOKENS: string[] = [
  "build",
  "compile",
  "xcode",
  "swift",
  "gradle",
  "cargo",
  "make",
  "cmake",
  "webpack",
  "vite",
  "tsc",
  "lint",
];

export const CONCIERGE_TOOL_TOKENS: string[] = [
  "navigate",
  "click",
  "fill",
  "screenshot",
  "scroll",
  "page",
  "form",
  "puppeteer",
  "playwright",
  "selenium",
  "chromedp",
];

export function resolveToolEmoji(
  toolName: string | undefined,
  emojis: Required<StatusReactionEmojis>,
  emojiOverrides?: StatusReactionEmojis,
): string {
  const normalized = normalizeOptionalLowercaseString(toolName) ?? "";
  if (!normalized) {
    return emojis.tool;
  }

  const category = DEPLOY_TOOL_TOKENS.some((token) => normalized.includes(token))
    ? "deploy"
    : BUILD_TOOL_TOKENS.some((token) => normalized.includes(token))
      ? "build"
      : CONCIERGE_TOOL_TOKENS.some((token) => normalized.includes(token))
        ? "concierge"
        : WEB_TOOL_TOKENS.some((token) => normalized.includes(token))
          ? "web"
          : CODING_TOOL_TOKENS.some((token) => normalized.includes(token))
            ? "coding"
            : "tool";
  if (emojiOverrides?.[category] !== undefined) {
    return emojis[category];
  }
  return TOOL_REACTION_EMOJIS.get(normalized) ?? emojis[category];
}

/** Defer reaction removal until cleanup to avoid flicker without atomic replacement. */
export function createStatusReactionController(params: {
  enabled: boolean;
  adapter: StatusReactionAdapter;
  initialEmoji: string;
  /**
   * Acknowledgement keeps one working reaction; only actual errors replace it.
   * Quiet holds QUIET_STATUS_REACTION_EMOJIS.working for every phase regardless of
   * initialEmoji, then ends on done/error, which restoreInitial() leaves in place.
   * Only `emojis.done`/`emojis.error` overrides apply to quiet (transport substitutes).
   */
  presentation?: "activity" | "acknowledgement" | "quiet";
  emojis?: StatusReactionEmojis;
  timing?: StatusReactionTiming;
  onError?: (err: unknown) => void;
}): StatusReactionController {
  const { enabled, adapter, initialEmoji, onError } = params;
  const presentation = params.presentation ?? "activity";
  const showActivity = presentation === "activity";
  const quiet = presentation === "quiet";
  // Non-activity presentations hold this for every phase; restoreInitial() returns to it.
  const baseEmoji = quiet ? QUIET_STATUS_REACTION_EMOJIS.working : initialEmoji;

  const emojis: Required<StatusReactionEmojis> = {
    ...DEFAULT_EMOJIS,
    queued: params.emojis?.queued ?? initialEmoji,
    ...(quiet
      ? { done: QUIET_STATUS_REACTION_EMOJIS.done, error: QUIET_STATUS_REACTION_EMOJIS.error }
      : {}),
    ...params.emojis,
  };

  const timing: Required<StatusReactionTiming> = {
    ...DEFAULT_TIMING,
    ...params.timing,
  };

  let currentEmoji = "";
  let pendingEmoji = "";
  let debounceTimer: NodeJS.Timeout | null = null;
  let stallTimers: NodeJS.Timeout[] = [];
  let terminalHold: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  let terminalHoldGeneration = 0;
  let finished = false;
  let keepTerminal = false;
  let chainPromise = Promise.resolve();
  const activeEmojis = new Set<string>();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    chainPromise = chainPromise.then(fn, fn);
    return chainPromise;
  }

  function clearActivityTimers(): void {
    clearDebounceTimer();
    clearStallTimers();
  }

  function clearStallTimers(): void {
    for (const timer of stallTimers) {
      clearTimeout(timer);
    }
    stallTimers = [];
  }

  function cancelTerminalHold(): void {
    terminalHoldGeneration += 1;
    const hold = terminalHold;
    if (!hold) {
      return;
    }
    terminalHold = null;
    clearTimeout(hold.timer);
    hold.resolve();
  }

  function waitForTerminalHold(holdMs: number, generation: number): Promise<void> {
    if (holdMs <= 0 || generation !== terminalHoldGeneration) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        terminalHold = null;
        resolve();
      }, holdMs);
      terminalHold = { timer, resolve };
    });
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function resetStallTimers(): void {
    if (!showActivity) {
      return;
    }
    clearStallTimers();
    stallTimers = (["stallSoft", "stallHard"] as const).map((phase) =>
      setTimeout(() => {
        scheduleEmoji(emojis[phase], { immediate: true, skipStallReset: true });
      }, timing[`${phase}Ms`]),
    );
  }

  async function removeActiveEmojis(options: { keepEmoji?: string } = {}): Promise<void> {
    if (!adapter.removeReaction) {
      return;
    }

    for (const emoji of activeEmojis) {
      if (emoji === options.keepEmoji) {
        continue;
      }
      try {
        await adapter.removeReaction(emoji);
      } catch (err) {
        onError?.(err);
      } finally {
        activeEmojis.delete(emoji);
      }
    }
  }

  async function applyEmoji(newEmoji: string): Promise<void> {
    try {
      if (!adapter.removeReaction || !activeEmojis.has(newEmoji)) {
        await adapter.setReaction(newEmoji);
      }

      activeEmojis.add(newEmoji);
      currentEmoji = newEmoji;
    } catch (err) {
      onError?.(err);
    }
  }

  function scheduleEmoji(
    requestedEmoji: string,
    options: { immediate?: boolean; skipStallReset?: boolean } = {},
  ): void {
    if (!enabled || finished) {
      return;
    }
    const emoji = showActivity ? requestedEmoji : baseEmoji;

    // Skip duplicate sends while still refreshing stall timers for active phases.
    if (emoji === currentEmoji || emoji === pendingEmoji) {
      if (!options.skipStallReset) {
        resetStallTimers();
      }
      return;
    }

    pendingEmoji = emoji;
    clearDebounceTimer();
    const applyPendingEmoji = async () => {
      await applyEmoji(emoji);
      pendingEmoji = "";
    };

    if (options.immediate) {
      void enqueue(applyPendingEmoji);
    } else {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void enqueue(applyPendingEmoji);
      }, timing.debounceMs);
    }

    if (!options.skipStallReset) {
      resetStallTimers();
    }
  }

  function finishWithEmoji(emoji: string, holdMs: number): Promise<void> {
    if (!enabled) {
      return Promise.resolve();
    }

    finished = true;
    keepTerminal = quiet;
    clearActivityTimers();
    const holdGeneration = terminalHoldGeneration;

    // The serialized hold keeps an immediate restore queued, while explicit clear can cancel it.
    return enqueue(async () => {
      await applyEmoji(emoji);
      await removeActiveEmojis({ keepEmoji: emoji });
      pendingEmoji = "";
      await waitForTerminalHold(holdMs, holdGeneration);
    });
  }

  async function clear(): Promise<void> {
    if (!enabled) {
      return;
    }

    clearActivityTimers();
    cancelTerminalHold();
    finished = true;
    keepTerminal = false;

    await enqueue(async () => {
      if (adapter.clearReaction) {
        try {
          await adapter.clearReaction();
        } catch (err) {
          onError?.(err);
        } finally {
          activeEmojis.clear();
        }
      } else {
        await removeActiveEmojis();
      }
      currentEmoji = "";
      pendingEmoji = "";
    });
  }

  async function restoreInitial(): Promise<void> {
    if (!enabled) {
      return;
    }

    if (keepTerminal) {
      // Quiet terminal reactions are the visible outcome; settle without reverting them.
      await chainPromise;
      return;
    }
    const alreadyInitial = currentEmoji === baseEmoji;
    const pendingBeforeClear = pendingEmoji;
    const hadDebouncedPending = debounceTimer !== null;
    const hasExtraActiveEmoji = Array.from(activeEmojis).some((emoji) => emoji !== baseEmoji);
    clearActivityTimers();
    if (
      !finished &&
      alreadyInitial &&
      (!pendingBeforeClear || hadDebouncedPending) &&
      !hasExtraActiveEmoji
    ) {
      pendingEmoji = "";
      return;
    }
    if (!finished && pendingBeforeClear === baseEmoji && !hadDebouncedPending) {
      await chainPromise;
      return;
    }

    await enqueue(async () => {
      await applyEmoji(baseEmoji);
      await removeActiveEmojis({ keepEmoji: baseEmoji });
      pendingEmoji = "";
    });
  }

  return {
    setQueued: () => scheduleEmoji(emojis.queued, { immediate: true }),
    setThinking: () => scheduleEmoji(emojis.thinking),
    setTool: (toolName) => scheduleEmoji(resolveToolEmoji(toolName, emojis, params.emojis)),
    setCompacting: () => scheduleEmoji(emojis.compacting),
    cancelPending() {
      clearDebounceTimer();
      pendingEmoji = "";
    },
    // Holds only delay an immediate restore; quiet terminals are never restored.
    setDone: () =>
      presentation === "acknowledgement"
        ? finishWithEmoji(initialEmoji, 0)
        : finishWithEmoji(emojis.done, quiet ? 0 : timing.doneHoldMs),
    setError: () => finishWithEmoji(emojis.error, quiet ? 0 : timing.errorHoldMs),
    clear,
    restoreInitial,
  };
}
