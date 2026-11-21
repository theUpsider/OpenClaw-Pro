/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { workboardCardBoardId } from "../../lib/workboard/board-filter.ts";
import { normalizeDraftLabels } from "../../lib/workboard/card-state.ts";
import {
  boardClassifications,
  classificationKey,
  WORKBOARD_CLASSIFICATION_SLOTS,
  type WorkboardClassification,
} from "../../lib/workboard/classification.ts";
import { getWorkboardState, type WorkboardCard } from "../../lib/workboard/index.ts";
import type { WorkboardProps } from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";

/**
 * The label editor's palette draft. InlineText keeps the card base, Save and focus
 * restore; this owns the toggled label list, the field error and the overwrite choice.
 * Slots only change the draft: Save and Create stay the single card update.
 */
export function createClassificationDraft(params: {
  owner: () => WorkboardProps;
  card: () => WorkboardCard;
  base: () => WorkboardCard | undefined;
  /** The Create field text; comma-separated names not yet on the card. */
  typed: () => string;
  inert: () => boolean;
  revision: () => unknown;
  publish: () => void;
}) {
  let labels: string[] = [];
  let error: string | undefined;
  let overwriteOpen = false;
  let overwriteTarget = "";
  const boardId = () => workboardCardBoardId(params.card());
  /** Undefined until the card's board summary has loaded. */
  const palette = () => {
    void params.owner().revision;
    const boards = getWorkboardState(params.owner().host).boards;
    return boards.some((board) => board.id === boardId())
      ? boardClassifications(boards, boardId())
      : undefined;
  };
  const payload = () => normalizeDraftLabels([...labels, params.typed()].join(","));
  /** Draft labels the palette does not know yet; each would take a slot. */
  const pending = () => {
    params.revision();
    const known = new Set(
      [...(palette() ?? []).map((entry) => entry.name), ...(params.base()?.labels ?? [])].map(
        classificationKey,
      ),
    );
    return payload().filter((label) => !known.has(classificationKey(label)));
  };
  /** New names past the free slots; the Gateway would refuse the write without `replaces`. */
  const overflow = () => {
    const used = palette()?.length;
    return used === undefined
      ? []
      : pending().slice(Math.max(0, WORKBOARD_CLASSIFICATION_SLOTS - used));
  };
  const read = <T,>(value: () => T) => {
    params.revision();
    return value();
  };
  return {
    palette,
    payload,
    reset(next: readonly string[] = []) {
      labels = [...next];
      error = undefined;
      overwriteOpen = false;
      overwriteTarget = "";
    },
    /**
     * A new name that finds no free slot would be refused by the Gateway: open the
     * overwrite step instead of sending. Returns whether the write has to wait for it.
     * Accepted edge: a typed system label (parallelizable) counts as new here; the
     * Gateway would pass it, and Cancel steps back.
     */
    awaitOverwrite() {
      if (overflow().length === 0) {
        return false;
      }
      error = undefined;
      overwriteOpen = true;
      params.publish();
      return true;
    },
    /** Closes the overwrite step once the typed names fit again. */
    typed() {
      if (overwriteOpen && overflow().length === 0) {
        overwriteOpen = false;
        overwriteTarget = "";
      }
    },
    setError(message: string | undefined) {
      error = message;
    },
    /** A refused write: the message stays at the field, focus returns to the open step. */
    refuse(message: string, root: HTMLElement) {
      error = message;
      // The controls were disabled while saving and dropped focus; keep a deliberate move elsewhere.
      requestAnimationFrame(() => {
        if (root.ownerDocument.activeElement === root.ownerDocument.body) {
          focusClassificationEditor(root, "refused");
        }
      });
    },
    /** Escape leaves the innermost step: the overwrite choice before the whole draft. */
    stepBack(root: HTMLElement) {
      if (!read(() => overwriteOpen && overflow().length === 1)) {
        return false;
      }
      this.cancelOverwrite();
      focusClassificationEditor(root, "refused");
      return true;
    },
    /** The refusal follows the Create field, so it never names a name no longer typed. */
    error: () =>
      read(() => {
        const over = overwriteOpen ? overflow() : [];
        if (over.length > 1) {
          return t("workboard.classificationOneReplacement", { names: over.join(", ") });
        }
        return over.length === 1 && error === undefined
          ? t("workboard.classificationFull", { name: over[0] ?? "" })
          : error;
      }),
    selected: (label: string) =>
      read(() => labels.some((entry) => classificationKey(entry) === classificationKey(label))),
    /** Card labels without a slot (system labels, names replaced since); removable here. */
    unslotted: () =>
      read(() => {
        const slotted = new Set((palette() ?? []).map((entry) => classificationKey(entry.name)));
        return (params.base() ?? params.card()).labels.filter(
          (label) => !slotted.has(classificationKey(label)),
        );
      }),
    toggle(label: string) {
      if (params.inert()) {
        return;
      }
      const key = classificationKey(label);
      labels = labels.some((entry) => classificationKey(entry) === key)
        ? labels.filter((entry) => classificationKey(entry) !== key)
        : [...labels, label];
      params.publish();
    },
    overwriteName: () =>
      read(() => {
        const over = overwriteOpen ? overflow() : [];
        return over.length === 1 ? over[0] : undefined;
      }),
    overwriteTarget: () => read(() => overwriteTarget),
    chooseTarget(name: string) {
      overwriteTarget = name;
      params.publish();
    },
    /** Back to before the attempt: the typed name stays, nothing was sent. */
    cancelOverwrite() {
      overwriteOpen = false;
      overwriteTarget = "";
      error = undefined;
      params.publish();
    },
    cardsCarrying(name: string) {
      void params.owner().revision;
      const key = classificationKey(name);
      return getWorkboardState(params.owner().host).cards.filter(
        (card) =>
          workboardCardBoardId(card) === boardId() &&
          card.labels.some((label) => classificationKey(label) === key),
      ).length;
    },
  };
}

export type ClassificationDraft = ReturnType<typeof createClassificationDraft>;

/**
 * Focus in the labels popover: on open the first usable slot (reusing a classification is
 * the primary path), after a refusal or step back the open overwrite step or the field.
 */
export function focusClassificationEditor(root: HTMLElement, moment: "open" | "refused") {
  const selectors =
    moment === "open"
      ? [".workboard-palette__slot--used:not([aria-disabled])", ".workboard-palette__create input"]
      : [".workboard-palette__overwrite select", ".workboard-palette__create input"];
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element) {
      element.focus();
      return;
    }
  }
}

function paletteClass(params: {
  palette: readonly WorkboardClassification[] | undefined;
  inert: boolean;
  error: boolean;
}): string[] {
  const used = params.palette?.length ?? 0;
  return [
    "workboard-palette",
    params.palette === undefined ? "workboard-palette--loading" : "",
    params.palette !== undefined && used === 0 ? "workboard-palette--empty" : "",
    used >= WORKBOARD_CLASSIFICATION_SLOTS ? "workboard-palette--full" : "",
    params.error ? "workboard-palette--error" : "",
    params.inert ? "workboard-palette--readonly" : "",
  ].filter(Boolean);
}

function ClassificationSlot(props: {
  label: string;
  color?: string;
  pressed: boolean;
  inert: boolean;
  unslotted?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      class={[
        "workboard-palette__slot",
        props.unslotted ? "workboard-palette__slot--unslotted" : "workboard-palette__slot--used",
      ]}
      style={props.color ? { "--palette-slot-color": props.color } : undefined}
      aria-pressed={props.pressed ? "true" : "false"}
      aria-disabled={props.inert ? "true" : undefined}
      title={props.label}
      onClick={() => {
        if (!props.inert) {
          props.onToggle();
        }
      }}
    >
      {props.unslotted ? null : <span class="workboard-palette__dot" aria-hidden="true" />}
      <span class="workboard-palette__name">{props.label}</span>
      <span class="workboard-palette__check" aria-hidden="true">
        {props.pressed ? icons.check : null}
      </span>
    </button>
  );
}

function ClassificationSlotGrid(props: { id: string; draft: ClassificationDraft; inert: boolean }) {
  // Read the resolver while the host is active, as the card view does.
  const resolveColor = workboardHost().components.resolveAppearanceColor;
  const titleId = () => `${props.id}-title`;
  const noteId = () => `${props.id}-note`;
  const free = () =>
    Math.max(0, WORKBOARD_CLASSIFICATION_SLOTS - (props.draft.palette()?.length ?? 0));
  return (
    <>
      <div class="workboard-palette__header">
        <span class="workboard-palette__title" id={titleId()}>
          {t("workboard.classificationTitle")}
        </span>
        <Show when={props.draft.palette()}>
          {(palette) => (
            <span class="workboard-palette__count" aria-live="polite">
              {t("workboard.classificationCount", {
                count: String(palette().length),
                total: String(WORKBOARD_CLASSIFICATION_SLOTS),
              })}
            </span>
          )}
        </Show>
      </div>
      <Show
        when={props.draft.palette()}
        fallback={<p class="workboard-palette__status">{t("workboard.classificationLoading")}</p>}
      >
        {(palette) => (
          <Show
            when={palette().length > 0}
            fallback={<p class="workboard-palette__status">{t("workboard.classificationEmpty")}</p>}
          >
            <div class="workboard-palette__slots" role="group" aria-labelledby={titleId()}>
              <For each={palette()} keyed={(entry) => classificationKey(entry.name)}>
                {(entry) => (
                  <ClassificationSlot
                    label={entry().name}
                    color={resolveColor(entry().color) || undefined}
                    pressed={props.draft.selected(entry().name)}
                    inert={props.inert}
                    onToggle={() => props.draft.toggle(entry().name)}
                  />
                )}
              </For>
              {/* Free capacity only; the palette grows from Create, never from an empty click. */}
              <For each={Array.from({ length: free() }, (_, index) => index)}>
                {() => (
                  <span class="workboard-palette__slot workboard-palette__slot--free">
                    {t("workboard.classificationFree")}
                  </span>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
      <Show when={props.draft.unslotted().length > 0}>
        <div
          class="workboard-palette__unslotted"
          role="group"
          aria-label={t("workboard.classificationUnslotted")}
          aria-describedby={props.draft.palette() ? noteId() : undefined}
        >
          <For each={props.draft.unslotted()} keyed={(label) => label}>
            {(label) => (
              <ClassificationSlot
                label={label()}
                unslotted
                pressed={props.draft.selected(label())}
                inert={props.inert}
                onToggle={() => props.draft.toggle(label())}
              />
            )}
          </For>
        </div>
        {/* While the palette loads, every card label is listed here; the note would be wrong. */}
        <Show when={props.draft.palette()}>
          <p class="workboard-palette__note" id={noteId()}>
            {t("workboard.classificationUnslottedNote")}
          </p>
        </Show>
      </Show>
    </>
  );
}

function ClassificationOverwritePicker(props: {
  id: string;
  draft: ClassificationDraft;
  palette: readonly WorkboardClassification[];
  name: string;
  busy: boolean;
  onConfirm: (target: string) => void;
  onCancel: () => void;
}) {
  let select: HTMLSelectElement | undefined;
  const bindTarget = liveInputValue(props.draft.overwriteTarget);
  const target = () => props.draft.overwriteTarget();
  const count = () => props.draft.cardsCarrying(target());
  onSettled(() => select?.focus());
  return (
    <div
      class="workboard-palette__overwrite"
      role="group"
      aria-labelledby={`${props.id}-overwrite-title`}
    >
      <span class="workboard-palette__overwrite-title" id={`${props.id}-overwrite-title`}>
        {t("workboard.classificationReplaceTitle")}
      </span>
      <label class="workboard-palette__field" for={`${props.id}-overwrite-target`}>
        {t("workboard.classificationReplaceLabel")}
      </label>
      <select
        id={`${props.id}-overwrite-target`}
        class="settings-input"
        ref={(element: HTMLSelectElement) => {
          select = element;
          bindTarget(element);
        }}
        disabled={props.busy}
        onChange={(event) => props.draft.chooseTarget(event.currentTarget.value)}
      >
        <option value="">{t("workboard.classificationReplaceChoose")}</option>
        <For each={props.palette} keyed={(entry) => classificationKey(entry.name)}>
          {(entry) => <option value={entry().name}>{entry().name}</option>}
        </For>
      </select>
      <Show when={target()}>
        <p class="workboard-palette__overwrite-warning" role="alert">
          {count() === 1
            ? t("workboard.classificationReplaceWarningOne", { name: target(), next: props.name })
            : t("workboard.classificationReplaceWarning", {
                name: target(),
                next: props.name,
                count: String(count()),
              })}
        </p>
      </Show>
      <div class="workboard-palette__overwrite-actions">
        <button type="button" class="btn" disabled={props.busy} onClick={props.onCancel}>
          {t("workboard.classificationReplaceBack")}
        </button>
        <button
          type="button"
          class="btn workboard-palette__replace"
          disabled={props.busy || !target()}
          onClick={() => props.onConfirm(target())}
        >
          {target()
            ? t("workboard.classificationReplaceConfirm", { name: target(), next: props.name })
            : t("workboard.classificationReplaceLabel")}
        </button>
      </div>
    </div>
  );
}

/** The labels popover body: slot grid, Create field, field error and overwrite step. */
export function ClassificationPaletteEditor(props: {
  id: string;
  draft: ClassificationDraft;
  typed: () => string;
  bindValue: (element: HTMLInputElement) => void;
  onInput: JSX.InputEventHandler<HTMLInputElement, InputEvent>;
  readOnly: boolean;
  /** No toggles or writes: read-only card, lost connection, or a save in flight. */
  inert: boolean;
  inputDisabled: boolean;
  onSave: (replaces?: string) => void;
}) {
  let input: HTMLInputElement | undefined;
  const errorId = () => `${props.id}-error`;
  return (
    <div
      class={paletteClass({
        palette: props.draft.palette(),
        inert: props.inert,
        error: Boolean(props.draft.error()),
      })}
    >
      <ClassificationSlotGrid id={props.id} draft={props.draft} inert={props.inert} />
      <div class="workboard-palette__create">
        <label class="workboard-palette__field" for={`${props.id}-new`}>
          {t("workboard.classificationNew")}
        </label>
        <input
          id={`${props.id}-new`}
          class="settings-input"
          ref={(element: HTMLInputElement) => {
            input = element;
            props.bindValue(element);
          }}
          disabled={props.inputDisabled}
          readonly={props.readOnly}
          aria-invalid={props.draft.error() ? "true" : undefined}
          aria-describedby={props.draft.error() ? errorId() : undefined}
          onInput={props.onInput}
        />
        <button
          type="button"
          class={props.draft.palette()?.length === 0 ? "btn primary" : "btn"}
          disabled={props.inert || !props.typed().trim()}
          onClick={() => props.onSave()}
        >
          {t("workboard.classificationCreate")}
        </button>
      </div>
      <Show when={props.draft.error()}>
        {(message) => (
          <p class="workboard-palette__error" id={errorId()} role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.draft.overwriteName()}>
        {(name) => (
          <ClassificationOverwritePicker
            id={props.id}
            draft={props.draft}
            palette={props.draft.palette() ?? []}
            name={name()}
            busy={props.inert}
            onConfirm={(target) => props.onSave(target)}
            onCancel={() => {
              props.draft.cancelOverwrite();
              input?.focus();
            }}
          />
        )}
      </Show>
    </div>
  );
}
