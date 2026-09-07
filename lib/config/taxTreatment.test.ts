import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaxTreatmentOrThrow, TaxTreatmentUnconfiguredError } from "./taxTreatment";

test("in production, resolving tax treatment throws when genuinely unconfigured", () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.HOST_TAX_TREATMENT;
  (process.env as any).NODE_ENV = "production";

  assert.throws(() => resolveTaxTreatmentOrThrow(), TaxTreatmentUnconfiguredError);

  (process.env as any).NODE_ENV = originalEnv;
});

test("in non-production, unconfigured resolves to 'unconfigured' without throwing (development convenience only)", () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.HOST_TAX_TREATMENT;
  (process.env as any).NODE_ENV = "development";

  const result = resolveTaxTreatmentOrThrow();
  assert.equal(result, "unconfigured");

  (process.env as any).NODE_ENV = originalEnv;
});

test("a real configured HOST_TAX_TREATMENT value is respected in production", () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.HOST_TAX_TREATMENT = "host_remits";
  (process.env as any).NODE_ENV = "production";

  const result = resolveTaxTreatmentOrThrow();
  assert.equal(result, "host_remits");

  delete process.env.HOST_TAX_TREATMENT;
  (process.env as any).NODE_ENV = originalEnv;
});

test("an explicit test override is always respected, regardless of environment or env var state", () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.HOST_TAX_TREATMENT;
  (process.env as any).NODE_ENV = "production";

  const result = resolveTaxTreatmentOrThrow("platform_remits");
  assert.equal(result, "platform_remits");

  (process.env as any).NODE_ENV = originalEnv;
});

test("an invalid/garbage HOST_TAX_TREATMENT value is treated as unconfigured, not silently accepted", () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.HOST_TAX_TREATMENT = "something_invalid";
  (process.env as any).NODE_ENV = "development";

  const result = resolveTaxTreatmentOrThrow();
  assert.equal(result, "unconfigured", "an unrecognised value must never be silently trusted");

  delete process.env.HOST_TAX_TREATMENT;
  (process.env as any).NODE_ENV = originalEnv;
});
