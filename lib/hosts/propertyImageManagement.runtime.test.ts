import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { z } = require("zod");
const propertyId = "b7d31e72-c0a1-406a-b46b-635769e04939";
const imageId = "a7d31e72-c0a1-406a-b46b-635769e04939";
const plain = (value: any) => JSON.parse(JSON.stringify(value));

function harness(options: {
  auth?: number; access?: number; blobFails?: boolean;
  serviceFails?: boolean; wrongPath?: boolean;
} = {}) {
  const events: string[] = [];
  const calls: { name: string; args: any[] }[] = [];
  class AuthError extends Error {
    constructor(message: string, public status: number) { super(message); }
  }
  class PropertyImageError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  }
  const details = {
    url: "https://fixture.public.blob.vercel-storage.com/verified.webp",
    pathname: options.wrongPath ? "properties/another-property/image.webp" :
      `properties/${propertyId}/image.webp`,
    contentType: "image/webp", size: 4096
  };
  const services: any = { PropertyImageError };
  for (const name of [
    "listPropertyImages", "registerUploadedPropertyImage",
    "reorderPropertyImages", "setPropertyImageCover",
    "updatePropertyImageAltText", "deletePropertyImage"
  ]) {
    services[name] = async (...args: any[]) => {
      events.push(name);
      calls.push({ name, args: plain(args) });
      if (options.serviceFails) {
        throw new PropertyImageError("PROPERTY_IMAGE_NOT_FOUND", "Mock missing image", 404);
      }
      if (name === "deletePropertyImage") return { blobUrl: details.url };
      return name === "listPropertyImages" || name === "reorderPropertyImages"
        ? [{ id: imageId }] : { id: imageId };
    };
  }
  const adapters: any = {
    "zod": { z },
    "@vercel/blob": {
      head: async () => { events.push("head"); return details; },
      del: async (url: string) => {
        events.push("del");
        assert.equal(url, details.url);
        if (options.blobFails) throw new Error("Mock storage cleanup failure");
      }
    },
    "next/server": {
      NextResponse: { json: (body: any, init: any = {}) =>
        ({ body, status: init.status ?? 200 }) }
    },
    "@/lib/auth/session": {
      AuthError, requireSession: async () => {
        events.push("session");
        if (options.auth) throw new AuthError("Mock authentication failure", options.auth);
        return { user: { id: "fixture-user" } };
      }
    },
    "@/lib/auth/hostAccess": {
      resolveHostPropertyAccess: async (_session: any, id: string) => {
        events.push("access");
        assert.equal(id, propertyId);
        if (options.access) throw new AuthError("Mock access failure", options.access);
      }
    },
    "@/lib/hosts/propertyImages": services
  };
  function load(file: string) {
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
      }
    }).outputText;
    const module = { exports: {} as any };
    vm.runInNewContext(compiled, {
      module, exports: module.exports, console: { error() {} },
      require(name: string) {
        assert.ok(Object.prototype.hasOwnProperty.call(adapters, name),
          "Unexpected import: " + name);
        return adapters[name];
      }
    });
    return module.exports;
  }
  const management = load("app/api/host/properties/[id]/images/route.ts");
  const deletion = load("app/api/host/properties/[id]/images/[imageId]/route.ts");
  return {
    events, calls, details,
    run: (method: string, body: any = {}) =>
      (method === "DELETE" ? deletion : management)[method](
        { json: async () => body },
        { params: Promise.resolve({ id: propertyId, imageId }) }
      )
  };
}

test("all image operations reject missing authentication and cross-owner access", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    for (const options of [{ auth: 401 }, { access: 403 }]) {
      const h = harness(options);
      const result = await h.run(method);
      assert.equal(result.status, options.auth ?? options.access);
      assert.equal(result.body.error.code, "UNAUTHORIZED");
      assert.equal(h.calls.length, 0);
      assert.equal(h.events.includes("head"), false);
      assert.equal(h.events.includes("del"), false);
    }
  }
});

test("listing uses authenticated identity and property", async () => {
  const h = harness();
  assert.equal((await h.run("GET")).status, 200);
  assert.deepEqual(h.calls, [{
    name: "listPropertyImages", args: [propertyId, "fixture-user"]
  }]);
});

test("registration uses Blob head metadata and rejects another property's path", async () => {
  const h = harness();
  assert.equal((await h.run("POST", {
    blobUrl: "https://fixture.public.blob.vercel-storage.com/input.webp"
  })).status, 200);
  assert.deepEqual(h.calls[0], {
    name: "registerUploadedPropertyImage",
    args: [propertyId, "fixture-user", h.details]
  });
  const wrong = harness({ wrongPath: true });
  const result = await wrong.run("POST", {
    blobUrl: "https://fixture.public.blob.vercel-storage.com/input.webp"
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_UPLOAD_PATH");
  assert.equal(wrong.calls.length, 0);
});

test("invalid management inputs never reach service or Blob adapters", async () => {
  for (const [method, body] of [
    ["POST", { blobUrl: "invalid" }],
    ["PATCH", { action: "unknown" }],
    ["PATCH", { action: "setCover", imageId: "invalid" }],
    ["PATCH", { action: "updateAltText", imageId, altText: "x".repeat(301) }],
    ["PATCH", { action: "reorder", imageIds: Array(31).fill(imageId) }]
  ] as const) {
    const h = harness();
    const result = await h.run(method, body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "VALIDATION_ERROR");
    assert.equal(h.calls.length, 0);
    assert.equal(h.events.includes("head"), false);
  }
});

test("management dispatch preserves identity and normalizes alternative text", async () => {
  for (const [body, name, args] of [
    [{ action: "setCover", imageId }, "setPropertyImageCover",
      [propertyId, imageId, "fixture-user"]],
    [{ action: "updateAltText", imageId, altText: "  Test room  " },
      "updatePropertyImageAltText", [propertyId, imageId, "fixture-user", "Test room"]],
    [{ action: "updateAltText", imageId, altText: "  " },
      "updatePropertyImageAltText", [propertyId, imageId, "fixture-user", null]],
    [{ action: "reorder", imageIds: [imageId] }, "reorderPropertyImages",
      [propertyId, [imageId], "fixture-user"]]
  ] as const) {
    const h = harness();
    assert.equal((await h.run("PATCH", body)).status, 200);
    assert.deepEqual(h.calls, [{ name, args }]);
  }
});

test("deletion calls storage only after service success and reports cleanup failure", async () => {
  for (const blobFails of [false, true]) {
    const h = harness({ blobFails });
    const result = await h.run("DELETE");
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.blobDeleted, !blobFails);
    assert.deepEqual(h.events, ["session", "access", "deletePropertyImage", "del"]);
    assert.deepEqual(h.calls[0].args, [propertyId, imageId, "fixture-user"]);
  }
  const missing = harness({ serviceFails: true });
  const result = await missing.run("DELETE");
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "PROPERTY_IMAGE_NOT_FOUND");
  assert.equal(missing.events.includes("del"), false);
});

test("registration rejects property-prefix collisions and empty filenames", async () => {
  for (const pathname of [
    `properties/${propertyId}-other/image.webp`,
    `properties/${propertyId}`,
    `properties/${propertyId}/`
  ]) {
    const h = harness();
    h.details.pathname = pathname;
    const result = await h.run("POST", {
      blobUrl: "https://fixture.public.blob.vercel-storage.com/input.webp"
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_UPLOAD_PATH");
    assert.equal(h.calls.length, 0);
  }
});

test("registration rejects untrusted URLs before Blob lookup", async () => {
  for (const blobUrl of [
    "https://example.com/image.webp",
    "http://fixture.public.blob.vercel-storage.com/image.webp",
    "https://fixture.public.blob.vercel-storage.com.evil.test/image.webp",
    "https://user:password@fixture.public.blob.vercel-storage.com/image.webp",
    "https://fixture.public.blob.vercel-storage.com:444/image.webp",
    "https://fixture.public.blob.vercel-storage.com/image.webp?download=1",
    "https://fixture.public.blob.vercel-storage.com/image.webp#fragment"
  ]) {
    const h = harness();
    const result = await h.run("POST", { blobUrl });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "VALIDATION_ERROR");
    assert.equal(h.events.includes("head"), false);
    assert.equal(h.calls.length, 0);
  }
});

test("registration rejects an untrusted URL returned by Blob metadata", async () => {
  const h = harness();
  h.details.url = "https://example.com/image.webp";
  const result = await h.run("POST", {
    blobUrl: "https://fixture.public.blob.vercel-storage.com/input.webp"
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_UPLOAD_URL");
  assert.equal(h.calls.length, 0);
});
