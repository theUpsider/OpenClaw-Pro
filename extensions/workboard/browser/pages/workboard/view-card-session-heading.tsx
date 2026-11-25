/** @jsxImportSource @solidjs/web */
import { createMemo } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard, WorkboardLifecycle } from "../../lib/workboard/types.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import {
  OpenSessionCardAction,
  StartExecutionButton,
  CardAction,
  type getCardActionState,
} from "./view-card-actions.tsx";
import {
  formatLifecycle,
  InteractionSpinner,
  renderLifecycleIcon,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { getSessionStatus, SessionStatusBadge } from "./view-session-status.tsx";

const workboardCardDetailDescriptionId = "workboard-card-detail-description";

export function CardSessionHeading(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  lifecycle: WorkboardLifecycle;
  action: ReturnType<typeof getCardActionState>;
  tab: "overview" | "session";
}) {
  const formatted = createMemo(() => formatLifecycle(props.lifecycle));
  const sessionStatus = createMemo(() => getSessionStatus(props.card, props.lifecycle));
  const sessionStateLabel = () => formatted().label;
  const sessionEmpty = () => props.lifecycle.state === "unlinked" && !props.action.linkedSessionKey;
  // The dictation fallback owns the row only when the card has no execution session;
  // an unresolvable interaction leaves the row exactly as it was before this slice.
  const interaction = createMemo(() => (sessionEmpty() ? props.action.interaction : undefined));
  const interactionName = createMemo(
    () =>
      interaction()?.session.displayName ??
      interaction()?.session.label ??
      // A resolved conversation without a title is still a session; "No session yet"
      // would contradict the spinner next to it.
      (interaction() ? t("workboard.fieldSession") : undefined),
  );
  const rowTitle = () =>
    sessionEmpty() ? (interactionName() ?? sessionStateLabel()) : sessionStateLabel();
  return (
    <div class="workboard-detail__execution-main">
      <div class="workboard-detail__session-row" title={formatted().detail}>
        {sessionEmpty() || !sessionStatus().visible ? (
          <span
            class="workboard-detail__session-state-icon"
            role="img"
            aria-label={rowTitle()}
            title={rowTitle()}
          >
            {!sessionEmpty() ? (
              renderLifecycleIcon(props.lifecycle)
            ) : interaction()?.state === "live" ? (
              <InteractionSpinner />
            ) : interaction() ? (
              icons.messageSquare
            ) : (
              icons.bot
            )}
          </span>
        ) : undefined}
        <div class="workboard-detail__session-copy">
          <span
            class="workboard-detail__session-name"
            id={props.tab === "overview" ? workboardCardDetailDescriptionId : undefined}
          >
            {sessionEmpty()
              ? (interactionName() ?? t("workboard.detailNoSessionYet"))
              : (props.lifecycle.session?.displayName ??
                props.lifecycle.session?.label ??
                (props.action.linkedSessionKey ? t("workboard.fieldSession") : formatted().label))}
          </span>
          {!sessionEmpty() && sessionStatus().detail ? (
            <p class="workboard-detail__session-description" textContent={sessionStatus().detail} />
          ) : undefined}
          {interaction() ? (
            <p class="workboard-detail__session-help">
              {t(
                interaction()?.state === "live"
                  ? "workboard.interactionRunningHelp"
                  : "workboard.interactionDoneHelp",
              )}
            </p>
          ) : undefined}
          {sessionEmpty() &&
          !interaction() &&
          props.action.showStartControls &&
          !props.action.archived ? (
            <p class="workboard-detail__session-help">
              {t("workboard.detailStartSessionHelp", {
                agent: cardAgentLabel(props.card, props.workboard.agentsList),
              })}
            </p>
          ) : undefined}
        </div>
        <SessionStatusBadge presentation={sessionStatus()} />
      </div>
      <div class="workboard-detail__actions">
        {props.tab === "overview" && props.action.showStartControls ? (
          <StartExecutionButton
            workboard={props.workboard}
            card={props.card}
            engine={null}
            mode={"autonomous"}
          />
        ) : undefined}
        {props.tab === "overview" &&
        props.action.writable &&
        props.action.linkedSessionKey &&
        props.action.live ? (
          <CardAction
            kind="stop"
            workboard={props.workboard}
            card={props.card}
            busy={props.action.busy}
          />
        ) : undefined}
        <OpenSessionCardAction
          workboard={props.workboard}
          session={props.action.sessionTarget ?? props.action.interactionTarget}
          options={{ quiet: true }}
        />
      </div>
    </div>
  );
}
