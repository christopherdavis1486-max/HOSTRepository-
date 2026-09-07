"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from "@/lib/i18n/config";
import { messages, type MessageKey } from "@/lib/i18n/messages";

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => Promise<void>; t: (key: MessageKey) => string };
const I18nContext = createContext<I18nValue | null>(null);

function cookieLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${LOCALE_COOKIE}=`))?.split("=")[1];
  return normalizeLocale(value || navigator.language);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const initial = cookieLocale();
    updateLocale(initial);
    document.documentElement.lang = initial;
    fetch("/api/account/language", { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!data?.success) return;
        const saved = normalizeLocale(data.locale);
        updateLocale(saved);
        document.documentElement.lang = saved;
      })
      .catch(() => undefined);
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    updateLocale(next);
    document.documentElement.lang = next;
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    await fetch("/api/account/language", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: next }) }).catch(() => undefined);
  }, []);

  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (key) => messages[locale][key] }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
