import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://host-git-host-staging-preview-host-team1.vercel.app";
const bookingId = "11111111-1111-4111-8111-111111111111";
class AuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}
function harness(options: {
  env?: Record<string, string | undefined>;
  origin?: string | null; urlOrigin?: string;
  authStatus?: number; body?: unknown; malformed?: boolean;
  contentType?: string; outcome?: string;
  auditFails?: boolean; live?: boolean; exerciseProvider?: boolean;
} = {}) {
  const events: string[] = [];
  const exports: any = {};
  const env = {
    VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "host-staging-preview",
    ENABLE_STAGING_UNPAID_INTENT_CLEANUP: "true",
    STRIPE_SECRET_KEY: "sk_test_fixture", ...options.env,
  };
  const compiled = ts.transpileModule(fs.readFileSync(
    "app/api/admin/payments/cleanup-unpaid-hotel/route.ts", "utf8"
  ), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  }}).outputText;
  vm.runInNewContext(compiled, {
    exports, process: { env }, console: { error() {} },
    require(name: string) {
      if (name === "next/server") return {
        NextResponse: { json: (body: any, init: any) => ({ body, ...init }) },
      };
      if (name === "@/lib/auth/session") return { AuthError };
      if (name === "@/lib/auth/permissions") return {
        async requirePermission(resource: string, action: string) {
          events.push("auth");
          assert.equal(resource, "refunds"); assert.equal(action, "write");
          if (options.authStatus) throw new AuthError("Denied", options.authStatus);
          return { user: { id: "operator", adminRole: "finance" } };
        },
      };
      if (name === "@/lib/db") return { db: {
        async query(sql: string, values: any[]) {
          events.push("audit");
          assert.ok(sql.includes("staging_unpaid_intent_cleanup_requested"));
          assert.equal(values[0], "operator"); assert.equal(values[1], bookingId);
          if (options.auditFails) throw new Error("Audit unavailable");
        },
      }};
      if (name === "@/lib/payments/stripeClient") return { stripe: {
        paymentIntents: {
          async retrieve() { events.push("provider-read"); return { livemode: options.live ?? false }; },
          async cancel() { events.push("provider-cancel"); },
        },
      }};
      if (name === "@/lib/payments/cleanupCancelledHotelIntent") return {
        async cleanupCancelledHotelIntent(id: string, provider: any) {
          events.push("worker"); assert.equal(id, bookingId);
          if (options.exerciseProvider) {
            await provider.retrieve("pi_fixture", {}, {});
            await provider.cancel("pi_fixture", {}, {});
          }
          return { outcome: options.outcome ?? "cancelled_unpaid" };
        },
      };
      throw new Error("Unexpected dependency: " + name);
    },
  });
  return {
    events,
    run: () => exports.POST({
      nextUrl: { origin: options.urlOrigin ?? origin },
      headers: { get(name: string) {
        if (name === "origin") return options.origin === undefined ? origin : options.origin;
        if (name === "content-type") return options.contentType ?? "application/json";
        return null;
      }},
      async json() {
        if (options.malformed) throw new Error("Invalid JSON");
        return options.body === undefined ? { bookingId } : options.body;
      },
    }),
  };
}

for (const env of [
  { VERCEL_ENV: "production" },
  { VERCEL_ENV: "development" },
  { VERCEL_GIT_COMMIT_REF: "main" },
  { ENABLE_STAGING_UNPAID_INTENT_CLEANUP: undefined },
  { STRIPE_SECRET_KEY: "sk_live_fixture" },
]) {
  test("environment gate prevents execution: " + JSON.stringify(env), async () => {
    const f = harness({ env });
    assert.equal((await f.run()).status, 404);
    assert.deepEqual(f.events, []);
  });
}
for (const source of [null, "https://other.example"]) {
  test("missing or foreign Origin is rejected: " + source, async () => {
    const f = harness({ origin: source });
    assert.equal((await f.run()).status, 403);
    assert.deepEqual(f.events, []);
  });
}
for (const status of [401, 403]) {
  test("authorization failure prevents audit and worker: " + status, async () => {
    const f = harness({ authStatus: status });
    assert.equal((await f.run()).status, status);
    assert.deepEqual(f.events, ["auth"]);
  });
}
for (const body of [null, {}, { bookingId: "invalid" }, { bookingId, actorId: "forged" }]) {
  test("invalid request is rejected: " + JSON.stringify(body), async () => {
    const f = harness({ body });
    assert.equal((await f.run()).status, 400);
    assert.deepEqual(f.events, ["auth"]);
  });
}
test("audit failure prevents worker execution", async () => {
  const f = harness({ auditFails: true });
  assert.equal((await f.run()).status, 500);
  assert.deepEqual(f.events, ["auth", "audit"]);
});
test("authorized request records actor then invokes worker", async () => {
  const f = harness();
  const response = await f.run();
  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(f.events, ["auth", "audit", "worker"]);
});
test("live provider evidence prevents cancellation", async () => {
  const f = harness({ live: true, exerciseProvider: true });
  assert.equal((await f.run()).status, 500);
  assert.equal(f.events.includes("provider-cancel"), false);
});
for (const outcome of ["blocked", "unresolved"]) {
  test("worker outcome is not reported as success: " + outcome, async () => {
    const response = await harness({ outcome }).run();
    assert.equal(response.status, 409);
    assert.equal(response.body.success, false);
  });
}
