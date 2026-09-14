import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

test("content security policy permits direct Vercel Blob uploads", () => {
  const middleware = read("middleware.ts");

  assert.match(
    middleware,
    /connect-src[^"]*https:\/\/vercel\.com/
  );
  assert.match(
    middleware,
    /connect-src[^"]*https:\/\/\*\.blob\.vercel-storage\.com/
  );
});

test("content security policy permits public property images", () => {
  const middleware = read("middleware.ts");

  assert.match(
    middleware,
    /img-src[^"]*https:\/\/\*\.blob\.vercel-storage\.com/
  );
});

test("the signed Blob callback has a narrowly scoped origin exemption", () => {
  const middleware = read("middleware.ts");
  const uploadRoute = read(
    "app/api/host/properties/[id]/images/upload/route.ts"
  );

  assert.match(
    middleware,
    /const BLOB_UPLOAD_PATH = \/\^\\\/api\\\/host\\\/properties\\\/\[0-9a-f\]/
  );
  assert.match(
    middleware,
    /BLOB_UPLOAD_PATH\.test\(pathname\)/
  );

  assert.match(uploadRoute, /handleUpload\(\{/);
  assert.match(uploadRoute, /onBeforeGenerateToken/);
  assert.match(uploadRoute, /requireSession\(\)/);
  assert.match(uploadRoute, /resolveHostPropertyAccess/);
  assert.match(uploadRoute, /onUploadCompleted/);
});

test("property image upload control has explicit high contrast", () => {
  const manager = read("components/PropertyImageManager.tsx");

  assert.match(manager, /: "#d49a3f"/);
  assert.match(manager, /color: "#100f0c"/);
  assert.match(manager, /border: "1px solid #e9bd70"/);
});