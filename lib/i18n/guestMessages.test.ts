import test from "node:test";
import assert from "node:assert/strict";
import { guestDictionary } from "./guestMessages";

test("Batch 12B supplies German and French guest-journey translations", () => {
  assert.equal(guestDictionary("de").myTrips, "Meine Reisen");
  assert.equal(guestDictionary("fr").completeBooking, "Finaliser votre réservation");
  assert.notEqual(guestDictionary("de").loadStaysError, guestDictionary("en").loadStaysError);
});

test("Batch 12C supplies Spanish, Italian and Dutch guest-journey translations", () => {
  assert.equal(guestDictionary("es").myTrips, "Mis viajes");
  assert.equal(guestDictionary("it").completeBooking, "Completa prenotazione");
  assert.equal(guestDictionary("nl").reviewsHeading, "Beoordelingen");
  assert.notEqual(guestDictionary("es").loadStaysError, guestDictionary("en").loadStaysError);
});

test("binding cancellation content remains identified as authoritative English", () => {
  assert.match(guestDictionary("de").cancellationPolicy, /authoritative English/);
  assert.match(guestDictionary("fr").cancellationPolicy, /authoritative English/);
  assert.match(guestDictionary("es").cancellationPolicy, /authoritative English/);
  assert.match(guestDictionary("it").cancellationPolicy, /authoritative English/);
  assert.match(guestDictionary("nl").cancellationPolicy, /authoritative English/);
});
