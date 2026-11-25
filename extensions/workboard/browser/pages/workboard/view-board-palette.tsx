/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import {
  WORKBOARD_CLASSIFICATION_COLORS,
  WORKBOARD_CLASSIFICATION_SLOTS,
  createPaletteDraft,
  normalizePaletteDraft,
  type WorkboardClassification,
  type WorkboardPaletteDraftEntry,
} from "../../lib/workboard/classification.ts";
import { liveInputValue } from "./view-input-value.ts";

/** The board editor's palette draft: rows the operator renames, recolors, orders, or drops. */
export type BoardPaletteDraft = {
  entries: WorkboardPaletteDraftEntry[];
  /** The stored palette at open time; a difference drives the write on save. */
  original: WorkboardClassification[];
  error: string | null;
};

export function createBoardPaletteDraft(
  stored: readonly WorkboardClassification[],
): BoardPaletteDraft {
  return {
    entries: createPaletteDraft(stored),
    original: stored.map((entry) => ({ name: entry.name, color: entry.color })),
    error: null,
  };
}

/** A fresh row seeds a color from the next slot index; the operator can change it. */
function nextColor(entries: readonly WorkboardPaletteDraftEntry[]): string {
  return WORKBOARD_CLASSIFICATION_COLORS[entries.length % WORKBOARD_CLASSIFICATION_COLORS.length]!;
}

/**
 * Whether the draft differs from what was stored, and the payload to send. A
 * locally invalid draft returns `error` so Save stays blocked with the reason at
 * the field, exactly as the label editor refuses in place.
 */
export function readBoardPaletteDraft(draft: BoardPaletteDraft): {
  changed: boolean;
  palette?: WorkboardClassification[];
  error?: string;
} {
  const normalized = normalizePaletteDraft(draft.entries);
  if ("error" in normalized) {
    return { changed: true, error: normalized.error };
  }
  const same =
    normalized.palette.length === draft.original.length &&
    normalized.palette.every(
      (entry, index) =>
        entry.name === draft.original[index]?.name && entry.color === draft.original[index]?.color,
    );
  return same ? { changed: false } : { changed: true, palette: normalized.palette };
}

/**
 * The board editor's classification palette: up to ten slots, each a name plus a
 * named session color. It only edits the draft; Save writes it through
 * `workboard.boards.classifications`. Existing cards keep their labels; a name
 * removed here leaves those chips as plain labels, as after a `replaces`.
 */
export function BoardPaletteEditor(props: {
  draft: BoardPaletteDraft;
  canWrite: boolean;
  saving: boolean;
  requestUpdate: () => void;
  revision?: number;
}) {
  const entries = () => {
    void props.revision;
    return props.draft.entries;
  };
  const disabled = () => {
    void props.revision;
    return props.saving || !props.canWrite;
  };
  const resolveColor = () => workboardHost().components.resolveAppearanceColor;
  const atLimit = () => entries().length >= WORKBOARD_CLASSIFICATION_SLOTS;
  const error = () => {
    void props.revision;
    return props.draft.error;
  };
  const move = (index: number, offset: number) => {
    const list = props.draft.entries;
    const target = index + offset;
    if (target < 0 || target >= list.length) {
      return;
    }
    const [entry] = list.splice(index, 1);
    list.splice(target, 0, entry!);
    props.requestUpdate();
  };
  const remove = (key: string) => {
    props.draft.entries = props.draft.entries.filter((candidate) => candidate.key !== key);
    props.requestUpdate();
  };
  return (
    <fieldset class="workboard-palette-editor" disabled={disabled()}>
      <legend>{t("workboard.classificationPaletteTitle")}</legend>
      <p class="workboard-palette-editor__help">{t("workboard.classificationPaletteHelp")}</p>
      <Show
        when={entries().length > 0}
        fallback={
          <p class="workboard-palette-editor__empty">{t("workboard.classificationPaletteEmpty")}</p>
        }
      >
        <ul class="workboard-palette-editor__rows">
          <For each={entries()} keyed={(entry) => entry.key}>
            {(entry, index) => {
              const current = () => {
                void props.revision;
                return entry();
              };
              const nameValue = liveInputValue(() => current().name);
              const colorValue = liveInputValue(() => current().color);
              return (
                <li class="workboard-palette-editor__row" data-palette-name={current().name}>
                  <label class="workboard-palette-editor__name">
                    <span class="workboard-palette-editor__field-label">
                      {t("workboard.classificationPaletteName")}
                    </span>
                    <input
                      class="settings-input"
                      maxlength="40"
                      required
                      aria-label={t("workboard.classificationPaletteNameFor", {
                        name: current().name,
                      })}
                      ref={nameValue}
                      onInput={(event) => {
                        current().name = event.currentTarget.value;
                        props.requestUpdate();
                      }}
                    />
                  </label>
                  <label class="workboard-palette-editor__color">
                    <span class="workboard-palette-editor__field-label">
                      {t("workboard.boardColor")}
                    </span>
                    <span class="workboard-palette-editor__color-control">
                      <span
                        class="workboard-palette-editor__dot"
                        aria-hidden="true"
                        style={{
                          "--palette-swatch-color":
                            resolveColor()(current().color) || "var(--muted)",
                        }}
                      />
                      <select
                        class="settings-input"
                        aria-label={t("workboard.classificationPaletteColorFor", {
                          name: current().name,
                        })}
                        ref={colorValue}
                        onChange={(event) => {
                          current().color = event.currentTarget.value;
                          props.requestUpdate();
                        }}
                      >
                        <For each={WORKBOARD_CLASSIFICATION_COLORS} keyed={(color) => color}>
                          {(color) => (
                            <option value={color()}>
                              {t(`workboard.sessionsBoard.color.${color()}`)}
                            </option>
                          )}
                        </For>
                      </select>
                    </span>
                  </label>
                  <div class="workboard-palette-editor__actions">
                    <button
                      type="button"
                      class="btn"
                      aria-label={t("workboard.classificationPaletteMoveUp", {
                        name: current().name,
                      })}
                      disabled={disabled() || index() === 0}
                      onClick={() => move(index(), -1)}
                    >
                      {t("workboard.classificationPaletteMoveUpShort")}
                    </button>
                    <button
                      type="button"
                      class="btn"
                      aria-label={t("workboard.classificationPaletteMoveDown", {
                        name: current().name,
                      })}
                      disabled={disabled() || index() === entries().length - 1}
                      onClick={() => move(index(), 1)}
                    >
                      {t("workboard.classificationPaletteMoveDownShort")}
                    </button>
                    <button
                      type="button"
                      class="btn btn--icon"
                      aria-label={t("workboard.classificationPaletteRemove", {
                        name: current().name,
                      })}
                      disabled={disabled()}
                      onClick={() => remove(current().key)}
                    >
                      {icons.trash}
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <div class="workboard-palette-editor__footer">
        <button
          type="button"
          class="btn"
          disabled={disabled() || atLimit()}
          onClick={() => {
            props.draft.entries = [
              ...props.draft.entries,
              { key: crypto.randomUUID(), name: "", color: nextColor(props.draft.entries) },
            ];
            props.requestUpdate();
          }}
        >
          {icons.plus}
          {t("workboard.classificationPaletteAdd")}
        </button>
        <span class="workboard-palette-editor__count" aria-live="polite">
          {t("workboard.classificationPaletteCount", {
            count: String(entries().length),
            total: String(WORKBOARD_CLASSIFICATION_SLOTS),
          })}
        </span>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="workboard-palette-editor__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </fieldset>
  );
}
