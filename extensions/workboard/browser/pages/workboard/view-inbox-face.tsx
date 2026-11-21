/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import {
  acceptWorkboardCard,
  recordWorkboardDecision,
  sendBackWorkboardCard,
  type WorkboardSettleTarget,
} from "../../lib/workboard/card-settle.ts";
import { resolveWorkboardDecisionOptions } from "../../lib/workboard/decision-options.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import type { WorkboardCard, WorkboardPriority } from "../../lib/workboard/index.ts";
import { parseWorkboardNote } from "../../lib/workboard/note-outline.ts";
import type {
  AttentionReason,
  WorkboardInboxEntry,
} from "../../lib/workboard/operator-attention.ts";
import type { WorkboardDecisionOption } from "../../lib/workboard/types.ts";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.tsx";
import { RelativeTime } from "./view-card-time.tsx";
import { canMutate, formatStatusLabel, type WorkboardProps } from "./view-helpers.tsx";

/**
 * How long a one-click decision waits before it is written. The write is deliberately delayed:
 * once a card is `ready` a dispatch can claim it, so an immediate write plus an "Undo" button
 * would race the agent, and a move without `expectedUpdatedAt` is last-writer-wins and can pull
 * a running card back. Nothing is written until this elapses, so Undo only cancels a pending
 * write instead of trying to undo one.
 */
export const WORKBOARD_FACE_DECIDE_DELAY_MS = 5_000;

const stripKeys: Record<AttentionReason, string> = {
  decision: "workboard.face.reasonDecision",
  input: "workboard.face.reasonInput",
  external: "workboard.face.reasonExternal",
  review: "workboard.face.reasonReview",
  unowned: "workboard.face.reasonUnowned",
};

/** A text glyph, so the strip's meaning never rests on colour. */
const stripGlyphs: Record<AttentionReason, string> = {
  decision: "◆",
  input: "?",
  external: "↗",
  review: "◐",
  unowned: "○",
};

const priorityKeys: Partial<Record<WorkboardPriority, string>> = {
  high: "workboard.face.priorityHigh",
  urgent: "workboard.face.priorityUrgent",
};

/** The canned send-back reasons; each is a chip plus the free line the operator may edit. */
const sendBackChips = [
  { id: "proof", key: "workboard.face.sendBackChipProof" },
  { id: "wrong", key: "workboard.face.sendBackChipWrong" },
  { id: "unfinished", key: "workboard.face.sendBackChipUnfinished" },
] as const;

/**
 * The stored text of one convention section, read through the module that owns the convention
 * (`note-outline.ts`) instead of a second parser here. That module splits on `\r?\n`, so a note
 * written with CRLF is read the same as one with LF -- a local `split("\n")` would leave the
 * trailing `\r` on the first line, fail to match, and leak the `Stand:`/`Nächster Schritt:`
 * label into the line the face shows.
 */
function workboardNoteSection(card: WorkboardCard, key: "stand" | "nextStep"): string | undefined {
  return parseWorkboardNote(card.notes).sections.find((section) => section.key === key)?.text;
}

/**
 * The line the operator question actually sits on, before `ask` existed. The convention puts it in
 * the PREAMBLE as `Braucht von the operator: ...` (decision cards) or `Wartet auf: ...` (waiting cards),
 * which are not section keys, so the parser keeps them above the list. Reading only `Naechster
 * Schritt` would show the agent's next action instead of the operator's question -- on the live
 * board the one real decision card leads with `Braucht von the operator:`.
 */
function workboardPreambleLine(card: WorkboardCard): string | undefined {
  const preamble = parseWorkboardNote(card.notes).preamble.trim();
  return preamble || undefined;
}

/** The first line of a text, trimmed and length-capped so the face stays skimmable. */
export function workboardFirstLine(text: string | undefined, maxLength = 280): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const firstLine = trimmed.split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine.length > maxLength
    ? `${firstLine.slice(0, maxLength - 1).trimEnd()}…`
    : firstLine;
}

/**
 * The question the decision face leads with, in the operator's own order of authority: the agent's
 * explicit `ask` when set, then the leading operator line the convention already carries
 * (`Braucht von the operator:` / `Wartet auf:`), then the agent's next action, then the note's opening.
 */
export function workboardDecisionQuestion(card: WorkboardCard): string {
  const ask = card.metadata?.automation?.ask?.trim();
  if (ask) {
    return ask;
  }
  // The operator question comes first: the live decision card carries it as the leading
  // `Braucht von the operator:` line, not as the agent's next action.
  return (
    workboardFirstLine(workboardPreambleLine(card)) ||
    workboardFirstLine(workboardNoteSection(card, "nextStep") ?? card.notes) ||
    t("workboard.face.questionFallback")
  );
}

/**
 * The one line the review face leads with: what the agent reports as the result. The `Stand:` value
 * is cut at its first LINE, not at its first sentence: covered separately, a sentence splitter
 * truncates German mid-abbreviation ("bis 14. November" -> "bis 14.").
 */
export function workboardReviewLine(card: WorkboardCard): string {
  return (
    workboardFirstLine(workboardNoteSection(card, "stand") ?? card.notes) ||
    t("workboard.face.reviewLineFallback")
  );
}

export type WorkboardFaceEvidence = {
  proofCount: number;
  fileCount: number;
  links: Array<{ id: string; label: string; url: string }>;
};

/** Proof and files the review face offers: a count, plus a link per entry that carries a URL. */
export function workboardFaceEvidence(card: WorkboardCard): WorkboardFaceEvidence {
  const proof = card.metadata?.proof ?? [];
  const files = [...(card.metadata?.artifacts ?? []), ...(card.metadata?.attachments ?? [])];
  const links: WorkboardFaceEvidence["links"] = [];
  proof.forEach((entry, index) => {
    if (entry.url) {
      links.push({
        id: `proof-${entry.id}`,
        label: t("workboard.face.evidenceProofLink", { number: String(index + 1) }),
        url: entry.url,
      });
    }
  });
  files.forEach((entry, index) => {
    const url = "url" in entry ? entry.url : undefined;
    if (url) {
      links.push({
        id: `file-${entry.id}`,
        label: t("workboard.face.evidenceFileLink", { number: String(index + 1) }),
        url,
      });
    }
  });
  return { proofCount: proof.length, fileCount: files.length, links };
}

/**
 * One option as the face renders it: the label and description from
 * `resolveWorkboardDecisionOptions`, plus the 1-based display number, so the number shown in the
 * button and the digit that picks it can never disagree.
 */
export type OrderedDecisionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
  number: number;
};

/**
 * The options in the STORED order: the order is the number. `number` is the 1-based position
 * shown in the button and the digit that picks it, so the two can never disagree -- and they
 * agree with the drawer, whose digit handler numbers by the same stored order ('the list order
 * is the number', `decision-options.ts`). Reordering here would give one card two mappings for
 * "2", so an agent note saying "option 2" could point at the wrong button.
 *
 * The recommendation is carried through as a flag and marked visually by the caller (filled
 * button plus the existing text marker), never by moving the option.
 * `resolveWorkboardDecisionOptions` owns which options exist and which one is recommended.
 */
export function orderWorkboardDecisionOptions(
  options: readonly WorkboardDecisionOption[],
): OrderedDecisionOption[] {
  return options.map((option, index) => {
    const entry: OrderedDecisionOption = { label: option.label, number: index + 1 };
    if (option.description) {
      entry.description = option.description;
    }
    if (option.recommended) {
      entry.recommended = true;
    }
    return entry;
  });
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

function FaceStrip(props: { entry: WorkboardInboxEntry; now: number }) {
  const priorityKey = () => priorityKeys[props.entry.card.priority];
  return (
    <div class="workboard-face__strip">
      <span class="workboard-face__glyph" aria-hidden="true">
        {stripGlyphs[props.entry.reason]}
      </span>
      <span class="workboard-face__reason">{t(stripKeys[props.entry.reason])}</span>
      <span class="workboard-face__age">
        {t("workboard.face.inStateSince", {
          status: formatStatusLabel(props.entry.card.status),
        })}{" "}
        <RelativeTime timestamp={props.entry.since} now={props.now} />
      </span>
      <Show when={priorityKey()}>
        {(key) => (
          <span class="workboard-face__priority">
            <span aria-hidden="true">{icons.alertTriangle}</span>
            {t(key())}
          </span>
        )}
      </Show>
    </div>
  );
}

/**
 * The decision/review surface of one waiting card, rendered NEXT TO the card, never inside it.
 *
 * The card root is `<article role="button" tabindex="0" draggable>`, so any form control nested
 * in it would be interactive content inside a button (WCAG 4.1.2) and the card's drag would
 * fight text selection. This region is therefore a sibling with its own accessible name and its
 * own heading, and its keyboard shortcuts are scoped to the focused panel.
 */
export function WorkboardInboxFace(props: {
  workboard: WorkboardProps;
  entry: WorkboardInboxEntry;
}) {
  const card = () => props.entry.card;
  const [pending, setPending] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [otherOpen, setOtherOpen] = createSignal(false);
  const [otherText, setOtherText] = createSignal("");
  const [sendBackOpen, setSendBackOpen] = createSignal(false);
  const [sendBackText, setSendBackText] = createSignal("");
  const [active, setActive] = createSignal(0);
  const now = createMemo(() => {
    void props.workboard.revision;
    return Date.now();
  });
  const isDecision = () => props.entry.tier === 0;
  /**
   * Only a `decision` card offers a pick list. An `input`/`external` card can carry unchecked task
   * items in its notes (`- [ ] ...`), and resolving those into answer buttons would turn the agent's
   * own checklist into the operator's choices: it gets the free answer field instead.
   */
  const offersChoices = () => props.entry.reason === "decision";
  const options = createMemo(() =>
    offersChoices()
      ? orderWorkboardDecisionOptions(resolveWorkboardDecisionOptions(card()).options)
      : [],
  );
  /**
   * The option Tab reaches: the operator's last move, else the recommended one, so the original
   * "recommended first" intent survives as focus order and not only as styling. Falls back to the
   * first option when nothing is marked recommended.
   */
  const activeNumber = () => {
    if (active() > 0) {
      return active();
    }
    const list = options();
    return list.find((option) => option.recommended)?.number ?? list[0]?.number ?? 1;
  };
  const evidence = createMemo(() => workboardFaceEvidence(card()));
  const hasEvidence = () => evidence().proofCount + evidence().fileCount > 0;
  const writable = () => canMutate(props.workboard);
  const disabled = () => !writable() || !props.workboard.connected || !props.workboard.client;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The write the operator already chose, kept outside the timer so disposal can still honour
   * it: on unmount the operator has decided and only the confirmation window was cut short.
   * `revision` is the `updatedAt` the click captured, checked before the write runs.
   */
  let pendingWrite:
    | { revision: number; write: (expectedUpdatedAt: number) => Promise<boolean> }
    | undefined;
  const cancelPending = () => {
    clearTimeout(timer);
    timer = undefined;
    pendingWrite = undefined;
    setPending(undefined);
  };

  /**
   * Records a write failure the operator can still see once this face is gone. The board's own
   * error is a plain store field (not a component signal), so it survives the unmount; the
   * update request is deferred out of the disposal scope, where writing signals is refused.
   * The message names the card, because the operator has already left the lens and cannot tell
   * which decision was not written.
   */
  const recordWriteFailure = () => {
    const state = getWorkboardState(props.workboard.host);
    state.error ??= t("workboard.face.decisionNotRecorded", { title: card().title });
    queueMicrotask(() => props.workboard.onRequestUpdate?.());
  };

  // Disposal may run inside an owned scope, where writing signals is refused. The timer is
  // cleared, but a decision the operator already made is not thrown away with the face: when
  // the card still carries the revision the click captured, the write runs (deferred out of
  // the disposal scope), so leaving the lens neither loses the decision nor hides its outcome.
  onCleanup(() => {
    clearTimeout(timer);
    timer = undefined;
    const queued = pendingWrite;
    pendingWrite = undefined;
    if (!queued) {
      return;
    }
    queueMicrotask(() => {
      void (async () => {
        if (!stillAtRevision(queued.revision) || !(await queued.write(queued.revision))) {
          recordWriteFailure();
        }
      })();
    });
  });

  const settleTarget = (): WorkboardSettleTarget => ({
    host: props.workboard.host,
    client: props.workboard.client,
    requestUpdate: props.workboard.onRequestUpdate,
    connected: props.workboard.connected,
    canWrite: writable(),
  });

  /**
   * True while the card still carries the revision the written action was queued against. The
   * decision path has no revision argument (its owner, `card-settle.ts`, is a shared slice), so
   * the face checks the rendered revision itself before writing; `accept` passes the same
   * revision through to the move owner, which enforces it in the store.
   */
  const stillAtRevision = (revision: number) =>
    getWorkboardState(props.workboard.host).cards.find((entry) => entry.id === card().id)
      ?.updatedAt === revision;

  /**
   * Queues a one-click write. The revision the operator saw is captured now and checked when
   * the timer expires, so a card that changed in the meantime refuses the write instead of
   * being overwritten.
   */
  const scheduleWrite = (label: string, write: (expectedUpdatedAt: number) => Promise<boolean>) => {
    cancelPending();
    setError(undefined);
    setPending(label);
    const revision = card().updatedAt;
    pendingWrite = { revision, write };
    timer = setTimeout(() => {
      timer = undefined;
      pendingWrite = undefined;
      setPending(undefined);
      void (async () => {
        // A guard refusal (a dispatch started, the card moved on) is visible, not silent.
        if (!stillAtRevision(revision) || !(await write(revision))) {
          setError(t("workboard.face.busy"));
        }
      })();
    }, WORKBOARD_FACE_DECIDE_DELAY_MS);
  };

  const decideOption = (option: OrderedDecisionOption) => {
    if (disabled()) {
      return;
    }
    scheduleWrite(option.label, async () =>
      recordWorkboardDecision({
        ...settleTarget(),
        cardId: card().id,
        decision: option.label,
        made: true,
      }),
    );
  };

  const accept = () => {
    if (disabled()) {
      return;
    }
    scheduleWrite(t("workboard.face.accept"), (expectedUpdatedAt) =>
      acceptWorkboardCard(settleTarget(), card(), { expectedUpdatedAt }),
    );
  };

  const sendBack = async () => {
    const reason = sendBackText().trim();
    if (!reason) {
      return;
    }
    setError(undefined);
    if (
      await sendBackWorkboardCard(settleTarget(), card(), {
        reason,
        expectedUpdatedAt: card().updatedAt,
      })
    ) {
      setSendBackOpen(false);
      setSendBackText("");
      return;
    }
    setError(t("workboard.face.busy"));
  };

  const openDrawer = () => {
    openCardDetails(getWorkboardState(props.workboard.host), card());
    props.workboard.onRequestUpdate?.();
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    // Digits act only while this panel has focus, so several decision faces in the lens never
    // all claim 1-4; a digit typed into a text field stays text.
    if (
      !/^[1-9]$/.test(event.key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      !isDecision() ||
      isTextEntry(event.target)
    ) {
      return;
    }
    const option = options()[Number(event.key) - 1];
    if (option) {
      event.preventDefault();
      setActive(option.number);
      decideOption(option);
    }
  };

  const onOptionsKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const buttons = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button"),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) {
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : (index + buttons.length - 1) % buttons.length;
    event.preventDefault();
    setActive(next + 1);
    buttons[next]?.focus();
  };

  return (
    <section
      class={[
        "workboard-face",
        isDecision() ? "workboard-face--decision" : "workboard-face--review",
      ]}
      aria-label={t(
        isDecision() ? "workboard.face.regionLabel" : "workboard.face.regionLabelReview",
        { title: card().title },
      )}
      aria-keyshortcuts={isDecision() ? "1 2 3 4 5 6 7 8 9" : undefined}
      onKeyDown={onPanelKeyDown}
    >
      <FaceStrip entry={props.entry} now={now()} />
      <h3 class="workboard-face__title workboard-truncate-two">{card().title}</h3>
      <p class="workboard-face__question">
        {isDecision() ? workboardDecisionQuestion(card()) : workboardReviewLine(card())}
      </p>
      <Show when={!isDecision()}>
        <div class="workboard-face__evidence">
          <Show
            when={hasEvidence()}
            fallback={
              <span
                class="workboard-face__evidence-none"
                title={t("workboard.face.evidenceNoneTitle")}
              >
                <span aria-hidden="true">{icons.alertTriangle}</span>
                {t("workboard.face.evidenceNone")}
              </span>
            }
          >
            <span class="workboard-face__evidence-counts">
              {[
                evidence().proofCount > 0
                  ? t("workboard.face.evidenceProof", { count: String(evidence().proofCount) })
                  : "",
                evidence().fileCount > 0
                  ? t("workboard.face.evidenceFiles", { count: String(evidence().fileCount) })
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <For each={evidence().links} keyed={(link) => link.id}>
              {(link) => (
                <a
                  class="workboard-face__evidence-link"
                  href={link().url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link().label}
                </a>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={isDecision() && options().length > 0 && !disabled()}>
        <p class="workboard-face__hint">{t("workboard.face.keyboardHint")}</p>
        <div
          class="workboard-face__options"
          role="group"
          aria-label={t("workboard.decisionTitle")}
          onKeyDown={onOptionsKeyDown}
        >
          <For each={options()} keyed={(option) => option.number}>
            {(option) => (
              <button
                type="button"
                class={["btn", "workboard-face__option", option().recommended ? "primary" : ""]}
                tabindex={Math.min(activeNumber(), options().length) === option().number ? 0 : -1}
                disabled={disabled()}
                aria-label={t(
                  option().recommended
                    ? "workboard.face.optionRecommendedChoice"
                    : "workboard.face.optionChoice",
                  { option: option().label },
                )}
                onClick={() => decideOption(option())}
                onFocus={() => setActive(option().number)}
              >
                <span class="workboard-face__option-number" aria-hidden="true">
                  {t("workboard.decisionOptionNumber", { number: String(option().number) })}
                </span>
                <span class="workboard-face__option-label">{option().label}</span>
                <Show when={option().recommended}>
                  <span class="workboard-face__option-mark">
                    {`* ${t("workboard.face.optionRecommended")}`}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={isDecision() && otherOpen()}>
        <label class="workboard-face__field">
          <span>{t("workboard.face.otherAnswerLabel")}</span>
          <textarea
            class="settings-input workboard-face__other-input"
            rows="2"
            placeholder={t("workboard.face.otherAnswerPlaceholder")}
            value={otherText()}
            disabled={disabled()}
            onInput={(event) => setOtherText(event.currentTarget.value)}
          />
        </label>
      </Show>
      <Show when={!isDecision() && sendBackOpen()}>
        <fieldset class="workboard-face__send-back">
          <legend>{t("workboard.face.sendBackTitle")}</legend>
          <p class="workboard-face__hint">{t("workboard.face.sendBackHint")}</p>
          <div class="workboard-face__chips">
            <For each={sendBackChips} keyed={(chip) => chip.id}>
              {(chip) => (
                <button
                  type="button"
                  class="btn workboard-face__chip"
                  onClick={() => setSendBackText(t(chip().key))}
                >
                  {t(chip().key)}
                </button>
              )}
            </For>
          </div>
          <label class="workboard-face__field">
            <span>{t("workboard.face.sendBackReason")}</span>
            <input
              class="settings-input"
              placeholder={t("workboard.face.sendBackReasonPlaceholder")}
              value={sendBackText()}
              disabled={disabled()}
              onInput={(event) => setSendBackText(event.currentTarget.value)}
            />
          </label>
          <div class="workboard-face__actions">
            <button
              type="button"
              class="btn primary"
              disabled={disabled() || !sendBackText().trim()}
              onClick={() => void sendBack()}
            >
              {t("workboard.face.sendBackSubmit")}
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => {
                setSendBackOpen(false);
                setSendBackText("");
              }}
            >
              {t("workboard.face.sendBackCancel")}
            </button>
          </div>
        </fieldset>
      </Show>
      <div class="workboard-face__actions">
        <Show when={isDecision()}>
          <Show when={options().some((option) => option.recommended)}>
            <button
              type="button"
              class="btn primary"
              disabled={disabled()}
              onClick={() => {
                const recommended = options().find((option) => option.recommended);
                if (recommended) {
                  decideOption(recommended);
                }
              }}
            >
              {t("workboard.face.acceptRecommendation")}
            </button>
          </Show>
          <button
            type="button"
            class="btn"
            disabled={disabled()}
            onClick={() => setOtherOpen((open) => !open)}
          >
            {t("workboard.face.otherAnswer")}
          </button>
          <Show when={otherOpen()}>
            <button
              type="button"
              class="btn"
              disabled={disabled() || !otherText().trim()}
              onClick={() => {
                const text = otherText().trim();
                const option = options().find((entry) => entry.label === text);
                if (option) {
                  decideOption(option);
                  return;
                }
                if (text) {
                  scheduleWrite(text, async () =>
                    recordWorkboardDecision({
                      ...settleTarget(),
                      cardId: card().id,
                      decision: text,
                      made: true,
                    }),
                  );
                }
              }}
            >
              {t("workboard.face.otherAnswerSend")}
            </button>
          </Show>
        </Show>
        <Show when={!isDecision()}>
          <button
            type="button"
            class={["btn", hasEvidence() ? "primary" : ""]}
            disabled={disabled()}
            onClick={accept}
          >
            {t(hasEvidence() ? "workboard.face.accept" : "workboard.face.acceptWithoutProof")}
          </button>
          <button
            type="button"
            class="btn"
            disabled={disabled()}
            onClick={() => setSendBackOpen((open) => !open)}
          >
            {t("workboard.face.sendBack")}
          </button>
        </Show>
        <button
          type="button"
          class="btn"
          aria-haspopup="dialog"
          aria-controls={workboardCardDetailDrawerId}
          onClick={openDrawer}
        >
          {t("workboard.face.open")}
        </button>
      </div>
      <p class="workboard-face__pending" role="status" aria-live="polite">
        <Show when={pending()}>
          <span>{t("workboard.face.pending", { option: pending() ?? "" })}</span>{" "}
          <button type="button" class="btn workboard-face__undo" onClick={cancelPending}>
            {t("workboard.face.pendingUndo")}
          </button>
        </Show>
      </p>
      <Show when={error()}>
        {(message) => (
          <p class="workboard-face__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={disabled()}>
        <p class="workboard-face__hint">
          {t(writable() ? "workboard.face.busy" : "workboard.face.readOnly")}
        </p>
      </Show>
    </section>
  );
}
