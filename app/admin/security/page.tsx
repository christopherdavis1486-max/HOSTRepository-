"use client";

import { useEffect, useState } from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";
import { LanguageSelector } from "@/components/LanguageSelector";

type Summary = { active_sessions: number; locked_accounts: number; failed_events_24h: number; active_admins: number };
type Admin = { id: string; email: string; role: string; email_verified: boolean; has_passkey: boolean; active_sessions: number };
type Event = { id: string; event_type: string; outcome: string; created_at: string; email: string | null };
type Overview = { summary: Summary; admins: Admin[]; events: Event[] };

const box: React.CSSProperties = { background: "#1d1a15", border: "1px solid #342c20", borderRadius: 10, padding: 28, marginBottom: 22 };
const button: React.CSSProperties = { background: "transparent", color: "#fff8e8", border: "1px solid #3c3225", borderRadius: 5, padding: "12px 16px", cursor: "pointer" };

export default function AdminSecurityPage() {
  const { ht, locale } = useHostI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState(ht("Loading security overview…"));
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function load() {
    const response = await fetch("/api/admin/security/overview", { cache: "no-store", credentials: "include" });
    const body = await response.json();
    if (!response.ok) { setMessage(body.error?.message ?? ht("Unable to load security overview.")); return; }
    setData(body); setMessage("");
  }
  useEffect(() => { void load(); }, []);

  async function act(targetUserId: string, action: "revoke_sessions" | "unlock_login") {
    const response = await fetch("/api/admin/security/actions", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetUserId, action, reason: reasons[targetUserId] ?? "" }) });
    const body = await response.json();
    setMessage(response.ok ? ht("Security action completed and recorded.") : body.error?.message ?? ht("Action failed."));
    if (response.ok) await load();
  }

  return <main style={{ minHeight: "100vh", background: "#100f0c", color: "#fff8e8", padding: "48px 6vw", fontFamily: "Arial, sans-serif" }}>
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      <section style={box}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{ color: "#d49a3f", letterSpacing: 2, fontSize: 13 }}>{ht("PRIVILEGED OPERATIONS")}</div><LanguageSelector compact/></div><h1 style={{ fontFamily: "Georgia, serif", fontSize: 42, marginBottom: 10 }}>{ht("Admin security")}</h1><p style={{ color: "#c4a98b" }}>Restricted to a verified super administrator with a registered passkey.</p>
        {data && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginTop: 24 }}>{Object.entries(data.summary).map(([key,value]) => <div key={key} style={{ border: "1px solid #342c20", padding: 16 }}><strong style={{ display: "block", color: "#d49a3f", fontSize: 26 }}>{value}</strong><span style={{ color: "#c4a98b" }}>{ht(key.replace(/_/g, " "))}</span></div>)}</div>}
      </section>
      {data && <><section style={box}><h2>{ht("Privileged accounts")}</h2>{data.admins.map(admin => <div key={admin.id} style={{ borderTop: "1px solid #342c20", padding: "18px 0" }}><strong>{admin.email}</strong><p style={{ color: "#c4a98b" }}>{admin.role} · {ht("Email")} {admin.email_verified ? ht("verified") : ht("not verified")} · {ht("Passkey")} {admin.has_passkey ? ht("present") : ht("missing")} · {admin.active_sessions} {ht(admin.active_sessions === 1 ? "active session" : "active sessions")}</p><input aria-label={`${ht("Reason for")} ${admin.email}`} placeholder={ht("Reason for security action")} value={reasons[admin.id] ?? ""} onChange={e => setReasons({...reasons,[admin.id]:e.target.value})} style={{ width: "min(100%, 420px)", padding: 12, marginRight: 8, background: "#100f0c", border: "1px solid #3c3225", color: "#fff8e8" }}/><button style={{...button, marginRight: 8}} onClick={() => act(admin.id,"unlock_login")}>{ht("Unlock login")}</button><button style={button} onClick={() => act(admin.id,"revoke_sessions")}>{ht("Revoke sessions")}</button></div>)}</section>
      <section style={box}><h2>{ht("Recent security events")}</h2>{data.events.map(event => <div key={event.id} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderTop: "1px solid #342c20", padding: "12px 0" }}><span>{event.event_type} · {ht(event.outcome)}</span><span style={{ color: "#c4a98b" }}>{event.email ?? ht("Unknown account")} · {new Date(event.created_at).toLocaleString(locale)}</span></div>)}</section></>}
      {message && <p role="status" style={{ color: "#d49a3f" }}>{message}</p>}
    </div>
  </main>;
}
