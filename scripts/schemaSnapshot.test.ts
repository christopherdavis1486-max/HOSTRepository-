import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptySnapshot,
  normalizeDefinition,
  schemaSatisfies,
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