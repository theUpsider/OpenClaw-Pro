/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import {
  partitionWorkboardInboxEntries,
  type AttentionReason,
  type WorkboardInboxEntry,
} from "../../lib/workboard/operator-attention.ts";
import { RelativeTime } from "./view-card-time.tsx";
import { WorkboardCardView } from "./view-card.tsx";
import {
  formatStatusLabel,
  formatUpdatedTime,
  workboardViewState,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { WorkboardInboxFace } from "./view-inbox-face.tsx";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";

/**
 * The number the toolbar's "Needs you" toggle shows: the operator's own steps only (decide /
 * review). Counting every entry would put the agentless cards back in the badge, which is the
 * 49-versus-4 noise this lens exists to remove; the agentless group states its own count on its
 * collapsed row.
 */
export function workboardInboxHeadlineCount(entries: readonly WorkboardInboxEntry[]): number {
  return partitionWorkboardInboxEntries(entries).headline.length;
}

const reasonKeys: Record<AttentionReason, string> = {
  decision: "workboard.inboxReasonDecision",
  input: "workboard.inboxReasonInput",
  external: "workboard.inboxReasonExternal",
  review: "workboard.inboxReasonReview",
  unowned: "workboard.inboxReasonUnowned",
};

export function InboxToggle(props: { workboard: WorkboardProps; count: number }) {
  const state = workboardViewState(() => props.workboard);
  return (
    <button
      class={["btn workboard-inbox-toggle", { active: state().attentionInbox }]}
      type="button"
      aria-pressed={state().attentionInbox ? "true" : "false"}
      aria-label={t("workboard.inboxToggle", { count: String(props.count) })}
      title={t("workboard.inboxToggleHelp")}
      onClick={() => {
        state().attentionInbox = !state().attentionInbox;
        props.workboard.onRequestUpdate?.();
      }}
    >
      <span>{t("workboard.needsYou")}</span>
      <span
        class={[
          "workboard-inbox-toggle__count",
          { "workboard-inbox-toggle__count--waiting": props.count > 0 },
        ]}
      >
        {props.count}
      </span>
    </button>
  );
}

function InboxWhy(props: { entry: WorkboardInboxEntry; now: number }) {
  return (
    <p class="workboard-inbox__why">
      <span class="workboard-inbox__reasons">
        {props.entry.reasons.map((reason) => t(reasonKeys[reason])).join(" · ")}
      </span>
      <time
        class="workboard-inbox__since"
        datetime={new Date(props.entry.since).toISOString()}
        title={t("workboard.inboxEnteredValue", { time: formatUpdatedTime(props.entry.since) })}
      >
        {t("workboard.inboxEntered", { status: formatStatusLabel(props.entry.card.status) })}{" "}
        <RelativeTime timestamp={props.entry.since} now={props.now} />
      </time>
    </p>
  );
}

/**
 * One waiting card: the face (its own region) next to the card, never inside it. The card root
 * is a `role="button"` article, so the face's form controls must be siblings or they would be
 * interactive content nested in a button.
 */
function InboxItem(props: {
  workboard: WorkboardProps;
  entry: WorkboardInboxEntry;
  now: number;
  list: boolean;
  face: boolean;
}) {
  return (
    <div
      class="workboard-column__item workboard-inbox__item"
      role="listitem"
      data-card-id={props.entry.card.id}
    >
      <Show when={!props.face}>
        <InboxWhy entry={props.entry} now={props.now} />
      </Show>
      <Show when={props.face}>
        <WorkboardInboxFace workboard={props.workboard} entry={props.entry} />
      </Show>
      <WorkboardCardView
        workboard={props.workboard}
        card={props.entry.card}
        surface={props.list ? "list" : "page"}
        {...(props.face ? { detail: "reduced" } : {})}
      />
    </div>
  );
}

/**
 * The agentless rest of the inbox as ONE row: a count the operator expands. Collapsed by
 * default, because these cards are housekeeping ("no agent"), not the operator's own steps --
 * expanding is a deliberate act, not something the lens decides.
 */
function UnownedRow(props: {
  workboard: WorkboardProps;
  entries: WorkboardInboxEntry[];
  now: number;
  list: boolean;
}) {
  const state = workboardViewState(() => props.workboard);
  const expanded = () => state().inboxUnownedExpanded;
  const toggle = () => {
    state().inboxUnownedExpanded = !expanded();
    props.workboard.onRequestUpdate?.();
  };
  return (
    <div class="workboard-inbox__unowned" role="listitem" data-unowned-count={props.entries.length}>
      <button
        type="button"
        class="workboard-inbox__unowned-row"
        aria-expanded={expanded() ? "true" : "false"}
        aria-label={t("workboard.inboxUnownedRowCount", {
          count: String(props.entries.length),
        })}
        title={expanded() ? t("workboard.inboxUnownedRowHide") : t("workboard.inboxUnownedRowHint")}
        onClick={toggle}
      >
        <span class="workboard-inbox__reasons">{t("workboard.inboxUnownedRow")}</span>
        <span class="workboard-inbox__unowned-count">{props.entries.length}</span>
        <span class="workboard-inbox__unowned-chevron" aria-hidden="true">
          {expanded() ? "▾" : "▸"}
        </span>
      </button>
      <Show when={expanded()}>
        <div class="workboard-inbox__unowned-list" role="list">
          <For each={props.entries} keyed={(entry) => entry.card.id}>
            {(entry) => (
              <InboxItem
                workboard={props.workboard}
                entry={entry()}
                now={props.now}
                list={props.list}
                face={false}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** The lens replaces the status columns with one globally ordered inbox, in both view modes. */
export function WorkboardInbox(props: {
  workboard: WorkboardProps;
  entries: WorkboardInboxEntry[];
}) {
  const state = workboardViewState(() => props.workboard);
  const list = createMemo(() => state().viewMode === "list");
  const group = createMemo(() => partitionWorkboardInboxEntries(props.entries));
  const now = createMemo(() => {
    void props.workboard.revision;
    return Date.now();
  });
  return (
    <div class={["workboard-board-viewport", { "workboard-board-viewport--list": list() }]}>
      <div
        class={[
          "workboard-board workboard-board--page workboard-board--single-column workboard-board--inbox",
          `workboard-board--${state().layout}`,
          { "workboard-board--list": list() },
        ]}
      >
        {list() ? (
          <div class="workboard-list-header" aria-hidden="true">
            <span>{t("workboard.fieldPriority")}</span>
            <span>{t("workboard.fieldTitle")}</span>
            <span>{t("workboard.fieldSession")}</span>
            <span>{t("workboard.detailUpdated")}</span>
            <span />
          </div>
        ) : null}
        <section
          class="workboard-column workboard-inbox"
          aria-label={`${t("workboard.needsYou")}, ${group().headline.length}`}
        >
          <div class="workboard-column__header">
            <div class="workboard-column__heading">
              <h2>{t("workboard.needsYou")}</h2>
              {/* The same number the toolbar toggle shows: the operator's own steps. Counting
                  every entry here would put the agentless rest back into a badge that names the
                  operator, which is the 49-versus-4 noise this lens exists to remove; the
                  agentless row below states its own count. */}
              <span class="workboard-column__count">{group().headline.length}</span>
            </div>
          </div>
          <div class="workboard-column__cards" role="list" ref={workboardScrollFadeRef()}>
            <For each={group().headline} keyed={(entry) => entry.card.id}>
              {(entry) => (
                <InboxItem
                  workboard={props.workboard}
                  entry={entry()}
                  now={now()}
                  list={list()}
                  face
                />
              )}
            </For>
            {/* The agentless rest belongs to the same scroll flow: a second container outside the
                viewport would leave the headline cards scrolling while the row stayed put. */}
            <Show when={group().unowned.length > 0}>
              <UnownedRow
                workboard={props.workboard}
                entries={group().unowned}
                now={now()}
                list={list()}
              />
            </Show>
          </div>
        </section>
      </div>
    </div>
  );
}
