"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { AvailabilityCalendar } from "@/components/AvailabilityCalendar";
import { CalendarSyncPanel } from "@/components/CalendarSyncPanel";
import { PropertyImageManager } from "@/components/PropertyImageManager";
import { ListingReadinessPanel } from "@/components/ListingReadinessPanel";
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

type PropertyDetail = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  city: string;
  district: string | null;
  countryCode: string | null;
  propertyType: string | null;
  status: string;
  currency: string;
  nightlyPrice: string | number;
  cleaningFee: string | number | null;
  maxGuests: number;
  bedrooms: number | null;
  bathrooms: number | null;
  minStayNights: number;
  maxStayNights: number;
  cancellationPolicyId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalTown: string | null;
  county: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  houseRules: string | null;
  amenities: Amenity[];
  cancellationPolicy: {
    name: string;
    description: string | null;
    rules: unknown;
  } | null;
  complianceStatus: string;
};

type AvailabilityDay = {
  date: string;
  status: string;
  source: string;
};

type State =
  | "loading"
  | "unauthenticated"
  | "forbidden"
  | "notFound"
  | "error"
  | "loaded";

export default function HostPropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { ht, hStatus } = useHostI18n();

  const [propertyId, setPropertyId] =
    useState<string | null>(null);

  const [property, setProperty] =
    useState<PropertyDetail | null>(null);

  const [allAmenities, setAllAmenities] =
    useState<Amenity[]>([]);

  const [
    selectedAmenities,
    setSelectedAmenities,
  ] = useState<Set<string>>(new Set());

  const [
    cancellationPolicies,
    setCancellationPolicies,
  ] = useState<CancellationPolicy[]>([]);

  const [state, setState] =
    useState<State>("loading");

  const [form, setForm] = useState({
    name: "",
    propertyType: "",
    description: "",
    city: "",
    district: "",
    countryCode: "",
    addressLine1: "",
    addressLine2: "",
    postalTown: "",
    county: "",
    postcode: "",
    latitude: "",
    longitude: "",
    maxGuests: 1,
    bedrooms: 0,
    bathrooms: 1,
    nightlyPrice: 0,
    cleaningFee: 0,
    minStayNights: 1,
    maxStayNights: 365,
    cancellationPolicyId: "",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    houseRules: "",
    status: "draft",
  });

  const [saving, setSaving] =
    useState(false);

  const [saveError, setSaveError] =
    useState<string | null>(null);

  const [saveSuccess, setSaveSuccess] =
    useState(false);

  const [availability, setAvailability] =
    useState<AvailabilityDay[]>([]);

  const [blockFrom, setBlockFrom] =
    useState("");

  const [blockTo, setBlockTo] =
    useState("");

  const [
    availabilityBusy,
    setAvailabilityBusy,
  ] = useState(false);

  const [
    availabilityMessage,
    setAvailabilityMessage,
  ] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ id }) =>
      setPropertyId(id)
    );
  }, [params]);

  const loadProperty = () => {
    if (!propertyId) return;

    fetch(
      `/api/host/properties/${propertyId}`,
      { credentials: "include" }
    )
      .then(async (response) => {
        if (response.status === 401) {
          setState("unauthenticated");
          return;
        }

        if (response.status === 403) {
          setState("forbidden");
          return;
        }

        if (response.status === 404) {
          setState("notFound");
          return;
        }

        const data = await response.json();

        if (!data.success) {
          setState("error");
          return;
        }

        const loaded: PropertyDetail =
          data.property;

        setProperty(loaded);

        setForm({
          name: loaded.name,
          propertyType:
            loaded.propertyType ?? "",
          description:
            loaded.description ?? "",
          city: loaded.city,
          district:
            loaded.district ?? "",
          countryCode:
            loaded.countryCode ?? "",
          addressLine1:
            loaded.addressLine1 ?? "",
          addressLine2:
            loaded.addressLine2 ?? "",
          postalTown:
            loaded.postalTown ?? "",
          county:
            loaded.county ?? "",
          postcode:
            loaded.postcode ?? "",
          latitude:
            loaded.latitude === null
              ? ""
              : String(loaded.latitude),
          longitude:
            loaded.longitude === null
              ? ""
              : String(loaded.longitude),
          maxGuests:
            loaded.maxGuests,
          bedrooms:
            loaded.bedrooms ?? 0,
          bathrooms:
            Number(
              loaded.bathrooms ?? 1
            ),
          nightlyPrice:
            Number(
              loaded.nightlyPrice
            ),
          cleaningFee:
            Number(
              loaded.cleaningFee ?? 0
            ),
          minStayNights:
            loaded.minStayNights ?? 1,
          maxStayNights:
            loaded.maxStayNights ?? 365,
          cancellationPolicyId:
            loaded.cancellationPolicyId ??
            "",
          checkInTime:
            loaded.checkInTime ??
            "15:00",
          checkOutTime:
            loaded.checkOutTime ??
            "11:00",
          houseRules:
            loaded.houseRules ?? "",
          status: loaded.status,
        });

        setSelectedAmenities(
          new Set(
            loaded.amenities.map(
              (amenity) => amenity.id
            )
          )
        );

        setState("loaded");
      })
      .catch(() =>
        setState("error")
      );
  };

  useEffect(loadProperty, [propertyId]);

  useEffect(() => {
    fetch("/api/host/amenities", {
      credentials: "include",
    })
      .then(async (response) => {
        const data =
          await response.json();

        if (data.success) {
          setAllAmenities(
            data.amenities
          );
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(
      "/api/host/cancellation-policies",
      { credentials: "include" }
    )
      .then(async (response) => {
        const data =
          await response.json();

        if (data.success) {
          setCancellationPolicies(
            data.policies
          );
        }
      })
      .catch(() => {});
  }, []);

  const loadAvailability = () => {
    if (!propertyId) return;

    fetch(
      `/api/host/properties/${propertyId}/availability`,
      { credentials: "include" }
    )
      .then((response) =>
        response.json()
      )
      .then((data) => {
        if (data.success) {
          setAvailability(
            data.availability
          );
        }
      })
      .catch(() => {});
  };

  useEffect(
    loadAvailability,
    [propertyId]
  );

  const toggleAmenity = (
    id: string
  ) => {
    setSelectedAmenities(
      (previous) => {
        const next =
          new Set(previous);

        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }

        return next;
      }
    );
  };

  const handleSave = async (
    event: React.FormEvent
  ) => {
    event.preventDefault();

    setSaveError(null);
    setSaveSuccess(false);

    if (!form.name.trim()) {
      setSaveError(
        "Property name is required."
      );
      return;
    }

    if (!form.city.trim()) {
      setSaveError(
        "City is required."
      );
      return;
    }

    if (form.nightlyPrice <= 0) {
      setSaveError(
        "Nightly price must be greater than zero."
      );
      return;
    }

    if (
      form.minStayNights < 1 ||
      form.minStayNights > 365
    ) {
      setSaveError(
        "Minimum stay must be between 1 and 365 nights."
      );
      return;
    }

    if (
      form.maxStayNights < 1 ||
      form.maxStayNights > 365
    ) {
      setSaveError(
        "Maximum stay must be between 1 and 365 nights."
      );
      return;
    }

    if (
      form.minStayNights >
      form.maxStayNights
    ) {
      setSaveError(
        "Maximum stay must be greater than or equal to minimum stay."
      );
      return;
    }

    if (
      (form.latitude === "") !==
      (form.longitude === "")
    ) {
      setSaveError(
        "Latitude and longitude must be provided together."
      );
      return;
    }

    setSaving(true);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type":
              "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            ...form,
            cancellationPolicyId:
              form.cancellationPolicyId ||
              null,
            latitude:
              form.latitude === ""
                ? null
                : Number(
                    form.latitude
                  ),
            longitude:
              form.longitude === ""
                ? null
                : Number(
                    form.longitude
                  ),
            amenityIds:
              Array.from(
                selectedAmenities
              ),
          }),
        }
      );

      const data =
        await response.json();

      if (!data.success) {
        setSaveError(
          data.error?.message ??
            "Couldn't save changes. Please check the details and try again."
        );
        setSaving(false);
        return;
      }

      setSaveSuccess(true);
      setSaving(false);
      loadProperty();
    } catch {
      setSaveError(
        "Something went wrong reaching the server. Please try again."
      );
      setSaving(false);
    }
  };

  const handleAvailabilityAction =
    async (
      action: "block" | "unblock"
    ) => {
      if (!blockFrom || !blockTo) {
        setAvailabilityMessage(
          "Select both a start and end date."
        );
        return;
      }

      setAvailabilityBusy(true);
      setAvailabilityMessage(null);

      try {
        const response = await fetch(
          `/api/host/properties/${propertyId}/availability`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              action,
              checkIn: blockFrom,
              checkOut: blockTo,
            }),
          }
        );

        const data =
          await response.json();

        if (!data.success) {
          setAvailabilityMessage(
            data.error?.message ??
              "Couldn't update availability."
          );
        } else {
          const skippedNote =
            data.skipped?.length > 0
              ? ` (${
                  data.skipped.length
                } date${
                  data.skipped.length ===
                  1
                    ? ""
                    : "s"
                } skipped — already booked)`
              : "";

          setAvailabilityMessage(
            `${
              action === "block"
                ? "Blocked"
                : "Unblocked"
            } ${
              data.blocked.length
            } date${
              data.blocked.length ===
              1
                ? ""
                : "s"
            }${skippedNote}.`
          );

          loadAvailability();
        }
      } catch {
        setAvailabilityMessage(
          "Something went wrong reaching the server."
        );
      }

      setAvailabilityBusy(false);
    };

  const blockedDates =
    availability.filter(
      (day) =>
        day.status !== "available"
    );

  const selectedPolicy =
    cancellationPolicies.find(
      (policy) =>
        policy.id ===
        form.cancellationPolicyId
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
          padding: 24px 28px 0;
        }

        .top-link a {
          color: var(--warm-grey);
          font-size: 13px;
          text-decoration: none;
        }

        .header {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          justify-content: space-between;
          margin: 0 auto;
          max-width: 720px;
          padding: 8px 28px 20px;
        }

        .header h1 {
          font-size: 24px;
          font-weight: 400;
        }

        .state-block {
          color: var(--warm-grey);
          margin: 60px auto;
          max-width: 640px;
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
          grid-template-columns:
            1fr 1fr 1fr;
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
          grid-template-columns:
            repeat(2, 1fr);
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

        .btn-primary,
        .btn-secondary {
          border-radius: 4px;
          cursor: pointer;
          display: inline-block;
          font-family: var(--font-body);
          text-decoration: none;
        }

        .btn-primary {
          background: var(--brass);
          border: none;
          color: var(--ink);
          font-size: 14px;
          font-weight: 500;
          padding: 12px 22px;
        }

        .btn-secondary {
          background: transparent;
          border: 1px solid var(--stone);
          color: var(--ivory);
          font-size: 13px;
          padding: 11px 18px;
        }

        .btn-primary:disabled,
        .btn-secondary:disabled {
          cursor: wait;
          opacity: 0.6;
        }

        .error-box,
        .success-box {
          border-radius: 4px;
          font-size: 13px;
          margin-bottom: 16px;
          padding: 10px 14px;
        }

        .error-box {
          background:
            rgba(224, 121, 107, 0.12);
          border: 1px solid var(--error);
          color: var(--error);
        }

        .success-box {
          background:
            rgba(201, 151, 75, 0.1);
          border: 1px solid var(--brass);
          color: var(--brass);
        }

        .actions-row {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }

        @media (max-width: 600px) {
          .amenity-grid,
          .field-grid,
          .field-grid.cols-3 {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="top-link">
        <a href="/host/properties">
          ← {ht("Back to Properties")}
        </a>
      </div>

      {state === "loading" && (
        <div className="state-block">
          {ht("Loading property…")}
        </div>
      )}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>
            {ht(
              "Sign in to your host account."
            )}
          </p>

          <a
            href={`/login?returnTo=${encodeURIComponent(
              `/host/properties/${
                propertyId ?? ""
              }`
            )}`}
            className="btn-primary"
          >
            {ht("Sign in")}
          </a>
        </div>
      )}

      {(state === "forbidden" ||
        state === "notFound") && (
        <div className="state-block">
          {ht(
            "This property isn't available."
          )}
        </div>
      )}

      {state === "error" && (
        <div className="state-block">
          {ht(
            "Something went wrong loading this property. Please try again shortly."
          )}
        </div>
      )}

      {state === "loaded" &&
        property && (
          <>
            <div className="header">
              <h1 className="display">
                {property.name}
              </h1>

              {property.slug && (
                <a
                  href={`/stays/${property.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary"
                >
                  {ht(
                    "Preview listing"
                  )}{" "}
                  →
                </a>
              )}
            </div>

            <HostNav active="properties" />

            <div
              className="wrap"
              style={{
                paddingBottom: 0,
              }}
            >
              <div className="card">
                <h2>
                  {ht(
                    "Property compliance"
                  )}
                </h2>

                <p
                  style={{
                    color:
                      "var(--warm-grey)",
                    lineHeight: 1.6,
                  }}
                >
                  {ht("Status")}:{" "}
                  <strong
                    style={{
                      color:
                        "var(--ivory)",
                    }}
                  >
                    {hStatus(
                      property.complianceStatus
                    )}
                  </strong>

                  {property.complianceStatus ===
                  "approved"
                    ? "."
                    : `. ${ht(
                        "Complete the owner declarations and evidence review before publishing."
                      )}`}
                </p>

                <a
                  className="btn-secondary"
                  href={`/host/properties/${property.id}/compliance`}
                >
                  {ht(
                    "Manage compliance"
                  )}{" "}
                  →
                </a>
              </div>
            </div>

            <form
              className="wrap"
              onSubmit={handleSave}
            >
              {saveError && (
                <div className="error-box">
                  {saveError}
                </div>
              )}

              {saveSuccess && (
                <div className="success-box">
                  {ht(
                    "Changes saved."
                  )}
                </div>
              )}

              <div className="card">
                <h2>
                  {ht("Listing status")}
                </h2>

                <div className="field">
                  <label htmlFor="status">
                    {ht("Status")}
                  </label>

                  <select
                    id="status"
                    value={form.status}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        status:
                          event.target
                            .value,
                      })
                    }
                  >
                    <option value="draft">
                      {ht(
                        "Draft — not visible to guests"
                      )}
                    </option>

                    <option value="published">
                      {ht(
                        "Published — live and bookable"
                      )}
                    </option>

                    <option value="paused">
                      {ht(
                        "Paused — temporarily hidden"
                      )}
                    </option>
                  </select>
                </div>
              </div>

              <div className="card">
                <h2>{ht("Basics")}</h2>

                <div className="field full">
                  <label htmlFor="name">
                    {ht(
                      "Property name"
                    )}
                  </label>

                  <input
                    id="name"
                    value={form.name}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        name:
                          event.target
                            .value,
                      })
                    }
                  />
                </div>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="propertyType">
                      {ht(
                        "Property type"
                      )}
                    </label>

                    <input
                      id="propertyType"
                      value={
                        form.propertyType
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          propertyType:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="countryCode">
                      {ht(
                        "Country code"
                      )}
                    </label>

                    <input
                      id="countryCode"
                      value={
                        form.countryCode
                      }
                      maxLength={2}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          countryCode:
                            event.target.value.toUpperCase(),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="city">
                      {ht("City")}
                    </label>

                    <input
                      id="city"
                      value={form.city}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          city:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="district">
                      {ht("District")}
                    </label>

                    <input
                      id="district"
                      value={
                        form.district
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          district:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="field full">
                  <label htmlFor="description">
                    {ht("Description")}
                  </label>

                  <textarea
                    id="description"
                    value={
                      form.description
                    }
                    onChange={(event) =>
                      setForm({
                        ...form,
                        description:
                          event.target
                            .value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="card">
                <h2>
                  {ht("Private address")}
                </h2>

                <p className="field-note">
                  {ht(
                    "The exact address and coordinates are visible only to the property owner and authorised HOST operations. Guests receive only an approximate map point."
                  )}
                </p>

                <div
                  className="field full"
                  style={{
                    marginTop: 16,
                  }}
                >
                  <label htmlFor="addressLine1">
                    {ht(
                      "Address line 1"
                    )}
                  </label>

                  <input
                    id="addressLine1"
                    autoComplete="address-line1"
                    value={
                      form.addressLine1
                    }
                    onChange={(event) =>
                      setForm({
                        ...form,
                        addressLine1:
                          event.target
                            .value,
                      })
                    }
                  />
                </div>

                <div className="field full">
                  <label htmlFor="addressLine2">
                    {ht(
                      "Address line 2"
                    )}
                  </label>

                  <input
                    id="addressLine2"
                    autoComplete="address-line2"
                    value={
                      form.addressLine2
                    }
                    onChange={(event) =>
                      setForm({
                        ...form,
                        addressLine2:
                          event.target
                            .value,
                      })
                    }
                  />
                </div>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="postalTown">
                      {ht(
                        "Postal town"
                      )}
                    </label>

                    <input
                      id="postalTown"
                      autoComplete="address-level2"
                      value={
                        form.postalTown
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          postalTown:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="county">
                      {ht("County")}
                    </label>

                    <input
                      id="county"
                      autoComplete="address-level1"
                      value={
                        form.county
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          county:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="postcode">
                      {ht("Postcode")}
                    </label>

                    <input
                      id="postcode"
                      autoComplete="postal-code"
                      value={
                        form.postcode
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          postcode:
                            event.target.value.toUpperCase(),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="latitude">
                      {ht(
                        "Exact latitude"
                      )}
                    </label>

                    <input
                      id="latitude"
                      type="number"
                      min={-90}
                      max={90}
                      step="any"
                      value={
                        form.latitude
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          latitude:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="longitude">
                      {ht(
                        "Exact longitude"
                      )}
                    </label>

                    <input
                      id="longitude"
                      type="number"
                      min={-180}
                      max={180}
                      step="any"
                      value={
                        form.longitude
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          longitude:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>
                </div>

                <p className="field-note">
                  {ht(
                    "Enter both coordinates or leave both blank. HOST derives the approximate public map point automatically."
                  )}
                </p>
              </div>

              <div className="card">
                <h2>
                  {ht("Capacity")}
                </h2>

                <div className="field-grid cols-3">
                  <div className="field">
                    <label htmlFor="maxGuests">
                      {ht(
                        "Max guests"
                      )}
                    </label>

                    <input
                      id="maxGuests"
                      type="number"
                      min={1}
                      value={
                        form.maxGuests
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          maxGuests:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="bedrooms">
                      {ht("Bedrooms")}
                    </label>

                    <input
                      id="bedrooms"
                      type="number"
                      min={0}
                      value={
                        form.bedrooms
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          bedrooms:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="bathrooms">
                      {ht(
                        "Bathrooms"
                      )}
                    </label>

                    <input
                      id="bathrooms"
                      type="number"
                      min={0}
                      step={0.5}
                      value={
                        form.bathrooms
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          bathrooms:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
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
                      {ht(
                        "Base nightly price"
                      )}
                    </label>

                    <input
                      id="nightlyPrice"
                      type="number"
                      min={0}
                      step={0.01}
                      value={
                        form.nightlyPrice
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          nightlyPrice:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="cleaningFee">
                      {ht(
                        "Cleaning fee"
                      )}
                    </label>

                    <input
                      id="cleaningFee"
                      type="number"
                      min={0}
                      step={0.01}
                      value={
                        form.cleaningFee
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          cleaningFee:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="card">
                <h2>
                  {ht("Booking terms")}
                </h2>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="minStayNights">
                      {ht(
                        "Minimum stay"
                      )}
                    </label>

                    <input
                      id="minStayNights"
                      type="number"
                      min={1}
                      max={365}
                      value={
                        form.minStayNights
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          minStayNights:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="maxStayNights">
                      {ht(
                        "Maximum stay"
                      )}
                    </label>

                    <input
                      id="maxStayNights"
                      type="number"
                      min={1}
                      max={365}
                      value={
                        form.maxStayNights
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          maxStayNights:
                            Number(
                              event
                                .target
                                .value
                            ),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="field full">
                  <label htmlFor="cancellationPolicyId">
                    {ht(
                      "Cancellation policy"
                    )}
                  </label>

                  <select
                    id="cancellationPolicyId"
                    value={
                      form.cancellationPolicyId
                    }
                    onChange={(event) =>
                      setForm({
                        ...form,
                        cancellationPolicyId:
                          event.target
                            .value,
                      })
                    }
                  >
                    <option value="">
                      {ht(
                        "Select a cancellation policy"
                      )}
                    </option>

                    {cancellationPolicies.map(
                      (policy) => (
                        <option
                          key={
                            policy.id
                          }
                          value={
                            policy.id
                          }
                        >
                          {ht(
                            policy.name
                          )}
                        </option>
                      )
                    )}
                  </select>

                  {(selectedPolicy?.description ||
                    property
                      .cancellationPolicy
                      ?.description) && (
                    <p className="field-note">
                      {ht(
                        selectedPolicy?.description ??
                          property
                            .cancellationPolicy
                            ?.description ??
                          ""
                      )}
                    </p>
                  )}
                </div>
              </div>

              <div className="card">
                <h2>
                  {ht("Check-in")}
                </h2>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="checkInTime">
                      {ht(
                        "Check-in time"
                      )}
                    </label>

                    <input
                      id="checkInTime"
                      type="time"
                      value={
                        form.checkInTime
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          checkInTime:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="checkOutTime">
                      {ht(
                        "Check-out time"
                      )}
                    </label>

                    <input
                      id="checkOutTime"
                      type="time"
                      value={
                        form.checkOutTime
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          checkOutTime:
                            event.target
                              .value,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="field full">
                  <label htmlFor="houseRules">
                    {ht(
                      "House rules"
                    )}
                  </label>

                  <textarea
                    id="houseRules"
                    value={
                      form.houseRules
                    }
                    onChange={(event) =>
                      setForm({
                        ...form,
                        houseRules:
                          event.target
                            .value,
                      })
                    }
                  />
                </div>
              </div>

              {allAmenities.length >
                0 && (
                <div className="card">
                  <h2>
                    {ht("Amenities")}
                  </h2>

                  <div className="amenity-grid">
                    {allAmenities.map(
                      (amenity) => (
                        <label
                          className="amenity-item"
                          key={
                            amenity.id
                          }
                        >
                          <input
                            type="checkbox"
                            checked={selectedAmenities.has(
                              amenity.id
                            )}
                            onChange={() =>
                              toggleAmenity(
                                amenity.id
                              )
                            }
                          />

                          {ht(
                            amenity.name
                          )}
                        </label>
                      )
                    )}
                  </div>
                </div>
              )}

              <button
                type="submit"
                className="btn-primary"
                disabled={saving}
              >
                {saving
                  ? ht("Saving…")
                  : ht(
                      "Save changes"
                    )}
              </button>
            </form>

            <div
              className="wrap"
              style={{ paddingTop: 0 }}
            >
              <div className="card">
                <h2>
                  {ht("Availability")}
                </h2>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="blockFrom">
                      {ht("From")}
                    </label>

                    <input
                      id="blockFrom"
                      type="date"
                      value={blockFrom}
                      onChange={(event) =>
                        setBlockFrom(
                          event.target
                            .value
                        )
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="blockTo">
                      {ht("To")}
                    </label>

                    <input
                      id="blockTo"
                      type="date"
                      value={blockTo}
                      onChange={(event) =>
                        setBlockTo(
                          event.target
                            .value
                        )
                      }
                    />
                  </div>
                </div>

                {availabilityMessage && (
                  <div className="success-box">
                    {
                      availabilityMessage
                    }
                  </div>
                )}

                <div className="actions-row">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      handleAvailabilityAction(
                        "block"
                      )
                    }
                    disabled={
                      availabilityBusy
                    }
                  >
                    {ht(
                      "Block these dates"
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      handleAvailabilityAction(
                        "unblock"
                      )
                    }
                    disabled={
                      availabilityBusy
                    }
                  >
                    {ht(
                      "Unblock these dates"
                    )}
                  </button>
                </div>

                {blockedDates.length >
                  0 && (
                  <>
                    <p
                      style={{
                        color:
                          "var(--warm-grey)",
                        fontSize: 12,
                        marginBottom: 10,
                        marginTop: 20,
                      }}
                    >
                      {ht(
                        "Upcoming availability — grey means manually blocked, gold means booked by a guest:"
                      )}
                    </p>

                    <AvailabilityCalendar
                      hostBlockedDates={
                        new Set(
                          blockedDates
                            .filter(
                              (day) =>
                                day.source ===
                                "host"
                            )
                            .map(
                              (day) =>
                                day.date
                            )
                        )
                      }
                      calendarBlockedDates={
                        new Set(
                          blockedDates
                            .filter(
                              (day) =>
                                day.source ===
                                "ical_sync"
                            )
                            .map(
                              (day) =>
                                day.date
                            )
                        )
                      }
                      bookedDates={
                        new Set(
                          blockedDates
                            .filter(
                              (day) =>
                                day.source ===
                                "booking"
                            )
                            .map(
                              (day) =>
                                day.date
                            )
                        )
                      }
                      interactive={false}
                    />
                  </>
                )}

                {propertyId && (
                  <CalendarSyncPanel
                    propertyId={propertyId}
                    onAvailabilityChanged={
                      loadAvailability
                    }
                  />
                )}
              </div>
            </div>
            {propertyId && (
              <>
                <ListingReadinessPanel propertyId={propertyId} />
                <PropertyImageManager propertyId={propertyId} />
              </>
            )}
          </>
        )}
    </div>
  );
}