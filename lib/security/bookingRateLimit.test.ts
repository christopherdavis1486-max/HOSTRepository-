import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

// Execute the actual middleware with isolated adapters, without network or secrets.
function harness(distributed = false, production = false, outage = false) {
  const counts = new Map<string, number>();
  class FakeRatelimit {
    options: any;
    constructor(options: any) { this.options = options; }
    static slidingWindow(maximum: number) { return maximum; }
    async limit(ip: string) {
      if (outage) throw new Error("fixture Redis unavailable");
      const key = this.options.prefix + ":" + ip;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= this.options.limiter };
    }
  }
  const source = fs.readFileSync("middleware.ts", "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export async function middleware", "async function middleware")
    .replace("export const config", "const config") +
    "\nglobalThis.runMiddleware = middleware;";
  const context: any = {
    process: { env: {
      NODE_ENV: production ? "production" : "development",
      ...(distributed ? { UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test" } : {})
    }},
    Redis: class {}, Ratelimit: FakeRatelimit, URL,
    NextResponse: {
      next: () => ({ status: 200, headers: new Headers() }),
      json: (body: unknown, options: any) => ({ status: options.status, body, headers: new Headers() })
    }
  };
  vm.runInNewContext(stripTypeScriptTypes(source), context);
  return async (path: string, method = "POST", origin = "http://localhost:3000") =>
    context.runMiddleware({
      method, nextUrl: new URL(path, "http://localhost:3000"),
      headers: new Headers({ origin, "x-forwarded-for": "127.0.0.1" })
    });
}
const root = "/api/bookings/3c391532-9c9e-4bc3-a63b-c10a0efe0d3f";
for (const distributed of [false, true]) {
  const mode = distributed ? "distributed" : "local";
  test(mode + ": 100 read receipts leave cancellation available", async () => {
    const request = harness(distributed);
    for (let i = 0; i < 100; i++) assert.equal((await request(root + "/messages/read")).status, 200);
    assert.equal((await request(root + "/cancel")).status, 200);
  });
  test(mode + ": payment and cancellation keep the shared financial limit", async () => {
    const request = harness(distributed);
    for (let i = 0; i < 20; i++)
      assert.equal((await request(i % 2 ? "/api/payments/intent" : root + "/cancel")).status, 200);
    assert.equal((await request("/api/bookings")).status, 429);
    assert.equal((await request(root + "/messages")).status, 200);
  });
  test(mode + ": non-financial activity remains limited independently", async () => {
    const request = harness(distributed);
    const actions = ["/messages", "/messages/read", "/archive", "/review"];
    for (let i = 0; i < 120; i++) assert.equal((await request(root + actions[i % 4])).status, 200);
    assert.equal((await request(root + "/messages")).status, 429);
    assert.equal((await request(root + "/discard")).status, 200);
  });
  test(mode + ": unknown actions remain financial and reads do not consume allowance", async () => {
    const request = harness(distributed);
    for (let i = 0; i < 30; i++) assert.equal((await request(root, "GET")).status, 200);
    for (let i = 0; i < 20; i++) assert.equal((await request(root + "/future-action")).status, 200);
    assert.equal((await request(root + "/cancel")).status, 429);
  });
}
test("activity retains origin protection and security headers", async () => {
  const response = await harness()(root + "/messages", "POST", "https://untrusted.example");
  assert.equal(response.status, 403);
  assert.ok(response.headers.get("Content-Security-Policy"));
});
test("production without distributed configuration fails closed", async () => {
  const request = harness(false, true);
  for (const path of [root + "/messages", root + "/cancel"])
    assert.equal((await request(path)).status, 503);
});

for (const distributed of [false, true]) {
  const mode = distributed ? "distributed" : "local";
  test(mode + ": credentials rate limiting returns a sign-in URL and keeps the 429 rejection", async () => {
    const request = harness(distributed);
    for (let i = 0; i < 5; i++) assert.equal((await request("/api/auth/callback/credentials")).status, 200);
    const rejected = await request("/api/auth/callback/credentials");
    assert.equal(rejected.status, 429);
    assert.equal(rejected.body.error.code, "RATE_LIMITED");
    const url = new URL(rejected.body.url);
    assert.equal(url.origin, "http://localhost:3000");
    assert.equal(url.pathname, "/login");
    assert.equal(url.searchParams.get("error"), "RateLimited");
    assert.equal((await request("/api/payments/intent")).status, 200);
  });
}

test("unconfigured production credentials security remains closed with readable sign-in feedback", async () => {
  const response = await harness(false, true)("/api/auth/callback/credentials");
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "SECURITY_NOT_CONFIGURED");
  assert.equal(new URL(response.body.url).searchParams.get("error"), "SecurityUnavailable");
});

test("ordinary API rate-limit responses keep their existing shape", async () => {
  const request = harness();
  for (let i = 0; i < 5; i++) await request("/api/auth/register");
  const rejected = await request("/api/auth/register");
  assert.equal(rejected.status, 429);
  assert.equal(rejected.body.url, undefined);
});

for (const [group, route] of [
  ["authentication", "/api/auth/callback/credentials"],
  ["financial", "/api/payments/intent"],
  ["booking activity", root + "/messages"],
  ["AI", "/api/ai/concierge"],
  ["contact", "/api/contact"],
  ["newsletter", "/api/newsletter"],
]) {
  test("Redis outage blocks " + group + " without local fallback", async () => {
    const request = harness(true, true, true);
    await assert.rejects(
      () => request(route),
      /fixture Redis unavailable/,
    );
  });
}

test("Redis outage does not block an ordinary page", async () => {
  const response = await harness(true, true, true)("/account", "GET");
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("Content-Security-Policy"));
});
