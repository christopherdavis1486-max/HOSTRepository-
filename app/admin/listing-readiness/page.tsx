"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type ReadinessCheck = {
  key: string;
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

type QueueProperty = {
  id: string;
  name: string;
  city: string;
  country_code: string | null;
  status: string;
  pilot_review_status: string;
  compliance_status: string;
  owner_email: string;
  updated_at: string;
  readiness: ReadinessReport;
};

const panelStyle = {
  background: "#1d1a15",
  border: "1px solid #342c20",
  borderRadius: 8,
  padding: 24,
  marginBottom: 16,
};

export default function AdminListingReadinessPage() {
  const { ht, hStatus } = useHostI18n();
  const [properties, setProperties] = useState<
    QueueProperty[]
  >([]);
  const [selected, setSelected] =
    useState<QueueProperty | null>(null);
  const [report, setReport] =
    useState<ReadinessReport | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] =
    useState("");
  const [busy, setBusy] = useState(false);

  async function loadQueue() {
    setBusy(true);
    setMessage(
      ht("Loading pilot-review queue...")
    );

    try {
      const response = await fetch(
        "/api/admin/listing-readiness",
        {
          credentials: "include",
          cache: "no-store",
        }
      );

      const body = await response.json();

      if (!response.ok) {
        setMessage(
          body.error?.message ??
            ht("Unable to load review queue.")
        );
        return;
      }

      setProperties(body.properties ?? []);
      setMessage("");
    } catch {
      setMessage(
        ht("Unable to load review queue.")
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadQueue();
  }, []);

  async function openProperty(
    property: QueueProperty
  ) {
    setSelected(property);
    setReport(property.readiness);
    setNote("");
    setMessage("");
    setBusy(true);

    try {
      const response = await fetch(
        `/api/admin/listing-readiness?propertyId=${property.id}`,
        {
          credentials: "include",
          cache: "no-store",
        }
      );

      const body = await response.json();

      if (!response.ok) {
        setMessage(
          body.error?.message ??
            ht(
              "Unable to load listing readiness."
            )
        );
        return;
      }

      setReport(body.readiness);
    } catch {
      setMessage(
        ht("Unable to load listing readiness.")
      );
    } finally {
      setBusy(false);
    }
  }

  const blockersOtherThanReview = useMemo(
    () =>
      report?.missing.filter(
        (check) =>
          check.key !== "pilotReview"
      ) ?? [],
    [report]
  );

  const noteIsValid =
    note.trim().length >= 8;

  const canApprove =
    !!selected &&
    !!report &&
    blockersOtherThanReview.length === 0 &&
    noteIsValid &&
    !busy;

  async function decide(
    decision:
      | "approved"
      | "changes_required"
  ) {
    if (!selected || !noteIsValid) return;

    setBusy(true);
    setMessage("");

    try {
      const response = await fetch(
        "/api/admin/listing-readiness",
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            propertyId: selected.id,
            decision,
            note: note.trim(),
          }),
        }
      );

      const body = await response.json();

      if (!response.ok) {
        setMessage(
          body.error?.message ??
            ht("Pilot review failed.")
        );

        if (body.error?.readiness) {
          setReport(
            body.error.readiness
          );
        }

        return;
      }

      setSelected(null);
      setReport(null);
      setNote("");
      await loadQueue();
      setMessage(
        ht(
          decision === "approved"
            ? "Pilot listing approved and audited."
            : "Listing changes requested and audited."
        )
      );
    } catch {
      setMessage(
        ht("Pilot review failed.")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#100f0c",
        color: "#fff8e8",
        padding: "48px 6vw",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent:
              "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <nav
            aria-label="Admin navigation"
            style={{
              display: "flex",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <a
              href="/admin/security"
              style={{ color: "#c4a98b" }}
            >
              {ht("Admin security")}
            </a>

            <a
              href="/admin/property-compliance"
              style={{ color: "#c4a98b" }}
            >
              {ht("Compliance review")}
            </a>
          </nav>

          <LanguageSelector compact />
        </div>

        <h1
          style={{
            fontFamily: "Georgia, serif",
            fontSize: 42,
            fontWeight: 400,
            marginBottom: 8,
          }}
        >
          {ht("Pilot listing review")}
        </h1>

        <p
          style={{
            color: "#c4a98b",
            lineHeight: 1.6,
            maxWidth: 760,
          }}
        >
          {ht(
            "Final internal approval is separate from compliance review. Confirm every commercial, operational and safety requirement before making a pilot listing publishable."
          )}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={() => void loadQueue()}
          style={{
            marginBottom: 24,
            padding: "10px 14px",
          }}
        >
          {busy
            ? ht("Loading...")
            : ht("Refresh queue")}
        </button>

        {properties.length === 0 &&
          !busy && (
            <section style={panelStyle}>
              <p style={{ margin: 0 }}>
                {ht(
                  "No listings currently require pilot review."
                )}
              </p>
            </section>
          )}

        {properties.map((property) => (
          <section
            key={property.id}
            style={panelStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent:
                  "space-between",
                gap: 18,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div>
                <strong
                  style={{ fontSize: 18 }}
                >
                  {property.name}
                </strong>

                <p
                  style={{
                    color: "#c4a98b",
                    lineHeight: 1.6,
                    margin: "8px 0",
                  }}
                >
                  {property.city}
                  {property.country_code
                    ? `, ${property.country_code}`
                    : ""}
                  {" · "}
                  {property.owner_email}
                </p>

                <p
                  style={{
                    color:
                      property.readiness
                        .missing.length === 1 &&
                      property.readiness
                        .missing[0].key ===
                        "pilotReview"
                        ? "#8fd1a4"
                        : "#d49a3f",
                    margin: 0,
                  }}
                >
                  {property.readiness
                    .missing.length === 1 &&
                  property.readiness
                    .missing[0].key ===
                    "pilotReview"
                    ? ht(
                        "Complete and awaiting final review"
                      )
                    : ht(
                        `${property.readiness.missing.length} requirements incomplete`
                      )}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  void openProperty(property)
                }
                style={{
                  padding: "10px 14px",
                }}
              >
                {ht("Open checklist")}
              </button>
            </div>
          </section>
        ))}

        {selected && report && (
          <section
            aria-labelledby="review-heading"
            style={{
              ...panelStyle,
              marginTop: 28,
              borderColor: "#6f5430",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent:
                  "space-between",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <h2
                  id="review-heading"
                  style={{
                    fontFamily:
                      "Georgia, serif",
                    fontWeight: 400,
                    fontSize: 28,
                    marginTop: 0,
                  }}
                >
                  {selected.name}
                </h2>

                <p
                  style={{
                    color: "#c4a98b",
                  }}
                >
                  {ht("Listing status")}:{" "}
                  {hStatus(selected.status)}
                  {" · "}
                  {ht("Compliance")}:{" "}
                  {hStatus(
                    selected.compliance_status
                  )}
                  {" · "}
                  {ht("Pilot review")}:{" "}
                  {hStatus(
                    selected.pilot_review_status
                  )}
                </p>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <a
                  href={`/host/properties/${selected.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#d49a3f" }}
                >
                  {ht("Open host listing")}
                </a>

                <a
                  href={`/admin/property-compliance?propertyId=${selected.id}`}
                  style={{ color: "#d49a3f" }}
                >
                  {ht("Open compliance")}
                </a>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gap: 10,
                marginTop: 20,
              }}
            >
              {report.checks.map((check) => (
                <div
                  key={check.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "30px minmax(0, 1fr)",
                    gap: 12,
                    padding: 14,
                    border:
                      "1px solid #342c20",
                    borderRadius: 6,
                    background: "#171510",
                  }}
                >
                  <span
                    aria-label={
                      check.ready
                        ? ht("Complete")
                        : ht("Incomplete")
                    }
                    style={{
                      color: check.ready
                        ? "#8fd1a4"
                        : "#d49a3f",
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
                          color:
                            "#c4a98b",
                          fontSize: 13,
                          lineHeight: 1.5,
                          margin:
                            "6px 0 0",
                        }}
                      >
                        {ht(check.guidance)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {blockersOtherThanReview.length >
              0 && (
              <p
                role="alert"
                style={{
                  color: "#d49a3f",
                  marginTop: 18,
                }}
              >
                {ht(
                  "Approval is blocked until every requirement except Final pilot review is complete."
                )}
              </p>
            )}

            <label
              htmlFor="pilot-review-note"
              style={{
                display: "block",
                marginTop: 20,
                marginBottom: 8,
              }}
            >
              {ht("Review note")}
            </label>

            <textarea
              id="pilot-review-note"
              value={note}
              maxLength={2000}
              onChange={(event) =>
                setNote(event.target.value)
              }
              placeholder={ht(
                "Record what was checked, or clearly explain the changes required."
              )}
              style={{
                display: "block",
                width: "100%",
                minHeight: 110,
                padding: 12,
                background: "#fff8e8",
                color: "#171510",
              }}
            />

            {!noteIsValid && note.length > 0 && (
              <p
                style={{
                  color: "#d49a3f",
                  fontSize: 13,
                }}
              >
                {ht(
                  "Enter at least 8 characters for the audit record."
                )}
              </p>
            )}

            <div
              style={{
                display: "flex",
                gap: 12,
                marginTop: 16,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                disabled={
                  busy || !noteIsValid
                }
                onClick={() =>
                  void decide(
                    "changes_required"
                  )
                }
                style={{
                  padding: "10px 14px",
                }}
              >
                {ht("Request changes")}
              </button>

              <button
                type="button"
                disabled={!canApprove}
                onClick={() =>
                  void decide("approved")
                }
                style={{
                  border: 0,
                  padding: "10px 14px",
                  background: canApprove
                    ? "#d49a3f"
                    : "#6b604f",
                  color: "#100f0c",
                }}
              >
                {ht("Approve pilot listing")}
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setReport(null);
                  setNote("");
                }}
                style={{
                  padding: "10px 14px",
                }}
              >
                {ht("Close checklist")}
              </button>
            </div>
          </section>
        )}

        {message && (
          <p
            role="status"
            style={{ color: "#d49a3f" }}
          >
            {message}
          </p>
        )}
      </div>
    </main>
  );
}