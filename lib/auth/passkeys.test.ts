import test from "node:test";
import assert from "node:assert/strict";
import { hashLoginToken, newLoginToken, webAuthnConfig } from "./passkeys";

test("passkey login grants are high-entropy and hash deterministically", () => {
  const first = newLoginToken();
  const second = newLoginToken();
  assert.notEqual(first, second);
  assert.ok(first.length >= 40);
  assert.equal(hashLoginToken(first), hashLoginToken(first));
  assert.notEqual(hashLoginToken(first), first);
});

test("local WebAuthn configuration is bound to localhost", () => {
  const priorOrigin = process.env.AUTH_WEBAUTHN_ORIGIN;
  process.env.AUTH_WEBAUTHN_ORIGIN = "http://localhost:3000";
  assert.deepEqual(webAuthnConfig(), { origin: "http://localhost:3000", rpID: "localhost", rpName: "HOST" });
  if (priorOrigin === undefined) delete process.env.AUTH_WEBAUTHN_ORIGIN; else process.env.AUTH_WEBAUTHN_ORIGIN = priorOrigin;
});
