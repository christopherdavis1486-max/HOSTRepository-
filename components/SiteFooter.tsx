"use client";

import { useState } from "react";
import type { FormEvent } from "react";

type SiteFooterProps = {
  showStaging?: boolean;
};

type FormState = "idle" | "submitting" | "success" | "error";

function browserLocale() {
  if (typeof navigator === "undefined") return "en";

  const language = navigator.language.slice(0, 2).toLowerCase();

  return ["en", "de", "fr", "es", "it", "nl"].includes(language)
    ? language
    : "en";
}

export function SiteFooter({
  showStaging = false,
}: SiteFooterProps) {
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [formState, setFormState] =
    useState<FormState>("idle");
  const [message, setMessage] = useState("");

  async function subscribe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!consent) {
      setFormState("error");
      setMessage("Please confirm that you would like to hear from HOST.");
      return;
    }

    setFormState("submitting");
    setMessage("");

    try {
      const response = await fetch("/api/newsletter", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          consent,
          locale: browserLocale(),
          website,
        }),
      });

      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error?.message ||
            "Unable to save your subscription right now.",
        );
      }

      setEmail("");
      setConsent(false);
      setFormState("success");
      setMessage(
        "Thank you. You are now subscribed to HOST updates.",
      );
    } catch (error) {
      setFormState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to save your subscription right now.",
      );
    }
  }

  return (
    <footer className="site-footer">
      <style>{`
        .site-footer {
          border-top: 1px solid var(--stone);
          background:
            radial-gradient(
              circle at 80% 10%,
              rgba(201, 151, 75, 0.1),
              transparent 32%
            ),
            #100e0b;
        }

        .footer-newsletter {
          display: grid;
          grid-template-columns: minmax(0, 0.9fr) minmax(360px, 1.1fr);
          gap: 72px;
          align-items: center;
          max-width: 1080px;
          margin: 0 auto;
          padding: 76px 28px 68px;
        }

        .footer-newsletter-copy h2 {
          max-width: 500px;
          margin: 12px 0 18px;
          font-family: var(--font-display);
          font-size: clamp(30px, 4vw, 48px);
          font-weight: 400;
          line-height: 1.08;
        }

        .footer-newsletter-copy p {
          max-width: 510px;
          margin: 0;
          color: var(--warm-grey);
          font-size: 15px;
          line-height: 1.7;
        }

        .newsletter-form {
          padding: 24px;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: rgba(31, 27, 21, 0.88);
        }

        .newsletter-field {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
        }

        .newsletter-field input {
          min-width: 0;
          padding: 14px 15px;
          border: 1px solid #3b3428;
          border-radius: 4px;
          background: var(--ink);
          color: var(--ivory);
          font: inherit;
        }

        .newsletter-field input:focus {
          border-color: var(--brass);
          outline: none;
        }

        .newsletter-field button {
          padding: 14px 22px;
          border: 1px solid var(--brass);
          border-radius: 4px;
          background: var(--brass);
          color: var(--ink);
          font: inherit;
          font-weight: 500;
          cursor: pointer;
        }

        .newsletter-field button:disabled {
          cursor: wait;
          opacity: 0.65;
        }

        .newsletter-consent {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 10px;
          align-items: start;
          margin-top: 15px;
          color: var(--warm-grey);
          font-size: 11px;
          line-height: 1.55;
        }

        .newsletter-consent input {
          width: 16px;
          height: 16px;
          margin: 1px 0 0;
          accent-color: var(--brass);
        }

        .newsletter-consent a,
        .footer-link-columns a,
        .footer-legal a {
          color: inherit;
          text-underline-offset: 3px;
        }

        .newsletter-consent a:hover,
        .footer-link-columns a:hover,
        .footer-legal a:hover {
          color: var(--brass);
        }

        .newsletter-status {
          min-height: 20px;
          margin: 13px 0 0;
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.5;
        }

        .newsletter-status.success {
          color: #b8c995;
        }

        .newsletter-status.error {
          color: #e0796b;
        }

        .newsletter-honeypot {
          position: absolute;
          left: -10000px;
          width: 1px;
          height: 1px;
          overflow: hidden;
        }

        .footer-main {
          display: grid;
          grid-template-columns: 1.15fr 1fr;
          gap: 72px;
          max-width: 1080px;
          margin: 0 auto;
          padding: 50px 28px;
          border-top: 1px solid var(--stone);
        }

        .footer-brand {
          max-width: 390px;
        }

        .footer-wordmark {
          display: inline-block;
          margin-bottom: 14px;
          color: var(--ivory);
          font-family: var(--font-display);
          font-size: 28px;
          text-decoration: none;
        }

        .footer-brand p {
          margin: 0;
          color: var(--warm-grey);
          font-size: 13px;
          line-height: 1.7;
        }

        .footer-link-columns {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 28px;
        }

        .footer-column h3 {
          margin: 0 0 16px;
          color: var(--brass);
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.13em;
          text-transform: uppercase;
        }

        .footer-column a {
          display: block;
          width: fit-content;
          margin-top: 11px;
          color: var(--warm-grey);
          font-size: 13px;
          text-decoration: none;
        }

        .footer-legal {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          max-width: 1080px;
          margin: 0 auto;
          padding: 22px 190px 36px 28px;
          border-top: 1px solid var(--stone);
          color: #80786a;
          font-size: 11px;
          line-height: 1.6;
        }

        .footer-legal-links {
          display: flex;
          gap: 18px;
          flex-wrap: wrap;
        }

        .staging-footer-note {
          max-width: 1080px;
          margin: 0 auto;
          padding: 18px 28px;
          border-top: 1px solid var(--stone);
          color: var(--warm-grey);
          font-size: 11px;
          line-height: 1.6;
          text-align: center;
        }

        .site-footer a:focus-visible,
        .site-footer button:focus-visible,
        .site-footer input:focus-visible {
          outline: 2px solid var(--brass);
          outline-offset: 3px;
        }

        @media (max-width: 760px) {
          .footer-newsletter,
          .footer-main {
            grid-template-columns: 1fr;
            gap: 34px;
          }

          .footer-newsletter {
            padding-top: 58px;
          }

          .footer-link-columns {
            grid-template-columns: repeat(2, 1fr);
          }

          .footer-legal {
            flex-direction: column;
            padding-right: 28px;
            padding-bottom: 104px;
          }
        }

        @media (max-width: 520px) {
          .newsletter-field {
            grid-template-columns: 1fr;
          }

          .newsletter-field button {
            width: 100%;
          }

          .footer-link-columns {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <section
        className="footer-newsletter"
        aria-labelledby="host-newsletter-title"
      >
        <div className="footer-newsletter-copy">
          <div className="eyebrow">The HOST journal</div>

          <h2 id="host-newsletter-title">
            City inspiration, thoughtfully delivered.
          </h2>

          <p>
            Discover distinctive stays, considered neighbourhoods and
            occasional ideas for travelling well across Britain and
            Europe.
          </p>
        </div>

        <form className="newsletter-form" onSubmit={subscribe}>
          <div className="newsletter-field">
            <label className="newsletter-honeypot">
              Leave this field empty
              <input
                type="text"
                name="website"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                tabIndex={-1}
                autoComplete="off"
              />
            </label>

            <label className="newsletter-honeypot" htmlFor="footer-email">
              Email address
            </label>

            <input
              id="footer-email"
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Your email address"
              autoComplete="email"
              maxLength={254}
              required
            />

            <button
              type="submit"
              disabled={formState === "submitting"}
            >
              {formState === "submitting"
                ? "Joining..."
                : "Join the journal"}
            </button>
          </div>

          <label className="newsletter-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />

            <span>
              I would like to receive occasional HOST news, destination
              ideas and offers by email. I can withdraw consent at any
              time. See the <a href="/privacy">privacy notice</a>.
            </span>
          </label>

          <p
            className={`newsletter-status ${formState}`}
            role="status"
            aria-live="polite"
          >
            {message}
          </p>
        </form>
      </section>

      <div className="footer-main">
        <div className="footer-brand">
          <a href="/" className="footer-wordmark">
            HOST
          </a>

          <p>
            Thoughtful city stays with the space, privacy and character
            to feel at home.
          </p>
        </div>

        <nav
          className="footer-link-columns"
          aria-label="Footer navigation"
        >
          <div className="footer-column">
            <h3>Explore</h3>
            <a href="/search">Find a stay</a>
            <a href="/favourites">Saved stays</a>
            <a href="/trips">My trips</a>
          </div>

          <div className="footer-column">
            <h3>Host</h3>
            <a href="/host-with-us">Host with us</a>
            <a href="/host/dashboard">Host workspace</a>
            <a href="/contact">Host support</a>
          </div>

          <div className="footer-column">
            <h3>HOST</h3>
            <a href="/contact">Contact</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </div>
        </nav>
      </div>

      {showStaging && (
        <div className="staging-footer-note">
          Staging deployment for integration testing. Payments and
          listings use test data and are not real transactions.
        </div>
      )}

      <div className="footer-legal">
        <span>
          © {new Date().getFullYear()} HOST. All rights reserved.
        </span>

        <div className="footer-legal-links">
          <a href="/privacy">Privacy notice</a>
          <a href="/terms">Terms</a>
          <a href="/contact">Support</a>
        </div>
      </div>
    </footer>
  );
}
