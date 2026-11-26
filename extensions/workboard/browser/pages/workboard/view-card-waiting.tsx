/** @jsxImportSource @solidjs/web */
import { Show, createMemo } from "solid-js";
import { Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import type { WorkboardWaitingReason } from "../../lib/workboard/waiting-reason.ts";
import { cardAgentLabel, type WorkboardAgentsList } from "./agent-filter.ts";
import { formatUpdatedTime } from "./view-helpers.tsx";

function waitingText(
  reason: WorkboardWaitingReason,
  card: WorkboardCard,
  agentsList: WorkboardAgentsList | null,
): string {
  switch (reason.kind) {
    case "decision":
      return t("workboard.waitingDecision");
    case "blocked": {
      const detail = formatUiExternalText(reason.detail);
      return detail
        ? t("workboard.waitingBlockedDetail", { detail })
        : reason.parents.length
          ? t("workboard.waitingBlockedParents", { cards: reason.parents.join(", ") })
          : t("workboard.waitingBlocked");
    }
    case "restart":
      return t("workboard.waitingRestart", { session: formatUiExternalText(reason.sessionKey) });
    case "parents":
      return t("workboard.waitingParents", { cards: reason.parents.join(", ") });
    case "stale":
      return t("workboard.waitingStale", { detail: formatUiExternalText(reason.detail) });
    case "lane":
      return t("workboard.waitingLane", { agent: cardAgentLabel(card, agentsList) });
    case "queued":
      return t("workboard.waitingQueued", {
        position: String(reason.queue.position),
        total: String(reason.queue.total),
        agent: cardAgentLabel(card, agentsList),
        holder: formatUiExternalText(reason.queue.holder.title, reason.queue.holder.id),
      });
    case "dispatcher":
      return t("workboard.waitingDispatcher");
    case "review":
      return t(reason.automatic ? "workboard.waitingReviewAutomatic" : "workboard.waitingReview");
    case "notReleased":
      return t("workboard.waitingNotReleased");
    case "notSpecified":
      return t("workboard.waitingNotSpecified");
    case "scheduled": {
      const time = formatUpdatedTime(reason.at);
      return time ? t("workboard.waitingScheduledAt", { time }) : t("workboard.waitingScheduled");
    }
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unexpected workboard waiting reason: ${String(exhaustive)}`);
    }
  }
}

export function CardWaitingReason(props: {
  reason: WorkboardWaitingReason | undefined;
  card: WorkboardCard;
  agentsList: WorkboardAgentsList | null;
}) {
  const text = createMemo(() =>
    props.reason ? waitingText(props.reason, props.card, props.agentsList) : "",
  );
  return (
    <Show when={text()}>
      <div
        class={[
          "workboard-waiting",
          { "workboard-waiting--decision": props.reason?.kind === "decision" },
        ]}
        role="note"
        aria-label={t("workboard.waitingTitle")}
      >
        {/* Host-owned copy plus an escaped detail; block Markdown is valid here and
            keeps the waiting text consistent with the other card text. */}
        <Markdown markdown={text()} />
      </div>
    </Show>
  );
}
