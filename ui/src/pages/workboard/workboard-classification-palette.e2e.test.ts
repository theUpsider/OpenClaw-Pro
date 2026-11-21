import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { WORKBOARD_CHANGED_EVENT } from "../../../../packages/workboard-contract/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard classification palette" });
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const colors = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
const palette = [
  "bug",
  "feature",
  "docs",
  "chore",
  "research",
  "ops",
  "design",
  "test",
  "ux",
  "perf",
];
const card = (id: string, title: string, labels: string[]) => ({
  id,
  title,
  labels,
  position: 1000,
  priority: "normal",
  status: "todo",
  createdAt: baseTime,
  updatedAt: baseTime,
});
const target = card("palette-card", "Palette card", ["bug"]);
const others = [card("ops-1", "Ops one", ["ops"]), card("ops-2", "Ops two", ["Ops", "docs"])];
const replaced = { ...target, labels: ["bug", "research", "triage"], updatedAt: baseTime + 1 };
const board = {
  id: "default",
  total: 3,
  active: 3,
  archived: 0,
  byStatus: { todo: 3 },
  classifications: palette.map((name, index) => ({ name, color: colors[index % colors.length] })),
};
const config = { plugins: { entries: { workboard: { enabled: true } } } };

suite.define(() => {
  it("toggles a slot, stops the 11th classification at the field, and replaces one", async () => {
    const context = await suite.newBrowserContext({
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const artifacts = captureUiProofEnabled
      ? createControlUiE2eArtifactDir("workboard-classification-palette")
      : undefined;
    const capture = async (surface: Locator, name: string) => {
      if (artifacts) {
        await surface.screenshot({ path: path.join(artifacts, `${name}.png`) });
      }
    };
    try {
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": {
            config,
            hash: "workboard-palette-e2e",
            path: "/tmp/openclaw-e2e/openclaw.json",
            raw: JSON.stringify(config),
            resolved: config,
            sourceConfig: config,
          },
          "workboard.cards.list": {
            boards: [board],
            cards: [target, ...others],
            statuses: ["todo"],
          },
          "workboard.cards.update": { card: replaced },
        },
      });
      await page.goto(`${suite.server.baseUrl}workboard`);
      const cardView = page.locator(".workboard-card", { hasText: target.title });
      // The board palette colors the card itself: "bug" is the primary classification.
      await expect
        .poll(() =>
          cardView.evaluate((element) => element.classList.contains("workboard-card--classified")),
        )
        .toBe(true);
      await cardView.hover();
      await cardView.locator(".workboard-card__menu-trigger").click();
      await cardView.getByRole("button", { name: "View details", exact: true }).click();
      await page.locator(".workboard-detail__text-trigger--labels").click();
      const popover = page.locator(".workboard-detail__labels-popover");
      const palettePanel = popover.locator(".workboard-palette");
      await palettePanel.waitFor({ state: "visible" });
      expect(await palettePanel.locator(".workboard-palette__count").textContent()).toBe(
        "10 / 10 used",
      );
      await capture(popover, "palette-full");

      const research = popover.getByRole("button", { name: "research", exact: true });
      expect(await research.getAttribute("aria-pressed")).toBe("false");
      await research.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => research.getAttribute("aria-pressed")).toBe("true");

      await popover.getByLabel("New classification").fill("triage");
      await popover.getByRole("button", { name: "Create", exact: true }).click();
      const error = popover.locator(".workboard-palette__error");
      await error.waitFor({ state: "visible" });
      expect(await error.getAttribute("role")).toBe("alert");
      expect(await error.textContent()).toContain("No free slot for “triage”");
      expect(await popover.getByLabel("New classification").inputValue()).toBe("triage");
      expect(await gateway.getRequests("workboard.cards.update")).toHaveLength(0);
      await capture(popover, "palette-error");

      const replaceTarget = popover.getByLabel("Replace", { exact: true });
      await expect
        .poll(() => replaceTarget.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await replaceTarget.selectOption("ops");
      const warning = popover.locator(".workboard-palette__overwrite-warning");
      await warning.waitFor({ state: "visible" });
      expect(await warning.textContent()).toBe(
        "“ops” loses its classification on 2 cards. “triage” takes its slot and color.",
      );
      await capture(popover, "overwrite-picker");

      await popover.getByRole("button", { name: "Replace “ops” with “triage”" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("workboard.cards.update")).length)
        .toBe(1);
      const [update] = await gateway.getRequests("workboard.cards.update");
      expect(update?.params).toEqual({
        id: target.id,
        expectedUpdatedAt: target.updatedAt,
        patch: { labels: ["bug", "research", "triage"], replaces: "ops" },
      });
      await palettePanel.waitFor({ state: "detached" });
      await expect
        .poll(() => page.locator(".workboard-detail__text-trigger--labels").textContent())
        .toContain("triage");

      // The Gateway's change event reloads the board palette: "triage" took the "ops" slot.
      const boardsBefore = (await gateway.getRequests("workboard.boards.list")).length;
      const replacedBoard = {
        ...board,
        classifications: palette.map((name, index) => ({
          name: name === "ops" ? "triage" : name,
          color: colors[index % colors.length],
        })),
      };
      await gateway.setMethodResponse("workboard.boards.list", { boards: [replacedBoard] });
      await gateway.setMethodResponse("workboard.cards.list", {
        boards: [replacedBoard],
        cards: [replaced, ...others],
        statuses: ["todo"],
      });
      await gateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {});
      await expect
        .poll(async () => (await gateway.getRequests("workboard.boards.list")).length)
        .toBeGreaterThan(boardsBefore);
      await page.locator(".workboard-detail__text-trigger--labels").click();
      await palettePanel.waitFor({ state: "visible" });
      const triage = popover.getByRole("button", { name: "triage", exact: true });
      await expect.poll(() => triage.getAttribute("aria-pressed")).toBe("true");
      expect(await popover.getByRole("button", { name: "ops", exact: true }).count()).toBe(0);
      await capture(popover, "palette-after-replace");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
