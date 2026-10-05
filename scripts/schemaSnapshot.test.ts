import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptySnapshot,
  normalizeDefinition,
  schemaSatisfies,
  schemaSatisfiesWithSuccessors,
} from "./schemaSnapshot";

const wrapped =
  "BEGIN IF OLD.status = 'approved' AND (ROW(OLD.name, OLD.city) IS DISTINCT FROM ROW(NEW.name, NEW.city)) THEN RETURN NEW; END IF; END;";

const unwrapped =
  "BEGIN IF OLD.status = 'approved' AND ROW( OLD.name, OLD.city ) IS DISTINCT FROM ROW( NEW.name, NEW.city ) THEN RETURN NEW; END IF; END;";

test("equivalent PostgreSQL ROW renderings normalize identically", () => {
  assert.equal(
    normalizeDefinition(wrapped),
    normalizeDefinition(unwrapped)
  );
});

test("schema verification accepts equivalent cross-version function renderings", () => {
  const required = emptySnapshot();
  const actual = emptySnapshot();

  required.functions.set("example_trigger", wrapped);
  actual.functions.set("example_trigger", unwrapped);

  assert.deepEqual(schemaSatisfies(actual, required), {
    complete: true,
    missing: [],
  });
});

test("normalization still detects a genuinely different ROW comparison", () => {
  const distinct =
    "BEGIN IF OLD.status = 'approved' AND ROW(OLD.name) IS DISTINCT FROM ROW(NEW.name) THEN RETURN NEW; END IF; END;";

  const notDistinct =
    "BEGIN IF OLD.status = 'approved' AND ROW(OLD.name) IS NOT DISTINCT FROM ROW(NEW.name) THEN RETURN NEW; END IF; END;";

  assert.notEqual(
    normalizeDefinition(distinct),
    normalizeDefinition(notDistinct)
  );
});

function successorScenario() {
  const required = emptySnapshot();
  required.functions.set("hotel_guard", "old definition");
  const successor = emptySnapshot();
  successor.functions.set("hotel_guard", "new definition");
  successor.triggers.set("inventory_guard@properties", "required trigger");
  const actual = emptySnapshot();
  actual.functions.set("hotel_guard", "new definition");
  actual.triggers.set("inventory_guard@properties", "required trigger");
  return { actual, required, successor };
}

test("a fully verified successor may supersede a historical function", () => {
  const { actual, required, successor } = successorScenario();
  assert.equal(schemaSatisfiesWithSuccessors(actual, required, [successor]).complete, true);
  assert.equal(required.functions.get("hotel_guard"), "old definition", "the manifest must remain immutable");
});

test("a partial successor cannot excuse a historical definition mismatch", () => {
  const { actual, required, successor } = successorScenario();
  actual.triggers.clear();
  assert.equal(schemaSatisfiesWithSuccessors(actual, required, [successor]).complete, false);
});

test("a successor cannot excuse a missing historical object or an unknown function", () => {
  const { actual, required, successor } = successorScenario();
  required.indexes.set("historical_index", "required index");
  assert.equal(schemaSatisfiesWithSuccessors(actual, required, [successor]).complete, false);
  required.indexes.clear();
  actual.functions.set("hotel_guard", "unrecognized definition");
  assert.equal(schemaSatisfiesWithSuccessors(actual, required, [successor]).complete, false);
});
