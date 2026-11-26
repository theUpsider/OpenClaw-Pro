import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import { workboardHost } from "../../host.ts";
import { workboardCardSessionKey } from "./card-state.ts";
import { isWorkboardSessionStale } from "./lifecycle.ts";
import { isReservedSessionKey } from "./session-links.ts";
import type { WorkboardCard, WorkboardInteraction } from "./types.ts";

/**
 * The dock conversation that last edited a card, resolved against the dock-inclusive
 * window. Reference data: it feeds "Open session" and the session tab, never the abort
 * target of `stopWorkboardCard` and never a liveness source for the Stop control.
 */
export type WorkboardInteractionLink = {
  interaction: WorkboardInteraction;
  session: GatewaySessionRow;
  state: "live" | "idle";
};

/** The interaction is a fallback for cards that own no execution session. */
export function resolveWorkboardInteraction(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[] | undefined,
): WorkboardInteractionLink | undefined {
  // A card with an execution session is untouched: the interaction is neither shown
  // nor consulted, so its Stop control keeps aborting the execution session.
  if (workboardCardSessionKey(card)) {
    return undefined;
  }
  const interaction = card.metadata?.interaction;
  if (!interaction) {
    return undefined;
  }
  const key = workboardHost().sessions.normalizeKey(interaction.sessionKey);
  if (!key || isReservedSessionKey(key)) {
    return undefined;
  }
  // Only a row the window actually carries earns a reference. A dock conversation that
  // no longer exists leaves nothing behind: no name, no link, no spinner, no warning.
  const session = (sessions ?? []).find(
    (candidate) => workboardHost().sessions.normalizeKey(candidate.key) === key,
  );
  if (!session) {
    return undefined;
  }
  return { interaction, session, state: isInteractionLive(session) ? "live" : "idle" };
}

/** A stale "running" row without an active run is not a live editing turn. */
function isInteractionLive(session: GatewaySessionRow): boolean {
  return (
    session.hasActiveRun === true ||
    (session.status === "running" && !isWorkboardSessionStale(session))
  );
}

/**
 * The interaction's "Open session" target. Additive on purpose: it must never reach
 * `getCardActionState().sessionTarget`, which is the `chat.abort` target.
 */
export function workboardInteractionTarget(
  link: WorkboardInteractionLink | undefined,
): BoardGetParams | undefined {
  if (!link) {
    return undefined;
  }
  const agentId = link.session.agentId ?? link.interaction.agentId;
  return { sessionKey: link.session.key, ...(agentId ? { agentId } : {}) };
}
