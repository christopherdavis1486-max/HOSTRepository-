"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { isSafeReturnPath } from "./returnPath";
import { startAuthentication } from "@simplewebauthn/browser";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

/**
 * Styling deliberately mirrors app/page.tsx exactly — same CSS custom
 * properties, same runtime Google Fonts <link> (not next/font/google;
 * see that file's comment for why build-time font fetching was replaced
 * with a runtime link tag), same class naming. No shared component file
 * was extracted for this, since the brief asked for exactly one new file
 * and the duplication here is small and contained.
 *
 * Google OAuth intentionally has no UI here: authOptions.ts only
 * registers GoogleProvider when GOOGLE_CLIENT_ID/SECRET are both set,
 * and I have no way to confirm from this environment whether that's true
 * in the actual deployed Vercel configuration — so per instruction, it's
 * left out rather than guessed at.
 *
 * EXTENDED for Batch 2: reads an optional ?returnTo= param and redirects
 * there after successful sign-in/registration instead of always going to
 * "/" — this is what lets app/stays/[slug]/page.tsx send an
 * unauthenticated visitor here and land them back on the exact property
 * page (with their dates/guests still in the URL) after signing in,
 * rather than dropping them on the homepage having lost their intended
 * booking. Validated to be a same-origin relative path only (must start
 * with exactly one "/", not "//" — a "//evil.com" value is
 * protocol-relative and would otherwise redirect off-site) before ever
 * being used, so this can't become an open-redirect vector regardless of
 * what a crafted URL puts in the query string. Auth logic itself
 * (signIn, register) is completely untouched.
 */
function safeReturnTo(): string {
  if (typeof window === "undefined") return "/";
  return isSafeReturnPath(new URLSearchParams(window.location.search).get("returnTo"));
}

type Mode = "signin" | "register" | "recovery";

function validatePassword(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters";
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter";
  if (!/[0-9]/.test(password)) return "Password must include at least one number";
  return null;
}

export default function LoginPage() {
  const { ui } = useInterfaceI18n();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "register") {
      setMode("register");
    }
    if (params.get("passwordChanged") === "1") setInfo("Password changed. Sign in again with your new password.");
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!email.trim()) { setError("Enter your email address."); return; }
    if (mode === "register") {
      const pwError = validatePassword(password);
      if (pwError) { setError(pwError); return; }
    } else if (!password) {
      setError("Enter your password.");
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "register") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!data.success) {
          setError(data.error?.message ?? "Couldn't create an account. Please try again.");
          setSubmitting(false);
          return;
        }

        if (data.verificationRequired) {
          setMode("signin");
          setInfo("Account created. Check your email and verify your address before signing in.");
          setPassword("");
          setSubmitting(false);
          return;
        }

        // Smallest robust option per the brief: sign the new account in
        // immediately using the same credentials, rather than sending
        // them back to a separate sign-in step. If this specific call
        // somehow fails despite registration succeeding, fall back
        // cleanly to sign-in mode instead of leaving them stuck.
        const signInResult = await signIn("credentials", { email, password, redirect: false });
        if (signInResult?.ok) {
          window.location.href = safeReturnTo();
          return;
        }
        setMode("signin");
        setInfo("Account created — sign in below.");
        setPassword("");
        setSubmitting(false);
        return;
      }

      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError("Incorrect email or password.");
        setSubmitting(false);
        return;
      }
      window.location.href = safeReturnTo();
    } catch {
      setError("Something went wrong reaching the server. Please try again.");
      setSubmitting(false);
    }
  };

  const handlePasskeySignIn = async () => {
    setSubmitting(true); setError(null); setInfo(null);
    try {
      const optionsRes = await fetch("/api/auth/passkeys/authenticate/options", { method: "POST" });
      const setup = await optionsRes.json();
      if (!setup.success) throw new Error(setup.error?.message);
      const response = await startAuthentication({ optionsJSON: setup.options });
      const verifyRes = await fetch("/api/auth/passkeys/authenticate/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: setup.challengeId, response }),
      });
      const verified = await verifyRes.json();
      if (!verified.success) throw new Error(verified.error?.message);
      const result = await signIn("credentials", { passkeyToken: verified.loginToken, redirect: false });
      if (!result?.ok) throw new Error("Passkey sign-in could not create a session.");
      window.location.href = safeReturnTo();
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : "Passkey sign-in was cancelled or failed.");
      setSubmitting(false);
    }
  };

  const handleRecoverySignIn = async (event: React.FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null); setInfo(null);
    try {
      const response = await fetch("/api/auth/recovery-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code: recoveryCode }) });
      const data = await response.json();
      if (!data.success) throw new Error(data.error?.message);
      const result = await signIn("credentials", { passkeyToken: data.loginToken, redirect: false });
      if (!result?.ok) throw new Error("Recovery sign-in could not create a session.");
      window.location.href = safeReturnTo();
    } catch (error) { setError(error instanceof Error && error.message ? error.message : "Recovery sign-in failed."); setSubmitting(false); }
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
        .eyebrow { font-family: var(--font-body), system-ui, sans-serif; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brass); }

        .top-link { display: block; padding: 24px 28px; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .top-link a:hover { color: var(--ivory); }

        .auth-wrap { max-width: 400px; margin: 40px auto 80px; padding: 0 28px; }
        .wordmark { font-family: var(--font-display), Georgia, serif; font-size: 22px; text-align: center; margin-bottom: 6px; }
        .subhead { text-align: center; color: var(--warm-grey); font-size: 14px; margin-bottom: 32px; }

        .tabs { display: flex; border: 1px solid var(--stone); border-radius: 4px; overflow: hidden; margin-bottom: 28px; }
        .tab { flex: 1; padding: 11px; text-align: center; font-size: 13px; background: transparent; color: var(--warm-grey); border: none; cursor: pointer; font-family: var(--font-body); }
        .tab.active { background: var(--graphite); color: var(--ivory); }

        .field { margin-bottom: 16px; }
        .field label { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .field input { width: 100%; background: var(--graphite); border: 1px solid var(--stone); color: var(--ivory); padding: 12px 14px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; }
        .field input:focus { outline: none; border-color: var(--brass); }

        .hint { font-size: 12px; color: var(--warm-grey); margin-top: -8px; margin-bottom: 16px; }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }
        .info-box { background: rgba(201,151,75,0.1); border: 1px solid var(--brass); color: var(--brass); font-size: 13px; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }

        .btn-primary { width: 100%; background: var(--brass); color: var(--ink); border: none; padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; }
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
        <div className="subhead">{mode === "signin" ? ui("signInAccount") : mode === "register" ? ui("createHostAccount") : ui("emergencyCode")}</div>

        <div className="tabs">
          <button type="button" className={`tab ${mode === "signin" ? "active" : ""}`} onClick={() => { setMode("signin"); setError(null); setInfo(null); }}>
            {ui("signIn")}
          </button>
          <button type="button" className={`tab ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setError(null); setInfo(null); }}>
            {ui("createAccount")}
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}
        {info && <div className="info-box">{info}</div>}

        {mode !== "recovery" ? <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">{ui("email")}</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">{ui("password")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
          </div>
          {mode === "register" && (
            <div className="hint">{ui("passwordHint")}</div>
          )}
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? (mode === "signin" ? ui("signingIn") : ui("creatingAccount")) : (mode === "signin" ? ui("signIn") : ui("createAccount"))}
          </button>
        </form> : <form onSubmit={handleRecoverySignIn}>
          <div className="field"><label htmlFor="recovery-email">{ui("email")}</label><input id="recovery-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></div>
          <div className="field"><label htmlFor="recovery-code">{ui("recoveryCode")}</label><input id="recovery-code" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX" required /></div>
          <button type="submit" className="btn-primary" disabled={submitting}>{submitting ? ui("checking") : ui("signInRecovery")}</button>
          <button type="button" className="tab" style={{ width: "100%", marginTop: 10 }} onClick={() => { setMode("signin"); setError(null); }}>{ui("backSignIn")}</button>
        </form>}
        {mode === "signin" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0", color: "var(--warm-grey)", fontSize: 12 }}>
              <span style={{ height: 1, background: "var(--stone)", flex: 1 }} /><span>{ui("or")}</span><span style={{ height: 1, background: "var(--stone)", flex: 1 }} />
            </div>
            <button type="button" className="btn-primary" style={{ background: "transparent", color: "var(--ivory)", border: "1px solid var(--stone)" }} onClick={handlePasskeySignIn} disabled={submitting}>
              {ui("signInPasskey")}
            </button>
            <button type="button" className="tab" style={{ width: "100%", marginTop: 10 }} onClick={() => { setMode("recovery"); setError(null); setInfo(null); }}>
              {ui("useRecovery")}
            </button>
          </>
        )}
        {mode === "signin" && (
          <a href="/forgot-password" style={{ display: "block", textAlign: "center", marginTop: 16, color: "var(--warm-grey)", fontSize: 13, textDecoration: "none" }}>
            {ui("forgotPassword")}
          </a>
        )}
      </div>
    </div>
  );
}
