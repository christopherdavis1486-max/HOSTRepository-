import { test } from "node:test";
import assert from "node:assert/strict";
import { signInFeedback } from "./signInFeedback";

test("a credentials rate limit explains the wait rather than blaming the password", () => {
  assert.match(signInFeedback({ ok: false, status: 429, error: "RateLimited" })!, /wait 15 minutes/);
});
test("a security outage is distinct from incorrect credentials", () => {
  assert.match(signInFeedback({ ok: false, status: 503, error: "SecurityUnavailable" })!, /temporarily unavailable/);
});
test("incorrect credentials retain their existing feedback", () => {
  assert.equal(signInFeedback({ ok: false, status: 401, error: "CredentialsSignin" }), "Incorrect email or password.");
});
test("missing and unsuccessful results cannot be treated as a successful login", () => {
  assert.ok(signInFeedback(undefined));
  assert.equal(signInFeedback({ ok: false, status: 500 }, "Could not create a session."), "Could not create a session.");
  assert.ok(signInFeedback({ ok: true, status: 200, error: "UnexpectedError" }));
});
test("only explicit success allows navigation", () => {
  assert.equal(signInFeedback({ ok: true, status: 200 }), null);
});
