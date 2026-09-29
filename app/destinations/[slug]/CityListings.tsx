"use client";

import { useEffect, useState } from "react";
import styles from "../destinations.module.css";

type Property = {
  id: string;
  slug: string | null;
  name: string;
  city: string;
  district: string | null;
  nightly_price: string | number;
  currency: string;
  coverImage: { url: string; altText: string | null } | null;
};

type ListingState = "loading" | "ready" | "error";

export function CityListings({ city }: { city: string }) {
  const [state, setState] = useState<ListingState>("loading");
  const [properties, setProperties] = useState<Property[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    fetch(`/api/properties?city=${encodeURIComponent(city)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load stays");
        const data = await response.json();
        if (!data.success || !Array.isArray(data.properties)) throw new Error("Unable to load stays");
        setProperties(data.properties);
        setState("ready");
      })
      .catch((error) => { if (error.name !== "AbortError") setState("error"); });
    return () => controller.abort();
  }, [city]);

  return (
    <section className={styles.content} aria-live="polite">
      {state === "loading" && <p className={styles.muted}>Finding stays in {city}…</p>}
      {state === "error" && <p className={styles.muted}>We couldn’t load stays right now. Please try again shortly.</p>}
      {state === "ready" && properties.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.eyebrow}>The collection</span>
          <h2>Coming soon to {city}</h2>
          <p>We’re preparing a collection of independent places to stay. Explore another city while we get ready.</p>
          <a href="/destinations" className={styles.button}>Browse destinations</a>
        </div>
      )}
      {state === "ready" && properties.length > 0 && (
        <>
          <div className={styles.heading}><span className={styles.eyebrow}>The collection</span><h2>Stay in {city}</h2><p>{properties.length} {properties.length === 1 ? "place" : "places"} to discover</p></div>
          <div className={styles.listings}>
            {properties.map((property) => (
              <a className={styles.stay} href={`/stays/${encodeURIComponent(property.slug ?? property.id)}`} key={property.id}>
                <div className={styles.stayImage}>
                  {property.coverImage ? <img src={property.coverImage.url} alt={property.coverImage.altText || property.name} loading="lazy" /> : <span>{property.city}</span>}
                </div>
                <div className={styles.stayText}><h3>{property.name}</h3><p>{property.district ? `${property.district}, ` : ""}{property.city}</p><span>From {property.currency} {Number(property.nightly_price).toFixed(0)} / night</span></div>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
