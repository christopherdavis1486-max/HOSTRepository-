"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { AvailabilityCalendar } from "@/components/AvailabilityCalendar";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type Amenity = { id: string; name: string; slug: string };
type PropertyDetail = {
  id: string; name: string; slug: string | null; description: string | null;
  city: string; district: string | null; countryCode: string | null; propertyType: string | null; status: string;
  currency: string; nightlyPrice: string | number; cleaningFee: string | number | null;
  maxGuests: number; bedrooms: number | null; bathrooms: number | null;
  checkInTime: string | null; checkOutTime: string | null; houseRules: string | null;
  amenities: Amenity[];
  cancellationPolicy: { name: string; description: string | null; rules: unknown } | null;
  complianceStatus: string;
};
type AvailabilityDay = { date: string; status: string; source: string };
type State = "loading" | "unauthenticated" | "forbidden" | "notFound" | "error" | "loaded";

/**
 * The single real management page for one property — read + edit +
 * amenities + status + availability + a preview link, all in one place
 * per the batch brief's "practical management page" framing, rather
 * than splitting these into several separate pages.
 */
export default function HostPropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ht, hStatus } = useHostI18n();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [property, setProperty] = useState<PropertyDetail | null>(null);
  const [allAmenities, setAllAmenities] = useState<Amenity[]>([]);
  const [selectedAmenities, setSelectedAmenities] = useState<Set<string>>(new Set());
  const [state, setState] = useState<State>("loading");

  const [form, setForm] = useState({
    name: "", propertyType: "", description: "", city: "", district: "", countryCode: "",
    maxGuests: 1, bedrooms: 0, bathrooms: 1, nightlyPrice: 0, cleaningFee: 0,
    checkInTime: "15:00", checkOutTime: "11:00", houseRules: "", status: "draft",
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [availability, setAvailability] = useState<AvailabilityDay[]>([]);
  const [blockFrom, setBlockFrom] = useState("");
  const [blockTo, setBlockTo] = useState("");
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(null);

  useEffect(() => { params.then(({ id }) => setPropertyId(id)); }, [params]);

  const loadProperty = () => {
    if (!propertyId) return;
    fetch(`/api/host/properties/${propertyId}`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        if (res.status === 404) { setState("notFound"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        const p: PropertyDetail = data.property;
        setProperty(p);
        setForm({
          name: p.name, propertyType: p.propertyType ?? "", description: p.description ?? "",
          city: p.city, district: p.district ?? "", countryCode: p.countryCode ?? "",
          maxGuests: p.maxGuests, bedrooms: p.bedrooms ?? 0, bathrooms: Number(p.bathrooms ?? 1),
          nightlyPrice: Number(p.nightlyPrice), cleaningFee: Number(p.cleaningFee ?? 0),
          checkInTime: p.checkInTime ?? "15:00", checkOutTime: p.checkOutTime ?? "11:00",
          houseRules: p.houseRules ?? "", status: p.status,
        });
        setSelectedAmenities(new Set(p.amenities.map((a) => a.id)));
        setState("loaded");
      })
      .catch(() => setState("error"));
  };

  useEffect(loadProperty, [propertyId]);

  useEffect(() => {
    fetch("/api/host/amenities", { credentials: "include" }).then(async (res) => {
      const data = await res.json();
      if (data.success) setAllAmenities(data.amenities);
    }).catch(() => {});
  }, []);

  const loadAvailability = () => {
    if (!propertyId) return;
    fetch(`/api/host/properties/${propertyId}/availability`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { if (data.success) setAvailability(data.availability); })
      .catch(() => {});
  };
  useEffect(loadAvailability, [propertyId]);

  const toggleAmenity = (id: string) => {
    setSelectedAmenities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(false);

    if (!form.name.trim()) { setSaveError("Property name is required."); return; }
    if (!form.city.trim()) { setSaveError("City is required."); return; }
    if (form.nightlyPrice <= 0) { setSaveError("Nightly price must be greater than zero."); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/host/properties/${propertyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...form, amenityIds: Array.from(selectedAmenities) }),
      });
      const data = await res.json();
      if (!data.success) {
        setSaveError(data.error?.message ?? "Couldn't save changes. Please check the details and try again.");
        setSaving(false);
        return;
      }
      setSaveSuccess(true);
      setSaving(false);
      loadProperty(); // reload with backend-confirmed state, not just the locally-submitted form
    } catch {
      setSaveError("Something went wrong reaching the server. Please try again.");
      setSaving(false);
    }
  };

  const handleAvailabilityAction = async (action: "block" | "unblock") => {
    if (!blockFrom || !blockTo) { setAvailabilityMessage("Select both a start and end date."); return; }
    setAvailabilityBusy(true);
    setAvailabilityMessage(null);
    try {
      const res = await fetch(`/api/host/properties/${propertyId}/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action, checkIn: blockFrom, checkOut: blockTo }),
      });
      const data = await res.json();
      if (!data.success) {
        setAvailabilityMessage(data.error?.message ?? "Couldn't update availability.");
      } else {
        const skippedNote = data.skipped?.length > 0 ? ` (${data.skipped.length} date${data.skipped.length === 1 ? "" : "s"} skipped — already booked)` : "";
        setAvailabilityMessage(`${action === "block" ? "Blocked" : "Unblocked"} ${data.blocked.length} date${data.blocked.length === 1 ? "" : "s"}${skippedNote}.`);
        loadAvailability();
      }
    } catch {
      setAvailabilityMessage("Something went wrong reaching the server.");
    }
    setAvailabilityBusy(false);
  };

  const blockedDates = availability.filter((d) => d.status !== "available");

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
        .state-block { max-width: 640px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
        .btn-secondary { background: transparent; border: 1px solid var(--stone); color: var(--ivory); padding: 11px 18px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block; }

        .header { max-width: 720px; margin: 0 auto; padding: 8px 28px 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
        .header h1 { font-size: 24px; font-weight: 400; }
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
        .success-box { background: rgba(201,151,75,0.1); border: 1px solid var(--brass); color: var(--brass); padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
        .actions-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .date-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
        .date-tag { font-size: 11px; padding: 4px 8px; border-radius: 4px; background: var(--ink); border: 1px solid var(--stone); color: var(--warm-grey); }
        .date-tag.booking { color: var(--brass); border-color: var(--brass); }
      `}</style>

      <div className="top-link"><a href="/host/properties">← {ht("Back to Properties")}</a></div>

      {state === "loading" && <div className="state-block">{ht("Loading property…")}</div>}
      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent(`/host/properties/${propertyId ?? ""}`)}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}
      {(state === "forbidden" || state === "notFound") && <div className="state-block">{ht("This property isn't available.")}</div>}
      {state === "error" && <div className="state-block">{ht("Something went wrong loading this property. Please try again shortly.")}</div>}

      {state === "loaded" && property && (
        <>
          <div className="header">
            <h1 className="display">{property.name}</h1>
            {property.slug && (
              <a href={`/stays/${property.slug}`} target="_blank" rel="noopener noreferrer" className="btn-secondary">{ht("Preview listing")} →</a>
            )}
          </div>
          <HostNav active="properties" />

          <div className="wrap" style={{ paddingBottom: 0 }}>
            <div className="card">
              <h2>{ht("Property compliance")}</h2>
              <p style={{ color: "var(--warm-grey)", lineHeight: 1.6 }}>{ht("Status")}: <strong style={{ color: "var(--ivory)" }}>{hStatus(property.complianceStatus)}</strong>. {ht("Complete the owner declarations and evidence review before publishing.")}</p>
              <a className="btn-secondary" href={`/host/properties/${property.id}/compliance`}>{ht("Manage compliance")} →</a>
            </div>
          </div>

          <form className="wrap" onSubmit={handleSave}>
            {saveError && <div className="error-box">{saveError}</div>}
            {saveSuccess && <div className="success-box">{ht("Changes saved.")}</div>}

            <div className="card">
              <h2>{ht("Listing status")}</h2>
              <div className="field">
                <label htmlFor="status">{ht("Status")}</label>
                <select id="status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="draft">{ht("Draft — not visible to guests")}</option>
                  <option value="published">{ht("Published — live and bookable")}</option>
                  <option value="paused">{ht("Paused — temporarily hidden")}</option>
                </select>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Basics")}</h2>
              <div className="field full"><label htmlFor="name">{ht("Property name")}</label><input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="field-grid">
                <div className="field"><label htmlFor="propertyType">{ht("Property type")}</label><input id="propertyType" value={form.propertyType} onChange={(e) => setForm({ ...form, propertyType: e.target.value })} /></div>
                <div className="field"><label htmlFor="countryCode">{ht("Country code")}</label><input id="countryCode" value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} maxLength={2} /></div>
                <div className="field"><label htmlFor="city">{ht("City")}</label><input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
                <div className="field"><label htmlFor="district">{ht("District")}</label><input id="district" value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} /></div>
              </div>
              <div className="field full"><label htmlFor="description">{ht("Description")}</label><textarea id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            </div>

            <div className="card">
              <h2>{ht("Capacity")}</h2>
              <div className="field-grid cols-3">
                <div className="field"><label htmlFor="maxGuests">{ht("Max guests")}</label><input id="maxGuests" type="number" min={1} value={form.maxGuests} onChange={(e) => setForm({ ...form, maxGuests: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="bedrooms">{ht("Bedrooms")}</label><input id="bedrooms" type="number" min={0} value={form.bedrooms} onChange={(e) => setForm({ ...form, bedrooms: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="bathrooms">{ht("Bathrooms")}</label><input id="bathrooms" type="number" min={0} step={0.5} value={form.bathrooms} onChange={(e) => setForm({ ...form, bathrooms: Number(e.target.value) })} /></div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Pricing")}</h2>
              <div className="field-grid">
                <div className="field"><label htmlFor="nightlyPrice">{ht("Base nightly price")}</label><input id="nightlyPrice" type="number" min={0} step={0.01} value={form.nightlyPrice} onChange={(e) => setForm({ ...form, nightlyPrice: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="cleaningFee">{ht("Cleaning fee")}</label><input id="cleaningFee" type="number" min={0} step={0.01} value={form.cleaningFee} onChange={(e) => setForm({ ...form, cleaningFee: Number(e.target.value) })} /></div>
              </div>
            </div>

            <div className="card">
              <h2>{ht("Check-in")}</h2>
              <div className="field-grid">
                <div className="field"><label htmlFor="checkInTime">{ht("Check-in time")}</label><input id="checkInTime" type="time" value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} /></div>
                <div className="field"><label htmlFor="checkOutTime">{ht("Check-out time")}</label><input id="checkOutTime" type="time" value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} /></div>
              </div>
              <div className="field full"><label htmlFor="houseRules">{ht("House rules")}</label><textarea id="houseRules" value={form.houseRules} onChange={(e) => setForm({ ...form, houseRules: e.target.value })} /></div>
            </div>

            {allAmenities.length > 0 && (
              <div className="card">
                <h2>{ht("Amenities")}</h2>
                <div className="amenity-grid">
                  {allAmenities.map((a) => (
                    <label className="amenity-item" key={a.id}>
                      <input type="checkbox" checked={selectedAmenities.has(a.id)} onChange={() => toggleAmenity(a.id)} />
                      {ht(a.name)}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button type="submit" className="btn-primary" disabled={saving}>{saving ? ht("Saving…") : ht("Save changes")}</button>
          </form>

          <div className="wrap" style={{ paddingTop: 0 }}>
            <div className="card">
              <h2>{ht("Availability")}</h2>
              <div className="field-grid">
                <div className="field"><label htmlFor="blockFrom">{ht("From")}</label><input id="blockFrom" type="date" value={blockFrom} onChange={(e) => setBlockFrom(e.target.value)} /></div>
                <div className="field"><label htmlFor="blockTo">{ht("To")}</label><input id="blockTo" type="date" value={blockTo} onChange={(e) => setBlockTo(e.target.value)} /></div>
              </div>
              {availabilityMessage && <div className="success-box">{availabilityMessage}</div>}
              <div className="actions-row">
                <button type="button" className="btn-secondary" onClick={() => handleAvailabilityAction("block")} disabled={availabilityBusy}>{ht("Block these dates")}</button>
                <button type="button" className="btn-secondary" onClick={() => handleAvailabilityAction("unblock")} disabled={availabilityBusy}>{ht("Unblock these dates")}</button>
              </div>

              {blockedDates.length > 0 && (
                <>
                  <p style={{ fontSize: 12, color: "var(--warm-grey)", marginTop: 20, marginBottom: 10 }}>
                    {ht("Upcoming availability — grey means manually blocked, gold means booked by a guest:")}
                  </p>
                  <AvailabilityCalendar
                    hostBlockedDates={new Set(blockedDates.filter((d) => d.source === "host").map((d) => d.date))}
                    bookedDates={new Set(blockedDates.filter((d) => d.source === "booking").map((d) => d.date))}
                    interactive={false}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
