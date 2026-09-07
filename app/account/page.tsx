"use client";

import { useEffect, useState } from "react";
import { CustomerNav } from "@/components/CustomerNav";
import { startRegistration } from "@simplewebauthn/browser";
import { signOut } from "next-auth/react";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

type Preferences = { email: boolean; push: boolean; sms: boolean };
type AccountSession = { id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string };
type Passkey = { id: string; label: string; createdAt: string; lastUsedAt: string | null };
type DeletionRequest = { id: string; status: string; requested_at: string; execute_after: string | null; blocked_reason: string | null };

export default function AccountPage() {
  const { ui } = useInterfaceI18n();
  const [state, setState] = useState<"loading" | "unauthenticated" | "loaded" | "error">("loading");
  const [userEmail, setUserEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ email: true, push: true, sms: false });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [sessionsSaving, setSessionsSaving] = useState(false);
  const [passkeySaving, setPasskeySaving] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [remainingRecoveryCodes, setRemainingRecoveryCodes] = useState(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [deletionRequest, setDeletionRequest] = useState<DeletionRequest | null>(null);
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [privacySaving, setPrivacySaving] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include" })
      .then((res) => res.json())
      .then((session) => {
        if (!session?.user?.email) { setState("unauthenticated"); return; }
        setUserEmail(session.user.email);
        setIsHost(!!session.user.hostProfileId);

        Promise.all([
          fetch("/api/notifications/preferences", { credentials: "include" }).then((res) => res.json()),
          fetch("/api/account/profile", { credentials: "include" }).then((res) => res.json()),
          fetch("/api/account/sessions", { credentials: "include" }).then((res) => res.json()),
          fetch("/api/account/passkeys", { credentials: "include" }).then((res) => res.json()),
          fetch("/api/account/recovery-codes", { credentials: "include" }).then((res) => res.json()),
          fetch("/api/account/privacy", { credentials: "include" }).then((res) => res.json()),
        ]).then(([prefs, profile, accountSessions, accountPasskeys, recoveryStatus, privacy]) => {
          if (prefs.success) setPreferences(prefs.preferences);
          if (profile.success) {
            setUserEmail(profile.profile.email);
            setFullName(profile.profile.fullName);
            setPhone(profile.profile.phone);
          }
          if (accountSessions.success) setSessions(accountSessions.sessions);
          if (accountPasskeys.success) setPasskeys(accountPasskeys.passkeys);
          if (recoveryStatus.success) setRemainingRecoveryCodes(recoveryStatus.remaining);
          if (privacy.success) setDeletionRequest(privacy.deletionRequest);
        }).catch(() => {}).finally(() => setState("loaded"));
      })
      .catch(() => setState("error"));
  }, []);

  const togglePreference = async (key: keyof Preferences) => {
    const next = { ...preferences, [key]: !preferences[key] };
    setPreferences(next); // optimistic
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [key]: next[key] }),
      });
      const data = await res.json();
      if (!data.success) {
        setPreferences(preferences); // revert
        setSaveMessage(data.error?.message ?? "Couldn't save that change.");
      } else {
        setPreferences(data.preferences);
        setSaveMessage("Saved.");
      }
    } catch {
      setPreferences(preferences); // revert
      setSaveMessage("Something went wrong reaching the server.");
    }
    setSaving(false);
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileSaving(true);
    setProfileMessage(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ fullName, phone }),
      });
      const data = await res.json();
      if (!data.success) setProfileMessage(data.error?.message ?? "Couldn't save your profile.");
      else {
        setFullName(data.profile.fullName);
        setPhone(data.profile.phone);
        setProfileMessage("Profile saved.");
      }
    } catch { setProfileMessage("Something went wrong reaching the server."); }
    setProfileSaving(false);
  };

  const handleSignOut = async () => {
    await signOut({ callbackUrl: "/" });
  };

  const signOutOtherDevices = async () => {
    setSessionsSaving(true);
    setSessionMessage(null);
    try {
      const res = await fetch("/api/account/sessions", { method: "DELETE", credentials: "include" });
      const data = await res.json();
      if (!data.success) setSessionMessage(data.error?.message ?? "Couldn't sign out other devices.");
      else {
        setSessions((current) => current.filter((item) => item.current));
        setSessionMessage(data.revoked ? `${data.revoked} other session${data.revoked === 1 ? "" : "s"} signed out.` : "No other signed-in devices were found.");
      }
    } catch { setSessionMessage("Something went wrong reaching the server."); }
    setSessionsSaving(false);
  };

  const addPasskey = async () => {
    setPasskeySaving(true); setPasskeyMessage(null);
    try {
      const optionsRes = await fetch("/api/auth/passkeys/register/options", { method: "POST", credentials: "include" });
      const setup = await optionsRes.json();
      if (!setup.success) throw new Error(setup.error?.message);
      const response = await startRegistration({ optionsJSON: setup.options });
      const verifyRes = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: setup.challengeId, response, label: "My passkey" }),
      });
      const verified = await verifyRes.json();
      if (!verified.success) throw new Error(verified.error?.message);
      const list = await fetch("/api/account/passkeys", { credentials: "include" }).then((res) => res.json());
      if (list.success) setPasskeys(list.passkeys);
      setPasskeyMessage("Passkey added. You can now use it to sign in.");
    } catch (error) {
      setPasskeyMessage(error instanceof Error && error.message ? error.message : "Passkey setup was cancelled or failed.");
    }
    setPasskeySaving(false);
  };

  const removePasskey = async (id: string) => {
    if (!window.confirm("Remove this passkey from your HOST account?")) return;
    setPasskeyMessage(null);
    const res = await fetch("/api/account/passkeys", { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const data = await res.json();
    if (!data.success) setPasskeyMessage(data.error?.message ?? "Couldn't remove that passkey.");
    else { setPasskeys((current) => current.filter((item) => item.id !== id)); setPasskeyMessage("Passkey removed."); }
  };

  const generateRecovery = async (event: React.FormEvent) => {
    event.preventDefault(); setRecoverySaving(true); setRecoveryMessage(null); setRecoveryCodes([]);
    try {
      const res = await fetch("/api/account/recovery-codes", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: recoveryPassword }) });
      const data = await res.json();
      if (!data.success) setRecoveryMessage(data.error?.message ?? "Couldn't create recovery codes.");
      else { setRecoveryCodes(data.codes); setRemainingRecoveryCodes(data.codes.length); setRecoveryPassword(""); setRecoveryMessage("New recovery codes created. Any older codes are now invalid."); }
    } catch { setRecoveryMessage("Something went wrong reaching the server."); }
    setRecoverySaving(false);
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault(); setPasswordSaving(true); setPasswordMessage(null);
    if (newPassword !== confirmPassword) { setPasswordMessage("New passwords do not match."); setPasswordSaving(false); return; }
    try {
      const res = await fetch("/api/account/password", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
      const data = await res.json();
      if (!data.success) { setPasswordMessage(data.error?.message ?? "Couldn't change your password."); setPasswordSaving(false); return; }
      await signOut({ callbackUrl: "/login?passwordChanged=1" });
    } catch { setPasswordMessage("Something went wrong reaching the server."); setPasswordSaving(false); }
  };

  const requestDeletion = async (event: React.FormEvent) => {
    event.preventDefault(); setPrivacySaving(true); setPrivacyMessage(null);
    try {
      const res = await fetch("/api/account/privacy", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deletionPassword, confirmation: deletionConfirmation }) });
      const data = await res.json();
      if (!data.success) setPrivacyMessage(data.error?.message ?? "Couldn't request account deletion.");
      else { setDeletionRequest(data.deletionRequest); setDeletionPassword(""); setDeletionConfirmation(""); setPrivacyMessage("Deletion scheduled. You can cancel it before the scheduled date."); }
    } catch { setPrivacyMessage("Something went wrong reaching the server."); }
    setPrivacySaving(false);
  };

  const cancelDeletion = async () => {
    setPrivacySaving(true); setPrivacyMessage(null);
    try {
      const res = await fetch("/api/account/privacy", { method: "DELETE", credentials: "include" });
      const data = await res.json();
      if (!data.success) setPrivacyMessage(data.error?.message ?? "Couldn't cancel account deletion.");
      else { setDeletionRequest(null); setPrivacyMessage("Account deletion cancelled."); }
    } catch { setPrivacyMessage("Something went wrong reaching the server."); }
    setPrivacySaving(false);
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
        .top-link { display: block; padding: 24px 28px 0; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .header { max-width: 640px; margin: 0 auto; padding: 8px 28px 20px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 640px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }
        .btn-secondary { background: transparent; border: 1px solid var(--stone); color: var(--ivory); padding: 10px 18px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; }
        .wrap { max-width: 640px; margin: 0 auto; padding: 0 28px 80px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin-bottom: 18px; }
        .card h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 14px; }
        .row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; color: var(--warm-grey); }
        .row .label { color: var(--ivory); }
        .field { display: block; margin-bottom: 14px; }
        .field span { display: block; font-size: 12px; color: var(--warm-grey); margin-bottom: 6px; }
        .field input { width: 100%; background: var(--ink); color: var(--ivory); border: 1px solid var(--stone); border-radius: 4px; padding: 11px 12px; font: inherit; font-size: 13px; }
        .field input:focus { outline: 2px solid var(--brass); outline-offset: 1px; }
        .readonly-value { color: var(--warm-grey); font-size: 13px; padding: 3px 0 15px; overflow-wrap: anywhere; }
        .form-actions { display: flex; align-items: center; gap: 12px; }
        .form-actions .btn-primary { margin-top: 0; }
        .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--stone); }
        .toggle-row:last-child { border-bottom: none; }
        .toggle-row .name { font-size: 13px; }
        .toggle-row .desc { font-size: 11px; color: var(--warm-grey); }
        .toggle-btn { background: var(--ink); border: 1px solid var(--stone); border-radius: 12px; width: 40px; height: 22px; position: relative; cursor: pointer; }
        .toggle-btn.on { background: var(--brass); border-color: var(--brass); }
        .toggle-btn .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--ivory); transition: left 0.15s; }
        .toggle-btn.on .knob { left: 20px; background: var(--ink); }
        .save-msg { font-size: 12px; color: var(--brass); margin-top: 10px; }
        .quick-links a { display: block; font-size: 13px; color: var(--ivory); text-decoration: none; padding: 8px 0; border-bottom: 1px solid var(--stone); }
        .quick-links a:last-child { border-bottom: none; }
        .security-item { border-top: 1px solid var(--stone); padding: 12px 0; }
        .security-item:first-of-type { border-top: none; padding-top: 0; }
        .code-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 18px; background: var(--ink); border: 1px solid var(--stone); padding: 14px; border-radius: 4px; margin-top: 12px; font-family: ui-monospace, monospace; font-size: 12px; }
      `}</style>

      <CustomerNav />

      {state === "loading" && <div className="state-block">{ui("loadingAccount")}</div>}
      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ui("signInManage")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/account")}`} className="btn-primary">{ui("signIn")}</a>
        </div>
      )}
      {state === "error" && <div className="state-block">{ui("accountError")}</div>}

      {state === "loaded" && (
        <>
          <div className="header"><h1 className="display">{ui("account")}</h1></div>
          <div className="wrap">
            <div className="card">
              <h2>{ui("profile")}</h2>
              <form onSubmit={saveProfile}>
                <label className="field"><span>{ui("fullName")}</span><input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} autoComplete="name" /></label>
                <label className="field"><span>{ui("phone")}</span><input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} autoComplete="tel" inputMode="tel" /></label>
                <div className="field"><span>{ui("email")}</span><div className="readonly-value">{userEmail} · {ui("signInEmailFixed")}</div></div>
                {isHost && <div className="row" style={{ marginBottom: 14 }}><span className="label">{ui("accountType")}</span><span>{ui("host")}</span></div>}
                <div className="form-actions"><button className="btn-primary" type="submit" disabled={profileSaving}>{profileSaving ? ui("saving") : ui("saveProfile")}</button>{profileMessage && <span className="save-msg" role="status">{profileMessage}</span>}</div>
              </form>
            </div>

            <div className="card">
              <h2>{ui("notificationPreferences")}</h2>
              <div className="toggle-row">
                <div><div className="name">{ui("email")}</div><div className="desc">{ui("emailNotifications")}</div></div>
                <button className={`toggle-btn ${preferences.email ? "on" : ""}`} onClick={() => togglePreference("email")} disabled={saving}><span className="knob" /></button>
              </div>
              <div className="toggle-row">
                <div><div className="name">{ui("push")}</div><div className="desc">{ui("pushDesc")}</div></div>
                <button className={`toggle-btn ${preferences.push ? "on" : ""}`} onClick={() => togglePreference("push")} disabled={saving}><span className="knob" /></button>
              </div>
              <div className="toggle-row">
                <div><div className="name">SMS</div><div className="desc">{ui("smsDesc")}</div></div>
                <button className={`toggle-btn ${preferences.sms ? "on" : ""}`} onClick={() => togglePreference("sms")} disabled={saving}><span className="knob" /></button>
              </div>
              {saveMessage && <div className="save-msg">{saveMessage}</div>}
            </div>

            <div className="card">
              <h2>{ui("quickLinks")}</h2>
              <div className="quick-links">
                <a href="/trips">{ui("myTrips")}</a>
                <a href="/favourites">{ui("savedStays")}</a>
                {isHost && <a href="/host/dashboard">{ui("hostDashboard")}</a>}
                {!isHost && <a href="/hosts/onboarding/connect-account">{ui("becomeHost")}</a>}
              </div>
            </div>

            <div className="card">
              <h2>{ui("accountSecurity")}</h2>
              <div className="row" style={{ marginBottom: 8 }}><span className="label">Passkey</span><span>{ui("passkeyDevice")}</span></div>
              <button className="btn-secondary" onClick={addPasskey} disabled={passkeySaving} style={{ marginBottom: 18 }}>
                {passkeySaving ? ui("waitingDevice") : ui("addPasskey")}
              </button>
              {passkeyMessage && <div className="save-msg" role="status" style={{ marginBottom: 14 }}>{passkeyMessage}</div>}
              {passkeys.map((passkey) => (
                <div className="security-item row" key={passkey.id}>
                  <span><span className="label">{passkey.label}</span><br /><small>{ui("added")} {new Date(passkey.createdAt).toLocaleDateString()}</small></span>
                  <button className="btn-secondary" onClick={() => removePasskey(passkey.id)}>{ui("remove")}</button>
                </div>
              ))}
              <div className="security-item">
                <div className="row"><span className="label">{ui("emergencyCodes")}</span><span>{remainingRecoveryCodes} {ui("unused")}</span></div>
                <p style={{ color: "var(--warm-grey)", fontSize: 12, lineHeight: 1.6, margin: "8px 0 12px" }}>Keep these somewhere private, such as a password manager. Creating a new set invalidates every older code.</p>
                <form onSubmit={generateRecovery}>
                  <label className="field"><span>{ui("confirmCurrentPassword")}</span><input type="password" value={recoveryPassword} onChange={(e) => setRecoveryPassword(e.target.value)} autoComplete="current-password" required /></label>
                  <button className="btn-secondary" type="submit" disabled={recoverySaving}>{recoverySaving ? ui("creating") : ui("createRecoveryCodes")}</button>
                </form>
                {recoveryMessage && <div className="save-msg" role="status">{recoveryMessage}</div>}
                {recoveryCodes.length > 0 && <><div className="code-grid">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div><p style={{ color: "var(--error)", fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>Copy these now. HOST cannot show them again after you leave this page.</p></>}
              </div>
              <div className="security-item">
                <div className="row"><span className="label">{ui("changePassword")}</span><span>{ui("signsOutEveryDevice")}</span></div>
                <p style={{ color: "var(--warm-grey)", fontSize: 12, lineHeight: 1.6, margin: "8px 0 12px" }}>Your existing recovery codes will also be invalidated. After signing back in, create and securely save a new set.</p>
                <form onSubmit={changePassword}>
                  <label className="field"><span>{ui("currentPassword")}</span><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></label>
                  <label className="field"><span>{ui("newPassword")}</span><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={12} required /></label>
                  <label className="field"><span>{ui("confirmPassword")}</span><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" minLength={12} required /></label>
                  <button className="btn-secondary" type="submit" disabled={passwordSaving}>{passwordSaving ? ui("changing") : ui("changePassword")}</button>
                </form>
                {passwordMessage && <div className="save-msg" role="status">{passwordMessage}</div>}
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="label">{ui("signedInSessions")}</span>
                <span>{sessions.length || 1}</span>
              </div>
              <p style={{ color: "var(--warm-grey)", fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
                If you do not recognise another sign-in, remove it immediately and change your password.
              </p>
              <button className="btn-secondary" onClick={signOutOtherDevices} disabled={sessionsSaving}>
                {sessionsSaving ? ui("signingOut") : ui("signOutOtherDevices")}
              </button>
              {sessionMessage && <div className="save-msg" role="status">{sessionMessage}</div>}
            </div>

            <div className="card">
              <h2>{ui("privacyData")}</h2>
              <div className="security-item">
                <div className="row"><span className="label">{ui("downloadInformation")}</span><span>JSON</span></div>
                <p style={{ color: "var(--warm-grey)", fontSize: 12, lineHeight: 1.6, margin: "8px 0 12px" }}>Download the account, booking, saved-stay, message, review and security information associated with your account.</p>
                <a className="btn-secondary" href="/api/account/data-export" download style={{ display: "inline-block", textDecoration: "none" }}>{ui("downloadData")}</a>
              </div>
              <div className="security-item">
                <div className="row"><span className="label">{ui("deleteAccount")}</span><span>{ui("coolingOff")}</span></div>
                <p style={{ color: "var(--warm-grey)", fontSize: 12, lineHeight: 1.6, margin: "8px 0 12px" }}>Deletion removes authentication and profile data. HOST may retain minimised booking and financial records where required for accounting, disputes, fraud prevention or legal claims. Active bookings, unresolved payments and host accounts must be resolved first.</p>
                {deletionRequest?.status === "pending" ? (
                  <div>
                    <p className="save-msg">Deletion scheduled for {deletionRequest.execute_after ? new Date(deletionRequest.execute_after).toLocaleDateString() : "review"}.</p>
                    <button className="btn-secondary" onClick={cancelDeletion} disabled={privacySaving}>{privacySaving ? ui("checking") : ui("cancelDeletion")}</button>
                  </div>
                ) : (
                  <form onSubmit={requestDeletion}>
                    <label className="field"><span>{ui("currentPassword")}</span><input type="password" value={deletionPassword} onChange={(e) => setDeletionPassword(e.target.value)} autoComplete="current-password" required /></label>
                    <label className="field"><span>{ui("typeDeleteConfirm")}</span><input value={deletionConfirmation} onChange={(e) => setDeletionConfirmation(e.target.value)} autoComplete="off" required /></label>
                    <button className="btn-secondary" type="submit" disabled={privacySaving}>{privacySaving ? ui("checking") : ui("requestDeletion")}</button>
                  </form>
                )}
                {privacyMessage && <div className="save-msg" role="status">{privacyMessage}</div>}
              </div>
            </div>

            <button className="btn-secondary" onClick={handleSignOut}>{ui("signOut")}</button>
          </div>
        </>
      )}
    </div>
  );
}
