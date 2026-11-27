/**
 * WP7 test: the live registrar folds the operator's configured hook failure
 * policy into the typed-hook registration record.
 *
 * The runner-side consumer (`hooks.ts`) reads `hook.failurePolicy` and falls
 * back to the Gateway per-hook default only when the registrar leaves it
 * unset. This test pins that producer contract at the single live registration
 * path (`registry-registrars.ts` -> `registerTypedHook`).
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNormalizedPluginsConfig } from "./config-state.js";
import type { HookFailurePolicy } from "./hook-failure-policy.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createPluginRecord } from "./status.test-helpers.js";

function registerHook(params: {
  hookName: "message_sending";
  plugins?: OpenClawConfig["plugins"];
  failurePolicy?: HookFailurePolicy;
}) {
  const runtime = createPluginRuntime();
  runtime.config.current = () => ({});
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
  });
  const record = createPluginRecord({ id: "guard", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, {
    config: {},
    hookPolicy: createNormalizedPluginsConfig(params.plugins).entries.guard?.hooks,
  });
  api.on(
    params.hookName,
    () => undefined,
    params.failurePolicy ? { failurePolicy: params.failurePolicy } : undefined,
  );
  return builder.registry.typedHooks.at(-1);
}

describe("registry-registrars typed-hook failure policy fold", () => {
  it("folds the per-hook operator config into the registration record", () => {
    const registration = registerHook({
      hookName: "message_sending",
      plugins: {
        entries: { guard: { hooks: { failurePolicies: { message_sending: "fail-closed" } } } },
      },
    });
    expect(registration?.failurePolicy).toBe("fail-closed");
  });

  it("folds the plugin-level operator failurePolicy into the registration record", () => {
    const registration = registerHook({
      hookName: "message_sending",
      plugins: { entries: { guard: { hooks: { failurePolicy: "fail-closed" } } } },
    });
    expect(registration?.failurePolicy).toBe("fail-closed");
  });

  it("leaves failurePolicy unset when nothing is configured", () => {
    const registration = registerHook({ hookName: "message_sending" });
    expect(registration).not.toHaveProperty("failurePolicy");
  });
});
