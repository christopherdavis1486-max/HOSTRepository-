import type { Metadata } from "next";
import { LegalPage } from "@/components/legalPage";

export const metadata: Metadata = {
  title: "Terms of use | HOST",
  description: "Terms governing use of the HOST staging service.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" effectiveDate="9 September 2026">
      <p>
        These terms govern your use of hostcityliving.com, operated by Gary
        Christopher Davies trading as HOST. By using the site, you agree to
        these terms.
      </p>

      <h2>Current staging status</h2>
      <p>
        HOST is currently a staging and test deployment. Property information,
        availability, prices, bookings and payment functions may be test data
        and must not be treated as a live commercial offer unless HOST
        expressly confirms otherwise.
      </p>
      <p>
        These are website and account terms only. Final guest booking, host,
        payment, cancellation and refund terms will be published and presented
        before HOST begins accepting live commercial bookings.
      </p>

      <h2>Accounts</h2>
      <p>
        You must provide accurate information, protect your credentials and
        promptly notify HOST if you suspect unauthorised access. You are
        responsible for activity performed through your account unless caused
        by HOST's failure to use reasonable care.
      </p>

      <h2>Google sign-in and passkeys</h2>
      <p>
        Optional authentication methods are provided for convenience and
        security. Your use of Google services is also governed by Google's
        applicable terms. HOST never asks for or receives your Google password.
      </p>

      <h2>Acceptable use</h2>
      <p>You must not:</p>
      <ul>
        <li>Use HOST unlawfully, fraudulently or to harm another person.</li>
        <li>Attempt to bypass authentication, security or access controls.</li>
        <li>Interfere with the service, introduce malicious code or probe systems without written authorisation.</li>
        <li>Submit false, infringing, abusive or misleading content.</li>
        <li>Use automated extraction or access in a way that materially burdens the service.</li>
      </ul>

      <h2>Content and intellectual property</h2>
      <p>
        HOST and its licensors retain rights in the site, branding, software
        and original content. You retain ownership of content you submit but
        grant HOST the limited rights needed to store, process and display it
        for operating and testing the service.
      </p>

      <h2>Service availability</h2>
      <p>
        We may modify, suspend or withdraw staging features without notice.
        We do not promise that test functionality will be uninterrupted,
        error-free or suitable for a particular purpose.
      </p>

      <h2>Liability</h2>
      <p>
        Nothing in these terms excludes liability that cannot lawfully be
        excluded, including liability for fraud or for death or personal injury
        caused by negligence. Subject to that, HOST is not responsible for
        losses arising solely from reliance on test data or unavailable staging
        functionality.
      </p>

      <h2>Suspension and termination</h2>
      <p>
        We may restrict or terminate access where reasonably necessary for
        security, unlawful conduct, material breach or protection of users and
        the platform.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of England and Wales. If you are a
        consumer, you retain any mandatory rights and jurisdiction protections
        provided by the law where you live.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms as HOST develops. Questions can be sent to{" "}
        <a href="mailto:hostplatform.admin@gmail.com">hostplatform.admin@gmail.com</a>.
      </p>
    </LegalPage>
  );
}
