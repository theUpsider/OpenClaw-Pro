// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE,
  loadLazyLocaleConfigHints, SUPPORTED_LOCALES } from "../../../../src/shared/control-ui-locale.ts";
import { loadLazyLocaleTranslation } from "./registry.ts";

describe("lazy locale registry", () => {
  it("keeps English as the default and materializes every registered foreign catalog", async () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(await loadLazyLocaleTranslation("en")).toBeNull();
    expect(await loadLazyLocaleConfigHints("en")).toBeNull();

    const catalogs = await Promise.all(
      SUPPORTED_LOCALES.slice(1).map(
        async (locale) =>
          [
            locale,
            await loadLazyLocaleTranslation(locale),
            await loadLazyLocaleConfigHints(locale),
          ] as const,
      ),
    );
    for (const [locale, catalog, configHints] of catalogs) {
      expect(catalog?.common, locale).toHaveProperty("loading");
      // Config hint copy is a separate lazy partition, never part of the locale catalog.
      expect(catalog, locale).not.toHaveProperty("configHints");
      expect(Object.keys(configHints ?? {}), locale).toEqual(["configHints"]);
    }
  });
});
