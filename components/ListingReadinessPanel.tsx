"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type ReadinessCheck = {
  key:
    | "basicDetails"
    | "guestCapacity"
    | "pricing"
    | "stayPolicy"
    | "privateLocation"
    | "images"
    | "hostAgreement"
    | "payoutAccount"
    | "compliance"
    | "pilotReview";
  label: string;
  ready: boolean;
  guidance: string;
};

type ReadinessReport = {
  propertyId: string;
  ready: boolean;
  checks: ReadinessCheck[];
  missing: ReadinessCheck[];
};

const actionLinks: Partial<
  Record<ReadinessCheck["key"], string>
> = {
  hostAgreement:
    "/host/onboarding/connect-account",
  payoutAccount:
    "/host/onboarding/connect-account",
};

export function ListingReadinessPanel({
  propertyId,
}: {
  propertyId: string;
}) {
  const { ht } = useHostI18n();
  const [report, setReport] =
    useState<ReadinessReport | null>(null);
  const [message, setMessage] =
    useState("Loading listing progress...");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/readiness`,
        {
          credentials: "include",
          cache: "no-store",
        }
      );

      const body = await response.json();

      if (!response.ok) {
        setMessage(
          body.error?.message ??
            "Unable to load listing progress."
        );
        return;
      }

      setReport(body.readiness);
      setMessage("");
    } catch {
      setMessage(
        "Unable to load listing progress."
      );
    } finally {
      setBusy(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="listing-readiness-heading"
      style={{
        marginTop: 28,
        padding: 24,
        border: "1px solid #3b3327",
        borderRadius: 8,
        background: "#1d1a15",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div>
          <p
            style={{
              margin: "0 0 6px",
              color: "var(--brass)",
              fontSize: 12,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {ht("Pilot onboarding")}
          </p>

          <h2
            id="listing-readiness-heading"
            className="display"
            style={{
              margin: 0,
              fontSize: 26,
              fontWeight: 400,
            }}
          >
            {ht("Listing readiness")}
          </h2>

          <p
            style={{
              color: "var(--warm-grey)",
              lineHeight: 1.6,
              maxWidth: 680,
            }}
          >
            {report?.ready
              ? ht(
                  "Every publication requirement is complete. This listing is ready to publish."
                )
              : ht(
                  "Complete each requirement below. HOST must manually review the finished listing before it can be published."
                )}
          </p>
        </div>

        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? ht("Checking...")
            : ht("Refresh progress")}
        </button>
      </div>

      {message && (
        <p
          role="status"
          style={{
            color: "var(--brass)",
          }}
        >
          {ht(message)}
        </p>
      )}

      {report && (
        <>
          <div
            role="status"
            style={{
              margin: "16px 0",
              padding: "12px 14px",
              borderRadius: 6,
              background: report.ready
                ? "rgba(92, 156, 113, 0.16)"
                : "rgba(201, 151, 75, 0.12)",
              color: report.ready
                ? "#8fd1a4"
                : "var(--brass)",
            }}
          >
            {report.ready
              ? ht("Ready to publish")
              : ht(
                  `${report.missing.length} requirement${
                    report.missing.length === 1
                      ? ""
                      : "s"
                  } remaining`
                )}
          </div>

          <div
            style={{
              display: "grid",
              gap: 10,
            }}
          >
            {report.checks.map((check) => {
              const actionLink =
                actionLinks[check.key];

              return (
                <div
                  key={check.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "28px minmax(0, 1fr) auto",
                    gap: 12,
                    alignItems: "start",
                    padding: 14,
                    border:
                      "1px solid #342c20",
                    borderRadius: 6,
                    background: "#171510",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      color: check.ready
                        ? "#8fd1a4"
                        : "var(--brass)",
                      fontSize: 18,
                    }}
                  >
                    {check.ready ? "✓" : "○"}
                  </span>

                  <div>
                    <strong>
                      {ht(check.label)}
                    </strong>

                    {!check.ready && (
                      <p
                        style={{
                          margin: "6px 0 0",
                          color:
                            "var(--warm-grey)",
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                      >
                        {ht(check.guidance)}
                      </p>
                    )}
                  </div>

                  {!check.ready &&
                    check.key ===
                      "compliance" && (
                      <a
                        href={`/host/properties/${propertyId}/compliance`}
                        style={{
                          color:
                            "var(--brass)",
                          fontSize: 13,
                        }}
                      >
                        {ht("Open")}
                      </a>
                    )}

                  {!check.ready &&
                    actionLink && (
                      <a
                        href={actionLink}
                        style={{
                          color:
                            "var(--brass)",
                          fontSize: 13,
                        }}
                      >
                        {ht("Open")}
                      </a>
                    )}
                </div>
              );
            })}
          </div>

          {!report.ready &&
            report.missing.length === 1 &&
            report.missing[0].key ===
              "pilotReview" && (
              <p
                style={{
                  marginTop: 16,
                  color: "var(--warm-grey)",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                {ht(
                  "Your listing is complete and waiting for HOST's final pilot review. Editing listing details or images after approval will require another review."
                )}
              </p>
            )}
        </>
      )}
    </section>
  );
}