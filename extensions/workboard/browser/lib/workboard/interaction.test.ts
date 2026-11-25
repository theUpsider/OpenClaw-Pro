import "../../test/host.setup.ts";
import { expect, it } from "vitest";
import { resolveWorkboardInteraction, workboardInteractionTarget } from "./interaction.ts";
import { createGatewaySession, createWorkboardCard } from "./test/index-helpers.ts";

const dockKey = "agent:main:dock-d";

function cardWithInteraction(
  overrides: Partial<NonNullable<ReturnType<typeof createWorkboardCard>["metadata"]>> = {},
  card: Partial<Parameters<typeof createWorkboardCard>[0]> = {},
) {
  return createWorkboardCard({
    ...card,
    metadata: {
      interaction: { sessionKey: dockKey, agentId: "main", startedAt: 1, updatedAt: 2 },
      ...overrides,
    },
  });
}

it("resolves a live dock conversation from the dock-inclusive window", () => {
  const session = createGatewaySession({
    key: dockKey,
    displayName: "Board agent",
    status: "running",
    hasActiveRun: true,
  });
  const link = resolveWorkboardInteraction(cardWithInteraction(), [session]);
  expect(link).toMatchObject({ state: "live", session: { key: dockKey } });
  expect(workboardInteractionTarget(link)).toEqual({ sessionKey: dockKey, agentId: "main" });
});

it("keeps a finished conversation as an idle reference", () => {
  const session = createGatewaySession({
    key: dockKey,
    displayName: "Board agent",
    status: "done",
    hasActiveRun: false,
  });
  expect(resolveWorkboardInteraction(cardWithInteraction(), [session])).toMatchObject({
    state: "idle",
  });
});

it("treats a stale running row without an active run as idle, not live", () => {
  const session = createGatewaySession({
    key: dockKey,
    status: "running",
    hasActiveRun: false,
    updatedAt: Date.now() - 60 * 60 * 1000,
  });
  expect(resolveWorkboardInteraction(cardWithInteraction(), [session])).toMatchObject({
    state: "idle",
  });
});

it("falls away cleanly when the dock conversation is gone", () => {
  const other = createGatewaySession({ key: "agent:main:elsewhere" });
  expect(resolveWorkboardInteraction(cardWithInteraction(), [other])).toBeUndefined();
  expect(resolveWorkboardInteraction(cardWithInteraction(), [])).toBeUndefined();
  expect(resolveWorkboardInteraction(cardWithInteraction(), undefined)).toBeUndefined();
  expect(workboardInteractionTarget(undefined)).toBeUndefined();
});

it("never claims a card that owns an execution session", () => {
  const session = createGatewaySession({ key: dockKey, status: "running", hasActiveRun: true });
  expect(
    resolveWorkboardInteraction(cardWithInteraction({}, { sessionKey: "agent:main:work" }), [
      session,
    ]),
  ).toBeUndefined();
  expect(
    resolveWorkboardInteraction(
      cardWithInteraction(
        {},
        {
          execution: {
            id: "e",
            kind: "agent-session",
            mode: "autonomous",
            status: "running",
            sessionKey: "agent:main:work",
            startedAt: 1,
            updatedAt: 1,
          },
        },
      ),
      [session],
    ),
  ).toBeUndefined();
});

it("ignores a reserved interaction key and a card without the field", () => {
  expect(
    resolveWorkboardInteraction(
      createWorkboardCard({
        metadata: { interaction: { sessionKey: "global", startedAt: 1, updatedAt: 2 } },
      }),
      [createGatewaySession({ key: "global" })],
    ),
  ).toBeUndefined();
  expect(resolveWorkboardInteraction(createWorkboardCard(), [])).toBeUndefined();
});
