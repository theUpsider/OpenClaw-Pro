import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard compact density" });
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const config = { plugins: { entries: { workboard: { enabled: true } } } };
const cards = ["Draft release notes", "Check CI flakes", "Review label filter"].map(
  (title, index): WorkboardCard => ({
    id: `compact-${index}`,
    title,
    labels: ["ui", "release"],
    position: 1000 * (index + 1),
    priority: "high",
    status: "todo",
    createdAt: baseTime,
    updatedAt: baseTime,
  }),
);

async function openWorkboard(page: Page) {
  await installMockGateway(page, {
    ...workboardUi,
    methodResponses: {
      "config.get": {
        config,
        hash: "workboard-density-e2e",
        path: "/tmp/openclaw-e2e/openclaw.json",
        raw: JSON.stringify(config),
        resolved: config,
        sourceConfig: config,
      },
      "workboard.cards.list": {
        boards: [{ id: "default", total: 3, active: 3, archived: 0, byStatus: {} }],
        cards,
        statuses: ["triage", "backlog", "todo", "ready", "review", "done"],
      },
    },
  });
  const response = await page.goto(`${suite.server.baseUrl}workboard`);
  expect(response?.status()).toBe(200);
  await page.locator(".workboard-column--todo .workboard-card").first().waitFor();
}

async function setFiltersOpen(page: Page, open: boolean) {
  const panel = page.locator(".workboard-filter-popover__panel");
  if (open) {
    await page.locator(".workboard-filter-trigger").click();
    await panel.waitFor({ state: "visible" });
  } else {
    await page
      .locator(".workboard-filter-popover")
      .evaluate((element) => (element as HTMLElement).hidePopover());
    await panel.waitFor({ state: "hidden" });
  }
}

async function chooseCompact(page: Page) {
  await setFiltersOpen(page, true);
  await page
    .getByRole("group", { name: "Density", exact: true })
    .getByRole("button", { name: "Compact", exact: true })
    .click();
  await setFiltersOpen(page, false);
}

function todoGeometry(page: Page) {
  return page.locator(".workboard-column--todo").evaluate((column) => {
    const [first, second] = [...column.querySelectorAll(".workboard-card")].map((item) =>
      item.getBoundingClientRect(),
    );
    const title = column.querySelector(".workboard-card__title h3") as HTMLElement;
    return {
      cardGap: second.top - first.bottom,
      cardHeight: first.height,
      columnWidth: column.getBoundingClientRect().width,
      titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
    };
  });
}

suite.define(() => {
  it("tightens compact columns and cards on desktop", async () => {
    const artifacts = captureUiProofEnabled
      ? createControlUiE2eArtifactDir("workboard-compact-density")
      : "";
    const capture = async (page: Page, name: string) => {
      if (artifacts) {
        await writeFile(
          path.join(artifacts, `${name}.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".workboard-page-title"),
          ]),
        );
      }
    };
    const context = await suite.newBrowserContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    try {
      await openWorkboard(page);
      const comfortable = await todoGeometry(page);
      expect(comfortable.columnWidth).toBeCloseTo(340, 0);
      await capture(page, "01-comfortable-density");
      await chooseCompact(page);
      await expect.poll(async () => (await todoGeometry(page)).columnWidth).toBeCloseTo(248, 0);
      const compact = await todoGeometry(page);
      expect(compact.cardHeight).toBeLessThan(comfortable.cardHeight * 0.85);
      expect(compact.cardGap).toBeLessThan(comfortable.cardGap);
      expect(compact.titleFontSize).toBeLessThan(comfortable.titleFontSize);
      await capture(page, "02-compact-density");
      await setFiltersOpen(page, true);
      await page.getByRole("group", { name: "Sort", exact: true }).waitFor();
      await page.getByRole("group", { name: "Labels", exact: true }).waitFor();
      await capture(page, "03-filter-sort-and-labels");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps compact touch collapse controls at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await page.setViewportSize({ height: 844, width: 390 });
      await openWorkboard(page);
      await chooseCompact(page);
      const collapseButton = page.getByRole("button", { name: "Collapse Todo column" });
      await collapseButton.waitFor({ state: "visible" });
      const bounds = await collapseButton.evaluate((button) => button.getBoundingClientRect());
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    });
  });
});
