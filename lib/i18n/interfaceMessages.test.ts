import test from "node:test";
import assert from "node:assert/strict";
import { interfaceDictionary } from "./interfaceMessages";

test("Batch 12D translates account and authentication interfaces", () => {
  assert.equal(interfaceDictionary("de").account, "Konto");
  assert.equal(interfaceDictionary("fr").forgotPassword, "Mot de passe oublié ?");
  assert.equal(interfaceDictionary("es").savedStays, "Alojamientos guardados");
  assert.equal(interfaceDictionary("it").signInPasskey, "Accedi con una passkey");
  assert.equal(interfaceDictionary("nl").resetPassword, "Wachtwoord opnieuw instellen");
});

test("every Batch 12D dictionary exposes the same interface keys", () => {
  const expected = Object.keys(interfaceDictionary("en")).sort();
  for (const locale of ["de", "fr", "es", "it", "nl"] as const) {
    assert.deepEqual(Object.keys(interfaceDictionary(locale)).sort(), expected);
  }
});
