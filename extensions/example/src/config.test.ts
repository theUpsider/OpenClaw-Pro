import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { ConfigSchema, localBaseUrl, runtimeConfig } from "./config.js";
import { resolveRuntimeConfig } from "./credentials.js";

it.each(["http://127.0.0.1:8011", "https://localhost", "http://[::1]:8011"])(
  "accepts a loopback origin %s",
  (value: string) => {
    expect(localBaseUrl(value)).toBe(new URL(value).origin);
    expect(runtimeConfig({ baseUrl: value })).toEqual({
      baseUrl: new URL(value).origin,
      timeoutMs: 30000,
      maxTokens: 4096,
    });
  },
);

it.each([
  "https://remote.example",
  "http://localhost:8011/v1",
  "http://user:secret@localhost:8011",
  "file:///localhost",
  "http://2130706433:8011",
  " http://127.0.0.1:8011",
])("rejects a non-loopback or ambiguous origin %s", (value: string) => {
  expect(() => localBaseUrl(value)).toThrow("baseUrl");
});

it("bounds timeoutMs and maxTokens and rejects unknown keys", () => {
  expect(Check(ConfigSchema, {})).toBe(true);
  expect(
    Check(ConfigSchema, { baseUrl: "http://127.0.0.1:8011", timeoutMs: 30000, maxTokens: 4096 }),
  ).toBe(true);
  for (const bad of [
    { baseUrl: "https://remote.example" },
    { timeoutMs: 999 },
    { timeoutMs: 60001 },
    { maxTokens: 255 },
    { maxTokens: 65537 },
    { extra: true },
  ]) {
    expect(Check(ConfigSchema, bad)).toBe(false);
  }
  expect(() => runtimeConfig({ timeoutMs: 60001 })).toThrow("Invalid Example configuration");
  expect(() => runtimeConfig({ maxTokens: 255 })).toThrow("Invalid Example configuration");
});

it("reads only this plugin's validated config from the host snapshot", () => {
  expect(
    resolveRuntimeConfig({
      plugins: {
        entries: { example: { config: { baseUrl: "http://127.0.0.1:8011/", maxTokens: 8192 } } },
      },
    }),
  ).toEqual({ baseUrl: "http://127.0.0.1:8011", timeoutMs: 30000, maxTokens: 8192 });
  expect(
    resolveRuntimeConfig({
      plugins: { entries: { other: { config: { baseUrl: "http://127.0.0.1:9" } } } },
    }),
  ).toEqual({ baseUrl: undefined, timeoutMs: 30000, maxTokens: 4096 });
});
