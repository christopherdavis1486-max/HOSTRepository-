"use client";

import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import CheckoutForm from "@/components/CheckoutForm";
import SetupIntentForm from "@/components/SetupIntentForm";
import { CustomerNav } from "@/components/CustomerNav";
import { formatDate } from "@/lib/presentation/formatters";
import { isChargeDeferred } from "@/lib/presentation/checkoutTiming";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe() {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      throw new Error("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured");
    }
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

export default function CheckoutPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { gt } = useGuestI18n();
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [paymentFlowVersion, setPaymentFlowVersion] = useState<string | null>(null);
  const [scheduledChargeDate, setScheduledChargeDate] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ bookingId: id }) => setBookingId(id));
  }, [params]);

  // Batch 10: the booking's own payment_flow_version is the sole source
  // of truth for which Stripe flow this checkout uses — fetched from the
  // server, never inferred client-side from check-in dates or feature
  // flags (both of which the client has no business reasoning about
  // directly).
  useEffect(() => {
    if (!bookingId) return;
    fetch(`/api/bookings/${bookingId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) { setError(data.error?.message ?? gt("bookingLoadError")); return; }
        setPaymentFlowVersion(data.booking.paymentFlowVersion);
        setScheduledChargeDate(data.booking.scheduledChargeDate ?? null);
      })
      .catch(() => setError(gt("serverError")));
  }, [bookingId, gt]);

  useEffect(() => {
    if (!bookingId || !paymentFlowVersion) return;
    const endpoint = paymentFlowVersion === "separate_charges_delayed_v1" ? "/api/payments/setup-intent" : "/api/payments/intent";
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId }),
      credentials: "include",
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) { setError(data.error?.message ?? gt("checkoutStartError")); return; }
        setClientSecret(data.clientSecret);
      })
      .catch(() => setError(gt("serverError")));
  }, [bookingId, paymentFlowVersion, gt]);

  const stateRootStyle = { minHeight: "100vh", background: "#14120E", color: "#F2ECDE", fontFamily: "'Space Grotesk', system-ui, sans-serif" };
  const stateContentStyle = { maxWidth: 560, margin: "0 auto", padding: "80px 28px" };

  if (error) return <div className="checkout-root" style={stateRootStyle}><CustomerNav /><div className="checkout-state error" role="alert" style={{ ...stateContentStyle, color: "#E0796B" }}>{error}</div></div>;
  if (!clientSecret || !bookingId || !paymentFlowVersion) return <div className="checkout-root" style={stateRootStyle}><CustomerNav /><div className="checkout-state" role="status" aria-live="polite" style={{ ...stateContentStyle, color: "#A79E8C" }}>{gt("loadingCheckout")}</div></div>;

  const isDelayedCharge = paymentFlowVersion === "separate_charges_delayed_v1";
  const chargeIsDeferred = isChargeDeferred(scheduledChargeDate);
  const isTestMode = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_") ?? false;

  return (
    <div className="checkout-root">
      <CustomerNav />
      <style>{`
        .checkout-root { --ink:#14120E;--graphite:#1F1B15;--stone:#2A251C;--ivory:#F2ECDE;--warm:#A79E8C;--brass:#C9974B;--error:#E0796B; min-height:100vh;background:var(--ink);color:var(--ivory);font-family:'Space Grotesk',system-ui,sans-serif; }
        .checkout-root *{box-sizing:border-box}.checkout-wrap{max-width:560px;margin:0 auto;padding:52px 28px 80px}.checkout-eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--brass);margin-bottom:8px}.checkout-wrap h1{font-family:'Fraunces',Georgia,serif;font-size:30px;font-weight:400;margin:0 0 10px}.checkout-summary{color:var(--warm);font-size:14px;line-height:1.6;margin:0 0 24px}.checkout-card{background:var(--graphite);border:1px solid var(--stone);border-radius:8px;padding:24px}.checkout-state{max-width:560px;margin:0 auto;padding:80px 28px;color:var(--warm)}.checkout-state.error{color:var(--error)}
        @media(max-width:600px){.checkout-wrap{padding:36px 18px 60px}.checkout-card{padding:18px}.checkout-wrap h1{font-size:26px}}
      `}</style>
      <main className="checkout-wrap">
      {isTestMode && <div className="checkout-eyebrow">{gt("stripeTest")}</div>}
      <h1>
        {isDelayedCharge && chargeIsDeferred ? gt("savePaymentMethod") : gt("completeBooking")}
      </h1>
      <p className="checkout-summary">
        {isDelayedCharge
          ? chargeIsDeferred
            ? `${gt("deferredChargePrefix")} ${formatDate(scheduledChargeDate!)}.`
            : gt("immediateSavedCharge")
          : gt("reviewPaymentDetails")}
      </p>
      <div className="checkout-card">
      <Elements stripe={getStripe()} options={{ clientSecret, appearance: { theme: "night", variables: { colorPrimary: "#C9974B", colorBackground: "#14120E", colorText: "#F2ECDE", colorDanger: "#E0796B", borderRadius: "4px" } } }}>
        {isDelayedCharge ? (
          <SetupIntentForm bookingId={bookingId} returnUrl={`${window.location.origin}/checkout/${bookingId}/return`} chargeIsDeferred={chargeIsDeferred} scheduledChargeDate={scheduledChargeDate} isTestMode={isTestMode} />
        ) : (
          <CheckoutForm bookingId={bookingId} returnUrl={`${window.location.origin}/checkout/${bookingId}/return`} isTestMode={isTestMode} />
        )}
      </Elements>
      </div>
      </main>
    </div>
  );
}
