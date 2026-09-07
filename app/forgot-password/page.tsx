"use client";

import { useState } from "react";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

/**
 * Calls the EXISTING POST /api/auth/password-reset/request — no backend
 * change. That route already always returns the same generic response
 * shape regardless of whether the email matched an account (confirmed by
 * reading it before writing this page); this page simply displays
 * whatever it returns rather than trying to infer or improve on that
 * signal, preserving the account-enumeration protection intact.
 */

export default function ForgotPasswordPage() {
  const { ui } = useInterfaceI18n();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) { setError("Enter your email address."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      if (!data.success) {
        // Only real validation errors (e.g. malformed email) land here —
        // the route's own account-enumeration protection means a
        // nonexistent email still returns success, by design.
        setError(data.error?.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Something went wrong reaching the server. Please try again.");
      setSubmitting(false);
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
        .top-link a:hover { color: var(--ivory); }
        .auth-wrap { max-width: 400px; margin: 40px auto 80px; padding: 0 28px; }
        .wordmark { font-family: var(--font-display), Georgia, serif; font-size: 22px; text-align: center; margin-bottom: 6px; }
        .subhead { text-align: center; color: var(--warm-grey); font-size: 14px; margin-bottom: 32px; line-height: 1.6; }
        .field { margin-bottom: 16px; }
        .field label { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .field input { width: 100%; background: var(--graphite); border: 1px solid var(--stone); color: var(--ivory); padding: 12px 14px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; }
        .field input:focus { outline: none; border-color: var(--brass); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }
        .success-box { background: rgba(201,151,75,0.1); border: 1px solid var(--brass); color: var(--brass); font-size: 13px; padding: 12px 14px; border-radius: 4px; margin-bottom: 16px; line-height: 1.6; }
        .btn-primary { width: 100%; background: var(--brass); color: var(--ink); border: none; padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
        .back-to-login { display: block; text-align: center; margin-top: 20px; color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .back-to-login:hover { color: var(--ivory); }
      `}</style>

      <div className="top-link"><a href="/">← {ui("backHost")}</a></div>

      <div className="auth-wrap">
        <div className="wordmark">HOST</div>
        <div className="subhead">
          {submitted ? ui("checkEmail") : ui("resetPassword")}
        </div>

        {submitted ? (
          <>
            <div className="success-box">
              {ui("resetSent")}
            </div>
            <a href="/login" className="back-to-login">← {ui("backSignIn")}</a>
          </>
        ) : (
          <>
            {error && <div className="error-box">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="email">{ui("email")}</label>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </div>
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? ui("sending") : ui("sendReset")}
              </button>
            </form>
            <a href="/login" className="back-to-login">← {ui("backSignIn")}</a>
          </>
        )}
      </div>
    </div>
  );
}
