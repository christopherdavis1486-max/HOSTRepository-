"use client";

import { useRef, useState } from "react";
import { formatCurrency } from "@/lib/presentation/formatters";
import type { PublicRoomType } from "./HotelBookingPanel";
import { AmenitySymbols } from "./AmenitySymbols";
import styles from "./HotelRoomGallery.module.css";

export function HotelRoomGallery({ rooms, currency, amenities = [], selectedRoomId, onChooseRoom, busy = false }: {
  rooms: PublicRoomType[];
  currency: string;
  amenities?: { name: string; slug: string }[];
  selectedRoomId: string;
  onChooseRoom: (id: string) => void;
  busy?: boolean;
}) {
  const [detailRoom, setDetailRoom] = useState<PublicRoomType | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const nightlyPrice = (room: PublicRoomType) => formatCurrency(Math.round(Number(room.nightlyPrice) * 100), currency);

  function openDetails(room: PublicRoomType, button: HTMLButtonElement) {
    opener.current = button;
    setDetailRoom(room);
    dialog.current?.showModal();
  }

  function chooseRoom(room: PublicRoomType) {
    onChooseRoom(room.id);
    dialog.current?.close();
    // Wait until native dialog close has restored focus before moving to booking.
    requestAnimationFrame(() => {
      const panel = document.getElementById("hotel-booking-panel");
      panel?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      panel?.focus({ preventScroll: true });
    });
  }

  if (!rooms.length) return null;
  return <section className={styles.section} aria-labelledby="hotel-rooms-heading">
    <h2 id="hotel-rooms-heading">Find your room</h2>
    <p className={styles.intro}>Compare room types, then choose one for your stay. You can reserve more than one room of the same type.</p>
    <div className={styles.cards}>
      {rooms.map(room => <article key={room.id} className={`${styles.card} ${selectedRoomId === room.id ? styles.selected : ""}`}>
        <button type="button" className={styles.cardSelect} disabled={busy} onClick={() => onChooseRoom(room.id)} onDoubleClick={e => openDetails(room, e.currentTarget)} aria-label={`Choose ${room.name}`} aria-pressed={selectedRoomId === room.id} />
        <div className={styles.photoButton}>
          {room.images[0] ? <img src={room.images[0].url} alt={room.images[0].altText ?? room.name} loading="lazy" /> : <span className={styles.noPhoto}>Room photos coming soon</span>}
          {room.images.length > 1 && <span className={styles.photoCount}>{room.images.length} photos</span>}
        </div>
        <div className={styles.cardBody}>
          <div className={styles.cardHeading}><h3>{room.name}</h3>{selectedRoomId === room.id && <span className={styles.badge}>Selected</span>}</div>
          <p className={styles.capacity}>Up to {room.maxGuests} guests per room</p>
          <p className={styles.description}>{room.description}</p>
          <p className={styles.price}>From <strong>{nightlyPrice(room)}</strong><span> per room / night</span></p>
          <div className={styles.actions}>
            <button type="button" className={styles.detailsButton} onClick={e => openDetails(room, e.currentTarget)}>Room details</button>
            <button type="button" className={styles.chooseButton} disabled={busy} onClick={() => chooseRoom(room)}>Choose this room</button>
          </div>
        </div>
      </article>)}
    </div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="room-detail-title" onClose={() => opener.current?.focus()} onClick={e => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) e.currentTarget.close(); } }}>
      {detailRoom && <>
        <div className={styles.dialogHeader}><h2 id="room-detail-title">{detailRoom.name}</h2><button type="button" className={styles.closeButton} onClick={() => dialog.current?.close()} aria-label="Close room details" autoFocus>×</button></div>
        <div className={styles.dialogBody}>
          {detailRoom.images.length > 0 && <div className={styles.gallery}>{detailRoom.images.map(photo => <img key={photo.id} src={photo.url} alt={photo.altText ?? detailRoom.name} loading="lazy" />)}</div>}
          <p className={styles.capacity}>Up to {detailRoom.maxGuests} guests per room</p>
          <p className={styles.fullDescription}>{detailRoom.description}</p>
          {Number(detailRoom.cleaningFee) > 0 && <p className={styles.capacity}>Cleaning: {formatCurrency(Math.round(Number(detailRoom.cleaningFee) * 100), currency)} per room / stay</p>}
          {amenities.length > 0 && <section className={styles.amenities} aria-labelledby="hotel-amenities-heading"><h3 id="hotel-amenities-heading">Hotel amenities</h3><p>Features listed by the host for this property. Room-specific facilities are described above.</p><AmenitySymbols amenities={amenities} /></section>}
          <p className={styles.intro}>Availability and the final total are checked using your dates and room quantity.</p>
        </div>
        <div className={styles.dialogFooter}><p className={styles.price}>From <strong>{nightlyPrice(detailRoom)}</strong><span> per room / night</span><small className={styles.reserveNote}>Choose dates and check the total next</small></p><button type="button" className={styles.chooseButton} disabled={busy} onClick={() => chooseRoom(detailRoom)}>Reserve this room</button></div>
      </>}
    </dialog>
  </section>;
}
