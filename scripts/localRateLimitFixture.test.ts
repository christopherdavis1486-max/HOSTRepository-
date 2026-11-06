import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFixture } = require("./localRateLimitFixture.cjs");
const { Redis } = require("@upstash/redis/cloudflare");
const { Ratelimit } = require("@upstash/ratelimit");
const hash = "977fb636fb5ceb7e98a96d1b3a1272ba018efdae";

async function withFixture(run: (url: string, fixture: any) => Promise<void>) {
  const fixture = createFixture();
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  try {
    await run(`http://127.0.0.1:${fixture.server.address().port}`, fixture);
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((error: Error | undefined) =>
        error ? reject(error) : resolve()));
  }
}

async function post(url: string, body: unknown, route = "/") {
  const response = await fetch(url + route, {
    method: "POST",
    headers: {
      authorization: "Bearer local-fixture-only",
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, body: await response.json() };
}

function command(id: string, now: number) {
  const bucket = Math.floor(now / 1000);
  return ["evalsha", hash, 3, `host:test:${id}:${bucket}`,
    `host:test:${id}:${bucket - 1}`, "", 5, now, 1000, 1];
}

test("installed client enforces five requests and isolates identifiers", async () => {
  await withFixture(async (url, fixture) => {
    const redis = new Redis({ url, token: "local-fixture-only" });
    const limiter = new Ratelimit({
      redis, limiter: Ratelimit.slidingWindow(5, "15 m"),
      prefix: "host:compatibility", ephemeralCache: false
    });
    for (let i = 1; i <= 6; i++) {
      const result = await limiter.limit("first");
      await result.pending;
      assert.equal(result.success, i <= 5);
      assert.equal(result.remaining, Math.max(0, 5 - i));
      assert.notEqual(result.reason, "timeout");
    }
    const separate = await limiter.limit("second");
    await separate.pending;
    assert.equal(separate.success, true);
    assert.notEqual(separate.reason, "timeout");
    assert.deepEqual(fixture.stats(), { commands: 7, rejected: 0 });
  });
});

test("previous-window weighting blocks at rollover and decays afterward", async () => {
  await withFixture(async url => {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual((await post(url, command("rollover", 1999))).body,
        { result: [4 - i, 5] });
    }
    assert.deepEqual((await post(url, command("rollover", 2000))).body,
      { result: [-1, 5] });
    assert.deepEqual((await post(url, command("rollover", 2500))).body,
      { result: [2, 5] });
    assert.deepEqual((await post(url, command("rollover", 3000))).body,
      { result: [3, 5] });
    assert.deepEqual((await post(url, command("rollover", 6000))).body,
      { result: [4, 5] });
  });
});

test("unsupported commands and parameters are rejected without consuming allowance", async () => {
  await withFixture(async (url, fixture) => {
    const valid = command("rejections", 1000);
    const badHash = [...valid]; badHash[1] = "unknown-script";
    const badKeys = [...valid]; badKeys[2] = 2;
    const badNamespace = [...valid]; badNamespace[3] = "other:key";
    const dynamic = [...valid]; dynamic[5] = "host:dynamic";
    const badIncrement = [...valid]; badIncrement[9] = 0;
    for (const input of [
      ["flushall"], badHash, badKeys, badNamespace, dynamic, badIncrement
    ]) {
      const result = await post(url, input);
      assert.equal(result.status, 200);
      assert.equal(typeof result.body.error, "string");
    }
    assert.deepEqual((await post(url, valid)).body, { result: [4, 5] });
    assert.deepEqual(fixture.stats(), { commands: 7, rejected: 6 });
  });
});

test("HTTP authentication, malformed JSON and pipeline limits are enforced", async () => {
  await withFixture(async url => {
    const unauthenticated = await fetch(url, {
      method: "POST", body: "[]", signal: AbortSignal.timeout(5000)
    });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const malformed = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer local-fixture-only" },
      body: "{", signal: AbortSignal.timeout(5000)
    });
    assert.equal(malformed.status, 400);
    await malformed.text();

    assert.equal((await post(url, Array(21).fill(["get", "x"]),
      "/pipeline")).status, 400);
    const pipeline = await post(url, [
      command("pipeline", 1000), command("pipeline", 1000)
    ], "/pipeline");
    assert.equal(pipeline.status, 200);
    assert.deepEqual(pipeline.body, [
      { result: [4, 5] }, { result: [3, 5] }
    ]);
  });
});
