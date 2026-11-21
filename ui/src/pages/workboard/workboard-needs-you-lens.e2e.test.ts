import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

/**
 * The "Needs you" lens: one ordered sequence, the agentless rest as one collapsed row, and a
 * card face that lets the operator decide without opening the drawer.
 *
 * Its own file because the main Workboard e2e file sits at the repository's `max-lines` lint
 * ceiling; the sibling `workboard-distribution.e2e.test.ts` splits for the same reason. The
 * helpers below are local copies of the main file's, which are not exported.
 */

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard needs-you lens mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 1000, width: 2400 };
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const WORKBOARD_STATUSES: readonly WorkboardStatus[] = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
];

type ProofArtifacts = { directory: string; screenshots: string[] };

function createProofArtifacts(scope: string): ProofArtifacts {
  return {
    directory: captureUiProofEnabled ? createControlUiE2eArtifactDir(scope) : "",
    screenshots: [],
  };
}

function workboardConfigSnapshot() {
  const config = { plugins: { entries: { workboard: { enabled: true } } } };
  return {
    config,
    hash: "workboard-lens-e2e-config",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
  };
}

function sessionsListResponse() {
  return {
    count: 0,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [],
    ts: baseTime,
  };
}

function card(
  overrides: Partial<WorkboardCard> & Pick<WorkboardCard, "id" | "title">,
): WorkboardCard {
  return {
    createdAt: baseTime,
    labels: [],
    notes: "",
    position: 1000,
    priority: "normal",
    status: "todo",
    updatedAt: baseTime,
    ...overrides,
  };
}

function cardsListResponse(cards: WorkboardCard[]) {
  const boards: WorkboardBoardSummary[] = [
    { id: "default", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
  ];
  return { boards, cards, statuses: WORKBOARD_STATUSES };
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

async function captureScreenshot(
  page: Page,
  artifacts: ProofArtifacts,
  name: string,
  surface: Locator = page.locator(".shell"),
  content: readonly Locator[] = [page.locator(".workboard-page-title")],
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const screenshotPath = path.join(artifacts.directory, `${name}.png`);
  await writeFile(screenshotPath, await takeControlUiViewportScreenshot(page, surface, content));
  artifacts.screenshots.push(screenshotPath);
}

suite.define(() => {
  it("ranks the lens by reason and decides a card without opening the drawer", async () => {
    const artifacts = createProofArtifacts("workboard-needs-you-lens");
    // The three tiers the lens draws: a blocked decision card, a review card to accept, and an
    // open card nobody owns. The decision card is LOW priority on purpose: the reason tier must
    // decide before priority, so the operator's own steps come first whatever their priority.
    // No card names an agent here: the page scopes every card to its roster's default agent, so a
    // foreign `agentId` never reaches the board (the agentless card is the tier-2 case anyway).
    const decisionCard = card({
      id: "lens-decision",
      title: "Choose the tenant for the drill",
      status: "blocked",
      priority: "low",
      labels: ["decision"],
      notes: "Was: Prepared the drill.\nNächster Schritt: Which tenant should the drill land in?",
      metadata: {
        automation: {
          decisionOptions: [
            { label: "Tenant A", description: "The sandbox tenant." },
            { label: "Tenant B", recommended: true },
          ],
        },
      },
      position: 1000,
    });
    const reviewCard = card({
      id: "lens-review",
      title: "Accept the protocol report",
      status: "review",
      priority: "urgent",
      notes: "Stand: The report is written and the gates are green.",
      position: 2000,
    });
    const unownedCard = card({
      id: "lens-unowned",
      title: "Nobody picked this up",
      status: "todo",
      priority: "urgent",
      position: 3000,
    });

    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse(),
          "workboard.cards.list": cardsListResponse([decisionCard, reviewCard, unownedCard]),
          // The mocked Gateway answers an unlisted method with no card, and the mutation owner
          // normalizes every response through `normalizeCardPayload`; name both writes so the
          // decision path can complete.
          "workboard.cards.comment": {
            card: {
              ...decisionCard,
              updatedAt: baseTime + 1,
              metadata: {
                ...decisionCard.metadata,
                comments: [{ id: "c1", body: "Decision: Tenant A", createdAt: baseTime + 1 }],
              },
            },
          },
          "workboard.cards.move": {
            card: {
              ...decisionCard,
              labels: [],
              status: "ready",
              updatedAt: baseTime + 2,
            },
          },
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await page.locator(".workboard-column--review .workboard-card").first().waitFor({
        state: "visible",
      });

      // The lens replaces the columns with one ordered sequence.
      await page.getByRole("button", { name: /^Needs you/u }).click();
      const inbox = page.locator(".workboard-inbox");
      await inbox.waitFor({ state: "visible" });
      await expect.poll(() => page.locator(".workboard-column").count()).toBe(1);

      // Tier order: decision (tier 0), review (tier 1); the agentless card is collapsed into one
      // summary row instead of taking a slot of its own.
      const rows = page.locator(".workboard-inbox__item");
      await expect.poll(() => rows.count()).toBe(2);
      await expect.poll(() => rows.nth(0).getAttribute("data-card-id")).toBe("lens-decision");
      await expect.poll(() => rows.nth(1).getAttribute("data-card-id")).toBe("lens-review");
      expect(await page.getByText(unownedCard.title).count()).toBe(0);
      const unownedRow = page.locator("button.workboard-inbox__unowned-row");
      await expect.poll(() => unownedRow.getAttribute("aria-expanded")).toBe("false");
      expect(await unownedRow.locator(".workboard-inbox__unowned-count").textContent()).toBe("1");

      // The face is a sibling of the card, never a child of its `role="button"` article.
      const decisionFace = page.locator("section.workboard-face--decision").first();
      await expect
        .poll(() => decisionFace.getAttribute("aria-label"))
        .toBe(`Decide: ${decisionCard.title}`);
      expect(
        await decisionFace.evaluate((face) => face.closest("article.workboard-card") === null),
      ).toBe(true);
      // The question is the hero and comes from the note's `Nächster Schritt:` line.
      expect(await decisionFace.locator(".workboard-face__question").textContent()).toBe(
        "Which tenant should the drill land in?",
      );

      // The option buttons are the existing resolver's options in the STORED order (the order is
      // the number, same as the drawer), with the recommendation marked as text
      // (* Recommendation), never by colour or by moving the option.
      const options = decisionFace.locator(".workboard-face__option");
      await expect.poll(() => options.count()).toBe(2);
      // Stored order and numbering: the numbers match the drawer's, and the recommendation sits
      // at its stored position 2 instead of being pulled to the front.
      await expect.poll(() => options.nth(0).textContent()).toContain("Tenant A");
      await expect.poll(() => options.nth(1).textContent()).toContain("Tenant B");
      await expect.poll(() => options.nth(1).textContent()).toContain("* Recommendation");
      await expect.poll(() => options.nth(0).textContent()).not.toContain("* Recommendation");
      expect(await options.nth(0).getAttribute("aria-label")).toBe("Choose: Tenant A");
      expect(await options.nth(1).getAttribute("aria-label")).toBe("Recommendation: Tenant B");
      await waitForControlUiProofSurface(inbox, [decisionFace]);
      await captureScreenshot(page, artifacts, "12-needs-you-lens");

      // The review face offers accept / send back and shows no decision options.
      const reviewFace = page.locator("section.workboard-face--review").first();
      await expect.poll(() => reviewFace.locator(".workboard-face__option").count()).toBe(0);
      expect(await reviewFace.locator(".workboard-face__evidence-none").textContent()).toContain(
        "No proof",
      );
      await reviewFace.getByRole("button", { name: "Send back...", exact: true }).click();
      const sendBack = reviewFace.locator(".workboard-face__send-back");
      await sendBack.waitFor({ state: "visible" });
      expect(
        await sendBack.getByRole("button", { name: "Send back", exact: true }).isDisabled(),
      ).toBe(true);
      await captureScreenshot(page, artifacts, "13-needs-you-review-face");
      await sendBack.getByRole("button", { name: "Cancel", exact: true }).click();

      // Deciding writes only after the countdown, and the countdown is announced with an Undo.
      const movesBefore = await requestCount(gateway, "workboard.cards.move");
      await options.nth(0).click();
      const pending = decisionFace.locator(".workboard-face__pending");
      await expect.poll(() => pending.textContent()).toContain("Deciding: Tenant A");
      expect(await requestCount(gateway, "workboard.cards.move")).toBe(movesBefore);
      await captureScreenshot(page, artifacts, "14-needs-you-pending-decision");
      await expect
        .poll(() => requestCount(gateway, "workboard.cards.move"), { timeout: 15_000 })
        .toBe(movesBefore + 1);
      expect(await requestCount(gateway, "workboard.cards.comment")).toBe(1);
      const move: MockGatewayRequest = (await gateway.getRequests("workboard.cards.move")).at(-1)!;
      expect(move.params).toMatchObject({
        id: decisionCard.id,
        labelsRemove: ["decision"],
        status: "ready",
      });
      // The card left the lens once it was decided: nothing waits on the operator any more.
      await expect.poll(() => page.locator(".workboard-inbox__item").count()).toBe(1);
    } finally {
      await context.close();
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(artifacts.directory, "manifest.json"),
          `${JSON.stringify(artifacts, null, 2)}\n`,
          "utf-8",
        );
      }
    }
  });
});
