import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { db } from "../db";
import { listStandardCancellationPolicies } from "./hostProperties";

test("policy catalogue selects one standard policy per name", async () => {
  const query = mock.method(db, "query", async (sql: string) => {
    assert.match(sql, /ROW_NUMBER\(\)/);
    assert.match(sql, /duplicate_rank = 1/);
    assert.match(sql, /'flexible', 'moderate', 'strict'/);
    return { rows: [{ id: "one", name: "Flexible", description: "Test", rules: [] }] } as any;
  });

  try {
    const result = await listStandardCancellationPolicies();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Flexible");
  } finally {
    query.mock.restore();
  }
});

test("policy endpoint requires the host role", () => {
  const route = fs.readFileSync("app/api/host/cancellation-policies/route.ts", "utf8");
  assert.match(route, /requireRole\("host"\)/);
});

test("policy seed prevents duplicate names", () => {
  const seed = fs.readFileSync("scripts/seedFeeConfig.ts", "utf8");
  assert.match(seed, /WHERE NOT EXISTS/);
  assert.match(seed, /LOWER\(existing\.name\) = LOWER\(p\.name\)/);
});
