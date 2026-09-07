"use client";

import { LanguageSelector } from "./LanguageSelector";
import { useI18n } from "./I18nProvider";

/**
 * Small and shared, not a sidebar framework — matches the brief's own
 * "do not build a huge sidebar framework" instruction. Relies on the
 * CSS custom properties (--ink, --brass, --stone, etc.) each host page
 * already defines in its own <style> block, same pattern as every other
 * page in this app — no separate style system introduced for this.
 */
export function HostNav({ active }: { active: "dashboard" | "bookings" | "properties" | "reviews" }) {
  const { t } = useI18n();
  const links: { key: typeof active; label: string; href: string }[] = [
    { key: "dashboard", label: t("dashboard"), href: "/host/dashboard" },
    { key: "bookings", label: t("bookings"), href: "/host/bookings" },
    { key: "properties", label: t("properties"), href: "/host/properties" },
    { key: "reviews", label: t("reviews"), href: "/host/reviews" },
  ];

  return (
    <nav className="host-nav">
      <style>{`
        .host-nav { display: flex; align-items:center; gap: 4px; padding: 0 28px; border-bottom: 1px solid var(--stone); max-width: 1080px; margin: 0 auto; }
        .host-nav .language-selector { margin-left:auto; }
        .host-nav a { padding: 14px 16px; font-size: 13px; color: var(--warm-grey); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
        .host-nav a.active { color: var(--ivory); border-bottom-color: var(--brass); }
        .host-nav a:hover { color: var(--ivory); }
        @media (max-width: 500px) { .host-nav { padding: 0 14px; overflow-x: auto; } .host-nav a { padding: 12px 10px; white-space: nowrap; } }
      `}</style>
      {links.map((l) => (
        <a key={l.key} href={l.href} className={l.key === active ? "active" : ""}>{l.label}</a>
      ))}
      <LanguageSelector compact />
    </nav>
  );
}
