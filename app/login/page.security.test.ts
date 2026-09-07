import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeReturnPath } from "./returnPath";

/**
 * Proves the specific security property Batch 2's auth-preserving
 * booking flow depends on: /login?returnTo=... can only ever redirect
 * back to a same-origin relative path, never off-site, regardless of
 * what a crafted URL puts in the query string.
 */

test("a genuine same-origin path is preserved exactly", () => {
  assert.equal(isSafeReturnPath("/stays/some-property?checkIn=2026-10-20&checkOut=2026-10-22&guests=1"), "/stays/some-property?checkIn=2026-10-20&checkOut=2026-10-22&guests=1");
  assert.equal(isSafeReturnPath("/search?city=Liverpool"), "/search?city=Liverpool");
});

test("null (no returnTo param at all) falls back to home", () => {
  assert.equal(isSafeReturnPath(null), "/");
});

test("an empty string falls back to home", () => {
  assert.equal(isSafeReturnPath(""), "/");
});

test("a protocol-relative //host value is rejected — this is the actual open-redirect vector", () => {
  assert.equal(isSafeReturnPath("//evil.example.com/phish"), "/");
  assert.equal(isSafeReturnPath("////evil.example.com"), "/");
});

test("an absolute external URL is rejected", () => {
  assert.equal(isSafeReturnPath("https://evil.example.com/phish"), "/");
  assert.equal(isSafeReturnPath("http://evil.example.com"), "/");
});

test("a value not starting with / at all is rejected", () => {
  assert.equal(isSafeReturnPath("evil.example.com"), "/");
  assert.equal(isSafeReturnPath("javascript:alert(1)"), "/");
});
