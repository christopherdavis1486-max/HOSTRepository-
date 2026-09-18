import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), relativePath),
    "utf8",
  );
}

test("host properties loading cannot remain pending indefinitely", () => {
  const source = read("app/host/properties/page.tsx");

  assert.ok(source.includes("new AbortController()"));
  assert.ok(source.includes("15000"));
  assert.ok(source.includes("controller.abort()"));
  assert.ok(source.includes("signal: controller.signal"));
  assert.ok(source.includes('cache: "no-store"'));
  assert.ok(source.includes('.catch(() => setState("error"))'));
});

test("a failed host properties request can be retried", () => {
  const source = read("app/host/properties/page.tsx");

  assert.ok(source.includes('ht("Try again")'));
  assert.ok(source.includes("loadProperties();"));
  assert.ok(source.includes('type="button"'));
});
