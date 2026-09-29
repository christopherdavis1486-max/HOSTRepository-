/** The city cards and destination pages share this list, so every link has a page. */
export const DESTINATIONS = [
  { city: "Lisbon", slug: "lisbon", country: "Portugal", note: "Riverside light and tiled facades", image: "/destinations/lisbon.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Lisbon_panorama_from_the_Bairro_Alto.jpg", imageCredit: "Dudva" },
  { city: "Copenhagen", slug: "copenhagen", country: "Denmark", note: "Considered design, canal-side calm", image: "/destinations/copenhagen.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Nyhavn_Copenhagen.jpg", imageCredit: "Matteosalvador" },
  { city: "Prague", slug: "prague", country: "Czechia", note: "Spires, courtyards, old-world scale", image: "/destinations/prague-v2.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Prague_Castle_and_Charles_Bridge_over_Vltava.jpg", imageCredit: "Mattsjc" },
  { city: "Porto", slug: "porto", country: "Portugal", note: "Terraced hills above the Douro", image: "/destinations/porto.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:The_Ribeira_area,_in_evening,_Porto.jpg", imageCredit: "Peter K Burian" },
  { city: "Barcelona", slug: "barcelona", country: "Spain", note: "Modernist façades, Mediterranean light", image: "/destinations/barcelona-v3.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Barcelona_city_view_at_sunset.jpg", imageCredit: "Walkerssk", imageLicense: "CC0 1.0", imageLicenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" },
  { city: "Amsterdam", slug: "amsterdam", country: "Netherlands", note: "Canal houses and quiet mornings", image: "/destinations/amsterdam.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Canal_houses_Nieuwmarkt_Amsterdam.jpg", imageCredit: "Kamanasish Debnath" },
  { city: "Milan", slug: "milan", country: "Italy", note: "Grand piazzas and considered style", image: "/destinations/milan.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Milan_Cathedral,_Italy.jpg", imageCredit: "Ali Murtaza Subhani" },
  { city: "Paris", slug: "paris", country: "France", note: "Boulevards, galleries and the Seine", image: "/destinations/paris-v2.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Panorama_of_the_Eiffel_Tower_in_July_2022.jpg", imageCredit: "DiscoA340" },
  { city: "London", slug: "london", country: "United Kingdom", note: "Neighbourhoods with a character of their own", image: "/destinations/london-v2.jpg", imageSource: "https://commons.wikimedia.org/wiki/File:Tower_Bridge-London,_England,_United_Kingdom.jpg", imageCredit: "Shawn M. Kent" },
] as const;

export type Destination = (typeof DESTINATIONS)[number];
export function findDestination(slug: string) {
  return DESTINATIONS.find((destination) => destination.slug === slug.toLowerCase());
}
