import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

test("rejects a cross-origin state-changing API request", async () => {
  const request = new NextRequest("http://localhost:3000/api/account/profile", {
    method: "PATCH", headers: { origin: "https://attacker.example" },
  });
  const response = await middleware(request);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "INVALID_ORIGIN");
});

test("accepts a same-origin state-changing API request", async () => {
  const request = new NextRequest("http://localhost:3000/api/account/profile", {
    method: "PATCH", headers: { origin: "http://localhost:3000" },
  });
  const response = await middleware(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("Stripe webhooks remain exempt from browser-origin enforcement", async () => {
  const response = await middleware(new NextRequest("http://localhost:3000/api/webhooks/stripe", { method: "POST" }));
  assert.equal(response.status, 200);
});

test("security headers are added to ordinary pages", async () => {
  const response = await middleware(new NextRequest("http://localhost:3000/account"));
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});
