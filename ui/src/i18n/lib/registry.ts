import { DEFAULT_LOCALE, type Locale } from "../../../../src/shared/control-ui-locale.ts";
import type { TranslationMap } from "./types.ts";

type LocaleModule = Record<string, TranslationMap>;

const LAZY_LOCALE_REGISTRY = {
  "zh-CN": () => import("../locales/zh-CN.ts"),
  "zh-TW": () => import("../locales/zh-TW.ts"),
  "pt-BR": () => import("../locales/pt-BR.ts"),
  de: () => import("../locales/de.ts"),
  es: () => import("../locales/es.ts"),
  "ja-JP": () => import("../locales/ja-JP.ts"),
  ko: () => import("../locales/ko.ts"),
  fr: () => import("../locales/fr.ts"),
  hi: () => import("../locales/hi.ts"),
  ar: () => import("../locales/ar.ts"),
  it: () => import("../locales/it.ts"),
  tr: () => import("../locales/tr.ts"),
  uk: () => import("../locales/uk.ts"),
  id: () => import("../locales/id.ts"),
  pl: () => import("../locales/pl.ts"),
  th: () => import("../locales/th.ts"),
  vi: () => import("../locales/vi.ts"),
  nl: () => import("../locales/nl.ts"),
  fa: () => import("../locales/fa.ts"),
  ru: () => import("../locales/ru.ts"),
  sv: () => import("../locales/sv.ts"),
  ca: () => import("../locales/ca.ts"),
} satisfies Record<Exclude<Locale, typeof DEFAULT_LOCALE>, () => Promise<LocaleModule>>;

type LazyLocale = keyof typeof LAZY_LOCALE_REGISTRY;

// Config schema hint copy is only read by Settings surfaces, so it stays a
// separate chunk rather than a static import of every locale catalog.
const LAZY_LOCALE_CONFIG_HINTS_REGISTRY = {
  "zh-CN": () => import("virtual:openclaw-control-ui-locale-config-hints/zh-CN"),
  "zh-TW": () => import("virtual:openclaw-control-ui-locale-config-hints/zh-TW"),
  "pt-BR": () => import("virtual:openclaw-control-ui-locale-config-hints/pt-BR"),
  de: () => import("virtual:openclaw-control-ui-locale-config-hints/de"),
  es: () => import("virtual:openclaw-control-ui-locale-config-hints/es"),
  "ja-JP": () => import("virtual:openclaw-control-ui-locale-config-hints/ja-JP"),
  ko: () => import("virtual:openclaw-control-ui-locale-config-hints/ko"),
  fr: () => import("virtual:openclaw-control-ui-locale-config-hints/fr"),
  hi: () => import("virtual:openclaw-control-ui-locale-config-hints/hi"),
  ar: () => import("virtual:openclaw-control-ui-locale-config-hints/ar"),
  it: () => import("virtual:openclaw-control-ui-locale-config-hints/it"),
  tr: () => import("virtual:openclaw-control-ui-locale-config-hints/tr"),
  uk: () => import("virtual:openclaw-control-ui-locale-config-hints/uk"),
  id: () => import("virtual:openclaw-control-ui-locale-config-hints/id"),
  pl: () => import("virtual:openclaw-control-ui-locale-config-hints/pl"),
  th: () => import("virtual:openclaw-control-ui-locale-config-hints/th"),
  vi: () => import("virtual:openclaw-control-ui-locale-config-hints/vi"),
  nl: () => import("virtual:openclaw-control-ui-locale-config-hints/nl"),
  fa: () => import("virtual:openclaw-control-ui-locale-config-hints/fa"),
  ru: () => import("virtual:openclaw-control-ui-locale-config-hints/ru"),
  sv: () => import("virtual:openclaw-control-ui-locale-config-hints/sv"),
  ca: () => import("virtual:openclaw-control-ui-locale-config-hints/ca"),
} satisfies Record<LazyLocale, () => Promise<{ default: TranslationMap }>>;

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (locale === DEFAULT_LOCALE) {
    return null;
  }
  const module: LocaleModule = await LAZY_LOCALE_REGISTRY[locale]();
  return module[locale.replaceAll("-", "_")] ?? null;
}

export async function loadLazyLocaleConfigHints(locale: Locale): Promise<TranslationMap | null> {
  if (locale === DEFAULT_LOCALE) {
    return null;
  }
  return (await LAZY_LOCALE_CONFIG_HINTS_REGISTRY[locale]()).default;
}
