"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { LanguageSelector } from "./LanguageSelector";
import { useI18n } from "./I18nProvider";

export function CustomerNav() {
  const { t } = useI18n();
  const [sessionState, setSessionState] = useState<{ signedIn: boolean; isHost: boolean } | null>(null);
  const showStaging = process.env.NEXT_PUBLIC_SHOW_STAGING_UI === "true";

  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((session) => setSessionState({
        signedIn: !!session?.user?.email,
        isHost: Array.isArray(session?.user?.roles) && session.user.roles.includes("host"),
      }))
      .catch(() => setSessionState({ signedIn: false, isHost: false }));
  }, []);

  return (
    <nav className="customer-nav" aria-label="Primary navigation">
      <style>{`
        .customer-nav { --nav-ink:#14120E; --nav-stone:#2A251C; --nav-ivory:#F2ECDE; --nav-warm:#A79E8C; --nav-brass:#C9974B; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 28px; border-bottom:1px solid var(--nav-stone); background:var(--nav-ink); font-family:'Space Grotesk',system-ui,sans-serif; }
        .customer-nav .customer-wordmark { color:var(--nav-ivory); font-family:'Fraunces',Georgia,serif; font-size:20px; text-decoration:none; }
        .customer-nav .customer-actions { display:flex; align-items:center; justify-content:flex-end; gap:9px; flex-wrap:wrap; min-width:0; }
        .customer-nav .customer-link, .customer-nav .customer-button { color:var(--nav-ivory); border:1px solid var(--nav-stone); border-radius:4px; padding:9px 13px; background:transparent; font:500 12px 'Space Grotesk',system-ui,sans-serif; text-decoration:none; cursor:pointer; }
        .customer-nav .customer-link.primary { background:var(--nav-brass); border-color:var(--nav-brass); color:var(--nav-ink); }
        .customer-nav .customer-link:hover, .customer-nav .customer-button:hover { border-color:var(--nav-brass); }
        .customer-nav .customer-link:focus-visible, .customer-nav .customer-button:focus-visible, .customer-nav .customer-wordmark:focus-visible { outline:2px solid var(--nav-brass); outline-offset:3px; }
        .customer-nav .staging-pill { color:var(--nav-warm); border:1px solid var(--nav-stone); border-radius:999px; padding:6px 11px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
        @media(max-width:1100px){ .customer-nav{padding:16px 12px;gap:8px}.customer-nav .customer-actions{gap:5px}.customer-nav .customer-link,.customer-nav .customer-button{padding:8px 9px;font-size:11px} }
        @media(max-width:600px){ .customer-nav{padding:16px 10px;align-items:flex-start}.customer-nav .staging-pill{display:none}.customer-nav .customer-actions{gap:5px}.customer-nav .customer-link,.customer-nav .customer-button{padding:8px 7px} }
      `}</style>
      <a href="/" className="customer-wordmark">HOST</a>
      <div className="customer-actions">
        {showStaging && <span className="staging-pill">Staging · Test deployment</span>}
        <LanguageSelector compact />
        {sessionState?.signedIn === false && <><a href="/login" className="customer-link">{t("login")}</a><a href="/login?mode=register" className="customer-link primary">{t("signup")}</a></>}
        {sessionState?.signedIn === true && <><a href="/trips" className="customer-link">{t("trips")}</a><a href="/favourites" className="customer-link">{t("savedStays")}</a>{sessionState.isHost && <a href="/host/dashboard" className="customer-link">{t("hostWorkspace")}</a>}<a href="/account" className="customer-link">{t("account")}</a><button type="button" className="customer-button" onClick={() => signOut({ callbackUrl: "/" })}>{t("logout")}</button></>}
      </div>
    </nav>
  );
}
