/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import {
  parseWorkboardNote,
  WORKBOARD_NOTES_COLLAPSE_LINES,
  workboardNoteDisplaySource,
} from "../../lib/workboard/note-outline.ts";

/**
 * The notes read path: the drawer's plain-text convention rendered as a label/value list in a
 * fixed order, with an unstructured fallback. The parser is pure
 * (`lib/workboard/note-outline`), the labels are i18n, and the stored string is never
 * rewritten -- the editor keeps binding `card.notes` verbatim, so a save writes the original
 * layout back.
 *
 * The read path is its own sibling module because `view-inline-properties` owns the editable
 * fields and this is the display-only projection of one of them.
 *
 * The disclosures stop their own click and key events: the notes render inside the drawer's
 * editor trigger, so an expanding `<details>` would otherwise also open the editor over the
 * note the operator is reading. A native `<details>` toggles on Enter and Space itself, so
 * swallowing the bubbled event never costs the keyboard path.
 */
export function CardNotes(props: { notes: string; class?: string; chrome?: "none" }) {
  const outline = createMemo(() => parseWorkboardNote(props.notes));
  const source = (text: string) => workboardNoteDisplaySource(text);
  // Both helpers take their body as an accessor on purpose. Reading the section inside the
  // `<Show>` children would make the children memo depend on the note object, so every page
  // re-render (the page bumps `revision` on each `requestUpdate`) rebuilt the `<details>` node
  // with `open=false` -- the row visibly collapsed under the operator while they were reading
  // it. With an accessor the read happens in the rendered child's own prop instead, so an
  // unchanged note keeps the SAME `<details>` element and the operator's expansion survives.
  const markdown = (text: () => string, className?: string) => (
    <Markdown
      markdown={source(text())}
      class={className}
      {...(props.chrome ? { codeBlockChrome: props.chrome } : {})}
    />
  );
  // The lead is one sentence; the split can straddle a Markdown construct, which is why the
  // unstructured path is the only one that takes it.
  const fullCharacters = createMemo(() => props.notes.trim().length);
  const disclosure = (label: string, body: () => JSX.Element) => (
    <details
      class="workboard-notes__disclosure"
      onClick={(event: MouseEvent) => event.stopPropagation()}
      onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <summary>{label}</summary>
      {body()}
    </details>
  );
  return (
    <Show
      when={outline().structured}
      fallback={
        <div class={["workboard-notes", "workboard-notes--unstructured", props.class ?? ""]}>
          <p class="workboard-notes__marker">{t("workboard.notes.unstructured")}</p>
          <p class="workboard-notes__marker-help">{t("workboard.notes.unstructuredHelp")}</p>
          <Show when={outline().lead}>
            {markdown(() => outline().lead, "workboard-notes__lead")}
          </Show>
          <Show when={outline().rest}>
            {disclosure(t("workboard.notes.showFull", { count: String(fullCharacters()) }), () =>
              markdown(() => outline().rest, "workboard-notes__rest"),
            )}
          </Show>
        </div>
      }
    >
      <div class={["workboard-notes", props.class ?? ""]}>
        <Show when={outline().preamble}>
          {markdown(() => outline().preamble, "workboard-notes__preamble")}
        </Show>
        <dl class="workboard-notes__list">
          <For each={outline().sections} keyed={(section) => section.key}>
            {(section) => (
              <>
                <dt class="workboard-notes__label">{t(section().labelKey)}</dt>
                <dd class="workboard-notes__value">
                  <Show
                    when={
                      section().key === "what" &&
                      section().lineCount > WORKBOARD_NOTES_COLLAPSE_LINES
                    }
                    fallback={markdown(() => section().text)}
                  >
                    {disclosure(t("workboard.notes.showWas"), () => markdown(() => section().text))}
                  </Show>
                </dd>
              </>
            )}
          </For>
        </dl>
      </div>
    </Show>
  );
}
