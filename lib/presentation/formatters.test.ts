import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatStatus, formatCurrency, formatTime } from "./formatters";

test("formatDate: full ISO timestamp with midnight UTC time component", () => {
  assert.equal(formatDate("2026-10-25T00:00:00.000Z"), "25 Oct 2026");
  assert.equal(formatDate("2026-10-27T00:00:00.000Z"), "27 Oct 2026");
});

test("formatDate: plain YYYY-MM-DD string, no time component", () => {
  assert.equal(formatDate("2026-10-25"), "25 Oct 2026");
});

test("formatDate: does not shift the calendar date regardless of time-of-day component", () => {
  // The exact bug class this function exists to avoid: a naive
  // new Date(iso).toLocaleDateString() in a UTC+1 (or later) browser
  // timezone can roll "2026-10-25T00:00:00.000Z" back to "24 Oct 2026".
  // This function must never do that, for any time-of-day value.
  assert.equal(formatDate("2026-10-25T23:59:59.000Z"), "25 Oct 2026");
  assert.equal(formatDate("2026-10-25T00:00:00.000Z"), "25 Oct 2026");
  assert.equal(formatDate("2026-01-01T00:00:00.000Z"), "1 Jan 2026");
});

test("formatDate: an unrecognized shape returns the raw input rather than crashing", () => {
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.equal(formatDate(""), "");
});

test("formatStatus: every currently known booking/payment status", () => {
  assert.equal(formatStatus("pending_payment"), "Pending payment");
  assert.equal(formatStatus("confirmed"), "Confirmed");
  assert.equal(formatStatus("cancelled"), "Cancelled");
  assert.equal(formatStatus("completed"), "Completed");
  assert.equal(formatStatus("refunded"), "Refunded");
  assert.equal(formatStatus("partially_refunded"), "Partially refunded");
  assert.equal(formatStatus("paid"), "Paid");
  assert.equal(formatStatus("payment_scheduled"), "Payment scheduled");
  assert.equal(formatStatus("payment_method_required"), "Payment method needed");
  assert.equal(formatStatus("payment_grace_period"), "Payment needs attention");
});

test("formatStatus: null/undefined degrades to an em dash, not a crash", () => {
  assert.equal(formatStatus(null), "—");
  assert.equal(formatStatus(undefined), "—");
});

test("formatStatus: an unknown future status degrades gracefully rather than crashing", () => {
  assert.equal(formatStatus("some_new_status"), "Some new status");
  assert.equal(formatStatus("disputed"), "Disputed");
});

test("formatTime: normalizes Postgres's HH:MM:SS to HH:MM", () => {
  assert.equal(formatTime("15:00:00"), "15:00");
  assert.equal(formatTime("11:00:00"), "11:00");
  assert.equal(formatTime("09:30:00"), "09:30");
});

test("formatTime: already-clean HH:MM passes through unchanged", () => {
  assert.equal(formatTime("15:00"), "15:00");
});

test("formatTime: null/undefined degrades to an em dash, not a crash", () => {
  assert.equal(formatTime(null), "—");
  assert.equal(formatTime(undefined), "—");
});

test("formatCurrency: GBP amounts render with a proper £ symbol", () => {
  assert.equal(formatCurrency(25500, "GBP"), "£255.00");
  assert.equal(formatCurrency(20000, "GBP"), "£200.00");
  assert.equal(formatCurrency(2000, "GBP"), "£20.00");
  assert.equal(formatCurrency(2400, "GBP"), "£24.00");
  assert.equal(formatCurrency(1100, "GBP"), "£11.00");
  assert.equal(formatCurrency(0, "GBP"), "£0.00");
});

test("formatCurrency: uses the backend-supplied currency code, not a hardcoded £", () => {
  const result = formatCurrency(10000, "USD");
  assert.match(result, /\$/, "a USD amount must not be rendered with a £ symbol");
});

test("formatCurrency: accepts a string amount (as returned by pg's numeric columns) as well as a number", () => {
  assert.equal(formatCurrency("25500", "GBP"), "£255.00");
});

test("formatCurrency: null/undefined inputs degrade to an em dash, not a crash", () => {
  assert.equal(formatCurrency(null, "GBP"), "—");
  assert.equal(formatCurrency(25500, null), "—");
});

test("formatCurrency: never performs any calculation — the exact minor-unit value is what gets divided and shown", () => {
  assert.equal(formatCurrency(29655, "GBP"), "£296.55");
});
