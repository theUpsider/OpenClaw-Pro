/** @jsxImportSource @solidjs/web */
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { moveWorkboardCardToStatus } from "../../lib/workboard/card-settle.ts";
import { isActiveWorkboardCard, workboardCardSessionKey } from "../../lib/workboard/card-state.ts";
import { canStartWorkboardCard } from "../../lib/workboard/execution.ts";
import {
  archiveWorkboardCard,
  deleteWorkboardCard,
  findWorkboardSession,
  getWorkboardLaneQueue,
  getWorkboardState,
  startWorkboardCard,
  stopWorkboardCard,
  type WorkboardCard,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardStatus,
} from "../../lib/workboard/index.ts";
import {
  resolveWorkboardInteraction,
  workboardInteractionTarget,
} from "../../lib/workboard/interaction.ts";
import { workboardCardSessionTarget } from "../../lib/workboard/session-resolution.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { openEditModal } from "./view-card-modal.tsx";
import {
  canMutate,
  cardHasUnresolvedStartedRun,
  engineBlockedByRuntime,
  formatStatusLabel,
  workboardMutationContext,
  workboardViewState,
  type WorkboardProps,
} from "./view-helpers.tsx";
/**
 * Resolves false when a guard refused the move or the write failed. Only a failed
 * write sets the board error; callers that must not end silently report refusals.
 *
 * `expectedUpdatedAt` is the revision the caller rendered; passing it makes the store
 * refuse a move onto a card that changed since then instead of overwriting it. Omitting
 * it keeps the previous behaviour, where the store moves from its own latest read.
 */
export async function moveCardToStatus(
  props: WorkboardProps,
  card: WorkboardCard,
  status: WorkboardStatus,
  options: { labelsRemove?: readonly string[]; expectedUpdatedAt?: number } = {},
): Promise<boolean> {
  return await moveWorkboardCardToStatus(
    {
      host: props.host,
      client: props.client,
      requestUpdate: props.onRequestUpdate,
      connected: props.connected,
      ...(props.canWrite !== undefined ? { canWrite: props.canWrite } : {}),
    },
    card,
    status,
    options,
  );
}
export function CardMoveControl(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
  options?: {
    wide?: boolean;
  };
}) {
  const state = workboardViewState(() => input.workboard);
  const statuses = createMemo(() =>
    state().statuses.includes(input.card.status)
      ? state().statuses
      : [input.card.status, ...state().statuses],
  );
  const StatusSelect = () => {
    let select: HTMLSelectElement | undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (
        state().busyCardIds.has(input.card.id) ||
        state().dispatching ||
        !input.workboard.connected ||
        !input.workboard.client
      ) {
        event.preventDefault();
        return;
      }
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const status = statuses()[statuses().indexOf(input.card.status) + offset];
      if (!status) {
        return;
      }
      event.preventDefault();
      void moveCardToStatus(input.workboard, input.card, status);
    };
    onCleanup(() => {
      if (select) {
        select.removeEventListener("keydown", handleKeyDown);
      }
    });
    return (
      <select
        class="workboard-card__move-select"
        aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-label={`${t("workboard.fieldStatus")}: ${input.card.title}`}
        value={input.card.status}
        disabled={input.busy || !input.workboard.connected || !input.workboard.client}
        onChange={(event) => {
          const target = event.currentTarget;
          const status = statuses().find((candidate) => candidate === target.value);
          if (status) {
            void moveCardToStatus(input.workboard, input.card, status);
          }
        }}
        ref={(element: HTMLSelectElement) => {
          select = element;
          element.addEventListener("keydown", handleKeyDown);
        }}
      >
        <For each={statuses()} keyed={(status) => status}>
          {(status) => (
            <option value={status()} selected={status() === input.card.status}>
              {formatStatusLabel(status())}
            </option>
          )}
        </For>
      </select>
    );
  };
  return (
    <>
      {!isActiveWorkboardCard(input.card) || statuses().length < 2 ? null : (
        <label
          class={["workboard-card__move", input.options?.wide ? "workboard-card__move--wide" : ""]}
          title={t("workboard.fieldStatus")}
        >
          <StatusSelect />
          <span class="workboard-card__move-chevron" aria-hidden="true">
            {icons.chevronDown}
          </span>
        </label>
      )}
    </>
  );
}
export function getCardActionState(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const session = findWorkboardSession(card, props.sessions, props.sessionResolution);
  const linkedSessionKey = workboardCardSessionKey(card);
  const sessionTarget = workboardCardSessionTarget(
    card,
    session
      ? {
          sessionKey: session.key,
          ...(session.agentId
            ? {
                agentId: session.agentId,
              }
            : {}),
        }
      : undefined,
  );
  // The dictation fallback for cards without an execution session. Additive on
  // purpose: it never reaches `sessionTarget` (the `chat.abort` target of Stop) and
  // never `live` (which arms Stop). Only "Open session" and the session tab read it.
  const interaction = resolveWorkboardInteraction(card, props.interactionSessions);
  const interactionTarget = workboardInteractionTarget(interaction);
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const writable = canMutate(props);
  const live =
    cardHasUnresolvedStartedRun(card) ||
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  return {
    state,
    busy,
    live,
    linkedSessionKey,
    sessionTarget,
    interaction,
    interactionTarget,
    writable,
    showStartControls: writable && canStartWorkboardCard(card),
    archived: Boolean(card.metadata?.archivedAt),
  };
}
function CardActionButton(input: {
  params: {
    label: string;
    icon: JSX.Element;
    className?: string;
    disabled?: boolean;
    ariaHaspopup?: "dialog";
    onClick: (event: MouseEvent) => void;
    requestAction?: (action: () => void) => void;
  };
}) {
  return (
    <button
      class={["btn", input.params.className ?? ""]}
      type="button"
      aria-label={input.params.label}
      aria-haspopup={input.params.ariaHaspopup}
      disabled={input.params.disabled}
      onClick={(event: MouseEvent) => {
        if (input.params.requestAction) {
          input.params.requestAction(() => input.params.onClick(event));
        } else {
          input.params.onClick(event);
        }
      }}
    >
      {input.params.icon}
      <span>{input.params.label}</span>
    </button>
  );
}
export function CardAction(
  input: {
    workboard: WorkboardProps;
    card: WorkboardCard;
    requestAction?: (action: () => void) => void;
  } & (
    | { kind: "edit" }
    | { kind: "archive"; busy: boolean; archived: boolean }
    | { kind: "stop" | "delete"; busy: boolean }
  ),
) {
  const state = workboardViewState(() => input.workboard);
  const appearance = createMemo(() => {
    switch (input.kind) {
      case "edit":
        return { label: "workboard.editCard", icon: icons.edit, disabled: state().dispatching };
      case "archive":
        return {
          label: input.archived ? "workboard.unarchiveCard" : "workboard.archiveCard",
          icon: input.archived ? icons.archiveRestore : icons.archive,
          disabled: input.busy,
        };
      case "stop":
        return {
          label: "workboard.stopSession",
          icon: icons.stop,
          disabled: input.busy || !input.workboard.connected,
        };
      case "delete":
        return { label: "workboard.deleteCard", icon: icons.trash, disabled: input.busy };
    }
    return input satisfies never;
  });
  const perform = () => {
    const context = workboardMutationContext(input.workboard);
    switch (input.kind) {
      case "edit":
        openEditModal(state(), input.card);
        input.workboard.onRequestUpdate?.();
        break;
      case "archive":
        void archiveWorkboardCard({ ...context, cardId: input.card.id, archived: !input.archived });
        break;
      case "stop":
        void stopWorkboardCard({
          ...context,
          card: input.card,
          session: getCardActionState(input.workboard, input.card).sessionTarget,
        });
        break;
      case "delete":
        void deleteWorkboardCard({ ...context, cardId: input.card.id });
        break;
    }
  };
  return (
    <CardActionButton
      params={{
        label: t(appearance().label),
        icon: appearance().icon,
        requestAction: input.requestAction,
        ariaHaspopup: input.kind === "edit" ? "dialog" : undefined,
        className: input.kind === "delete" ? "workboard-card__delete" : undefined,
        disabled: appearance().disabled,
        onClick: perform,
      }}
    />
  );
}
export function OpenSessionCardAction(input: {
  workboard: WorkboardProps;
  session: BoardGetParams | undefined;
  options?: {
    quiet?: boolean;
  };
}) {
  const open = () => {
    const session = input.session;
    if (session) {
      input.workboard.onOpenSession(session);
    }
  };
  return (
    <Show when={input.session}>
      {input.options?.quiet ? (
        <button type="button" class="workboard-detail__session-link" onClick={open}>
          {t("workboard.openSession")}
        </button>
      ) : (
        <CardActionButton
          params={{
            label: t("workboard.openSession"),
            icon: icons.messageSquare,
            onClick: open,
          }}
        />
      )}
    </Show>
  );
}
export function StartExecutionButton(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  engine: WorkboardExecutionEngine | null;
  mode: WorkboardExecutionMode;
}) {
  const state = workboardViewState(() => input.workboard);
  const busy = createMemo(() => state().busyCardIds.has(input.card.id) || state().dispatching);
  const runtimeBlock = createMemo(() =>
    engineBlockedByRuntime(input.workboard, input.card, input.engine),
  );
  const engineName = createMemo(() =>
    input.engine === "codex" ? t("workboard.engineOpenAI") : t("workboard.engineClaude"),
  );
  // The claim gate refuses a card whose lane slot is held, so a queued card's
  // first click only arms "Try to start" instead of sending a start that fails.
  const queue = createMemo(() =>
    input.mode === "autonomous" ? getWorkboardLaneQueue(input.card, state().cards) : undefined,
  );
  const [armed, setArmed] = createSignal(false);
  const queuedText = createMemo(() => {
    const current = queue();
    return current
      ? t("workboard.startQueuedHelp", {
          position: String(current.position),
          total: String(current.total),
          agent: cardAgentLabel(input.card, input.workboard.agentsList),
          holder: formatUiExternalText(current.holder.title, current.holder.id),
        })
      : "";
  });
  const disabled = createMemo(
    () =>
      busy() ||
      !input.workboard.connected ||
      Boolean(runtimeBlock()) ||
      Boolean(input.card.metadata?.archivedAt),
  );
  const title = createMemo(() => {
    const blocked = runtimeBlock();
    const action = input.engine
      ? input.mode === "autonomous"
        ? t("workboard.runEngine", {
            engine: engineName(),
          })
        : t("workboard.openEngine", {
            engine: engineName(),
          })
      : t("workboard.runDefaultAgent");
    return blocked
      ? blocked
      : queue()
        ? armed()
          ? t("workboard.startAnyway", { action })
          : queuedText()
        : action;
  });
  const start = async () => {
    const key = await startWorkboardCard({
      ...workboardMutationContext(input.workboard),
      card: input.card,
      ...(input.engine
        ? {
            engine: input.engine,
          }
        : {}),
      mode: input.mode,
    });
    if (key) {
      input.workboard.onOpenSession({
        sessionKey: key,
      });
    }
  };
  return (
    <button
      class={[
        "btn",
        "btn--xs",
        "workboard-card__start",
        `workboard-card__start--${input.mode}`,
        input.engine ? "" : "workboard-card__start--default",
        { "workboard-card__start--queued": Boolean(queue()) && !armed() },
      ]}
      type="button"
      aria-label={title()}
      title={queue() ? title() : undefined}
      disabled={disabled()}
      onClick={() => {
        if (queue() && !armed()) {
          setArmed(true);
          return;
        }
        void start();
      }}
    >
      {input.engine ? (
        <span>{engineName()}</span>
      ) : queue() && !armed() ? (
        <span>
          {t("workboard.startQueued", {
            position: String(queue()?.position),
            total: String(queue()?.total),
          })}
        </span>
      ) : queue() ? (
        <>
          {icons.play}
          <span>{t("workboard.startAnywayShort")}</span>
        </>
      ) : (
        <>
          {input.mode === "autonomous" ? icons.play : icons.penLine}
          <span>{t("workboard.start")}</span>
        </>
      )}
    </button>
  );
}
