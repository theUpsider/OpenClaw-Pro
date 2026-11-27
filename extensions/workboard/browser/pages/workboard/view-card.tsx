/** @jsxImportSource @solidjs/web */
import { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, For, Show } from "solid-js";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import type { createElementRefs } from "../../lib/element-refs.ts";
import { workboardCardBoardId } from "../../lib/workboard/board-filter.ts";
import { getCardAlerts, visibleCardAlerts } from "../../lib/workboard/card-alerts.ts";
import {
  boardClassifications,
  resolveCardClassification,
} from "../../lib/workboard/classification.ts";
import { getWorkboardDependencyState } from "../../lib/workboard/card-state.ts";
import { needsOperatorAttention } from "../../lib/workboard/operator-attention.ts";
import { getWorkboardLifecycle } from "../../lib/workboard/lifecycle.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { getCardActionState, CardMoveControl } from "./view-card-actions.tsx";
import {
  CardAcceptanceMarker,
  CardNeedsYouMarker,
  CardAlertView,
  CardUpdatedTime,
  CardPriority,
  CardMeta,
  CardCounts,
  CardSession,
  CardClassificationAnnouncement,
  CardLabelChip,
} from "./view-card-content.tsx";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.tsx";
import { equalCardActions, WorkboardCardMenuTrigger } from "./view-card-menu.tsx";
import { workboardViewState, type WorkboardProps } from "./view-helpers.tsx";
import { getSessionStatus } from "./view-session-status.tsx";
function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea, details"))
    : false;
}
export type WorkboardCardSurface = "page" | "widget" | "list";
/**
 * What the card shows beside its face in the "Needs you" lens. `full` keeps every element (the
 * board, list, widget and detail surfaces); `reduced` drops what the face already carries, so the
 * two do not compete for attention: the counts row and the "updated N ago" line are redundant with
 * the face's evidence line and time-in-status, the label chips stop at three, and the alert banner
 * moves into the face's strip instead of standing beside it.
 */
export type WorkboardCardDetail = "full" | "reduced";
export function WorkboardCardView(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  surface: WorkboardCardSurface;
  cardRefs?: ReturnType<typeof createElementRefs<HTMLElement>>;
  detail?: WorkboardCardDetail;
}) {
  const state = workboardViewState(() => input.workboard);
  const action = createMemo(
    () => {
      void input.workboard.revision;
      return getCardActionState(input.workboard, input.card);
    },
    {
      equals: equalCardActions,
    },
  );
  const widget = createMemo(() => input.surface === "widget");
  // Beside a face the card is context, not the reading surface, so its duplicate facts drop out.
  const reduced = createMemo(() => input.detail === "reduced");
  const dependencies = createMemo(() =>
    getWorkboardDependencyState(input.card, state().cards, !state().nextCursor),
  );
  const lifecycle = createMemo(() =>
    getWorkboardLifecycle(input.card, input.workboard.sessions, input.workboard.sessionResolution),
  );
  const now = createMemo(() => {
    void input.workboard.revision;
    return Date.now();
  });
  // Read the resolver while the host is active: card updates can still land after disposal.
  const resolveColor = workboardHost().components.resolveAppearanceColor;
  const classification = createMemo(() =>
    resolveCardClassification(
      input.card.labels,
      boardClassifications(action().state.boards, workboardCardBoardId(input.card)),
      resolveColor,
    ),
  );
  const updatedAt = createMemo(() => asDateTimestampMs(input.card.updatedAt));
  const sessionStatus = createMemo(() => getSessionStatus(input.card, lifecycle(), now()));
  const alerts = createMemo(() =>
    visibleCardAlerts(
      getCardAlerts(input.card, lifecycle(), dependencies(), now()),
      sessionStatus().visible || sessionStatus().state === "running"
        ? sessionStatus().state
        : undefined,
    ),
  );
  const showDetails = () => {
    openCardDetails(state(), input.card);
    input.workboard.onRequestUpdate?.();
  };
  const MoveAction = () => (
    <>
      {!action().archived && (action().writable || widget()) ? (
        <CardMoveControl
          workboard={input.workboard}
          card={input.card}
          busy={action().busy || !action().writable}
          options={{
            wide: widget(),
          }}
        />
      ) : null}
    </>
  );
  const selected = createMemo(() => state().selectedCardIds.has(input.card.id));
  const dragged = createMemo(() => state().draggedCardId === input.card.id);
  const detailOpen = createMemo(() => state().detailCardId === input.card.id);
  const draggable = createMemo(
    () => action().writable && !action().archived && !state().dispatching && !state().nextCursor,
  );
  const alertDescriptionId = createMemo(
    () => `workboard-card-alert-${input.surface}-${input.card.id}`,
  );
  const selectable = createMemo(() => !widget() && action().writable && !action().archived);
  const selectionMode = createMemo(() => selectable() && state().selectedCardIds.size > 0);
  const toggleSelection = () => {
    if (!selectable() || action().busy || state().dispatching) {
      return;
    }
    if (state().selectedCardIds.has(input.card.id)) {
      state().selectedCardIds.delete(input.card.id);
    } else {
      state().selectedCardIds.add(input.card.id);
    }
    input.workboard.onRequestUpdate?.();
  };
  const ActionsMenu = () => (
    <Show when={!widget() && (action().writable || action().linkedSessionKey || action().interactionTarget)}>
      <div class="workboard-card__action-menu">
        <WorkboardCardMenuTrigger cardId={input.card.id} />
      </div>
    </Show>
  );
  const ListContents = () => (
    <>
      {input.surface === "list" ? (
        <>
          <div class="workboard-list-row__priority">
            <CardPriority card={input.card} />
          </div>
          <div class="workboard-list-row__identity">
            <div class="workboard-list-row__title">
              <h3
                class="workboard-truncate"
                title={[input.card.title, input.card.notes].filter(Boolean).join("\n\n")}
              >
                {input.card.title}
              </h3>
              {input.card.labels.length ? (
                <div class="workboard-card__labels">
                  <CardClassificationAnnouncement classification={classification()} />
                  <For each={classification().orderedLabels.slice(0, 1)} keyed={(label) => label}>
                    {(label) => (
                      <CardLabelChip label={label()} color={classification().colors.get(label())} />
                    )}
                  </For>
                  {input.card.labels.length > 1 ? (
                    <span
                      class="workboard-chip"
                      title={classification().orderedLabels.slice(1).join(", ")}
                      aria-label={t("workboard.cardMoreLabels", {
                        count: String(input.card.labels.length - 1),
                        labels: classification().orderedLabels.slice(1).join(", "),
                      })}
                    >
                      +{input.card.labels.length - 1}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {action().archived ? (
                <span class="workboard-card__archived">{t("workboard.archived")}</span>
              ) : null}
              <CardNeedsYouMarker card={input.card} />
              <CardAcceptanceMarker card={input.card} />
            </div>
            <div class="workboard-list-row__context">
              {alerts().length ? (
                <div class="workboard-list-row__alert">
                  <CardAlertView alerts={alerts()} descriptionId={alertDescriptionId()} />
                </div>
              ) : null}
              {reduced() ? null : <CardCounts card={input.card} />}
            </div>
          </div>
          <div class="workboard-list-row__session">
            <CardSession
              workboard={input.workboard}
              card={input.card}
              lifecycle={lifecycle()}
              status={sessionStatus()}
            />
          </div>
          <div class="workboard-list-row__updated">
            {reduced() ? null : <CardUpdatedTime updatedAt={updatedAt()} now={now()} />}
          </div>
          <div class="workboard-list-row__actions">
            <ActionsMenu />
          </div>
        </>
      ) : null}
    </>
  );
  return (
    <article
      ref={input.cardRefs?.ref(() => input.card.id)}
      class={[
        "workboard-card",
        input.surface === "list" ? "workboard-card--list" : "",
        `priority-${input.card.priority}`,
        action().busy ? "workboard-card--busy" : "",
        action().archived ? "workboard-card--archived" : "",
        dragged() ? "workboard-card--dragging" : "",
        selected() ? "workboard-card--selected" : "",
        widget() ? "workboard-card--widget" : "workboard-card--openable",
        classification().primary ? "workboard-card--classified" : "",
        needsOperatorAttention(input.card) ? "workboard-card--needs-you" : "",
      ]}
      style={
        classification().primary
          ? { "--workboard-card-accent": classification().primary?.color }
          : undefined
      }
      role={widget() ? undefined : "button"}
      tabindex={widget() ? undefined : "0"}
      aria-pressed={selectionMode() ? (selected() ? "true" : "false") : undefined}
      aria-describedby={alerts().length && !reduced() ? alertDescriptionId() : undefined}
      aria-keyshortcuts={selectable() ? "Shift+Enter Shift+Space" : undefined}
      title={
        widget() || !selectionMode()
          ? undefined
          : t(selected() ? "workboard.deselectCard" : "workboard.selectCard", {
              title: input.card.title,
            })
      }
      aria-haspopup={widget() || selectionMode() ? undefined : "dialog"}
      aria-expanded={widget() || selectionMode() ? undefined : detailOpen() ? "true" : "false"}
      aria-controls={widget() || selectionMode() ? undefined : workboardCardDetailDrawerId}
      draggable={draggable() ? "true" : "false"}
      onMouseDown={(event) => {
        if (event.button === 0 && event.shiftKey && selectable() && !isCardActionTarget(event)) {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onClick={(event: MouseEvent) => {
        if (!widget() && !isCardActionTarget(event)) {
          if (selectionMode() || (event.shiftKey && selectable())) {
            toggleSelection();
            return;
          }
          showDetails();
        }
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (widget() || isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        if (selectionMode() || (event.shiftKey && selectable())) {
          toggleSelection();
        } else {
          showDetails();
        }
        event.preventDefault();
      }}
      onDragStart={(event) => {
        if (!action().writable || action().archived || state().dispatching || state().nextCursor) {
          event.preventDefault();
          return;
        }
        state().draggedCardId = input.card.id;
        state().dragOverStatus = null;
        state().dragBeforeCardId = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", input.card.id);
          const source = event.currentTarget;
          const bounds = source.getBoundingClientRect();
          event.dataTransfer.setDragImage(
            source,
            event.clientX - bounds.left,
            event.clientY - bounds.top,
          );
        }
        input.workboard.onRequestUpdate?.();
      }}
      onDragEnd={() => {
        state().draggedCardId = null;
        state().dragOverStatus = null;
        state().dragBeforeCardId = null;
        input.workboard.onRequestUpdate?.();
      }}
    >
      {input.surface === "list" ? (
        <ListContents />
      ) : (
        <>
          {" "}
          <header class="workboard-card__title">
            <h3 class="workboard-truncate-two" title={input.card.title}>
              {input.card.title}
            </h3>
            <div class="workboard-card__header-actions">
              <ActionsMenu />
            </div>
          </header>
          <CardSession
            workboard={input.workboard}
            card={input.card}
            lifecycle={lifecycle()}
            status={sessionStatus()}
          />
          <CardMeta
            card={input.card}
            archived={action().archived}
            classification={classification()}
            {...(reduced() ? { maxLabels: 3 } : {})}
          />{" "}
          {reduced() ? null : (
            <CardAlertView alerts={alerts()} descriptionId={alertDescriptionId()} />
          )}
          {reduced() ? null : <CardCounts card={input.card} />}
          <footer class="workboard-card__footer">
            <CardPriority card={input.card} />{" "}
            {reduced() ? null : <CardUpdatedTime updatedAt={updatedAt()} now={now()} />}
          </footer>
          {widget() ? (
            <div class="workboard-card__actions workboard-card__actions--widget">
              <MoveAction />
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
