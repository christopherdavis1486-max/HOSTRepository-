import type { Metadata } from "next";
import { LegalPage } from "@/components/legalPage";

export const metadata: Metadata = {
  title: "Privacy notice | HOST",
  description: "How HOST collects, uses and protects personal information.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice" effectiveDate="9 September 2026">
      <p>
        This notice explains how Gary Christopher Davies trading as HOST
        ("HOST", "we", "us") handles personal information when you use
        hostcityliving.com.
      </p>

      <h2>Who controls your information</h2>
      <p>
        Gary Christopher Davies trading as HOST is the data controller.
        Privacy enquiries can be sent to{" "}
        <a href="mailto:hostplatform.admin@gmail.com">hostplatform.admin@gmail.com</a>.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>Account information, including your email address and profile details.</li>
        <li>Authentication and security information, including login events, sessions, passkeys and recovery activity.</li>
        <li>Booking, saved-stay, message, review and notification information you provide through HOST.</li>
        <li>Host and property information submitted for onboarding or compliance review.</li>
        <li>Payment-related identifiers and transaction status supplied by Stripe. HOST does not store complete payment-card details.</li>
        <li>Technical information needed to operate and protect the service, such as device, browser, IP address and request data.</li>
      </ul>

      <h2>Google sign-in</h2>
      <p>
        If you choose Google sign-in, Google supplies the basic account
        information required to authenticate you, normally your email address
        and basic profile identity. HOST does not receive your Google password.
      </p>

      <h2>How and why we use information</h2>
      <ul>
        <li>To create accounts, authenticate users and provide requested services.</li>
        <li>To process and administer bookings, messages, reviews and host onboarding.</li>
        <li>To prevent fraud, secure accounts, investigate failures and enforce our terms.</li>
        <li>To meet legal, accounting, regulatory and consumer-protection obligations.</li>
        <li>To communicate service, verification, security and transaction information.</li>
      </ul>
      <p>
        We rely on contractual necessity, legal obligations, legitimate
        interests and consent where each basis is appropriate.
      </p>

      <h2>Service providers and disclosures</h2>
      <p>
        We use carefully selected providers to operate HOST, including Google
        for optional authentication, Vercel for application hosting, Resend for
        transactional email, Stripe for payment services, and database,
        security and infrastructure providers. Information may also be
        disclosed when required by law or to establish, exercise or defend
        legal claims.
      </p>

      <h2>International processing</h2>
      <p>
        Some providers may process information outside the United Kingdom.
        Where required, we use recognised safeguards such as adequacy
        regulations or approved contractual protections.
      </p>

      <h2>Retention</h2>
      <p>
        We keep information only for as long as needed for the purposes
        described above, including security, dispute, accounting and legal
        requirements. Retention periods vary according to the record and
        applicable obligations.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on the circumstances, UK data-protection law may give you
        rights to access, correct, erase, restrict or object to processing,
        receive portable information, and withdraw consent. You may also
        complain to the UK Information Commissioner's Office at{" "}
        <a href="https://ico.org.uk/make-a-complaint/" rel="noreferrer">
          ico.org.uk
        </a>.
      </p>

      <h2>Cookies and local storage</h2>
      <p>
        HOST uses essential authentication and security technologies needed
        for sign-in, account protection and core service operation. Any future
        non-essential analytics or marketing technologies will require the
        appropriate notice and consent controls before use.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this notice as HOST develops. The effective date above
        identifies the current version.
      </p>
    </LegalPage>
  );
}
