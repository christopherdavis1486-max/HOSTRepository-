
"use client";

import {
  useState,
  type FormEvent,
} from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type State =
  | "ready"
  | "starting"
  | "unauthenticated"
  | "error";

export default function HostOnboardingConnectAccountPage() {
  const { ht } = useHostI18n();

  const [state, setState] =
    useState<State>("ready");
  const [
    hostAgreementAccepted,
    setHostAgreementAccepted,
  ] = useState(false);
  const [
    defaultPoliciesAccepted,
    setDefaultPoliciesAccepted,
  ] = useState(false);
  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

  const handleContinue = async (
    event: FormEvent
  ) => {
    event.preventDefault();
    setErrorMessage(null);

    if (
      !hostAgreementAccepted ||
      !defaultPoliciesAccepted
    ) {
      setErrorMessage(
        ht(
          "Accept both required statements before continuing."
        )
      );
      return;
    }

    setState("starting");

    try {
      const response = await fetch(
        "/api/hosts/onboarding/connect-account",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            country: "GB",
            hostAgreementAccepted,
            defaultPoliciesAccepted,
          }),
        }
      );

      const data = await response
        .json()
        .catch(() => ({
          success: false,
        }));

      if (!data.success) {
        if (
          data.error?.code ===
          "UNAUTHORIZED"
        ) {
          setState("unauthenticated");
        } else {
          setState("error");
        }

        setErrorMessage(
          data.error?.message ?? null
        );
        return;
      }

      window.location.href =
        data.onboardingUrl;
    } catch {
      setState("error");
      setErrorMessage(
        ht(
          "We couldn't connect to Stripe right now. Please try again shortly."
        )
      );
    }
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
          --ink: #14120E;
          --graphite: #1F1B15;
          --stone: #2A251C;
          --ivory: #F2ECDE;
          --warm-grey: #A79E8C;
          --brass: #C9974B;
          --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink);
          color: var(--ivory);
          min-height: 100vh;
        }

        .page-root * {
          box-sizing: border-box;
        }

        .display {
          font-family: var(--font-display), Georgia, serif;
        }

        .top-link {
          display: block;
          padding: 24px 28px;
        }

        .top-link a {
          color: var(--warm-grey);
          font-size: 13px;
          text-decoration: none;
        }

        .wrap {
          max-width: 580px;
          margin: 40px auto;
          padding: 0 28px 80px;
        }

        .wordmark {
          margin-bottom: 24px;
          text-align: center;
          font-family: var(--font-display), Georgia, serif;
          font-size: 22px;
        }

        h1 {
          margin: 0 0 12px;
          text-align: center;
          font-size: 28px;
          font-weight: 400;
        }

        .intro {
          margin: 0 0 28px;
          color: var(--warm-grey);
          font-size: 14px;
          line-height: 1.7;
          text-align: center;
        }

        .consent-panel {
          padding: 22px;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: var(--graphite);
        }

        .consent-row {
          display: grid;
          grid-template-columns: 20px 1fr;
          gap: 12px;
          align-items: start;
          margin-bottom: 20px;
          color: var(--ivory);
          font-size: 14px;
          line-height: 1.6;
          cursor: pointer;
        }

        .consent-row:last-of-type {
          margin-bottom: 0;
        }

        .consent-row input {
          width: 18px;
          height: 18px;
          margin-top: 2px;
          accent-color: var(--brass);
        }

        .consent-row a {
          color: var(--brass);
        }

        .pilot-note {
          margin: 20px 0 0;
          padding-top: 18px;
          border-top: 1px solid var(--stone);
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.65;
        }

        .error-box {
          margin-top: 18px;
          padding: 12px 14px;
          border: 1px solid var(--error);
          border-radius: 6px;
          background: rgba(224, 121, 107, 0.12);
          color: var(--error);
          font-size: 13px;
          line-height: 1.5;
        }

        .btn-primary {
          width: 100%;
          margin-top: 22px;
          padding: 13px 24px;
          border: none;
          border-radius: 4px;
          background: var(--brass);
          color: var(--ink);
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .btn-primary:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .state-panel {
          text-align: center;
        }

        .state-panel p {
          color: var(--warm-grey);
          font-size: 14px;
          line-height: 1.6;
        }

        .state-panel a {
          display: inline-block;
          margin-top: 8px;
          padding: 13px 24px;
          border-radius: 4px;
          background: var(--brass);
          color: var(--ink);
          text-decoration: none;
        }
      `}</style>

      <div className="top-link">
        <a href="/">
          ← {ht("Back to HOST")}
        </a>
      </div>

      <main className="wrap">
        <div className="wordmark">
          HOST
        </div>

        {state === "ready" && (
          <>
            <h1 className="display">
              {ht("Become a HOST")}
            </h1>

            <p className="intro">
              {ht(
                "Review the pilot requirements before continuing to secure Stripe onboarding."
              )}
            </p>

            <form onSubmit={handleContinue}>
              <div className="consent-panel">
                <label className="consent-row">
                  <input
                    type="checkbox"
                    checked={
                      hostAgreementAccepted
                    }
                    onChange={(event) =>
                      setHostAgreementAccepted(
                        event.target.checked
                      )
                    }
                  />

                  <span>
                    {ht(
                      "I accept the HOST host agreement and agree to comply with the"
                    )}{" "}
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {ht("Terms of Service")}
                    </a>
                    .
                  </span>
                </label>

                <label className="consent-row">
                  <input
                    type="checkbox"
                    checked={
                      defaultPoliciesAccepted
                    }
                    onChange={(event) =>
                      setDefaultPoliciesAccepted(
                        event.target.checked
                      )
                    }
                  />

                  <span>
                    {ht(
                      "I accept HOST's pilot policies, including accurate listing information, required compliance evidence, guest-visible cancellation terms and manual HOST review before publication."
                    )}
                  </span>
                </label>

                <p className="pilot-note">
                  {ht(
                    "The initial HOST pilot supports individual hosts located in Great Britain. Payout setup uses Stripe's secure onboarding service."
                  )}
                </p>
              </div>

              {errorMessage && (
                <div
                  className="error-box"
                  role="alert"
                >
                  {errorMessage}
                </div>
              )}

              <button
                className="btn-primary"
                type="submit"
                disabled={
                  !hostAgreementAccepted ||
                  !defaultPoliciesAccepted
                }
              >
                {ht(
                  "Accept and continue to Stripe"
                )}
              </button>
            </form>
          </>
        )}

        {state === "starting" && (
          <div className="state-panel">
            <h1 className="display">
              {ht(
                "Connecting you to Stripe…"
              )}
            </h1>

            <p>
              {ht(
                "You'll be redirected in a moment."
              )}
            </p>
          </div>
        )}

        {state === "unauthenticated" && (
          <div className="state-panel">
            <h1 className="display">
              {ht("Please sign in")}
            </h1>

            <p>
              {ht(
                "Sign in to continue setting up your HOST account."
              )}
            </p>

            <a href="/login">
              {ht("Sign in")}
            </a>
          </div>
        )}

        {state === "error" && (
          <div className="state-panel">
            <h1 className="display">
              {ht("Something went wrong")}
            </h1>

            <p>
              {errorMessage ??
                ht(
                  "We couldn't connect to Stripe right now. Please try again shortly."
                )}
            </p>

            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setState("ready");
                setErrorMessage(null);
              }}
            >
              {ht("Try again")}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}