"use client";

import { useRef, useState } from "react";
import { checkSetupCheckoutSubmission } from "@/lib/presentation/setupSubmission";
import { PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";
import { LOCALE_TAGS } from "@/lib/i18n/config";

/**
 * The separate_charges_delayed_v1 counterpart to CheckoutForm.tsx.
 * Deliberately a separate component, not a branch inside that one, so
 * the two confirmation calls (confirmPayment vs confirmSetup) — which
 * have genuinely different semantics — never share a code path either.
 * Same minimal, smoke-test-fixture scope as CheckoutForm.tsx, not a
 * polished production checkout page.
 */
export default function SetupIntentForm({ bookingId, returnUrl, chargeIsDeferred, scheduledChargeDate, isTestMode }: { bookingId: string; returnUrl: string; chargeIsDeferred: boolean; scheduledChargeDate: string | null; isTestMode: boolean }) {
  const { locale, gt } = useGuestI18n();
  const stripe = useStripe();
  const elements = useElements();
  const submissionInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elementReady, setElementReady] = useState(false);
  const [elementLoadError, setElementLoadError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || !elementReady || elementLoadError ||
        submissionInFlight.current) return;

    submissionInFlight.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const eligibility = await checkSetupCheckoutSubmission(bookingId);
      if (!eligibility.allowed) {
        setErrorMessage(eligibility.message);
        return;
      }

      // This saves a card; only the server decides whether a charge is due.
      const { error } = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: returnUrl },
      });
      if (error) {
        setErrorMessage(error.message ?? gt("savePaymentFailed"));
      }
    } catch {
      setErrorMessage("We couldn't verify the card setup outcome. Check My Trips before trying again.");
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ background: "rgba(201,151,75,.08)", border: "1px solid #C9974B", borderRadius: 6, padding: "12px 14px", marginBottom: 18, fontSize: 13, lineHeight: 1.55, color: "#F2ECDE" }}>
        {chargeIsDeferred
          ? `${gt("notChargedTodayPrefix")} ${scheduledChargeDate ? new Date(scheduledChargeDate).toLocaleDateString(LOCALE_TAGS[locale], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : gt("scheduledDate")}.`
          : gt("chargedImmediately")}
      </div>
      <PaymentElement
        onReady={() => {
          setElementReady(true);
          setElementLoadError(false);
        }}
        onLoadError={() => {
          setElementReady(false);
          setElementLoadError(true);
        }}
      />
      {!elementReady && !elementLoadError && (
        <div role="status" style={{ color: "#A79E8C", fontSize: 14, marginTop: 12 }}>{gt("loadingPayment")}</div>
      )}
      {elementLoadError && (
        <div role="alert" style={{ color: "#E0796B", fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>
          {gt("paymentFormLoadError")}
          <button type="button" onClick={() => window.location.reload()} style={{ display: "block", marginTop: 10, padding: "9px 14px", cursor: "pointer", background: "transparent", color: "#F2ECDE", border: "1px solid #C9974B", borderRadius: 4 }}>
            {gt("reloadPaymentForm")}
          </button>
        </div>
      )}
      {errorMessage && (
        <div role="alert" style={{ color: "#E0796B", fontSize: 14, marginTop: 12 }}>
          {errorMessage}
          <a href="/trips" style={{ display: "block", marginTop: 10, color: "#C9974B" }}>Back to My Trips</a>
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting || !elementReady || elementLoadError}
        style={{ marginTop: 18, padding: "13px 20px", width: "100%", cursor: submitting ? "wait" : elementReady && !elementLoadError ? "pointer" : "not-allowed", background: "#C9974B", color: "#14120E", border: 0, borderRadius: 4, fontSize: 14, fontWeight: 600, opacity: elementReady && !elementLoadError ? 1 : .55 }}
      >
        {submitting ? gt("saving") : chargeIsDeferred ? gt("savePaymentMethod") : gt("saveCardPay")}
      </button>
      {isTestMode && <p style={{ fontSize: 12, color: "#A79E8C", marginTop: 10 }}>
        {gt("testCardNote")}
      </p>}
    </form>
  );
}
