import type { DecisionBatch, DecisionEntry, DecisionQuestion } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";

const BASE_URL = "http://127.0.0.1:8011";
const CONFIG = { baseUrl: BASE_URL, timeoutMs: 30000, maxTokens: 4096 };
const MODEL = "example/ds41-314113f8";

function batchOf(
  questions: Record<string, DecisionQuestion>,
  state: DecisionEntry = { report: "The parcel is damaged" },
): DecisionBatch {
  return { state, questions };
}

function context(
  extra: Partial<{
    model: string;
    signal: AbortSignal;
    deadlineMonotonicMs: number;
    isAdmissible: () => boolean;
  }> = {},
) {
  return {
    model: MODEL,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30000,
    ...extra,
  };
}

function stubFetch(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function chatCompletion(content: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "ds41",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    ...overrides,
  };
}

function jsonCompletion(value: unknown, overrides: Record<string, unknown> = {}) {
  return chatCompletion(JSON.stringify(value), overrides);
}

function respondWith(body: unknown, init?: ResponseInit) {
  return async () => Response.json(body, init);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("maps a choice answer to the exact real-label shape", async () => {
  const fetch = stubFetch(
    respondWith(
      jsonCompletion({
        q0: { type: "choice", probabilities: { l0: 0.98, l1: 0.01, l2: 0.01 }, choice: "l0" },
      }),
    ),
  );
  const outcome = await evaluate(
    batchOf({
      route: {
        type: "choice",
        instructions: "Pick a team",
        criteria: { support: "Help desk", billing: "Plans", sales: "New orders" },
      },
    }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({
    status: "ok",
    result: {
      model: "ds41-314113f8",
      answers: {
        route: {
          type: "choice",
          choice: "support",
          probabilities: { support: 0.98, billing: 0.01, sales: 0.01 },
        },
      },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("maps a score answer with index-aligned probabilities and a fractional score", async () => {
  stubFetch(
    respondWith(
      jsonCompletion({ q0: { type: "score", probabilities: [0, 0, 0.02, 0.98], score: 2.5 } }),
    ),
  );
  const outcome = await evaluate(
    batchOf({ urgency: { type: "score", criteria: ["Routine", "Soon", "Immediate", "Now"] } }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({
    status: "ok",
    result: {
      model: "ds41-314113f8",
      answers: { urgency: { type: "score", score: 2.5, probabilities: [0, 0, 0.02, 0.98] } },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  });
});

it("maps a boolean answer to probabilityTrue", async () => {
  stubFetch(respondWith(jsonCompletion({ q0: { type: "boolean", probabilityTrue: 0.99 } })));
  const outcome = await evaluate(
    batchOf({ escalate: { type: "boolean", criteria: { true: "Page on-call", false: "Wait" } } }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({
    status: "ok",
    result: {
      model: "ds41-314113f8",
      answers: { escalate: { type: "boolean", probabilityTrue: 0.99 } },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  });
});

it("maps all three question types in one batch", async () => {
  stubFetch(
    respondWith(
      jsonCompletion({
        q0: { type: "choice", probabilities: { l0: 0.98, l1: 0.01, l2: 0.01 }, choice: "l0" },
        q1: { type: "score", probabilities: [0, 0, 0.02, 0.98], score: 3 },
        q2: { type: "boolean", probabilityTrue: 0.99 },
      }),
    ),
  );
  const outcome = await evaluate(
    batchOf({
      route: {
        type: "choice",
        criteria: { support: "Help desk", billing: "Plans", sales: "New orders" },
      },
      urgency: { type: "score", criteria: ["Routine", "Soon", "Immediate", "Now"] },
      escalate: { type: "boolean" },
    }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({
    status: "ok",
    result: {
      model: "ds41-314113f8",
      answers: {
        route: {
          type: "choice",
          choice: "support",
          probabilities: { support: 0.98, billing: 0.01, sales: 0.01 },
        },
        urgency: { type: "score", score: 3, probabilities: [0, 0, 0.02, 0.98] },
        escalate: { type: "boolean", probabilityTrue: 0.99 },
      },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  });
});

it("maps a refused connection to transport", async () => {
  const fetch = stubFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "transport" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("maps a 400 unsatisfiable-schema rejection to unsupported-input", async () => {
  stubFetch(
    respondWith(
      { error: { message: "Grammar error: Unsatisfiable schema for response_format" } },
      { status: 400 },
    ),
  );
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "unsupported-input" });
});

it("maps a 401 to authentication", async () => {
  stubFetch(respondWith({ error: { message: "unauthorized" } }, { status: 401 }));
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "authentication" });
});

it("maps a 429 to rate-limited with the retry hint", async () => {
  stubFetch(respondWith({}, { status: 429, headers: { "retry-after": "2" } }));
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "rate-limited", retryAfterMs: 2000 });
});

it("rejects a prose response that is not JSON", async () => {
  stubFetch(respondWith(chatCompletion("The best team is support.")));
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("rejects a served model that is not the pinned served name", async () => {
  // Pins the served-name guard: a server re-pointed at a different alias must fail
  // loudly rather than answer under the pinned identity.
  stubFetch(
    respondWith(
      jsonCompletion(
        { q0: { type: "boolean", probabilityTrue: 0.5 } },
        { model: "some-other-checkpoint" },
      ),
    ),
  );
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("rejects a truncated response with null content", async () => {
  stubFetch(
    respondWith(
      chatCompletion(null, {
        choices: [
          { index: 0, finish_reason: "length", message: { role: "assistant", content: null } },
        ],
      }),
    ),
  );
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("rejects a non-stop finish_reason even when the content is well-formed JSON", async () => {
  // Pins the finish_reason guard itself: without it, a truncated generation whose
  // partial output happens to parse would be accepted as a complete answer.
  stubFetch(
    respondWith(
      chatCompletion(JSON.stringify({ q0: { type: "boolean", probabilityTrue: 0.2 } }), {
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: JSON.stringify({ q0: { type: "boolean", probabilityTrue: 0.2 } }),
            },
          },
        ],
      }),
    ),
  );
  const outcome = await evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, context());
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

const GOOD_CHOICE = {
  type: "choice",
  probabilities: { l0: 0.98, l1: 0.01, l2: 0.01 },
  choice: "l0",
};
it.each<[string, unknown]>([
  ["an extra synthetic key", { q0: GOOD_CHOICE, q1: GOOD_CHOICE }],
  ["a missing synthetic key", {}],
  ["an unknown choice label", { q0: { ...GOOD_CHOICE, choice: "l9" } }],
  ["a probability above one", { q0: { ...GOOD_CHOICE, probabilities: { l0: 1.5, l1: 0, l2: 0 } } }],
  [
    "a negative probability",
    { q0: { ...GOOD_CHOICE, probabilities: { l0: -0.5, l1: 0.5, l2: 1 } } },
  ],
  ["an all-zero distribution", { q0: { ...GOOD_CHOICE, probabilities: { l0: 0, l1: 0, l2: 0 } } }],
  [
    "an unknown probability key",
    { q0: { ...GOOD_CHOICE, probabilities: { l0: 0.9, l1: 0.05, l2: 0.05, l9: 0 } } },
  ],
  ["a wrong per-question type", { q0: { ...GOOD_CHOICE, type: "boolean" } }],
  [
    "a non-numeric probability",
    { q0: { ...GOOD_CHOICE, probabilities: { l0: "0.9", l1: 0.05, l2: 0.05 } } },
  ],
])("rejects a choice answer with %s", async (_name, content) => {
  stubFetch(respondWith(jsonCompletion(content)));
  const outcome = await evaluate(
    batchOf({
      route: {
        type: "choice",
        criteria: { support: "Help desk", billing: "Plans", sales: "Orders" },
      },
    }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

const GOOD_SCORE = { type: "score", probabilities: [0, 0, 0.02, 0.98], score: 2.5 };
it.each<[string, unknown]>([
  ["a wrong score array length", { q0: { ...GOOD_SCORE, probabilities: [0, 1] } }],
  ["a score above the last level", { q0: { ...GOOD_SCORE, score: 9 } }],
  ["a negative score", { q0: { ...GOOD_SCORE, score: -1 } }],
  ["an all-zero score distribution", { q0: { ...GOOD_SCORE, probabilities: [0, 0, 0, 0] } }],
])("rejects a score answer with %s", async (_name, content) => {
  stubFetch(respondWith(jsonCompletion(content)));
  const outcome = await evaluate(
    batchOf({ urgency: { type: "score", criteria: ["Routine", "Soon", "Immediate", "Now"] } }),
    CONFIG,
    context(),
  );
  expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("preserves a `__proto__` question id and choice label instead of dropping it", async () => {
  // A plain `{}` assignment would set the prototype for `__proto__` and lose the key,
  // so the host would reject a valid batch as `invalid-response`. Every object with a
  // `__proto__` key here is built with Object.fromEntries, because an object *literal*
  // `{ __proto__: ... }` sets the prototype instead of creating an own key.
  stubFetch(
    respondWith(
      jsonCompletion({
        q0: { type: "choice", probabilities: { l0: 0.6, l1: 0.4 }, choice: "l0" },
      }),
    ),
  );
  const questions = Object.fromEntries([
    [
      "__proto__",
      {
        type: "choice",
        criteria: Object.fromEntries([
          ["__proto__", "A"],
          ["other", "B"],
        ]),
      },
    ],
  ]);
  const outcome = await evaluate(batchOf(questions), CONFIG, context());
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") {
    throw new Error(JSON.stringify(outcome));
  }
  const answers = outcome.result.answers as Record<string, unknown>;
  expect(Object.keys(answers)).toContain("__proto__");
});

it("rejects an unsupported model before any fetch", async () => {
  const fetch = stubFetch(
    respondWith(jsonCompletion({ q0: { type: "boolean", probabilityTrue: 1 } })),
  );
  await expect(
    evaluate(batchOf({ escalate: { type: "boolean" } }), CONFIG, {
      ...context(),
      model: "other/model",
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects an over-cap batch before any fetch", async () => {
  const fetch = stubFetch(respondWith(jsonCompletion({})));
  const questions = Object.fromEntries(
    Array.from({ length: 33 }, (_value, index) => [`q${index}`, { type: "boolean" as const }]),
  );
  await expect(evaluate(batchOf(questions), CONFIG, context())).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a choice question over the alternative cap before any fetch", async () => {
  const fetch = stubFetch(respondWith(jsonCompletion({})));
  const criteria = Object.fromEntries(
    Array.from({ length: 65 }, (_value, index) => [`label-${index}`, `option ${index}`]),
  );
  await expect(
    evaluate(batchOf({ route: { type: "choice", criteria } }), CONFIG, context()),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects caller cancellation instead of returning an unavailable outcome", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller closed"));
  await expect(
    evaluate(
      batchOf({ escalate: { type: "boolean" } }),
      CONFIG,
      context({ signal: controller.signal }),
    ),
  ).rejects.toThrow("caller closed");
});

it("rejects when cancelled during transport instead of returning an unavailable outcome", async () => {
  const controller = new AbortController();
  stubFetch(async () => {
    controller.abort(new Error("caller closed mid-flight"));
    throw new Error("aborted");
  });
  await expect(
    evaluate(
      batchOf({ escalate: { type: "boolean" } }),
      CONFIG,
      context({ signal: controller.signal }),
    ),
  ).rejects.toThrow("caller closed mid-flight");
});
