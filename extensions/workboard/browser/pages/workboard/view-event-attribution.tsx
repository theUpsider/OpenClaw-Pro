/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { WorkboardEvent } from "../../lib/workboard/index.ts";
import { agentDisplayName, type WorkboardAgentsList } from "./agent-filter.ts";
import { formatEventLabel, formatUpdatedTime } from "./view-helpers.tsx";

/**
 * One card event with the agent that caused it. Events written before the
 * Gateway recorded an agent, or by an operator, show only text and time.
 */
export function EventAttributionRow(props: {
  event: WorkboardEvent;
  agentsList: WorkboardAgentsList | null;
}) {
  return (
    <li>
      <span>
        {formatEventLabel(props.event)}
        <Show when={props.event.agentId}>
          {(id) => (
            <span class="workboard-detail__event-agent">
              {" "}
              {t("workboard.eventBy", {
                agent: agentDisplayName(
                  props.agentsList?.agents.find((agent) => agent.id === id()),
                  id(),
                ),
              })}
            </span>
          )}
        </Show>
      </span>
      <time>{formatUpdatedTime(props.event.at)}</time>
    </li>
  );
}
