import {test} from "node:test";
import assert from "node:assert/strict";
import {financialMonitoringEmailOccurrenceId as identify}
  from "./financialMonitoringEmailOccurrenceId";

const binding = {
  environment: "local", database: "host_test", schema: "fixture"
};
const chain = "a".repeat(64);
const opening = "b".repeat(64);
const key = "refund_execute:heartbeat_missing";

test("same opening produces a stable id independent of identity property order", () => {
  const before = structuredClone(binding);
  const id = identify(binding, chain, opening, key);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(identify({
    schema: binding.schema, database: binding.database,
    environment: binding.environment
  }, chain, opening, key), id);
  assert.deepEqual(binding, before);
});

test("different opening, chain, source or condition produces a different id", () => {
  const original = identify(binding, chain, opening, key);
  const alternatives = [
    identify(binding, chain, "c".repeat(64), key),
    identify(binding, "d".repeat(64), opening, key),
    identify(binding, chain, opening, "transfer_execute:heartbeat_missing"),
    ...(["environment", "database", "schema"] as const).map(field =>
      identify({...binding, [field]: "different"}, chain, opening, key))
  ];
  assert.ok(alternatives.every(id => id !== original));
  assert.equal(new Set(alternatives).size, alternatives.length);
});

test("invalid identities and malformed components fail visibly", () => {
  assert.throws(() => identify({...binding, schema: ""}, chain, opening, key));
  assert.throws(() => identify(
    {...binding, extra: "unexpected"} as any, chain, opening, key));
  for (const invalid of ["", "x", "A".repeat(64), "a".repeat(65)]) {
    assert.throws(() => identify(binding, invalid, opening, key));
    assert.throws(() => identify(binding, chain, invalid, key));
  }
  for (const invalid of ["", "missing_separator", "a:b:c", "a:b\n"]) {
    assert.throws(() => identify(binding, chain, opening, invalid));
  }
});
