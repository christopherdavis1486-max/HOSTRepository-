import test from "node:test";
import assert from "node:assert/strict";
import { formatHostCurrency, formatHostDate, formatHostStatus, hostDictionary } from "./hostMessages";

test("Batch 12E translates the core host journey",()=>{
  assert.equal(hostDictionary("de")("Bookings"),"Buchungen");
  assert.equal(hostDictionary("fr")("Add property"),"Ajouter un hébergement");
  assert.equal(hostDictionary("es")("Property compliance"),"Cumplimiento del alojamiento");
  assert.equal(hostDictionary("it")("Your payout amount"),"Importo del tuo pagamento");
  assert.equal(hostDictionary("nl")("Upcoming bookings"),"Aankomende boekingen");
});

test("Batch 12E localises host dates, statuses and currency",()=>{
  assert.match(formatHostDate("2027-03-28","de"),/28/);
  assert.equal(formatHostStatus("payment_failed","es"),"Pago fallido");
  assert.match(formatHostCurrency(10000,"GBP","nl"),/100/);
});

test("Batch 12E localises property metadata and amenities",()=>{
  const nl = hostDictionary("nl");
  assert.equal(formatHostStatus("paused","nl"),"Gepauzeerd");
  assert.equal(formatHostStatus("approved","nl"),"Goedgekeurd");
  assert.equal(nl("Apartment"),"Appartement");
  assert.equal(nl("guests"),"gasten");
  assert.equal(nl("beds"),"bedden");
  assert.equal(nl("Air conditioning"),"Airconditioning");
  assert.equal(nl("Washing machine"),"Wasmachine");
});

test("Batch 12E localises admin security operational labels",()=>{
  const nl = hostDictionary("nl");
  assert.equal(nl("active sessions"),"actieve sessies");
  assert.equal(nl("locked accounts"),"vergrendelde accounts");
  assert.equal(nl("present"),"aanwezig");
  assert.equal(nl("success"),"geslaagd");
});
