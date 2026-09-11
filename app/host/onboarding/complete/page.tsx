"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

/**
 * This is the EXACT route lib/hosts/onboarding.ts already generates as
 * Stripe's return_url (`${baseUrl}/host/onboarding/complete`) — confirmed
 * by reading app/api/hosts/onboarding/connect-account/route.ts directly
 * before writing this page. Its absence was the literal 404 previously
 * reported after a real, successful Stripe onboarding completion.
 *
 * Calls the EXISTING GET /api/hosts/onboarding/status — no new backend
 * logic, no change to account-creation/readiness architecture. "Require
 * authenticated host" is enforced by that route itself (401 on no
 * session) — same pattern every other page in this app already uses
 * (login/reset-password), not a separate server-side guard reinvented
 * here.
 */

type Status = "checking" | "active" | "pending" | "not_connected" | "unauthenticated" | "error";

export default function HostOnboardingCompletePage() {
  const { ht } = useHostI18n();
  const { update } = useSession();
  const [status, setStatus] = useState<Status>("checking");
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  useEffect(() => {
    update()
      .then(() => fetch("/api/hosts/onboarding/status", { credentials: "include" }))
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) {
          setStatus(data.error?.code === "UNAUTHORIZED" ? "unauthenticated" : "error");
          return;
        }
        setStatus(data.status as Status);
      })
      .catch(() => setStatus("error"));
  }, [update]);

  const handleResume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      const res = await fetch("/api/hosts/onboarding/connect-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ country: "GB" }), // UK-first default — see lib/hosts/onboarding.ts's own documented rationale; only actually used if Stripe needs to create a brand-new account, which a "resume" flow rarely does
      });
      const data = await res.json();
      if (!data.success) { setResumeError(data.error?.message ?? "Couldn't continue onboarding."); setResuming(false); return; }
      window.location.href = data.onboardingUrl;
    } catch {
      setResumeError("Something went wrong reaching the server. Please try again.");
      setResuming(false);
    }
  };

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
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }
      `}</style>

      <div className="top-link"><a href="/">← {ht("Back to HOST")}</a></div>

      <div className="wrap">
        <div className="wordmark">HOST</div>

        {status === "checking" && (
          <>
            <h1 className="display">{ht("Checking your account…")}</h1>
            <p>{ht("This only takes a moment.")}</p>
          </>
        )}

        {status === "active" && (
          <>
            <h1 className="display">{ht("Your payout account is connected.")}</h1>
            <p>{ht("You're ready to receive bookings and payouts.")}</p>
            <a href="/host/dashboard" className="btn-primary">{ht("Continue")}</a>
          </>
        )}

        {(status === "pending" || status === "not_connected") && (
          <>
            <h1 className="display">{ht("A few more details are needed.")}</h1>
            <p>{ht("Stripe still needs some information before your payout account is fully active.")}</p>
            {resumeError && <div className="error-box">{resumeError}</div>}
            <button className="btn-primary" onClick={handleResume} disabled={resuming}>
              {resuming ? ht("Redirecting…") : ht("Continue Stripe setup")}
            </button>
          </>
        )}

        {status === "unauthenticated" && (
          <>
            <h1 className="display">{ht("Please sign in")}</h1>
            <p>{ht("Sign in to your host account to check your payout status.")}</p>
            <a href="/login" className="btn-primary">{ht("Sign in")}</a>
          </>
        )}

        {status === "error" && (
          <>
            <h1 className="display">{ht("Something went wrong")}</h1>
            <p>{ht("We couldn't check your account status right now. Please try again shortly.")}</p>
          </>
        )}
      </div>
    </div>
  );
}
