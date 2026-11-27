// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Locale } from "../../../../src/shared/control-ui-locale.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import * as storageHelpers from "../../test-helpers/storage.ts";
import { registerCommandPaletteEnglish } from "../locales/en-command-palette.ts";
import { createLazyLocaleCatalog } from "./lazy-catalog.ts";
import { createI18nManagerForTesting } from "./translate.test-support.ts";
import type { TranslationMap } from "./types.ts";

const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;
const settingsKey = "commandPalette.newSessionSettings";
const rememberKey = "commandPalette.rememberUnavailable";
const offline = new Error("offline");
const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
const subscriber = vi.fn<(locale: Locale) => void>();
let manager: ReturnType<typeof createI18nManagerForTesting>;

async function retryPendingLocale() {
  manager.retryPendingLocale();
  await Promise.allSettled(loadTranslation.mock.results.map((result) => result.value));
}

function createManager() {
  const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
  const loadConfigHints = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
  const manager = createI18nManagerForTesting(loadTranslation, loadConfigHints);
  return {
    loadTranslation,
    loadConfigHints,
    manager,
    retryPendingLocale: async () => {
      manager.retryPendingLocale();
      await Promise.allSettled(loadTranslation.mock.results.map((result) => result.value));
    },
  };
}

const state = () => ({
  locale: manager.getLocale(),
  requested: manager.getRequestedLocale(),
  stored: localStorage.getItem("openclaw.i18n.locale"),
  loads: loadTranslation.mock.calls.length,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", storageHelpers.createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  loadTranslation.mockReset();
  subscriber.mockReset();
  manager = createI18nManagerForTesting(loadTranslation);
  manager.subscribe(subscriber);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("repairs a Node-style storage accessor without invoking its unsafe getter", () => {
  const unsafeGetter = vi.fn(() => {
    throw new Error("Node WebStorage is unavailable without a local-storage file");
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: unsafeGetter });
  const storage = storageHelpers.installSafeLocalStorageForTesting();
  expect(unsafeGetter).not.toHaveBeenCalled();
  expect(getSafeLocalStorage()).toBe(storage);
});

it("prepares registered English namespaces before publishing a locale without loading unopened ones", async () => {
  registerCommandPaletteEnglish();
  const page = deferred<{ default: TranslationMap }>();
  const loadHints = vi.fn();
  const catalog = createLazyLocaleCatalog(
    { ...german, commandPalette: { newSessionSettings: "Neue Sitzung" } },
    { commandPalette: () => page.promise, configHints: loadHints },
  );
  manager.registerTranslation("de", catalog);
  const changing = manager.setLocale("de");
  expect(manager.getLocale()).toBe("en");
  expect(loadHints).not.toHaveBeenCalled();
  page.resolve({ default: { commandPalette: { rememberUnavailable: "Erneut verbinden" } } });
  await changing;
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  expect(manager.t(rememberKey)).toBe("Erneut verbinden");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.translateActive(settingsKey)).toBe("Neue Sitzung");
  expect(manager.translateActive("common.connected")).toBeUndefined();
});

it.each(["loaded", "failed"] as const)(
  "prepares the saved locale before route readiness (%s)",
  async (outcome) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("openclaw.i18n.locale", "de");
    const entry = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(entry.promise);
    manager = createI18nManagerForTesting(loadTranslation);
    let ready = false;
    const preparation = manager.prepareLocale().then(() => {
      ready = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(ready).toBe(false);
    if (outcome === "loaded") {
      entry.resolve(german);
    } else {
      entry.reject(offline);
    }
    await preparation;
    expect(manager.getLocale()).toBe(outcome === "loaded" ? "de" : "en");
    expect(manager.getRequestedLocale()).toBe("de");
  },
);

it("prepares a namespace registered after the active locale was published", async () => {
  const page = deferred<{ default: TranslationMap }>();
  const loadPage = vi.fn(() => page.promise);
  manager.registerTranslation(
    "de",
    createLazyLocaleCatalog({ ...german }, { lateRoute: loadPage }),
  );
  await manager.setLocale("de");
  expect(loadPage).not.toHaveBeenCalled();
  const { en } = await import("../locales/en.ts");
  en.lateRoute = { title: "Late route" };
  try {
    const prepared = manager.prepareLocale();
    expect(loadPage).toHaveBeenCalledOnce();
    page.resolve({ default: { lateRoute: { title: "Späte Seite" } } });
    await prepared;
    expect(manager.translateActive("lateRoute.title")).toBe("Späte Seite");
  } finally {
    delete en.lateRoute;
  }
});

it("keeps late namespace results scoped to their locale and retries a failed namespace", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const page = deferred<{ default: TranslationMap }>();
  const loadPage = vi.fn().mockRejectedValueOnce(offline).mockReturnValueOnce(page.promise);
  manager.registerTranslation("de", createLazyLocaleCatalog(german, { configHints: loadPage }));
  manager.registerTranslation("es", spanish);
  await manager.setLocale("de");
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await manager.setLocale("es");
  subscriber.mockClear();
  page.resolve({ default: { configHints: { label: "Einstellung" } } });
  await page.promise;
  await Promise.resolve();
  expect(subscriber).not.toHaveBeenCalled();
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await manager.setLocale("de");
  expect(manager.translateActive("configHints.label")).toBe("Einstellung");
  expect(loadPage).toHaveBeenCalledTimes(2);
});

it("deduplicates an in-flight target and permits retry after the shared load settles", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const firstLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(german);
  const first = manager.setLocale("de");
  const second = manager.setLocale("de");
  expect(loadTranslation).toHaveBeenCalledTimes(1);
  firstLoad.reject(offline);
  await Promise.all([first, second]);
  expect(state()).toMatchObject({ locale: "en", requested: "de" });
  expect(subscriber).not.toHaveBeenCalled();
  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "de", loads: 2 });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
});

it.each(["explicit", "system"] as const)("persists the latest %s request", async (mode) => {
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const localeLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(localeLoad.promise);
  const select = () => manager.setLocale("de");
  const system = () => manager.useSystemLocale();
  const requests = mode === "system" ? [select(), system()] : [system(), select()];
  localeLoad.resolve(german);
  await Promise.all(requests);
  expect(state()).toMatchObject({ locale: "de", stored: mode === "system" ? null : "de" });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
});

it.each(["explicit", "system"] as const)("keeps %s recovery preference", async (mode) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const onUnrecoverableLocaleLoad = vi.fn(() => state().stored);
  const importFailure = new Error("stale chunk");
  manager.setLocaleLoadRecovery({
    isUnrecoverableError: (error) => error === importFailure,
    onUnrecoverableLocaleLoad,
  });
  loadTranslation
    .mockRejectedValueOnce(offline)
    .mockRejectedValueOnce(importFailure)
    .mockResolvedValueOnce(german);

  await (mode === "system" ? manager.useSystemLocale() : manager.setLocale("de"));
  expect(state()).toMatchObject({ locale: "en", stored: mode === "system" ? null : "es" });
  await retryPendingLocale();

  const preference = mode === "system" ? null : "de";
  expect(state()).toMatchObject({ locale: "en", stored: preference, loads: 2 });
  expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("de");
  expect(onUnrecoverableLocaleLoad).toHaveReturnedWith(preference);

  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "de", stored: preference, loads: 3 });
});

it.each(["failure", "success"] as const)("ignores a stale locale load's %s", async (outcome) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const germanLoad = deferred<TranslationMap | null>();
  const spanishLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(germanLoad.promise).mockReturnValueOnce(spanishLoad.promise);
  if (outcome === "success") {
    loadTranslation.mockResolvedValueOnce(spanish);
  }
  const setGerman = manager.setLocale("de");
  const prepared = manager.prepareLocale();
  const setSpanish = manager.setLocale("es");
  spanishLoad.resolve(outcome === "failure" ? spanish : Promise.reject(offline));
  await setSpanish;
  germanLoad.resolve(outcome === "failure" ? Promise.reject(offline) : german);
  await setGerman;
  await prepared;
  expect(manager.getLocale()).toBe(outcome === "failure" ? "es" : "en");
  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "es", loads: outcome === "failure" ? 2 : 3 });
  expect(manager.getRequestedLocale()).toBe("es");
});

it("loads config hint copy on first lookup instead of with the locale catalog", async () => {
  const { loadTranslation, loadConfigHints, manager } = createManager();
  const hintKey = "configHints.gateway%2Eauth%2Etoken.label.v1-abc-d";
  const hintLoad = deferred<TranslationMap | null>();
  loadTranslation.mockResolvedValueOnce(german);
  loadConfigHints.mockReturnValueOnce(hintLoad.promise);
  const subscriber = vi.fn();
  manager.subscribe(subscriber);

  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  expect(loadConfigHints).not.toHaveBeenCalled();
  await manager.setLocale("de");
  expect(loadConfigHints).not.toHaveBeenCalled();
  subscriber.mockClear();

  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  expect(loadConfigHints).toHaveBeenCalledExactlyOnceWith("de");
  hintLoad.resolve({
    configHints: { "gateway%2Eauth%2Etoken": { label: { "v1-abc-d": "Gateway-Token" } } },
  });
  await vi.waitFor(() => expect(subscriber).toHaveBeenCalledExactlyOnceWith("de"));

  expect(manager.translateConfigHint(hintKey)).toBe("Gateway-Token");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(loadConfigHints).toHaveBeenCalledOnce();
});

it("keeps registered catalogs complete and retries a failed hint load", async () => {
  const { loadTranslation, loadConfigHints, manager } = createManager();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const hintKey = "configHints.cloudWorkers.label.v1-abc-d";
  manager.registerTranslation("de", german);
  await manager.setLocale("de");
  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  expect(loadConfigHints).not.toHaveBeenCalled();

  loadTranslation.mockResolvedValueOnce(spanish);
  loadConfigHints.mockRejectedValueOnce(new Error("gateway unavailable")).mockResolvedValueOnce({
    configHints: { cloudWorkers: { label: { "v1-abc-d": "Trabajadores en la nube" } } },
  });
  await manager.setLocale("es");
  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
  expect(manager.translateConfigHint(hintKey)).toBeUndefined();
  await vi.waitFor(() =>
    expect(manager.translateConfigHint(hintKey)).toBe("Trabajadores en la nube"),
  );
  expect(loadConfigHints).toHaveBeenCalledTimes(2);
  expect(manager.t("common.health")).toBe("Salud");
});
