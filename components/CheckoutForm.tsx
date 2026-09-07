"use client";

import { useState } from "react";
import { PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * This is the piece that was entirely missing before the Stripe Sandbox
 * prep pass: the backend's /api/payments/intent route has always
 * returned a real clientSecret, but nothing client-side ever consumed it.
 * Without this component, Test A's "proceed to Stripe Test Mode checkout"
 * step had nothing to open.
 *
 * Deliberately minimal — this is a smoke-test fixture, not a polished
 * checkout page. It exists so an operator with real Stripe connectivity
 * has something to click through with an official test card, not to be
 * the final production checkout UI.
 */
export default function CheckoutForm({ bookingId, returnUrl, isTestMode }: { bookingId: string; returnUrl: string; isTestMode: boolean }) {
  const { gt } = useGuestI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elementReady, setElementReady] = useState(false);
  const [elementLoadError, setElementLoadError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || !elementReady || elementLoadError) return;

    setSubmitting(true);
    setErrorMessage(null);

    // confirmPayment redirects to returnUrl on success/3DS completion.
    // The booking is NOT marked paid here, on the client — only the
    // webhook does that (technical spec's non-negotiable #2). This call
    // is purely "did the payment attempt itself go through," not "is the
    // booking now confirmed."
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });

    // Only failures return here — success navigates away via return_url
    // before this line would run.
    if (error) {
      setErrorMessage(error.message ?? gt("paymentFailed"));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
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
        <div role="alert" style={{ color: "#E0796B", fontSize: 14, marginTop: 12 }}>{errorMessage}</div>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting || !elementReady || elementLoadError}
        style={{ marginTop: 18, padding: "13px 20px", width: "100%", cursor: submitting ? "wait" : elementReady && !elementLoadError ? "pointer" : "not-allowed", background: "#C9974B", color: "#14120E", border: 0, borderRadius: 4, fontSize: 14, fontWeight: 600, opacity: elementReady && !elementLoadError ? 1 : .55 }}
      >
        {submitting ? gt("processing") : gt("payNow")}
      </button>
      {isTestMode && <p style={{ fontSize: 12, color: "#A79E8C", marginTop: 10 }}>
        {gt("testCardNote")}
      </p>}
    </form>
  );
}
