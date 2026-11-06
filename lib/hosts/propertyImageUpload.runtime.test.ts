import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const propertyId = "b7d31e72-c0a1-406a-b46b-635769e04939";

function harness(options: {
  mode?: "token" | "complete";
  authStatus?: number;
  accessStatus?: number;
  payload?: string;
  headFails?: boolean;
  requestedPath?: string;
} = {}) {
  const events: string[] = [];
  let tokenOptions: any;
  let registration: any[];
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
    pathname: `properties/${propertyId}/verified.webp`,
    contentType: "image/webp", size: 4096
  };
  const adapters: Record<string, any> = {
    "@vercel/blob": {
      head: async (url: string) => {
        events.push("head");
        assert.equal(url, "https://fixture.public.blob.vercel-storage.com/callback.webp");
        if (options.headFails) throw new Error("Mock Blob failure");
        return details;
      }
    },
    "@vercel/blob/client": {
      handleUpload: async (config: any) => {
        if (options.mode === "complete") {
          await config.onUploadCompleted({
            blob: { url: "https://fixture.public.blob.vercel-storage.com/callback.webp" },
            tokenPayload: options.payload
          });
        } else {
          tokenOptions = await config.onBeforeGenerateToken(options.requestedPath ?? `properties/${propertyId}/image.webp`);
        }
        return { fixture: true };
      }
    },
    "next/server": {
      NextResponse: { json: (body: any, init: any = {}) =>
        ({ body, status: init.status ?? 200 }) }
    },
    "@/lib/auth/session": {
      AuthError,
      requireSession: async () => {
        events.push("session");
        if (options.authStatus) throw new AuthError("Mock auth rejection", options.authStatus);
        return { user: { id: "fixture-user" } };
      }
    },
    "@/lib/auth/hostAccess": {
      resolveHostPropertyAccess: async (session: any, id: string) => {
        events.push("access");
        assert.equal(session.user.id, "fixture-user");
        assert.equal(id, propertyId);
        if (options.accessStatus) throw new AuthError("Mock access rejection", options.accessStatus);
      }
    },
    "@/lib/hosts/propertyImages": {
      PropertyImageError,
      registerUploadedPropertyImage: async (...args: any[]) => {
        events.push("register");
        registration = args;
      }
    }
  };
  const source = fs.readFileSync(
    "app/api/host/properties/[id]/images/upload/route.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    console: { error() {} },
    require(name: string) {
      assert.ok(Object.prototype.hasOwnProperty.call(adapters, name), "Unexpected import: " + name);
      return adapters[name];
    }
  });
  return {
    events, details,
    run: () => module.exports.POST(
      { json: async () => ({ fixture: true }) },
      { params: Promise.resolve({ id: propertyId }) }
    ),
    token: () => tokenOptions,
    registration: () => registration
  };
}

test("upload token requires session and ownership and uses server identity", async () => {
  const h = harness();
  assert.equal((await h.run()).status, 200);
  assert.deepEqual(h.events, ["session", "access"]);
  const token = JSON.parse(JSON.stringify(h.token()));
  assert.deepEqual(token.allowedContentTypes, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(token.maximumSizeInBytes, 10485760);
  assert.equal(token.addRandomSuffix, true);
  assert.equal(Object.prototype.hasOwnProperty.call(token, "pathname"), false);
  assert.deepEqual(JSON.parse(token.tokenPayload),
    { propertyId, userId: "fixture-user" });
});

test("unauthenticated and cross-owner token requests stop before Blob lookup", async () => {
  for (const options of [{ authStatus: 401 }, { accessStatus: 403 }]) {
    const h = harness(options);
    const response = await h.run();
    assert.equal(response.status, options.authStatus ?? options.accessStatus);
    assert.equal(response.body.error.code, "UNAUTHORIZED");
    assert.equal(h.events.includes("head"), false);
    assert.equal(h.events.includes("register"), false);
  }
});

test("missing malformed and wrong-property callback payloads stop before Blob lookup", async () => {
  for (const payload of [
    undefined, "{",
    JSON.stringify({ propertyId: "another-property", userId: "fixture-user" }),
    JSON.stringify({ propertyId })
  ]) {
    const h = harness({ mode: "complete", payload });
    const response = await h.run();
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_UPLOAD_TOKEN");
    assert.deepEqual(h.events, []);
  }
});

test("valid callback registers metadata obtained from mocked Blob head", async () => {
  const h = harness({
    mode: "complete",
    payload: JSON.stringify({ propertyId, userId: "fixture-user" })
  });
  assert.equal((await h.run()).status, 200);
  assert.deepEqual(h.events, ["head", "register"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.registration())),
    [propertyId, "fixture-user", h.details]);
});

test("Blob lookup failure returns an error without registering an image", async () => {
  const h = harness({
    mode: "complete", headFails: true,
    payload: JSON.stringify({ propertyId, userId: "fixture-user" })
  });
  const response = await h.run();
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "PROPERTY_IMAGE_UPLOAD_FAILED");
  assert.deepEqual(h.events, ["head"]);
});

test("upload token rejects property-prefix collisions and empty filenames", async () => {
  for (const requestedPath of [
    `properties/${propertyId}-other/image.webp`,
    `properties/${propertyId}`,
    `properties/${propertyId}/`,
    "properties/another-property/image.webp"
  ]) {
    const h = harness({ requestedPath });
    const result = await h.run();
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_UPLOAD_PATH");
    assert.equal(h.token(), undefined);
    assert.deepEqual(h.events, ["session", "access"]);
  }
});

test("upload callback rejects metadata outside the property directory", async () => {
  for (const pathname of [
    `properties/${propertyId}-other/image.webp`,
    `properties/${propertyId}`,
    `properties/${propertyId}/`,
    "properties/another-property/image.webp"
  ]) {
    const h = harness({
      mode: "complete",
      payload: JSON.stringify({ propertyId, userId: "fixture-user" })
    });
    h.details.pathname = pathname;
    const result = await h.run();
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_UPLOAD_PATH");
    assert.deepEqual(h.events, ["head"]);
  }
});

test("upload callback rejects an untrusted metadata URL", async () => {
  const h = harness({
    mode: "complete",
    payload: JSON.stringify({ propertyId, userId: "fixture-user" })
  });
  h.details.url = "https://example.com/image.webp";
  const result = await h.run();
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_UPLOAD_URL");
  assert.deepEqual(h.events, ["head"]);
});
