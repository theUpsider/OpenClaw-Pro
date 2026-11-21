import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiHost,
  ControlUiSessionListResult,
  ControlUiSessionListSubscription,
} from "openclaw/plugin-sdk/control-ui";
import type { GatewaySessionRow } from "../../api/types.ts";
import { workboardHost } from "../../host.ts";
import { formatUiError } from "../format-error.ts";
import { workboardCardSessionKey } from "./card-state.ts";
import { isReservedSessionKey, workboardSessionKeyMatches } from "./session-links.ts";
import type { WorkboardCard } from "./types.ts";

export type WorkboardSessionResolution =
  | { key: string; status: "resolved"; session: GatewaySessionRow }
  | {
      key: string;
      status: "unknown" | "unavailable" | "ambiguous";
      candidates?: readonly GatewaySessionRow[];
      error?: string;
    };

export function workboardCardSessionTarget(
  card: WorkboardCard,
  session?: BoardGetParams,
): BoardGetParams | undefined {
  const key = session?.sessionKey ?? workboardCardSessionKey(card);
  // Provisional links need a resolved key; reserved keys also need an explicit owner.
  // The card's current assignee does not identify the original execution.
  if (
    !key ||
    key.toLowerCase().startsWith("subagent:workboard-") ||
    (isReservedSessionKey(key) && !session?.agentId)
  ) {
    return undefined;
  }
  return session ?? { sessionKey: key };
}

function resolveSession(
  key: string,
  result: ControlUiSessionListResult,
): WorkboardSessionResolution {
  const exact = result.sessions.find(
    (session) => workboardHost().sessions.normalizeKey(session.key) === key,
  );
  if (exact) {
    return { key, status: "resolved", session: exact };
  }
  const candidates = result.sessions.filter((session) =>
    workboardSessionKeyMatches(session.key, key),
  );
  if (candidates.length > 1) {
    return { key, status: "ambiguous", candidates };
  }
  // Pending deletions can hide rows without changing pagination metadata.
  // Neither that gap nor a partial page establishes a provisional link's owner.
  if (result.hasMore !== false || (result.totalCount ?? 0) > result.sessions.length) {
    return { key, status: "unknown", candidates };
  }
  const session = candidates[0];
  return session ? { key, status: "resolved", session } : { key, status: "unavailable" };
}

/**
 * One open card owns one bounded lookup; the sidebar is not a session directory.
 * The execution route keeps its `excludeDock` default (the board deliberately hides
 * dock conversations); the interaction fallback reads its own dock-inclusive window
 * through `createWorkboardDockSessions` instead of relaxing this query.
 */
export function createWorkboardSessionResolver(host: ControlUiHost, notify: () => void) {
  let key = "";
  let active = false;
  let disposed = false;
  let subscription: ControlUiSessionListSubscription | undefined;
  let resolution: WorkboardSessionResolution | undefined;

  return {
    get resolution() {
      return resolution;
    },
    sync(sessionKey: string | undefined, enabled: boolean) {
      const nextKey = workboardHost().sessions.normalizeKey(sessionKey ?? "");
      if (disposed || (key === nextKey && active === enabled)) {
        return;
      }
      subscription?.dispose();
      subscription = undefined;
      key = nextKey;
      active = enabled;
      const reserved = isReservedSessionKey(key);
      resolution = key ? { key, status: reserved ? "ambiguous" : "unknown" } : undefined;
      if (!active || !key || reserved) {
        return;
      }
      try {
        subscription = host.sessions.observe(
          {
            search: key,
            archived: "all",
            limit: 2,
            configuredAgentsOnly: false,
            includeGlobal: false,
            includeUnknown: false,
            includeDerivedTitles: false,
            includeLastMessage: false,
          },
          ({ result, error }) => {
            resolution =
              result && !error
                ? resolveSession(key, result)
                : {
                    key,
                    status: "unknown",
                    ...(error ? { error } : {}),
                    candidates: result?.sessions.filter((session) =>
                      workboardSessionKeyMatches(session.key, key),
                    ),
                  };
            notify();
          },
        );
      } catch (error) {
        resolution = { key, status: "unknown", error: formatUiError(error) };
        notify();
      }
    },
    refresh() {
      const current = subscription;
      if (current) {
        void current.refresh().catch((error: unknown) => {
          if (!disposed && subscription === current) {
            resolution = {
              key,
              status: "unknown",
              candidates:
                resolution?.status === "resolved" ? [resolution.session] : resolution?.candidates,
              error: formatUiError(error),
            };
            notify();
          }
        });
      }
    },
    dispose() {
      disposed = true;
      subscription?.dispose();
      subscription = undefined;
    },
  };
}

/**
 * Rows one board view reads for the interaction fallback: the most recently updated
 * sessions, dock conversations included. A dock turn that just edited a card is the
 * newest row of the roster, so this window covers it; a conversation that fell out of
 * the window degrades to nothing rather than to a wrong live state.
 */
export const WORKBOARD_INTERACTION_WINDOW = 25;

export type WorkboardDockSessionsSnapshot = {
  readonly sessions: readonly GatewaySessionRow[];
};

const EMPTY_DOCK_SNAPSHOT: WorkboardDockSessionsSnapshot = { sessions: [] };

/**
 * The additive, dock-inclusive window behind `WorkboardProps.interactionSessions`. It
 * is a separate route on purpose: merging dock rows into `props.sessions` would move
 * the attention/"Needs you" filter and every other roster consumer. One subscription
 * per board view serving N cards, plus nothing per card.
 */
export function createWorkboardDockSessions(host: ControlUiHost, notify: () => void) {
  let enabled = false;
  let disposed = false;
  let subscription: ControlUiSessionListSubscription | undefined;
  let snapshot: WorkboardDockSessionsSnapshot = EMPTY_DOCK_SNAPSHOT;

  return {
    get snapshot() {
      return snapshot;
    },
    sync(next: boolean) {
      if (disposed || enabled === next) {
        return;
      }
      enabled = next;
      subscription?.dispose();
      subscription = undefined;
      if (!enabled) {
        snapshot = EMPTY_DOCK_SNAPSHOT;
        return;
      }
      try {
        subscription = host.sessions.observe(
          {
            archived: "all",
            limit: WORKBOARD_INTERACTION_WINDOW,
            configuredAgentsOnly: false,
            includeGlobal: false,
            includeUnknown: false,
            excludeDock: false,
            includeDerivedTitles: false,
            includeLastMessage: false,
          },
          ({ result, error }) => {
            // A failed read is informational: a card keeps its execution behaviour and
            // loses its fallback name. It is never a page error (invariant).
            snapshot = result && !error ? { sessions: result.sessions } : EMPTY_DOCK_SNAPSHOT;
            notify();
          },
        );
      } catch {
        snapshot = EMPTY_DOCK_SNAPSHOT;
        notify();
      }
    },
    refresh() {
      const current = subscription;
      if (current) {
        void current.refresh().catch(() => undefined);
      }
    },
    dispose() {
      disposed = true;
      subscription?.dispose();
      subscription = undefined;
    },
  };
}
