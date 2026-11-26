import { createEffect, createSignal, type Accessor } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { parseAgentSessionKey, resolveUiDefaultAgentId } from "../lib/sessions/session-key.ts";

type PluginSessionTarget = {
  context: ApplicationContext | null;
  sessionKey: string | null;
  agentId?: string;
};

/** The routing facts session-settings owners read from a chat pane, taken from the application. */
export function pluginSessionScope(context: ApplicationContext) {
  return {
    sessions: context.sessions,
    get hello() {
      return context.gateway.snapshot.hello;
    },
    get agentsList() {
      return context.agents.state.agentsList;
    },
  };
}

export function pluginSessionAgentId(context: ApplicationContext, target: PluginSessionTarget) {
  return (
    target.agentId ||
    (target.sessionKey ? parseAgentSessionKey(target.sessionKey)?.agentId : undefined) ||
    resolveUiDefaultAgentId(pluginSessionScope(context))
  );
}

/**
 * The live row of a plugin's target conversation. Dock conversations can be
 * outside the visible roster, so the session owner observes the row directly.
 */
export function observePluginSessionRow(
  target: PluginSessionTarget,
): Accessor<GatewaySessionRow | null> {
  const [row, setRow] = createSignal<GatewaySessionRow | null>(null);
  createEffect(
    () => {
      const context = target.context;
      const key = target.sessionKey;
      return context && key
        ? { context, key, agentId: pluginSessionAgentId(context, target) }
        : undefined;
    },
    (observed) => {
      setRow(null);
      if (!observed) {
        return undefined;
      }
      const { context, key, agentId } = observed;
      const observation = context.sessions.observeRow({ key, agentId }, (next) => setRow(next));
      setRow(observation.row);
      return () => observation.dispose();
    },
  );
  return row;
}
