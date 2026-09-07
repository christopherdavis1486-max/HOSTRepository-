"use client";

import { useEffect, useState } from "react";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

/**
 * Field names (token, newPassword) and response shape confirmed by
 * reading app/api/auth/password-reset/confirm/route.ts and
 * passwordResetConfirmSchema directly before writing this — not guessed.
 * Password validation mirrors app/login/page.tsx's validatePassword()
 * exactly, same rules the backend schema itself enforces.
 * Styling mirrors app/page.tsx and app/login/page.tsx's CSS custom
 * properties and runtime Google Fonts link — no shared component file,
 * same reasoning as login: one new file requested, small contained
 * duplication.
 */

function validatePassword(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters";
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter";
  if (!/[0-9]/.test(password)) return "Password must include at least one number";
  return null;
}

export default function ResetPasswordPage() {
  const { ui } = useInterfaceI18n();
  const [token, setToken] = useState<string | null>(null);
  const [checkedToken, setCheckedToken] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
    setCheckedToken(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) { setError("This reset link is missing its token. Please use the link from your email."); return; }

    const pwError = validatePassword(newPassword);
    if (pwError) { setError(pwError); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "This reset link is invalid or has expired.");
        setSubmitting(false);
        return;
      }
      setSuccess(true);
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
          --ink: #14120E;
          --graphite: #1F1B15;
          --stone: #2A251C;
          --ivory: #F2ECDE;
          --warm-grey: #A79E8C;
          --brass: #C9974B;
          --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink);
          color: var(--ivory);
          min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }

        .top-link { display: block; padding: 24px 28px; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .top-link a:hover { color: var(--ivory); }

        .auth-wrap { max-width: 400px; margin: 40px auto 80px; padding: 0 28px; }
        .wordmark { font-family: var(--font-display), Georgia, serif; font-size: 22px; text-align: center; margin-bottom: 6px; }
        .subhead { text-align: center; color: var(--warm-grey); font-size: 14px; margin-bottom: 32px; }

        .field { margin-bottom: 16px; }
        .field label { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .field input { width: 100%; background: var(--graphite); border: 1px solid var(--stone); color: var(--ivory); padding: 12px 14px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; }
        .field input:focus { outline: none; border-color: var(--brass); }

        .hint { font-size: 12px; color: var(--warm-grey); margin-top: -8px; margin-bottom: 16px; }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }
        .success-box { background: rgba(201,151,75,0.1); border: 1px solid var(--brass); color: var(--brass); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }

        .btn-primary { width: 100%; background: var(--brass); color: var(--ink); border: none; padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: block; text-align: center; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }

        @media (max-width: 480px) {
          .auth-wrap { margin-top: 12px; }
        }
      `}</style>

      <div className="top-link">
        <a href="/">← {ui("backHost")}</a>
      </div>

      <div className="auth-wrap">
        <div className="wordmark">HOST</div>

        {success ? (
          <>
            <div className="subhead">{ui("passwordReset")}</div>
            <div className="success-box">{ui("resetSuccess")}</div>
            <a href="/login" className="btn-primary">{ui("signIn")}</a>
          </>
        ) : (
          <>
            <div className="subhead">{ui("choosePassword")}</div>

            {checkedToken && !token && (
              <div className="error-box">
                This reset link is missing its token. Please use the link from your password reset email, or request a new one.
              </div>
            )}
            {error && <div className="error-box">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="newPassword">{ui("newPassword")}</label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="hint">{ui("passwordHint")}</div>
              <div className="field">
                <label htmlFor="confirmPassword">{ui("confirmPassword")}</label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="btn-primary" disabled={submitting || !checkedToken || !token}>
                {submitting ? ui("resetting") : ui("resetPassword")}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
