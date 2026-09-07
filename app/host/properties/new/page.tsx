"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type Amenity = { id: string; name: string; slug: string };
type State = "checking" | "unauthenticated" | "forbidden" | "ready";

export default function NewPropertyPage() {
  const { ht } = useHostI18n();
  const [state, setState] = useState<State>("checking");
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [selectedAmenities, setSelectedAmenities] = useState<Set<string>>(new Set());

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
  const [checkInTime, setCheckInTime] = useState("15:00");
  const [checkOutTime, setCheckOutTime] = useState("11:00");
  const [houseRules, setHouseRules] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/host/amenities", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        const data = await res.json();
        if (data.success) setAmenities(data.amenities);
        setState("ready");
      })
      .catch(() => setState("ready"));
  }, []);

  const toggleAmenity = (id: string) => {
    setSelectedAmenities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client-side checks are convenience only — POST /api/host/properties
    // validates authoritatively via createPropertySchema; nothing here
    // replaces that.
    if (!name.trim()) { setError("Property name is required."); return; }
    if (!city.trim()) { setError("City is required."); return; }
    if (nightlyPrice <= 0) { setError("Nightly price must be greater than zero."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/host/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name, propertyType: propertyType || undefined, description: description || undefined,
          city, district: district || undefined, countryCode: countryCode || undefined,
          maxGuests, bedrooms, bathrooms, nightlyPrice, cleaningFee: cleaningFee || undefined,
          checkInTime, checkOutTime, houseRules: houseRules || undefined,
          amenityIds: Array.from(selectedAmenities),
          status: "draft",
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Couldn't create the property. Please check the details and try again.");
        setSubmitting(false);
        return;
      }
      window.location.href = `/host/properties/${data.propertyId}`;
    } catch {
      setError("Something went wrong reaching the server. Please try again.");
      setSubmitting(false);
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
          --ink: #14120E; --graphite: #1F1B15; --stone: #2A251C;
          --ivory: #F2ECDE; --warm-grey: #A79E8C; --brass: #C9974B; --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink); color: var(--ivory); min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }
        .top-link { display: block; padding: 24px 28px 0; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .header { max-width: 720px; margin: 0 auto; padding: 8px 28px 20px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 720px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 720px; margin: 0 auto; padding: 8px 28px 80px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin-bottom: 20px; }
        .card h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 16px; }
        .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .field-grid.cols-3 { grid-template-columns: 1fr 1fr 1fr; }
        .field { margin-bottom: 14px; }
        .field.full { grid-column: 1 / -1; }
        .field label { display: block; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .field input, .field textarea, .field select { width: 100%; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 10px 12px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; color-scheme: dark; }
        .field textarea { resize: vertical; min-height: 80px; }
        .field input:focus, .field textarea:focus, .field select:focus { outline: none; border-color: var(--brass); }
        .amenity-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        @media (max-width: 600px) { .amenity-grid, .field-grid, .field-grid.cols-3 { grid-template-columns: 1fr; } }
        .amenity-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--warm-grey); }
        .amenity-item input { width: auto; }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
        .submit-row { display: flex; gap: 12px; align-items: center; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
      `}</style>

      <div className="top-link"><a href="/host/properties">← {ht("Back to Properties")}</a></div>

      {state === "checking" && <div className="state-block">{ht("Loading…")}</div>}
      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/host/properties/new")}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}
      {state === "forbidden" && <div className="state-block">{ht("This account doesn't have host access.")}</div>}

      {state === "ready" && (
        <>
          <div className="header"><h1 className="display">{ht("Add property")}</h1></div>
          <HostNav active="properties" />

          <form className="wrap" onSubmit={handleSubmit}>
            {error && <div className="error-box">{error}</div>}

            <div className="card">
              <h2>{ht("Basics")}</h2>
              <div className="field full">
                <label htmlFor="name">{ht("Property name")}</label>
                <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="propertyType">{ht("Property type")}</label>
                  <input id="propertyType" value={propertyType} onChange={(e) => setPropertyType(e.target.value)} placeholder={ht("Apartment, House…")} />
                </div>
                <div className="field">
                  <label htmlFor="countryCode">{ht("Country code")}</label>
                  <input id="countryCode" value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} maxLength={2} />
                </div>
                <div className="field">
                  <label htmlFor="city">{ht("City")}</label>
                  <input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="district">{ht("District")}</label>
                  <input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
                </div>
              </div>
              <div className="field full">
                <label htmlFor="description">{ht("Description")}</label>
                <textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>

            <div className="card">
              <h2>{ht("Capacity")}</h2>
              <div className="field-grid cols-3">
                <div className="field"><label htmlFor="maxGuests">{ht("Max guests")}</label><input id="maxGuests" type="number" min={1} value={maxGuests} onChange={(e) => setMaxGuests(Number(e.target.value))} /></div>
                <div className="field"><label htmlFor="bedrooms">{ht("Bedrooms")}</label><input id="bedrooms" type="number" min={0} value={bedrooms} onChange={(e) => setBedrooms(Number(e.target.value))} /></div>
                <div className="field"><label htmlFor="bathrooms">{ht("Bathrooms")}</label><input id="bathrooms" type="number" min={0} step={0.5} value={bathrooms} onChange={(e) => setBathrooms(Number(e.target.value))} /></div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Pricing")}</h2>
              <div className="field-grid">
                <div className="field"><label htmlFor="nightlyPrice">{ht("Base nightly price")}</label><input id="nightlyPrice" type="number" min={0} step={0.01} value={nightlyPrice} onChange={(e) => setNightlyPrice(Number(e.target.value))} /></div>
                <div className="field"><label htmlFor="cleaningFee">{ht("Cleaning fee")}</label><input id="cleaningFee" type="number" min={0} step={0.01} value={cleaningFee} onChange={(e) => setCleaningFee(Number(e.target.value))} /></div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Check-in")}</h2>
              <div className="field-grid">
                <div className="field"><label htmlFor="checkInTime">{ht("Check-in time")}</label><input id="checkInTime" type="time" value={checkInTime} onChange={(e) => setCheckInTime(e.target.value)} /></div>
                <div className="field"><label htmlFor="checkOutTime">{ht("Check-out time")}</label><input id="checkOutTime" type="time" value={checkOutTime} onChange={(e) => setCheckOutTime(e.target.value)} /></div>
              </div>
              <div className="field full">
                <label htmlFor="houseRules">{ht("House rules")}</label>
                <textarea id="houseRules" value={houseRules} onChange={(e) => setHouseRules(e.target.value)} />
              </div>
            </div>

            {amenities.length > 0 && (
              <div className="card">
                <h2>{ht("Amenities")}</h2>
                <div className="amenity-grid">
                  {amenities.map((a) => (
                    <label className="amenity-item" key={a.id}>
                      <input type="checkbox" checked={selectedAmenities.has(a.id)} onChange={() => toggleAmenity(a.id)} />
                      {ht(a.name)}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="submit-row">
              <button type="submit" className="btn-primary" disabled={submitting} style={{ marginTop: 0 }}>
                {submitting ? ht("Creating…") : ht("Create property")}
              </button>
              <span style={{ fontSize: 13, color: "var(--warm-grey)" }}>{ht("Saved as a draft — you can publish it once you're ready.")}</span>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
