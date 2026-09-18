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

test("customer navigation uses a two-column mobile grid", () => {
  for (const relativePath of [
    "app/page.tsx",
    "components/CustomerNav.tsx",
  ]) {
    const source = read(relativePath);

    assert.ok(source.includes(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    ));
    assert.ok(source.includes("flex-direction: column"));
    assert.ok(source.includes("min-height: 42px"));
  }
});

test("HOST provides a branded application icon", () => {
  const source = read("app/icon.svg");

  assert.ok(source.includes("<svg"));
  assert.ok(source.includes("#14120e"));
  assert.ok(source.includes("#c9974b"));
  assert.ok(source.includes(">H</text>"));
});
