"use client";

import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/config";
import { useI18n } from "./I18nProvider";

export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="language-selector" title={t("language")}>
      <span className={compact ? "sr-only" : "language-label"}>{t("language")}</span>
      <select aria-label={t("language")} value={locale} onChange={(event) => void setLocale(event.target.value as Locale)}>
        {SUPPORTED_LOCALES.map((item) => <option key={item} value={item}>{LOCALE_LABELS[item]}</option>)}
      </select>
      <style>{`
        .language-selector { display:inline-flex; align-items:center; gap:7px; color:inherit; font:500 12px 'Space Grotesk',system-ui,sans-serif; }
        .language-selector select { color:inherit; background:#14120E; border:1px solid #2A251C; border-radius:4px; padding:8px 7px; font:inherit; cursor:pointer; }
        .language-selector select:focus-visible { outline:2px solid #C9974B; outline-offset:2px; }
        .sr-only { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0; }
        @media(max-width:600px){ .language-label{display:none}.language-selector select{max-width:112px} }
      `}</style>
    </label>
  );
}
