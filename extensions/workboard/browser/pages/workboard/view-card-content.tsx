/** @jsxImportSource @solidjs/web */
import { createMemo, createEffect, onCleanup, For, Show } from "solid-js";
import { AgentAvatar } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { selectCardAlert, type CardAlert } from "../../lib/workboard/card-alerts.ts";
import type { WorkboardCardClassification } from "../../lib/workboard/classification.ts";
import {
  getWorkboardAcceptanceMarker,
  type WorkboardCard,
  type WorkboardLifecycle,
} from "../../lib/workboard/index.ts";
import { resolveWorkboardInteraction } from "../../lib/workboard/interaction.ts";
import { needsOperatorAttention } from "../../lib/workboard/operator-attention.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { RelativeTime } from "./view-card-time.tsx";
import {
  formatPriorityLabel,
  formatUpdatedTime,
  LifecycleIcon,
  PriorityIcon,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { SessionStatus, type SessionStatusPresentation } from "./view-session-status.tsx";
function alertLabel(alert: CardAlert) {
  if (alert.kind === "stale") {
    if (alert.ageMs === undefined) {
      return t("workboard.sessionStatus.stale");
    }
    const minutes = Math.max(1, Math.floor((alert.ageMs ?? 0) / 60_000));
    return t("workboard.cardStaleAge", {
      age: formatDurationCompact(minutes * 60_000) ?? "",
    });
  }
  if (alert.kind === "dependency") {
    return t("workboard.dependenciesBlocked", {
      count: String(alert.count),
    });
  }
  return formatUiExternalText(alert.title);
}
export function CardAlertView(input: { alerts: CardAlert[]; descriptionId: string }) {
  const alert = createMemo(() => selectCardAlert(input.alerts));
  const fullText = createMemo(() =>
    input.alerts
      .map((entry) =>
        [
          ...new Set(
            [
              alertLabel(entry),
              formatUiExternalText(entry.title),
              formatUiExternalText(entry.detail),
            ].filter(Boolean),
          ),
        ].join(" — "),
      )
      .join("\n"),
  );
  return (
    <Show when={alert()}>
      {(activeAlert) => (
        <>
          <div
            class={`workboard-card__alert workboard-card__alert--${activeAlert().severity}`}
            title={fullText()}
          >
            <span class="workboard-truncate">{alertLabel(activeAlert())}</span>
            <span class="workboard-card__alert-marker" aria-hidden="true">
              {activeAlert().severity === "info" ? icons.info : icons.alertTriangle}
            </span>
          </div>
          <span id={input.descriptionId} hidden>
            {fullText()}
          </span>
        </>
      )}
    </Show>
  );
}
export function CardUpdatedTime(input: { updatedAt: number | undefined; now: number }) {
  return (
    <Show
      when={
        input.updatedAt === undefined
          ? undefined
          : {
              value: input.updatedAt,
            }
      }
    >
      {(timestamp) => (
        <time
          class="workboard-card__updated"
          datetime={new Date(timestamp().value).toISOString()}
          title={t("workboard.detailUpdatedValue", {
            time: formatUpdatedTime(timestamp().value),
          })}
        >
          <RelativeTime timestamp={timestamp().value} now={input.now} />
        </time>
      )}
    </Show>
  );
}
export function CardPriority(input: { card: WorkboardCard }) {
  return (
    <>
      {input.card.priority === "normal" ? null : (
        <span class="workboard-card__priority">
          <span aria-hidden="true">
            <PriorityIcon priority={input.card.priority} />
          </span>
          {formatPriorityLabel(input.card.priority)}
        </span>
      )}
    </>
  );
}
const pendingLabelMeasurements = new Map<HTMLElement, () => (() => () => void) | undefined>();
let labelMeasurementFrame: number | undefined;
function flushLabelMeasurements() {
  labelMeasurementFrame = undefined;
  // Prepare all chips, then read every card before hiding chips on any card.
  const measurements = [...pendingLabelMeasurements.values()].flatMap((prepare) => {
    const measure = prepare();
    return measure ? [measure] : [];
  });
  const updates = measurements.map((measure) => measure());
  pendingLabelMeasurements.clear();
  for (const update of updates) {
    update();
  }
}
function labelOverflowRef(labels: () => readonly string[]) {
  let dispose = () => {};
  let refresh: (() => void) | undefined;
  onCleanup(() => dispose());
  createEffect(
    () => labels(),
    () => refresh?.(),
  );
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    let measuredWidth = -1;
    const update = () => {
      pendingLabelMeasurements.set(element, () => {
        const chips = [...element.querySelectorAll<HTMLElement>(".workboard-card__label")];
        const overflow = element.querySelector<HTMLElement>(".workboard-card__label-overflow");
        if (!overflow) {
          return undefined;
        }
        for (const chip of chips) {
          chip.hidden = false;
        }
        overflow.hidden = false;
        overflow.textContent = `+${labels().length}`;
        return () => {
          const available = element.clientWidth;
          measuredWidth = available;
          const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
          const widths = chips.map((chip) => chip.getBoundingClientRect().width);
          const total =
            widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, chips.length - 1);
          let visible = chips.length;
          if (total > available) {
            let used = overflow.getBoundingClientRect().width;
            visible = 0;
            for (const width of widths) {
              if (used + gap + width > available) {
                break;
              }
              used += gap + width;
              visible++;
            }
          }
          return () => {
            chips.forEach((chip, index) => {
              chip.hidden = index >= visible;
            });
            overflow.hidden = visible === chips.length;
            overflow.textContent = `+${chips.length - visible}`;
            overflow.title = labels().slice(visible).join(", ");
            overflow.setAttribute(
              "aria-label",
              t("workboard.cardMoreLabels", {
                count: String(chips.length - visible),
                labels: labels().slice(visible).join(", "),
              }),
            );
          };
        };
      });
      labelMeasurementFrame ??= requestAnimationFrame(flushLabelMeasurements);
    };
    refresh = update;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            if (entries.some((entry) => entry.contentRect.width !== measuredWidth)) {
              update();
            }
          })
        : null;
    update();
    observer?.observe(element);
    dispose = () => {
      pendingLabelMeasurements.delete(element);
      if (pendingLabelMeasurements.size === 0 && labelMeasurementFrame !== undefined) {
        cancelAnimationFrame(labelMeasurementFrame);
        labelMeasurementFrame = undefined;
      }
      refresh = undefined;
      observer?.disconnect();
    };
  };
}
export function CardLabelChip(input: { label: string; color?: string; class?: string }) {
  return (
    <span
      class={[
        "workboard-chip workboard-truncate",
        input.class ?? "",
        input.color ? "workboard-card__label--colored" : "",
      ]}
      style={input.color ? { "--workboard-label-color": input.color } : undefined}
      title={input.label}
    >
      {/* The colored chip is a flex row, so its text needs its own truncating box. */}
      {input.color ? <span class="workboard-truncate">{input.label}</span> : input.label}
    </span>
  );
}
export function CardClassificationAnnouncement(input: {
  classification: WorkboardCardClassification;
}) {
  return (
    <Show when={input.classification.primary}>
      {(primary) => (
        <span class="sr-only">{t("workboard.cardClassification", { label: primary().label })}</span>
      )}
    </Show>
  );
}
export function CardAcceptanceMarker(input: { card: WorkboardCard }) {
  const marker = createMemo(() => getWorkboardAcceptanceMarker(input.card));
  return (
    <Show when={marker()}>
      {(current) => (
        <span
          class={["workboard-card__acceptance", `workboard-card__acceptance--${current()}`]}
          title={t(
            current() === "awaiting"
              ? "workboard.acceptanceAwaitingHelp"
              : "workboard.acceptanceUnseenHelp",
          )}
        >
          {t(
            current() === "awaiting"
              ? "workboard.acceptanceAwaiting"
              : "workboard.acceptanceUnseen",
          )}
        </span>
      )}
    </Show>
  );
}
export function CardNeedsYouMarker(input: { card: WorkboardCard }) {
  return (
    <Show when={needsOperatorAttention(input.card)}>
      <span class="workboard-card__needs-you" title={t("workboard.needsYouHelp")}>
        {t("workboard.needsYou")}
      </span>
    </Show>
  );
}
export function CardMeta(input: {
  card: WorkboardCard;
  archived: boolean;
  classification: WorkboardCardClassification;
  /**
   * Cap on the label chips before the `+N` chip. The default is the measured overflow (whatever
   * fits); a card drawn next to its face caps it at three, because the face is where the operator
   * reads now and a chip wall beside it only competes for attention.
   */
  maxLabels?: number;
}) {
  const labels = () =>
    input.maxLabels === undefined
      ? input.classification.orderedLabels
      : input.classification.orderedLabels.slice(0, input.maxLabels);
  const hiddenLabels = () => input.classification.orderedLabels.slice(labels().length);
  // A cap is deterministic, so the measured overflow ref must stay out of it: that ref hides
  // chips by available width and would hide the fixed `+N` chip too.
  const overflowRef = () => (input.maxLabels === undefined ? labelOverflowRef(labels) : undefined);
  return (
    <>
      {!input.card.labels.length &&
      !input.archived &&
      !getWorkboardAcceptanceMarker(input.card) &&
      !needsOperatorAttention(input.card) ? null : (
        <div class="workboard-card__meta">
          <CardClassificationAnnouncement classification={input.classification} />
          <CardNeedsYouMarker card={input.card} />
          <CardAcceptanceMarker card={input.card} />
          {input.card.labels.length ? (
            <div class="workboard-card__labels" ref={overflowRef()}>
              <For each={labels()} keyed={(label) => label}>
                {(label) => (
                  <CardLabelChip
                    label={label()}
                    color={input.classification.colors.get(label())}
                    class="workboard-card__label"
                  />
                )}
              </For>
              {/* With a cap, the hidden labels are named in the chip itself; the measured
                  overflow ref only manages chips that fit the available width. */}
              {hiddenLabels().length ? (
                <span
                  class="workboard-chip workboard-card__label-overflow"
                  title={hiddenLabels().join(", ")}
                  aria-label={t("workboard.cardMoreLabels", {
                    count: String(hiddenLabels().length),
                    labels: hiddenLabels().join(", "),
                  })}
                >
                  {`+${hiddenLabels().length}`}
                </span>
              ) : (
                <span class="workboard-chip workboard-card__label-overflow" hidden />
              )}
            </div>
          ) : null}
          {input.archived ? (
            <span class="workboard-card__archived">{t("workboard.archived")}</span>
          ) : null}
        </div>
      )}
    </>
  );
}
export function CardCounts(input: { card: WorkboardCard }) {
  const metadata = createMemo(() => input.card.metadata);
  const attempts = createMemo(() => metadata()?.attempts?.length ?? 0);
  const counts = createMemo(() =>
    [
      {
        count: metadata()?.comments?.length ?? 0,
        label: "workboard.badgeComments",
        icon: "messageSquare" as const,
      },
      {
        count: metadata()?.proof?.length ?? 0,
        label: "workboard.badgeProof",
        icon: "fileText" as const,
      },
      {
        count: (metadata()?.artifacts?.length ?? 0) + (metadata()?.attachments?.length ?? 0),
        label: "workboard.cardFiles",
        icon: "paperclip" as const,
      },
      {
        count: metadata()?.diagnostics?.length ?? 0,
        label: "workboard.cardWarnings",
        icon: "info" as const,
      },
      {
        count: attempts(),
        label: "workboard.badgeAttempts",
        icon: "refresh" as const,
      },
      {
        count: metadata()?.failureCount ?? 0,
        label: "workboard.badgeFailures",
        icon: "alertTriangle" as const,
      },
    ].filter((entry) => entry.count > 0),
  );
  return (
    <Show when={counts().length > 0}>
      <div class="workboard-card__counts">
        <For each={counts()} keyed={(entry) => entry.label}>
          {(entry) => (
            <span
              title={t(entry().label, {
                count: String(entry().count),
              })}
              aria-label={t(entry().label, {
                count: String(entry().count),
              })}
            >
              <i aria-hidden="true">{icons[entry().icon]}</i>
              {entry().count}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
function AgentChip(input: { workboard: WorkboardProps; card: WorkboardCard }) {
  const label = createMemo(() => cardAgentLabel(input.card, input.workboard.agentsList));
  return (
    <span
      class="workboard-agent-chip workboard-agent-avatar"
      title={label()}
      role="img"
      aria-label={label()}
    >
      <AgentAvatar
        {...{
          agentId:
            input.card.agentId?.trim() ||
            input.workboard.agentsList?.defaultId ||
            input.workboard.defaultAgentId ||
            "",
          label: label(),
        }}
      />
    </span>
  );
}
export function CardSession(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  lifecycle: WorkboardLifecycle;
  status: SessionStatusPresentation;
}) {
  const hasSession = createMemo(() => input.lifecycle.state !== "unlinked");
  // The dictation fallback: only a card without an execution session has one, and only
  // a dock conversation the window still carries resolves. No session means the card
  // renders exactly like a card without any session — no marker, no badge, no line.
  const interaction = createMemo(() =>
    resolveWorkboardInteraction(input.card, input.workboard.interactionSessions),
  );
  const sessionName = createMemo(() =>
    hasSession()
      ? (input.lifecycle.session?.displayName ??
        input.lifecycle.session?.label ??
        t("workboard.fieldSession"))
      : (interaction()?.session.displayName ??
        interaction()?.session.label ??
        cardAgentLabel(input.card, input.workboard.agentsList)),
  );
  return (
    <div class={`workboard-card__session workboard-card__session--${input.status.tone}`}>
      <AgentChip workboard={input.workboard} card={input.card} />
      <span class="workboard-card__session-name workboard-truncate" title={sessionName()}>
        {sessionName()}
      </span>
      <span class="workboard-card__session-state">
        {hasSession() && !input.status.visible ? (
          <span
            class="workboard-card__session-marker"
            role="img"
            aria-label={input.status.label}
            title={input.status.detail}
          >
            <LifecycleIcon lifecycle={input.lifecycle} />
          </span>
        ) : null}
        {!hasSession() && interaction()?.state === "live" ? (
          <span
            class="workboard-card__session-marker"
            role="img"
            aria-label={t("workboard.interactionRunning")}
            title={t("workboard.interactionRunning")}
          >
            <span class="session-run-spinner" aria-hidden="true" />
          </span>
        ) : null}
        <SessionStatus
          presentation={input.status}
          context={{
            id: `workboard-card-status-${input.card.id}`,
            sessionName: sessionName(),
          }}
        />
      </span>
    </div>
  );
}
