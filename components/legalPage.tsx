import type { ReactNode } from "react";

export function LegalPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <main style={{ minHeight: "100vh", background: "#14120E", color: "#F2ECDE", padding: "48px 24px 80px", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
      <article style={{ maxWidth: 820, margin: "0 auto" }}>
        <a href="/" style={{ color: "#C9974B", textDecoration: "none" }}>Back to HOST</a>
        <h1 style={{ margin: "40px 0 8px", fontFamily: "'Fraunces', Georgia, serif", fontSize: "clamp(38px, 7vw, 64px)", fontWeight: 500 }}>{title}</h1>
        <p style={{ color: "#A79E8C", marginBottom: 40 }}>Effective date: {effectiveDate}</p>

        <div className="legal-content">{children}</div>

        <nav style={{ display: "flex", gap: 20, marginTop: 48, paddingTop: 24, borderTop: "1px solid #2A251C" }}>
          <a href="/privacy" style={{ color: "#C9974B" }}>Privacy notice</a>
          <a href="/terms" style={{ color: "#C9974B" }}>Terms of use</a>
        </nav>
      </article>

      <style>{`
        .legal-content h2 {
          margin: 34px 0 12px;
          font-family: 'Fraunces', Georgia, serif;
          font-size: 26px;
          font-weight: 500;
        }
        .legal-content p, .legal-content li {
          color: #C7BDAA;
          font-size: 16px;
          line-height: 1.75;
        }
        .legal-content ul { padding-left: 22px; }
        .legal-content a { color: #C9974B; }
      `}</style>
    </main>
  );
}
