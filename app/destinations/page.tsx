import type { Metadata } from "next";
import Image from "next/image";
import { CustomerNav } from "@/components/CustomerNav";
import { SiteFooter } from "@/components/SiteFooter";
import { DESTINATIONS } from "@/lib/destinations";
import styles from "./destinations.module.css";

export const metadata: Metadata = {
  title: "Browse destinations | HOST",
  description: "Explore independent stays in Europe's most captivating cities.",
  alternates: { canonical: "/destinations" },
};

export default async function DestinationsPage({searchParams}:{searchParams:Promise<{propertyType?:string}>}) {
  const query=await searchParams;
  const propertyType=["Apartment","House","Hotel","Aparthotel"].includes(query.propertyType??"")?query.propertyType:"";
  return <div className={styles.page}>
    <CustomerNav />
    <main className={styles.content}>
      <div className={styles.heading}><span className={styles.eyebrow}>Where to next</span><h1>Browse destinations</h1><p>Discover a city that stays with you.</p></div>
      <form method="get" className={styles.browseForm}>
        <label htmlFor="destination-city" className={styles.browseField}>
          City
          <input id="destination-city" name="city" type="search" placeholder="Search a city, e.g. Liverpool" maxLength={100} />
        </label>
        <label htmlFor="destination-type" className={styles.browseField}>
          Accommodation type
          <select id="destination-type" name="propertyType" defaultValue={propertyType}>
            <option value="">All accommodation</option>
            <option>Apartment</option><option>House</option><option>Hotel</option><option>Aparthotel</option>
          </select>
        </label>
        <button type="submit" formAction="/search" className={styles.searchButton}>Search stays</button>
        <button type="submit" formAction="/destinations" className={styles.browseButton}>Browse featured cities</button>
      </form>
      <p className={styles.searchHint}>Search any city, or explore our featured destinations below.</p>
      <div className={styles.destinations}>
        {DESTINATIONS.map((destination) => <div className={styles.destination} key={destination.slug}>
          <a href={`/destinations/${destination.slug}${propertyType?`?propertyType=${encodeURIComponent(propertyType)}`:""}`} className={styles.destinationLink} aria-label={`Explore ${destination.city}`}>
            <div className={styles.destinationImage}><Image src={destination.image} alt={`${destination.city} city view`} fill sizes="(max-width: 600px) 100vw, (max-width: 960px) 50vw, 33vw" style={{ objectFit: "cover" }} /></div>
            <div className={styles.destinationText}><span className={styles.eyebrow}>{destination.country}</span><h2>{destination.city}</h2><p>{destination.note}</p></div>
          </a>
          <div className={styles.smallCredit}>Photo: <a href={destination.imageSource} target="_blank" rel="noopener noreferrer">{destination.imageCredit}</a>{" · "}<a href={"imageLicenseUrl" in destination ? destination.imageLicenseUrl : "https://creativecommons.org/licenses/by-sa/4.0/"} target="_blank" rel="noopener noreferrer">{"imageLicense" in destination ? destination.imageLicense : "CC BY-SA 4.0"}</a>{" · display cropped"}</div>
        </div>)}
      </div>
    </main>
    <SiteFooter />
  </div>;
}
