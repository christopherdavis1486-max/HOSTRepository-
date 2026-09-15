"use client";

import { CustomerNav } from "@/components/CustomerNav";
import { useI18n } from "@/components/I18nProvider";

const steps = [
  {
    number: "01",
    title: "Create your HOST account",
    text: "Register securely and confirm the account that will manage your properties.",
  },
  {
    number: "02",
    title: "Connect your payout account",
    text: "Complete Stripe onboarding so booking payments can be paid to you securely.",
  },
  {
    number: "03",
    title: "Create your property listing",
    text: "Add your property details, pricing, availability, policies and photographs.",
  },
  {
    number: "04",
    title: "Complete verification",
    text: "Submit the required property compliance evidence for review by HOST.",
  },
];

const requirements = [
  "Authority to offer the property for short-term stays",
  "Accurate property and guest-capacity information",
  "Current safety and compliance documentation",
  "A Stripe-supported bank account for payouts",
  "Clear photographs and an honest property description",
];

export default function HostWithUsPage() {
  const { t } = useI18n();
  const showStaging =
    process.env.NEXT_PUBLIC_SHOW_STAGING_UI === "true";

  return (
    <main className="host-acquisition">
      <CustomerNav />

      <style>{`
        .host-acquisition {
          min-height: 100vh;
          background: #100f0c;
          color: #fff8e8;
          font-family: "Space Grotesk", Arial, sans-serif;
        }

        .host-hero,
        .host-section,
        .host-footer {
          width: min(1120px, calc(100% - 40px));
          margin: 0 auto;
        }

        .host-hero {
          padding: 92px 0 84px;
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr);
          gap: 64px;
          align-items: center;
        }

        .eyebrow {
          color: #d49a3f;
          font-size: 13px;
          letter-spacing: .14em;
          text-transform: uppercase;
        }

        .host-hero h1 {
          margin: 18px 0 24px;
          max-width: 760px;
          font-family: Fraunces, Georgia, serif;
          font-size: clamp(46px, 7vw, 82px);
          font-weight: 500;
          line-height: 1.02;
        }

        .host-hero-copy {
          max-width: 690px;
          color: #c4a98b;
          font-size: 19px;
          line-height: 1.7;
        }

        .host-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 34px;
        }

        .host-button {
          display: inline-block;
          padding: 14px 20px;
          border: 1px solid #3c3225;
          border-radius: 4px;
          color: #fff8e8;
          text-decoration: none;
          font-weight: 600;
        }

        .host-button.primary {
          border-color: #d49a3f;
          background: #d49a3f;
          color: #100f0c;
        }

        .host-button:hover {
          border-color: #d49a3f;
        }

        .host-button:focus-visible {
          outline: 2px solid #d49a3f;
          outline-offset: 4px;
        }

        .host-summary {
          padding: 30px;
          border: 1px solid #342c20;
          border-radius: 8px;
          background: #1d1a15;
        }

        .host-summary h2,
        .host-section h2 {
          margin-top: 0;
          font-family: Fraunces, Georgia, serif;
          font-weight: 500;
        }

        .host-summary p,
        .host-summary li,
        .host-section p {
          color: #c4a98b;
          line-height: 1.65;
        }

        .host-summary ul {
          margin: 20px 0 0;
          padding-left: 20px;
        }

        .host-summary li + li {
          margin-top: 12px;
        }

        .host-section {
          padding: 76px 0;
          border-top: 1px solid #342c20;
        }

        .host-section-heading {
          max-width: 720px;
          margin-bottom: 38px;
        }

        .host-section h2 {
          margin-bottom: 14px;
          font-size: clamp(32px, 4vw, 48px);
        }

        .host-steps {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }

        .host-step {
          padding: 28px;
          border: 1px solid #342c20;
          border-radius: 6px;
          background: #1d1a15;
        }

        .host-step-number {
          color: #d49a3f;
          font-size: 13px;
          letter-spacing: .12em;
        }

        .host-step h3 {
          margin: 18px 0 10px;
          font-family: Fraunces, Georgia, serif;
          font-size: 24px;
          font-weight: 500;
        }

        .host-step p {
          margin: 0;
        }

        .host-callout {
          padding: 48px;
          border: 1px solid #4c3920;
          border-radius: 8px;
          background: #211b12;
          text-align: center;
        }

        .host-callout h2 {
          margin-bottom: 16px;
        }

        .host-callout p {
          max-width: 700px;
          margin: 0 auto;
        }

        .host-callout .host-actions {
          justify-content: center;
        }

        .staging-note {
          margin-top: 20px !important;
          color: #a79e8c !important;
          font-size: 13px;
        }

        .host-footer {
          padding: 34px 0 48px;
          border-top: 1px solid #342c20;
          color: #a79e8c;
          font-size: 14px;
        }

        .host-footer a {
          color: #d49a3f;
        }

        @media (max-width: 800px) {
          .host-hero {
            grid-template-columns: 1fr;
            padding: 64px 0;
          }

          .host-steps {
            grid-template-columns: 1fr;
          }

          .host-callout {
            padding: 34px 22px;
          }
        }
      `}</style>

      <section className="host-hero">
        <div>
          <span className="eyebrow">Host with us</span>
          <h1>Host exceptional stays with HOST</h1>

          <p className="host-hero-copy">
            Reach guests looking for distinctive places to stay while
            keeping control of your property, availability and pricing.
            HOST provides the booking platform, secure payments and a
            guided route from registration to publication.
          </p>

          <div className="host-actions">
            <a
              className="host-button primary"
              href="/login?mode=register&returnTo=%2Fhost%2Fonboarding%2Fconnect-account"
            >
              {t("listProperty")}
            </a>

            <a
              className="host-button"
              href="/login?returnTo=%2Fhost%2Fonboarding%2Fconnect-account"
            >
              Sign in to continue
            </a>
          </div>
        </div>

        <aside className="host-summary">
          <h2>Before you begin</h2>

          <p>
            HOST&apos;s current pilot is intended for individual property
            hosts operating eligible accommodation in Great Britain.
          </p>

          <ul>
            {requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="host-section">
        <div className="host-section-heading">
          <span className="eyebrow">How it works</span>
          <h2>A guided path to publication</h2>

          <p>
            Your listing remains private until its required information,
            compliance review and HOST pilot review are complete.
          </p>
        </div>

        <div className="host-steps">
          {steps.map((step) => (
            <article className="host-step" key={step.number}>
              <span className="host-step-number">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="host-section">
        <div className="host-callout">
          <span className="eyebrow">Ready to start?</span>
          <h2>Create your host account</h2>

          <p>
            Begin your application now. You can save your property
            information as a draft and return to complete it later.
          </p>

          <div className="host-actions">
            <a
              className="host-button primary"
              href="/login?mode=register&returnTo=%2Fhost%2Fonboarding%2Fconnect-account"
            >
              Create account and start
            </a>
          </div>

          {showStaging && (
            <p className="staging-note">
              This is a staging test deployment. No live payouts will be
              created.
            </p>
          )}
        </div>
      </section>

      <footer className="host-footer">
        <a href="/">← Return to HOST stays</a>
      </footer>
    </main>
  );
}