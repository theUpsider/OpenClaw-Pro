import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { installTalkBrowserFixtures } from "../../e2e/browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard voice transcript gate",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const config = { plugins: { entries: { workboard: { enabled: true } } } };
const transcript = "Move the login redirect card to in progress.";
const card: WorkboardCard = {
  id: "voice-card",
  title: "Fix login redirect",
  labels: ["bug"],
  position: 1000,
  priority: "high",
  status: "todo",
  createdAt: baseTime,
  updatedAt: baseTime,
};

suite.define(() => {
  it("shows the composer controls in the Check transcript dialog", async () => {
    await suite.withPage(
      {
        permissions: ["microphone"],
        reducedMotion: "reduce",
        viewport: { width: 1400, height: 900 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          ...workboardUi,
          deferredMethods: ["talk.session.create"],
          methodResponses: {
            "config.get": {
              config,
              hash: "workboard-voice-gate-e2e",
              path: "/tmp/openclaw-e2e/openclaw.json",
              raw: JSON.stringify(config),
              resolved: config,
              sourceConfig: config,
            },
            "workboard.cards.list": {
              boards: [{ id: "default", total: 1, active: 1, archived: 0, byStatus: {} }],
              cards: [card],
              statuses: ["todo"],
            },
            "talk.catalog": {
              transcription: { ready: true, providers: [] },
              realtime: { providers: [] },
              speech: { providers: [] },
              modes: [],
              transports: [],
              brains: [],
            },
            "talk.session.create": {
              sessionId: "workboard-voice-gate",
              transcriptionSessionId: "workboard-voice-gate",
              audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}workboard`);
        const title = page.locator(".workboard-page-title");
        const microphone = title.getByRole("button", { name: "Talk to the board" });
        await microphone.waitFor({ state: "visible" });
        await microphone.click();
        await gateway.waitForRequest("talk.session.create");
        await gateway.resolveDeferred("talk.session.create");
        await gateway.emitGatewayEvent("talk.event", {
          transcriptionSessionId: "workboard-voice-gate",
          type: "transcript",
          final: true,
          text: transcript,
        });
        await title.getByRole("button", { name: "Stop and keep text" }).click();

        const dialog = page.getByRole("dialog", { name: "Check transcript" });
        const gate = dialog.locator(".workboard-voice-gate");
        await gate.waitFor({ state: "visible" });
        expect(await gate.getByLabel("Recognized text").inputValue()).toBe(transcript);
        const actions = gate.locator(".workboard-modal__actions");
        const sessionControls = actions.locator("openclaw-plugin-composer-session-controls");
        const recordAgain = actions.getByRole("button", { name: "Record again" });
        const discard = actions.getByRole("button", { name: "Discard", exact: true });
        const send = actions.locator("openclaw-plugin-composer-send-action .chat-send-btn--send");
        await sessionControls.waitFor({ state: "visible" });
        await recordAgain.waitFor({ state: "visible" });
        await discard.waitFor({ state: "visible" });
        await send.waitFor({ state: "visible" });
        // The plain Workboard Send button is replaced by the composer's send action.
        expect(await actions.locator(":scope > button").count()).toBe(1);
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(createControlUiE2eArtifactDir("workboard-voice-gate"), "after.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [gate]),
          );
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
