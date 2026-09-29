import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomerNav } from "@/components/CustomerNav";
import { SiteFooter } from "@/components/SiteFooter";
import { DESTINATIONS, findDestination } from "@/lib/destinations";
import { CityListings } from "./CityListings";
import styles from "../destinations.module.css";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return DESTINATIONS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const destination = findDestination(slug);
  if (!destination) return { title: "Destination not found | HOST" };
  return {
    title: `Stays in ${destination.city} | HOST`,
    description: `Discover independent stays in ${destination.city}, ${destination.country}, on HOST.`,
    alternates: { canonical: `/destinations/${destination.slug}` },
  };
}

export default async function DestinationPage({ params }: PageProps) {
  const { slug } = await params;
  const destination = findDestination(slug);
  if (!destination) notFound();

  return (
    <div className={styles.page}>
      <CustomerNav />
      <main>
        <div className={styles.hero} style={{ backgroundImage: `linear-gradient(90deg, rgba(20,18,14,.88), rgba(20,18,14,.28)), url("${destination.image}")` }}>
          <div className={styles.heroContent}>
            <a className={styles.back} href="/destinations">All destinations</a>
            <span className={styles.eyebrow}>{destination.country}</span>
            <h1>{destination.city}</h1>
            <p>{destination.note}</p>
          </div>
        </div>
        <div className={styles.credit}>
          Photo: <a href={destination.imageSource} target="_blank" rel="noopener noreferrer">{destination.imageCredit}</a>
          {" · "}<a href={"imageLicenseUrl" in destination ? destination.imageLicenseUrl : "https://creativecommons.org/licenses/by-sa/4.0/"} target="_blank" rel="noopener noreferrer">{"imageLicense" in destination ? destination.imageLicense : "CC BY-SA 4.0"}</a>
          {" · display cropped"}
        </div>
        <CityListings city={destination.city} />
      </main>
      <SiteFooter />
    </div>
  );
}
