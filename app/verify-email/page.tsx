"use client";
import { useEffect, useState } from "react";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

export default function VerifyEmailPage() {
  const { ui } = useInterfaceI18n();
  const [state, setState] = useState<"working" | "success" | "error">("working");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) { setState("error"); return; }
    fetch("/api/auth/email-verification/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then((r) => r.json()).then((data) => setState(data.success ? "success" : "error")).catch(() => setState("error"));
  }, []);
  return <main style={{ minHeight: "100vh", background: "#14120E", color: "#F2ECDE", display: "grid", placeItems: "center", fontFamily: "system-ui" }}>
    <section style={{ maxWidth: 520, padding: 32, textAlign: "center" }}>
      <h1>{state === "working" ? ui("verifyingEmail") : state === "success" ? ui("emailVerified") : ui("verificationUnavailable")}</h1>
      <p style={{ color: "#A79E8C", lineHeight: 1.6 }}>{state === "working" ? ui("waitMoment") : state === "success" ? ui("verifiedMessage") : ui("invalidVerification")}</p>
      {state !== "working" && <a href="/login" style={{ color: "#C9974B" }}>{ui("continueSignIn")}</a>}
    </section>
  </main>;
}
