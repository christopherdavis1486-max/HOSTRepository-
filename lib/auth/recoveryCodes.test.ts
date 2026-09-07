import test from "node:test";
import assert from "node:assert/strict";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, recoveryCodeMatches } from "./recoveryCodes";

test("recovery codes are unique, formatted, and normalized", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.equal(normalizeRecoveryCode(codes[0].toLowerCase()), codes[0].replace(/-/g, ""));
});

test("recovery codes use a keyed deterministic hash", () => {
  process.env.AUTH_SECRET = "test-secret-that-is-not-used-in-production";
  const code = "ABCD-EF01-2345-6789";
  const hash = hashRecoveryCode(code);
  assert.equal(hash.length, 64);
  assert.equal(recoveryCodeMatches("abcd ef01 2345 6789", hash), true);
  assert.equal(recoveryCodeMatches("ABCD-EF01-2345-6788", hash), false);
  assert.equal(hash.includes(normalizeRecoveryCode(code)), false);
});
