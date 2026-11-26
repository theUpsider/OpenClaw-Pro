/**
 * Config-to-runtime plumbing for `compat.numericReasoningEfforts`.
 *
 * The numeric map is authored in `models.providers.<id>.models[].compat` and must survive the real
 * config validation, model-default materialization, inline-provider projection, and configured
 * runtime-model preparation before any request builder can see it. Non-numbers must be rejected at
 * the schema boundary instead of being coerced.
 */
import { describe, expect, it } from "vitest";
import { applyModelDefaults } from "../config/defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { prepareConfiguredRuntimeModels } from "./prepared-model-runtime.configured.js";

const provider = "numeric-effort-fixture";
const route = {
  api: "openai-completions",
  baseUrl: "http://numeric-effort.example.test:8001/v1",
} as const;
const NUMERIC_EFFORTS = { low: 40, medium: 50, high: 70, xhigh: 80, max: 100 };

const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: provider, providers: [provider] }],
});

function authoredModel(compat: ModelDefinitionConfig["compat"]): ModelDefinitionConfig {
  return {
    id: "ds41",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    compat,
  };
}

function sourceConfig(compat: ModelDefinitionConfig["compat"]) {
  return {
    models: {
      providers: {
        [provider]: { ...route, models: [authoredModel(compat)] },
      },
    },
  };
}

describe("numeric reasoning effort plumbing", () => {
  it("carries the field from config through defaults into the runtime model", () => {
    const parsed = validateConfigObjectRaw(
      sourceConfig({
        supportedReasoningEfforts: ["low", "high", "xhigh", "max"],
        numericReasoningEfforts: NUMERIC_EFFORTS,
      }),
    );
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.issues));
    }

    const config = applyModelDefaults(parsed.config, {
      manifestRegistry: metadata.manifestRegistry,
    });
    expect(config.models?.providers?.[provider]?.models?.[0]?.compat).toMatchObject({
      numericReasoningEfforts: NUMERIC_EFFORTS,
    });

    const inline = buildInlineProviderModels(config.models?.providers ?? {}, {
      providerMetadataOwners: metadata.owners,
    });
    expect(inline[0]?.compat).toMatchObject({ numericReasoningEfforts: NUMERIC_EFFORTS });

    const configured = prepareConfiguredRuntimeModels({
      config,
      inlineProviderModels: inline,
      configuredModelRefs: [{ provider, modelId: "ds41" }],
      metadataSnapshot: metadata,
      providerStaticModels: [],
      resolveStaticCatalogModel: () => undefined,
      matchesStaticModelId: createStaticModelIdMatcher({ manifestPlugins: metadata }),
    });
    expect(configured[0]?.model.compat).toMatchObject({
      numericReasoningEfforts: NUMERIC_EFFORTS,
    });
  });

  it.each([
    ["a numeric string", { medium: "50" }],
    ["a boolean", { medium: true }],
    ["null", { medium: null }],
    ["an array", [50]],
  ])("rejects %s at the config schema", (_label, value) => {
    const result = validateConfigObjectRaw(
      sourceConfig({ numericReasoningEfforts: value as never }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts an empty numeric map after defaults omit it", () => {
    const parsed = validateConfigObjectRaw(sourceConfig({ numericReasoningEfforts: {} }));
    expect(parsed.ok).toBe(true);
  });
});
