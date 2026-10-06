const paths: Record<string, string> = {
  wifi: "M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0M12 20h.01",
  kitchen: "M4 3v6a3 3 0 0 0 6 0V3M7 3v18M17 3v18M17 3c-4 3-4 9 0 9",
  parking: "M4 3h16v18H4zM9 17V7h4a3 3 0 0 1 0 6H9",
  "air-conditioning": "M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10M9 4l3 3 3-3M9 20l3-3 3 3",
  heating: "M5 15c-2-3 2-4 0-7M12 15c-2-3 2-4 0-7M19 15c-2-3 2-4 0-7M3 20h18",
  "washing-machine": "M4 2h16v20H4zM4 6h16M7 4h.01M10 4h.01M17 14a5 5 0 1 1-10 0 5 5 0 0 1 10 0M8 14c3-3 5 3 8 0",
  dryer: "M4 2h16v20H4zM4 6h16M7 4h.01M17 14a5 5 0 1 1-10 0 5 5 0 0 1 10 0M10 12l4 4M14 12l-4 4",
  tv: "M3 5h18v13H3zM8 22h8M12 18v4",
  workspace: "M2 12h20M4 12v9M20 12v9M6 4h12v8H6z",
  "balcony-terrace": "M3 12h18M3 20h18M5 12v8M10 12v8M15 12v8M20 12v8M8 8V3h8v5",
  garden: "M12 21V10M12 14C3 14 3 4 3 4s9 0 9 10M12 10c0-7 9-7 9-7s0 7-9 7",
  lift: "M3 2h18v20H3zM9 7l-3 3M9 7l3 3M9 7v10M16 17l-3-3M16 17l3-3M16 17V7",
  "wheelchair-accessibility": "M10 3h.01M10 7v7h8l3 6M10 10h6M7 11a6 6 0 1 0 9 7",
};

export function AmenitySymbols({ amenities }: { amenities: { name: string; slug: string }[] }) {
  return <ul style={{ listStyle: "none", padding: 0, margin: "20px 0 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "20px" }}>
    {amenities.map(amenity => <li key={amenity.slug} style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "14px" }}>
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={paths[amenity.slug] ?? "M4 4h16v16H4zM8 12l3 3 5-6"} /></svg>
      <span>{amenity.name}</span>
    </li>)}
  </ul>;
}
