import type { WorkboardCard } from "@openclaw/workboard-contract";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { WorkboardStore } from "./store.js";

type WorkboardExactSessionRead = (sessionKey: string) => Promise<{
  sessions: readonly { key: string }[];
  /**
   * True only when the reader consulted the Gateway. Without it an empty list is an
   * unknown, and absence conclusions must never be drawn from it.
   */
  authoritative?: boolean;
}>;

/**
 * Tracks a card's persisted session link across sweeps. A found session clears an
 * unreconciled miss. Absence counts only in a complete snapshot and after an exact read
 * of the agent-scoped key also finds nothing: partial snapshots, read errors, an
 * unavailable Gateway, and agentless keys stay unknown and change nothing. Returns true
 * when this miss blocked the card.
 */
export async function reconcileDanglingWorkboardSession(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  session: { key: string } | undefined;
  complete?: boolean;
  readSession?: WorkboardExactSessionRead;
  now: number;
}): Promise<boolean> {
  const { card, now } = params;
  if (params.session) {
    if (card.metadata?.automation?.danglingSession && card.status !== "blocked") {
      await params.store.reconcileDanglingSession(card.id, {
        sessionKey: params.session.key,
        present: true,
        now,
      });
    }
    return false;
  }
  const sessionKey = card.sessionKey;
  if (
    !params.complete ||
    !params.readSession ||
    !sessionKey ||
    !parseAgentSessionKey(sessionKey) ||
    (card.status !== "running" && card.execution?.status !== "running")
  ) {
    return false;
  }
  let present: boolean;
  try {
    const exact = await params.readSession(sessionKey);
    // Only a reader that actually consulted the Gateway can confirm an absence. An
    // undeclared or unavailable reader yields an unknown, and this path never blocks
    // on an unknown.
    if (exact.authoritative !== true) {
      return false;
    }
    present = exact.sessions.some((session) => session.key === sessionKey);
  } catch {
    return false;
  }
  const outcome = await params.store.reconcileDanglingSession(card.id, {
    sessionKey,
    present,
    now,
  });
  return outcome === "blocked";
}
