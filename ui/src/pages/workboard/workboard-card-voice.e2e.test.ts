import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard card voice" });
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const config = { plugins: { entries: { workboard: { enabled: true } } } };
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
  it("offers a card-scoped microphone in the card detail overview", async () => {
    const context = await suite.newBrowserContext({
      reducedMotion: "reduce",
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": {
            config,
            hash: "workboard-card-voice-e2e",
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
        },
      });
      await page.goto(`${suite.server.baseUrl}workboard`);
      // The board heading keeps its own, differently named microphone.
      await page
        .locator(".workboard-page-title")
        .getByRole("button", { name: "Talk to the board" })
        .waitFor({ state: "visible" });
      const surface = page.locator(".workboard-card", { hasText: card.title });
      await surface.hover();
      await surface.locator(".workboard-card__menu-trigger").click();
      await surface.getByRole("button", { name: "View details", exact: true }).click();
      const properties = page.locator(".workboard-detail__properties");
      await properties
        .getByRole("button", { name: "Talk about this card" })
        .waitFor({ state: "visible" });
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(createControlUiE2eArtifactDir("workboard-card-voice"), "01-card-voice.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [properties]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
