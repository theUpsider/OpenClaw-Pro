import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ConfigSchema } from "./src/config.js";
import { resolveRuntimeConfig } from "./src/credentials.js";
import { createDecisionProvider } from "./src/decisions.js";

export default definePluginEntry({
  id: "example",
  name: "Example Decisions",
  description: "Typed decision provider for the loopback Example ds41 model.",
  configSchema: { jsonSchema: { ...ConfigSchema } },
  register(api) {
    api.registerDecisionProvider(
      createDecisionProvider(() => resolveRuntimeConfig(api.runtime.config.current())),
    );
  },
});
