import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import entry from "./index.js";

type Manifest = {
  id: string;
  enabledByDefault: boolean;
  contracts: { decisionProviders: string[] };
  configSchema: {
    additionalProperties: boolean;
    properties: Record<string, Record<string, unknown>>;
  };
  decisionModels: unknown[];
};

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as Manifest;

it("registers a example decision provider backed by plugin config", () => {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  entry.register({
    runtime: {
      config: {
        current: () => ({
          plugins: { entries: { example: { config: { baseUrl: "http://127.0.0.1:8011" } } } },
        }),
      },
    },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  expect(registerDecisionProvider).toHaveBeenCalledOnce();
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  expect(provider?.id).toBe("example");
  expect(provider?.contractVersion).toBe(1);
  expect(provider?.isReady?.()).toBe(true);
});

it("declares the pinned decision model and ownership contract", () => {
  expect(manifest.id).toBe("example");
  expect(manifest.enabledByDefault).toBe(false);
  expect(manifest.contracts.decisionProviders).toEqual(["example"]);
  expect(manifest.decisionModels).toEqual([
    {
      provider: "example",
      id: "ds41-314113f8",
      name: "DeepSeek V4.1 (ds41, HF 314113f8)",
      capabilities: {
        questionTypes: ["boolean", "choice", "score"],
        maxQuestions: 32,
        maxChoiceAlternatives: 64,
        maxScoreLevels: 10,
        confidence: "none",
      },
    },
  ]);
});

it("keeps the manifest config bounds aligned with the runtime schema", () => {
  expect(manifest.configSchema.additionalProperties).toBe(false);
  expect(manifest.configSchema.properties.baseUrl?.pattern).toBe(
    "^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]{1,5})?/?$",
  );
  expect(manifest.configSchema.properties.maxTokens).toMatchObject({
    type: "integer",
    minimum: 256,
    maximum: 65536,
    default: 4096,
  });
  expect(manifest.configSchema.properties.timeoutMs).toMatchObject({
    type: "integer",
    minimum: 1000,
    maximum: 60000,
    default: 30000,
  });
});
