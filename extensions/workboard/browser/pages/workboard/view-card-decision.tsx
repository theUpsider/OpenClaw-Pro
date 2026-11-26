/** @jsxImportSource @solidjs/web */
import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { recordWorkboardDecision } from "../../lib/workboard/card-settle.ts";
import { resolveWorkboardDecisionOptions } from "../../lib/workboard/decision-options.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

/**
 * Records the operator's answer on a decision card as a comment. Picking an option
 * (click, its digit, or Enter/Space on the focused one) and "Decision made" then move
 * the card to Ready and drop its decision label so the worker can continue; "Add note"
 * leaves it blocked.
 */
export function CardDecision(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
}) {
  const [text, setText] = createSignal("");
  const bindText = liveInputValue(text);
  const choices = createMemo(() => resolveWorkboardDecisionOptions(props.card));
  // Roving tabindex: the one option Tab reaches; arrows move it without deciding.
  const [active, setActive] = createSignal(0);
  // Stays checked after a refused move, so the operator sees what was saved.
  const [chosen, setChosen] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const customLabelId = createUniqueId();
  const descriptionId = createUniqueId();
  const disabled = () => props.busy || !props.workboard.connected || !props.workboard.client;
  const record = async (decision: string, made: boolean) => {
    setSaving(true);
    try {
      await save(decision, made);
    } finally {
      setSaving(false);
    }
  };
  const save = async (decision: string, made: boolean) => {
    const recorded = await recordWorkboardDecision({
      ...workboardMutationContext(props.workboard),
      connected: props.workboard.connected,
      ...(props.workboard.canWrite !== undefined ? { canWrite: props.workboard.canWrite } : {}),
      cardId: props.card.id,
      decision,
      made,
    });
    if (!recorded) {
      return;
    }
    if (text().trim() === decision) {
      setText("");
    }
  };
  const decide = (index: number) => {
    const option = choices().options[index];
    if (!option || disabled()) {
      return;
    }
    setActive(index);
    setChosen(option.label);
    void record(option.label, true);
  };
  const onPanelKeyDown = (event: KeyboardEvent) => {
    // Digits decide only outside text entry: a "2" typed into the answer field is
    // text, and must never move the card.
    if (
      !/^[1-9]$/.test(event.key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      isTextEntry(event.target)
    ) {
      return;
    }
    const index = Number(event.key) - 1;
    if (index < choices().options.length) {
      event.preventDefault();
      decide(index);
    }
  };
  const onOptionsKeyDown = (event: KeyboardEvent) => {
    const radios = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ];
    const index = radios.indexOf(event.target as HTMLButtonElement);
    if (index < 0) {
      return;
    }
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = (index + 1) % radios.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (index + radios.length - 1) % radios.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = radios.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      // Handled here so the button's own activation does not decide a second time.
      event.preventDefault();
      decide(index);
      return;
    } else {
      return;
    }
    event.preventDefault();
    setActive(next);
    radios[next]?.focus();
  };
  return (
    <section
      class="workboard-detail__section workboard-decision"
      aria-label={t("workboard.decisionTitle")}
      onKeyDown={onPanelKeyDown}
    >
      <h3>{t("workboard.decisionTitle")}</h3>
      <p class="workboard-decision__hint">{t("workboard.decisionHint")}</p>
      <Show when={choices().options.length}>
        <p class="workboard-decision__hint">{t("workboard.decisionKeyboardHint")}</p>
        <div
          class="workboard-decision__options"
          role="radiogroup"
          aria-label={t(
            choices().structured ? "workboard.decisionChoices" : "workboard.decisionOptions",
          )}
          onKeyDown={onOptionsKeyDown}
        >
          <For each={choices().options} keyed={(option) => option.label}>
            {(option, index) => (
              <button
                type="button"
                role="radio"
                class="btn workboard-decision__option"
                aria-checked={chosen() === option().label ? "true" : "false"}
                tabindex={Math.min(active(), choices().options.length - 1) === index() ? 0 : -1}
                aria-label={t(
                  option().recommended
                    ? "workboard.decisionChooseRecommended"
                    : "workboard.decisionChoose",
                  { option: option().label },
                )}
                aria-describedby={option().description ? `${descriptionId}-${index()}` : undefined}
                disabled={disabled()}
                onClick={() => decide(index())}
                onFocus={() => setActive(index())}
              >
                <span class="workboard-decision__option-number" aria-hidden="true">
                  {t("workboard.decisionOptionNumber", { number: String(index() + 1) })}
                </span>
                <span class="workboard-decision__option-text">
                  <span class="workboard-decision__option-label">
                    {/* Labels may carry emphasis/code; the accessible name stays the plain label. */}
                    <Markdown markdown={option().label} inline />
                  </span>
                  <Show when={option().recommended}>
                    <span class="workboard-decision__recommended" aria-hidden="true">
                      {t("workboard.decisionRecommended")}
                    </span>
                  </Show>
                  <Show when={option().description}>
                    {(description) => (
                      <span
                        class="workboard-decision__option-description"
                        id={`${descriptionId}-${index()}`}
                      >
                        <Markdown markdown={description()} inline />
                      </span>
                    )}
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
        <p class="workboard-decision__custom-label" id={customLabelId}>
          {t("workboard.decisionCustomLabel")}
        </p>
      </Show>
      <textarea
        class="settings-input workboard-decision__input"
        aria-label={t("workboard.decisionTitle")}
        aria-describedby={choices().options.length ? customLabelId : undefined}
        rows="2"
        maxlength="2000"
        placeholder={t("workboard.decisionPlaceholder")}
        ref={bindText}
        disabled={disabled()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div class="workboard-decision__actions">
        <button
          type="button"
          class="btn"
          disabled={disabled() || !text().trim()}
          onClick={() => void record(text().trim(), false)}
        >
          {t("workboard.decisionAddNote")}
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={disabled() || !text().trim()}
          onClick={() => void record(text().trim(), true)}
        >
          {t("workboard.decisionMade")}
        </button>
      </div>
      <p class="workboard-decision__status" role="status">
        {saving() ? t("workboard.decisionSaving") : ""}
      </p>
    </section>
  );
}
