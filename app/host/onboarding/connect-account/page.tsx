"use client";

import { useEffect, useState } from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

/**
 * The EXACT route lib/hosts/onboarding.ts generates as Stripe's
 * refresh_url (`${baseUrl}/host/onboarding/connect-account`) — Stripe
 * redirects here specifically when an onboarding link has expired or was
 * abandoned partway through, and expects the platform to generate a
 * fresh link and send the host back to Stripe immediately.
 */

type State = "starting" | "unauthenticated" | "error";

export default function HostOnboardingConnectAccountPage() {
  const { ht } = useHostI18n();
  const [state, setState] = useState<State>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hosts/onboarding/connect-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ country: "GB" }), // UK-first default, matching the project's established scope — only used if a brand-new Stripe account genuinely needs creating
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.success) {
          setState(data.error?.code === "UNAUTHORIZED" ? "unauthenticated" : "error");
          setErrorMessage(data.error?.message ?? null);
          return;
        }
        window.location.href = data.onboardingUrl;
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="page-root">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;1,400;1,500&family=Space+Grotesk:wght@400;500&display=swap"
      />
      <style>{`
        .page-root {
          --font-display: 'Fraunces', Georgia, serif;
          --font-body: 'Space Grotesk', system-ui, sans-serif;
          --ink: #14120E; --graphite: #1F1B15; --stone: #2A251C;
          --ivory: #F2ECDE; --warm-grey: #A79E8C; --brass: #C9974B; --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink); color: var(--ivory); min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }
        .top-link { display: block; padding: 24px 28px; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .wrap { max-width: 440px; margin: 60px auto; padding: 0 28px; text-align: center; }
        .wordmark { font-family: var(--font-display), Georgia, serif; font-size: 22px; margin-bottom: 24px; }
        h1 { font-size: 24px; font-weight: 400; margin-bottom: 12px; }
        p { color: var(--warm-grey); font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 13px 24px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }
      `}</style>

      <div className="top-link"><a href="/">← {ht("Back to HOST")}</a></div>

      <div className="wrap">
        <div className="wordmark">HOST</div>

        {state === "starting" && (
          <>
            <h1 className="display">{ht("Reconnecting you to Stripe…")}</h1>
            <p>{ht("You'll be redirected in a moment.")}</p>
          </>
        )}

        {state === "unauthenticated" && (
          <>
            <h1 className="display">{ht("Please sign in")}</h1>
            <p>{ht("Sign in to your host account to continue setting up payouts.")}</p>
            <a href="/login" className="btn-primary">{ht("Sign in")}</a>
          </>
        )}

        {state === "error" && (
          <>
            <h1 className="display">{ht("Something went wrong")}</h1>
            <p>{errorMessage ?? ht("We couldn't reconnect you to Stripe right now. Please try again shortly.")}</p>
          </>
        )}
      </div>
    </div>
  );
}
