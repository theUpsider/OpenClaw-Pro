import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiDictationControlProps } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createWorkboardTestClient } from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { openCreateModal } from "./view-card-modal.tsx";
import { createWorkboardView, toast } from "./view.test-support.ts";

// Test names map to the "New card: Sprachentwurf" row of docs/ui/screen-state-matrix.md.

type Microphone = HTMLButtonElement & { props: ControlUiDictationControlProps };

function newCardDialog(
  draftResponse: (params: unknown) => unknown,
  overrides: Parameters<typeof createWorkboardView>[0] = {},
) {
  const client = createWorkboardTestClient((method, params) =>
    method === "workboard.cards.draft" ? draftResponse(params) : undefined,
  ) as unknown as GatewayBrowserClient & { request: ReturnType<typeof vi.fn> };
  const onRequestUpdate = vi.fn();
  const view = createWorkboardView({ client, onRequestUpdate, ...overrides });
  openCreateModal(view.state, { agentsList: overrides.agentsList ?? null });
  view.renderView();
  const field = <T extends HTMLElement>(selector: string) =>
    expectDefined(view.container.querySelector<T>(selector), selector);
  return {
    ...view,
    client,
    onRequestUpdate,
    microphone: () => field<Microphone>(".workboard-modal__header [data-test-dictation]"),
    title: () => field<HTMLInputElement>(".workboard-draft__title"),
    notes: () => field<HTMLTextAreaElement>(".workboard-draft__notes"),
    labels: () => field<HTMLInputElement>(".workboard-draft__labels"),
    status: () => field<HTMLElement>(".workboard-draft__voice-status"),
    requests: (method: string) => client.request.mock.calls.filter(([called]) => called === method),
  };
}

describe("New card voice draft", () => {
  it("mic present: offers the microphone only in the New card dialog", () => {
    const dialog = newCardDialog(() => ({ draft: {}, hints: [] }));

    const microphone = dialog.microphone();
    expect(microphone.props.accessibleLabel).toBe("Fill in the card by voice");
    expect(microphone.disabled).toBe(false);
    expect(dialog.status().getAttribute("aria-live")).toBe("polite");
    // Before speaking it takes no room above the title: its spacing sits on its children.
    expect(dialog.status().children).toHaveLength(0);

    dialog.state.editingCardId = "card-1";
    dialog.renderView();
    expect(dialog.container.querySelector("[data-test-dictation]")).toBeNull();
  });

  it("read-only: disables the microphone with its reason", () => {
    const dialog = newCardDialog(() => ({ draft: {}, hints: [] }), { canWrite: false });

    const microphone = dialog.microphone();
    expect(microphone.disabled).toBe(true);
    expect(microphone.props.disabledReason).toBe(
      "Filling in by voice needs write access and a form that is not saving.",
    );
  });

  it("prefills the open form from exactly one draft request and never creates the card", async () => {
    const answer = createDeferred<unknown>();
    const dialog = newCardDialog(() => answer.promise, {
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    });
    const title = dialog.title();
    title.value = "typed before speaking";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));

    dialog.microphone().props.onTranscript("fix the login bug, urgent, frontend, for writer");

    // drafting: the status says so, only the microphone waits; the form stays editable.
    await waitForFast(() =>
      expect(dialog.status().textContent).toBe("Filling in the form from your words…"),
    );
    expect(dialog.microphone().disabled).toBe(true);
    expect(dialog.title().disabled).toBe(false);
    answer.resolve({
      draft: {
        title: "Fix the login bug",
        notes: "Safari only.",
        status: "ready",
        priority: "urgent",
        labels: ["Frontend", "Infra"],
        agentId: "writer",
      },
      hints: [],
    });

    await waitForFast(() =>
      expect(dialog.status().textContent).toBe(
        "Filled in from your words. Check the fields; nothing is created until you press Create.",
      ),
    );
    expect(dialog.requests("workboard.cards.draft")).toEqual([
      ["workboard.cards.draft", { voiceText: "fix the login bug, urgent, frontend, for writer" }],
    ]);
    expect(dialog.requests("workboard.cards.create")).toEqual([]);
    expect(dialog.state.draftOpen).toBe(true);
    expect(dialog.state).toMatchObject({
      draftTitle: "Fix the login bug",
      draftNotes: "Safari only.",
      draftStatus: "ready",
      draftPriority: "urgent",
      draftLabels: "Frontend, Infra",
      draftAgentId: "writer",
    });
    expect(dialog.title().value).toBe("Fix the login bug");
    expect(dialog.notes().value).toBe("Safari only.");
    expect(dialog.labels().value).toBe("Frontend, Infra");
    expect(dialog.onRequestUpdate).toHaveBeenCalled();
    expect(dialog.microphone().disabled).toBe(false);
  });

  it("empty answer fields keep the operator's values and hints are shown as text", async () => {
    const dialog = newCardDialog(() => ({
      draft: { title: "", labels: ["Frontend"] },
      hints: ['Label "backend" is not one of this board\'s labels; left out.'],
    }));
    Object.assign(dialog.state, {
      draftTitle: "My title",
      draftNotes: "My notes",
      draftPriority: "high",
      draftAgentId: "writer",
    });
    dialog.renderView();

    dialog.microphone().props.onTranscript("label it frontend and backend");

    await waitForFast(() =>
      expect([...dialog.status().querySelectorAll("li")].map((item) => item.textContent)).toEqual([
        'Label "backend" is not one of this board\'s labels; left out.',
      ]),
    );
    expect(dialog.state).toMatchObject({
      draftTitle: "My title",
      draftNotes: "My notes",
      draftPriority: "high",
      draftAgentId: "writer",
      draftLabels: "Frontend",
    });
    expect(dialog.title().value).toBe("My title");
    expect(dialog.state.draftOpen).toBe(true);
    expect(dialog.requests("workboard.cards.create")).toEqual([]);
  });

  it("error path: shows the failure and leaves every field and the dialog as they were", async () => {
    const dialog = newCardDialog(() => {
      throw new Error("Plugin LLM completion denied: capability denied");
    });
    Object.assign(dialog.state, { draftTitle: "Keep me", draftLabels: "Infra" });
    dialog.renderView();

    dialog.microphone().props.onTranscript("fix login");

    await waitForFast(() =>
      expect(toast(dialog.container).textContent).toContain(
        "Could not fill in the form from your words; your entries are unchanged. Plugin LLM completion denied: capability denied",
      ),
    );
    expect(dialog.state).toMatchObject({
      draftOpen: true,
      draftTitle: "Keep me",
      draftLabels: "Infra",
      draftPriority: "normal",
    });
    expect(dialog.title().value).toBe("Keep me");
    expect(dialog.status().textContent).toBe("");
    expect(dialog.requests("workboard.cards.create")).toEqual([]);
    expect(dialog.microphone().disabled).toBe(false);
  });

  it("drops a late answer once the dialog was dismissed", async () => {
    const answer = createDeferred<unknown>();
    const dialog = newCardDialog(() => answer.promise);

    dialog.microphone().props.onTranscript("fix login");
    expectDefined(
      dialog.container.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]'),
      "close",
    ).click();
    expect(dialog.state.draftOpen).toBe(false);
    answer.resolve({ draft: { title: "Fix login" }, hints: [] });
    await answer.promise;
    await Promise.resolve();

    expect(dialog.state.draftTitle).toBe("");
    expect(dialog.requests("workboard.cards.create")).toEqual([]);
  });
});
