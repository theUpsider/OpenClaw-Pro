import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { expect, it } from "vitest";
import { createDecisionProvider } from "./decisions.js";

// Opt-in only: drives the real loopback endpoint at EXAMPLE_LIVE_TEST=1.
const live = process.env.EXAMPLE_LIVE_TEST === "1" ? it : it.skip;

const batch: DecisionBatch = {
  state: { report: "The parcel arrived damaged and the customer is upset." },
  questions: {
    route: {
      type: "choice",
      instructions: "Choose the team that should own this.",
      criteria: {
        support: "Handle damaged goods",
        billing: "Refunds and plans",
        sales: "New orders",
      },
    },
    urgency: {
      type: "score",
      instructions: "Rate how urgent this is.",
      criteria: ["Routine", "Soon", "Immediate", "Now"],
    },
    escalate: {
      type: "boolean",
      instructions: "Should this page the on-call agent?",
      criteria: { true: "Page on-call now", false: "Handle in normal queue" },
    },
  },
};

live("answers choice, score, and boolean against the live ds41 endpoint", async () => {
  const provider = createDecisionProvider(() => ({
    baseUrl: "http://127.0.0.1:8011",
    timeoutMs: 60000,
    maxTokens: 4096,
  }));
  const outcome = await provider.evaluate(batch, {
    model: "example/ds41-314113f8",
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 60000,
  });
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") {
    throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
  }
  const { answers, model } = outcome.result;
  expect(model).toBe("ds41-314113f8");
  expect(answers.route?.type).toBe("choice");
  expect(answers.urgency?.type).toBe("score");
  expect(answers.escalate?.type).toBe("boolean");
  if (answers.route?.type === "choice") {
    expect(Object.keys(answers.route.probabilities).toSorted()).toEqual([
      "billing",
      "sales",
      "support",
    ]);
  }
  if (answers.urgency?.type === "score") {
    expect(answers.urgency.probabilities).toHaveLength(4);
  }
  console.log("example live answers:", JSON.stringify(outcome.result));
});
