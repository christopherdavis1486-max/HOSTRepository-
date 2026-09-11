"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type Amenity = {
  id: string;
  name: string;
  slug: string;
};

type CancellationPolicy = {
  id: string;
  name: string;
  description: string | null;
  rules: unknown;
};

type State = "checking" | "unauthenticated" | "forbidden" | "ready";

export default function NewPropertyPage() {
  const { ht } = useHostI18n();

  const [state, setState] = useState<State>("checking");
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [selectedAmenities, setSelectedAmenities] = useState<Set<string>>(
    new Set()
  );
  const [cancellationPolicies, setCancellationPolicies] = useState<
    CancellationPolicy[]
  >([]);

  const [name, setName] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [description, setDescription] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [countryCode, setCountryCode] = useState("GB");
  const [maxGuests, setMaxGuests] = useState(2);
  const [bedrooms, setBedrooms] = useState(1);
  const [bathrooms, setBathrooms] = useState(1);
  const [nightlyPrice, setNightlyPrice] = useState(100);
  const [cleaningFee, setCleaningFee] = useState(0);
  const [minStayNights, setMinStayNights] = useState(1);
  const [maxStayNights, setMaxStayNights] = useState(365);
  const [cancellationPolicyId, setCancellationPolicyId] = useState("");
  const [checkInTime, setCheckInTime] = useState("15:00");
  const [checkOutTime, setCheckOutTime] = useState("11:00");
  const [houseRules, setHouseRules] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/host/amenities", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) {
          setState("unauthenticated");
          return;
        }

        if (res.status === 403) {
          setState("forbidden");
          return;
        }

        const data = await res.json();

        if (data.success) {
          setAmenities(data.amenities);
        }

        setState("ready");
      })
      .catch(() => setState("ready"));
  }, []);

  useEffect(() => {
    fetch("/api/host/cancellation-policies", {
      credentials: "include",
    })
      .then(async (res) => {
        const data = await res.json();

        if (data.success) {
          setCancellationPolicies(data.policies);
        }
      })
      .catch(() => {});
  }, []);

  const toggleAmenity = (id: string) => {
    setSelectedAmenities((previous) => {
      const next = new Set(previous);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Property name is required.");
      return;
    }

    if (!city.trim()) {
      setError("City is required.");
      return;
    }

    if (nightlyPrice <= 0) {
      setError("Nightly price must be greater than zero.");
      return;
    }

    if (minStayNights < 1 || minStayNights > 365) {
      setError("Minimum stay must be between 1 and 365 nights.");
      return;
    }

    if (maxStayNights < 1 || maxStayNights > 365) {
      setError("Maximum stay must be between 1 and 365 nights.");
      return;
    }

    if (minStayNights > maxStayNights) {
      setError(
        "Maximum stay must be greater than or equal to minimum stay."
      );
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch("/api/host/properties", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          name,
          propertyType: propertyType || undefined,
          description: description || undefined,
          city,
          district: district || undefined,
          countryCode: countryCode || undefined,
          maxGuests,
          bedrooms,
          bathrooms,
          nightlyPrice,
          cleaningFee,
          minStayNights,
          maxStayNights,
          cancellationPolicyId: cancellationPolicyId || undefined,
          checkInTime,
          checkOutTime,
          houseRules: houseRules || undefined,
          amenityIds: Array.from(selectedAmenities),
          status: "draft",
        }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(
          data.error?.message ??
            "Couldn't create the property. Please check the details and try again."
        );
        setSubmitting(false);
        return;
      }

      window.location.href = `/host/properties/${data.propertyId}`;
    } catch {
      setError("Something went wrong reaching the server. Please try again.");
      setSubmitting(false);
    }
  };

  const selectedPolicy = cancellationPolicies.find(
    (policy) => policy.id === cancellationPolicyId
  );

  return (
    <div className="page-root">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;1,400;1,500&family=Space+Grotesk:wght@400;500&display=swap"
      />

      <style>{`
        .page-root {
          --font-display: "Fraunces", Georgia, serif;
          --font-body: "Space Grotesk", system-ui, sans-serif;
          --ink: #14120e;
          --graphite: #1f1b15;
          --stone: #2a251c;
          --ivory: #f2ecde;
          --warm-grey: #a79e8c;
          --brass: #c9974b;
          --error: #e0796b;
          background: var(--ink);
          color: var(--ivory);
          font-family: var(--font-body);
          min-height: 100vh;
        }

        .page-root * {
          box-sizing: border-box;
        }

        .display {
          font-family: var(--font-display);
        }

        .top-link {
          display: block;
          padding: 24px 28px 0;
        }

        .top-link a {
          color: var(--warm-grey);
          font-size: 13px;
          text-decoration: none;
        }

        .header {
          margin: 0 auto;
          max-width: 720px;
          padding: 8px 28px 20px;
        }

        .header h1 {
          font-size: 26px;
          font-weight: 400;
        }

        .state-block {
          color: var(--warm-grey);
          margin: 60px auto;
          max-width: 720px;
          padding: 0 28px;
          text-align: center;
        }

        .wrap {
          margin: 0 auto;
          max-width: 720px;
          padding: 8px 28px 80px;
        }

        .card {
          background: var(--graphite);
          border: 1px solid var(--stone);
          border-radius: 8px;
          margin-bottom: 20px;
          padding: 22px;
        }

        .card h2 {
          color: var(--brass);
          font-size: 13px;
          font-weight: 400;
          letter-spacing: 0.08em;
          margin-bottom: 16px;
          text-transform: uppercase;
        }

        .field-grid {
          display: grid;
          gap: 14px;
          grid-template-columns: 1fr 1fr;
        }

        .field-grid.cols-3 {
          grid-template-columns: 1fr 1fr 1fr;
        }

        .field {
          margin-bottom: 14px;
        }

        .field.full {
          grid-column: 1 / -1;
        }

        .field label {
          color: var(--warm-grey);
          display: block;
          font-size: 11px;
          letter-spacing: 0.05em;
          margin-bottom: 6px;
          text-transform: uppercase;
        }

        .field input,
        .field textarea,
        .field select {
          background: var(--ink);
          border: 1px solid var(--stone);
          border-radius: 4px;
          color: var(--ivory);
          color-scheme: dark;
          font-family: var(--font-body);
          font-size: 14px;
          padding: 10px 12px;
          width: 100%;
        }

        .field textarea {
          min-height: 80px;
          resize: vertical;
        }

        .field input:focus,
        .field textarea:focus,
        .field select:focus {
          border-color: var(--brass);
          outline: none;
        }

        .field-note {
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.5;
          margin: 8px 0 0;
        }

        .amenity-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(2, 1fr);
        }

        .amenity-item {
          align-items: center;
          color: var(--warm-grey);
          display: flex;
          font-size: 13px;
          gap: 8px;
        }

        .amenity-item input {
          width: auto;
        }

        .error-box {
          background: rgba(224, 121, 107, 0.12);
          border: 1px solid var(--error);
          border-radius: 4px;
          color: var(--error);
          font-size: 13px;
          margin-bottom: 16px;
          padding: 10px 14px;
        }

        .submit-row {
          align-items: center;
          display: flex;
          gap: 12px;
        }

        .btn-primary {
          background: var(--brass);
          border: none;
          border-radius: 4px;
          color: var(--ink);
          cursor: pointer;
          display: inline-block;
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          margin-top: 16px;
          padding: 12px 22px;
          text-decoration: none;
        }

        .btn-primary:disabled {
          cursor: wait;
          opacity: 0.6;
        }

        @media (max-width: 600px) {
          .amenity-grid,
          .field-grid,
          .field-grid.cols-3 {
            grid-template-columns: 1fr;
          }

          .submit-row {
            align-items: flex-start;
            flex-direction: column;
          }
        }
      `}</style>

      <div className="top-link">
        <a href="/host/properties">← {ht("Back to Properties")}</a>
      </div>

      {state === "checking" && (
        <div className="state-block">{ht("Loading…")}</div>
      )}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>
            {ht("Sign in to your host account.")}
          </p>
          <a
            href={`/login?returnTo=${encodeURIComponent(
              "/host/properties/new"
            )}`}
            className="btn-primary"
          >
            {ht("Sign in")}
          </a>
        </div>
      )}

      {state === "forbidden" && (
        <div className="state-block">
          {ht("This account doesn't have host access.")}
        </div>
      )}

      {state === "ready" && (
        <>
          <div className="header">
            <h1 className="display">{ht("Add property")}</h1>
          </div>

          <HostNav active="properties" />

          <form className="wrap" onSubmit={handleSubmit}>
            {error && <div className="error-box">{error}</div>}

            <div className="card">
              <h2>{ht("Basics")}</h2>

              <div className="field full">
                <label htmlFor="name">{ht("Property name")}</label>
                <input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="field-grid">
                <div className="field">
                  <label htmlFor="propertyType">
                    {ht("Property type")}
                  </label>
                  <input
                    id="propertyType"
                    value={propertyType}
                    onChange={(event) =>
                      setPropertyType(event.target.value)
                    }
                    placeholder={ht("Apartment, House…")}
                  />
                </div>

                <div className="field">
                  <label htmlFor="countryCode">{ht("Country code")}</label>
                  <input
                    id="countryCode"
                    value={countryCode}
                    onChange={(event) =>
                      setCountryCode(event.target.value.toUpperCase())
                    }
                    maxLength={2}
                  />
                </div>

                <div className="field">
                  <label htmlFor="city">{ht("City")}</label>
                  <input
                    id="city"
                    value={city}
                    onChange={(event) => setCity(event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="district">{ht("District")}</label>
                  <input
                    id="district"
                    value={district}
                    onChange={(event) => setDistrict(event.target.value)}
                  />
                </div>
              </div>

              <div className="field full">
                <label htmlFor="description">{ht("Description")}</label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </div>

            <div className="card">
              <h2>{ht("Capacity")}</h2>

              <div className="field-grid cols-3">
                <div className="field">
                  <label htmlFor="maxGuests">{ht("Max guests")}</label>
                  <input
                    id="maxGuests"
                    type="number"
                    min={1}
                    value={maxGuests}
                    onChange={(event) =>
                      setMaxGuests(Number(event.target.value))
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor="bedrooms">{ht("Bedrooms")}</label>
                  <input
                    id="bedrooms"
                    type="number"
                    min={0}
                    value={bedrooms}
                    onChange={(event) =>
                      setBedrooms(Number(event.target.value))
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor="bathrooms">{ht("Bathrooms")}</label>
                  <input
                    id="bathrooms"
                    type="number"
                    min={0}
                    step={0.5}
                    value={bathrooms}
                    onChange={(event) =>
                      setBathrooms(Number(event.target.value))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Pricing")}</h2>

              <div className="field-grid">
                <div className="field">
                  <label htmlFor="nightlyPrice">
                    {ht("Base nightly price")}
                  </label>
                  <input
                    id="nightlyPrice"
                    type="number"
                    min={0}
                    step={0.01}
                    value={nightlyPrice}
                    onChange={(event) =>
                      setNightlyPrice(Number(event.target.value))
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor="cleaningFee">{ht("Cleaning fee")}</label>
                  <input
                    id="cleaningFee"
                    type="number"
                    min={0}
                    step={0.01}
                    value={cleaningFee}
                    onChange={(event) =>
                      setCleaningFee(Number(event.target.value))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Booking terms")}</h2>

              <div className="field-grid">
                <div className="field">
                  <label htmlFor="minStayNights">
                    {ht("Minimum stay")}
                  </label>
                  <input
                    id="minStayNights"
                    type="number"
                    min={1}
                    max={365}
                    value={minStayNights}
                    onChange={(event) =>
                      setMinStayNights(Number(event.target.value))
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor="maxStayNights">
                    {ht("Maximum stay")}
                  </label>
                  <input
                    id="maxStayNights"
                    type="number"
                    min={1}
                    max={365}
                    value={maxStayNights}
                    onChange={(event) =>
                      setMaxStayNights(Number(event.target.value))
                    }
                  />
                </div>
              </div>

              <div className="field full">
                <label htmlFor="cancellationPolicyId">
                  {ht("Cancellation policy")}
                </label>
                <select
                  id="cancellationPolicyId"
                  value={cancellationPolicyId}
                  onChange={(event) =>
                    setCancellationPolicyId(event.target.value)
                  }
                >
                  <option value="">
                    {ht("Select a cancellation policy")}
                  </option>
                  {cancellationPolicies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {ht(policy.name)}
                    </option>
                  ))}
                </select>

                {selectedPolicy?.description && (
                  <p className="field-note">
                    {ht(selectedPolicy.description)}
                  </p>
                )}
              </div>
            </div>

            <div className="card">
              <h2>{ht("Check-in")}</h2>

              <div className="field-grid">
                <div className="field">
                  <label htmlFor="checkInTime">
                    {ht("Check-in time")}
                  </label>
                  <input
                    id="checkInTime"
                    type="time"
                    value={checkInTime}
                    onChange={(event) =>
                      setCheckInTime(event.target.value)
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor="checkOutTime">
                    {ht("Check-out time")}
                  </label>
                  <input
                    id="checkOutTime"
                    type="time"
                    value={checkOutTime}
                    onChange={(event) =>
                      setCheckOutTime(event.target.value)
                    }
                  />
                </div>
              </div>

              <div className="field full">
                <label htmlFor="houseRules">{ht("House rules")}</label>
                <textarea
                  id="houseRules"
                  value={houseRules}
                  onChange={(event) => setHouseRules(event.target.value)}
                />
              </div>
            </div>

            {amenities.length > 0 && (
              <div className="card">
                <h2>{ht("Amenities")}</h2>

                <div className="amenity-grid">
                  {amenities.map((amenity) => (
                    <label className="amenity-item" key={amenity.id}>
                      <input
                        type="checkbox"
                        checked={selectedAmenities.has(amenity.id)}
                        onChange={() => toggleAmenity(amenity.id)}
                      />
                      {ht(amenity.name)}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="submit-row">
              <button
                type="submit"
                className="btn-primary"
                disabled={submitting}
                style={{ marginTop: 0 }}
              >
                {submitting ? ht("Creating…") : ht("Create property")}
              </button>

              <span
                style={{
                  color: "var(--warm-grey)",
                  fontSize: 13,
                }}
              >
                {ht(
                  "Saved as a draft — you can publish it once you're ready."
                )}
              </span>
            </div>
          </form>
        </>
      )}
    </div>
  );
}