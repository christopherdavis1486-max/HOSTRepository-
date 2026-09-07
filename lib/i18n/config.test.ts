import test from "node:test";
import assert from "node:assert/strict";
import { LEGAL_CONTENT_LOCALE, localeForContent, normalizeLocale } from "./config";

test("normalizes supported browser locales and safely falls back", () => {
  assert.equal(normalizeLocale("de-DE"), "de");
  assert.equal(normalizeLocale("FR-fr"), "fr");
  assert.equal(normalizeLocale("ru"), "en");
  assert.equal(normalizeLocale(null), "en");
});

test("legal content is always authoritative English", () => {
  assert.equal(LEGAL_CONTENT_LOCALE, "en");
  for (const preference of ["de", "fr", "es", "it", "nl"]) assert.equal(localeForContent("legal", preference), "en");
  assert.equal(localeForContent("interface", "nl-NL"), "nl");
});
