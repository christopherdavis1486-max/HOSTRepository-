export const SUPPORTED_LOCALES = ["en", "de", "fr", "es", "it", "nl"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LEGAL_CONTENT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "host_locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  nl: "Nederlands",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const candidate = value.trim().toLowerCase().split("-")[0];
  return isLocale(candidate) ? candidate : DEFAULT_LOCALE;
}

export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-GB", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT", nl: "nl-NL",
};

/** Legal documents and binding terms always use the authoritative English text. */
export function localeForContent(content: "interface" | "legal", preferred: unknown): Locale {
  return content === "legal" ? LEGAL_CONTENT_LOCALE : normalizeLocale(preferred);
}
