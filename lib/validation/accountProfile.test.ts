import test from "node:test";
import assert from "node:assert/strict";
import { accountProfileSchema } from "./schemas";

test("account profile accepts trimmed optional contact details", () => {
  const result = accountProfileSchema.parse({ fullName: "  Alex Guest  ", phone: " +44 7700 900123 " });
  assert.deepEqual(result, { fullName: "Alex Guest", phone: "+44 7700 900123" });
});

test("account profile rejects oversized fields and ignores no email mutation field", () => {
  assert.equal(accountProfileSchema.safeParse({ fullName: "x".repeat(121), phone: null }).success, false);
  const result = accountProfileSchema.parse({ fullName: null, phone: null, email: "attacker@example.com" });
  assert.equal("email" in result, false);
});
