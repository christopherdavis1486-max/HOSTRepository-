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

test("contact requests are validated and bounded", () => {
  const route = read("app/api/contact/route.ts");

  assert.match(route, /contentLength > 12000/);
  assert.match(route, /\.email\(\)\.max\(254\)/);
  assert.match(route, /message:[\s\S]*\.min\(10\)\.max\(3000\)/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /website: z\.string\(\)\.max\(200\)/);
});

test("contact email remains server-side and replyable", () => {
  const route = read("app/api/contact/route.ts");
  const provider = read(
    "lib/notifications/emailProvider.ts",
  );
  const env = read(".env.example");

  assert.match(
    route,
    /process\.env\.HOST_SUPPORT_EMAIL/,
  );
  assert.match(route, /replyTo: parsed\.data\.email/);
  assert.match(provider, /replyTo: options\?\.replyTo/);
  assert.match(env, /^HOST_SUPPORT_EMAIL=$/m);
  assert.doesNotMatch(env, /NEXT_PUBLIC_HOST_SUPPORT/);
});

test("contact endpoint has dedicated abuse protection", () => {
  const middleware = read("middleware.ts");

  assert.match(
    middleware,
    /Ratelimit\.slidingWindow\(5, "15 m"\)/,
  );
  assert.match(
    middleware,
    /prefix: "host:contact"/,
  );
  assert.match(
    middleware,
    /pathname === "\/api\/contact"/,
  );
  assert.match(
    middleware,
    /contactLimiter\.limit\(ip\)/,
  );
  assert.match(middleware, /contact:\$\{ip\}/);
  assert.match(
    middleware,
    /SECURITY_NOT_CONFIGURED/,
  );
});
