const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { NextRequest, NextResponse } = require("next/server");

class AuthError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
class SetupReviewCaseError extends Error {
  constructor(code, message, status) {
    super(message); this.code = code; this.status = status;
  }
}

const filename = "app/api/admin/setup-review-cases/route.ts";
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

test("setup review endpoint boundaries", async t => {
  let authFailure;
  let permissionFailure;
  let serviceFailure;
  let received;
  let calls;
  const actor = "11111111-1111-4111-8111-111111111111";
  const result = { status: "in_review", version: 1 };
  const mod = { exports: {} };

  vm.runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    require(name) {
      if (name === "next/server") return { NextRequest, NextResponse };
      if (name === "@/lib/auth/session") return { AuthError };
      if (name === "@/lib/auth/adminSecurity") return {
        requireSecureAdmin: async () => {
          calls.push("secure");
          if (authFailure) throw authFailure;
          return { user: { id: actor } };
        },
      };
      if (name === "@/lib/auth/permissions") return {
        requirePermission: async (resource, action) => {
          calls.push("permission");
          assert.equal(resource, "reconciliation");
          assert.equal(action, "write");
          if (permissionFailure) throw permissionFailure;
        },
      };
      if (name === "@/lib/payments/setupReviewCases") return {
        SetupReviewCaseError,
        updateSetupReviewCase: async (userId, input) => {
          calls.push("update");
          received = { userId, input };
          if (serviceFailure) throw serviceFailure;
          return result;
        },
      };
      throw new Error("Unexpected import: " + name);
    },
  }, { filename });

  function reset() {
    authFailure = permissionFailure = serviceFailure = undefined;
    received = undefined;
    calls = [];
  }
  function request(origin = "http://localhost:3001", body = "{}") {
    return new NextRequest(
      "http://localhost:3001/api/admin/setup-review-cases",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(origin === null ? {} : { origin }),
        },
        body,
      }
    );
  }
  async function invoke(req, status) {
    const response = await mod.exports.PATCH(req);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes("PRIVATE_DETAIL"));
    return body;
  }

  await t.test("rejects unauthenticated requests before permission or service", async () => {
    reset();
    authFailure = new AuthError("PRIVATE_DETAIL", 401);
    await invoke(request(), 401);
    assert.deepEqual(calls, ["secure"]);
  });
  await t.test("rejects insecure or disabled administrative access", async () => {
    reset();
    authFailure = new AuthError("PRIVATE_DETAIL", 403);
    await invoke(request(), 403);
    assert.deepEqual(calls, ["secure"]);
  });
  await t.test("requires reconciliation write permission", async () => {
    reset();
    permissionFailure = new AuthError("PRIVATE_DETAIL", 403);
    await invoke(request(), 403);
    assert.deepEqual(calls, ["secure", "permission"]);
  });
  for (const origin of [null, "https://other.example", "null"]) {
    await t.test("rejects missing or foreign origin: " + origin, async () => {
      reset();
      const body = await invoke(request(origin), 403);
      assert.equal(body.error.code, "INVALID_ORIGIN");
      assert.ok(!calls.includes("update"));
    });
  }
  await t.test("uses the session actor and forwards the request for strict service validation", async () => {
    reset();
    const input = { action: "claim", actorUserId: "forged" };
    const body = await invoke(request(undefined, JSON.stringify(input)), 200);
    assert.equal(received.userId, actor);
    assert.deepEqual(received.input, input);
    assert.deepEqual(body.reviewCase, result);
    assert.deepEqual(calls, ["secure", "permission", "update"]);
  });
  await t.test("malformed JSON reaches service as null and returns safe validation error", async () => {
    reset();
    serviceFailure = new SetupReviewCaseError(
      "INVALID_REVIEW_UPDATE", "Invalid review update.", 400);
    await invoke(request(undefined, "{"), 400);
    assert.equal(received.input, null);
  });
  for (const [status, errorCode] of [
    [403, "REVIEW_ACCESS_DENIED"],
    [404, "REVIEW_NOT_FOUND"],
    [409, "REVIEW_VERSION_CONFLICT"],
  ]) {
    await t.test("preserves expected service error " + status, async () => {
      reset();
      serviceFailure = new SetupReviewCaseError(errorCode, "Safe guidance.", status);
      const body = await invoke(request(), status);
      assert.equal(body.error.code, errorCode);
    });
  }
  await t.test("hides unexpected exception details", async () => {
    reset();
    serviceFailure = new Error("PRIVATE_DETAIL");
    const body = await invoke(request(), 500);
    assert.equal(body.error.code, "REVIEW_UPDATE_FAILED");
  });
});


test("setup review GET boundaries", async t => {
  let authFailure, permissionFailure, readFailure;
  let calls, received;
  const reviews = { records: [], hasMore: false };
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    require(name) {
      if (name === "next/server") return { NextRequest, NextResponse };
      if (name === "@/lib/auth/session") return { AuthError };
      if (name === "@/lib/auth/adminSecurity") return {
        requireSecureAdmin: async () => {
          calls.push("secure");
          if (authFailure) throw authFailure;
          return { user: { id: "session-actor" } };
        },
      };
      if (name === "@/lib/auth/permissions") return {
        requirePermission: async (resource, action) => {
          calls.push("permission");
          assert.equal(resource, "reconciliation");
          assert.equal(action, "read");
          if (permissionFailure) throw permissionFailure;
        },
      };
      if (name === "@/lib/payments/setupReviewCases") return {
        SetupReviewCaseError,
        getSetupReviewCases: async bookingId => {
          calls.push("read");
          received = bookingId;
          if (readFailure) throw readFailure;
          return reviews;
        },
        updateSetupReviewCase: async () => {
          throw new Error("GET must not update cases");
        },
      };
      throw new Error("Unexpected import: " + name);
    },
  }, { filename });

  function reset() {
    authFailure = permissionFailure = readFailure = undefined;
    calls = [];
    received = undefined;
  }
  async function invoke(query, status) {
    const response = await mod.exports.GET(new NextRequest(
      "http://localhost:3001/api/admin/setup-review-cases" + query
    ));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes("PRIVATE_DETAIL"));
    return body;
  }

  await t.test("denies unauthenticated reads before service access", async () => {
    reset();
    authFailure = new AuthError("PRIVATE_DETAIL", 401);
    await invoke("", 401);
    assert.deepEqual(calls, ["secure"]);
  });
  await t.test("requires secure administrative access", async () => {
    reset();
    authFailure = new AuthError("PRIVATE_DETAIL", 403);
    await invoke("", 403);
    assert.deepEqual(calls, ["secure"]);
  });
  await t.test("requires reconciliation read permission", async () => {
    reset();
    permissionFailure = new AuthError("PRIVATE_DETAIL", 403);
    await invoke("", 403);
    assert.deepEqual(calls, ["secure", "permission"]);
  });
  await t.test("passes booking query to reader and returns its bounded result", async () => {
    reset();
    const id = "11111111-1111-4111-8111-111111111111";
    const body = await invoke("?bookingId=" + id, 200);
    assert.equal(received, id);
    assert.deepEqual(body.reviews, reviews);
    assert.deepEqual(calls, ["secure", "permission", "read"]);
  });
  await t.test("missing booking ID receives safe service validation error", async () => {
    reset();
    readFailure = new SetupReviewCaseError(
      "INVALID_REVIEW_QUERY", "Enter a valid booking ID.", 400
    );
    const body = await invoke("", 400);
    assert.equal(received, "");
    assert.equal(body.error.code, "INVALID_REVIEW_QUERY");
  });
  await t.test("unexpected reader failure exposes no internal details", async () => {
    reset();
    readFailure = new Error("PRIVATE_DETAIL");
    const body = await invoke("?bookingId=test", 500);
    assert.equal(body.error.code, "REVIEW_LOAD_FAILED");
  });
});
