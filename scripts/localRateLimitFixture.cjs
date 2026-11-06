"use strict";

// Local test fixture only. Not a Redis server or production limiter.
const http = require("node:http");
const crypto = require("node:crypto");

const SCRIPT_HASH = "977fb636fb5ceb7e98a96d1b3a1272ba018efdae";

function createFixture() {
  const buckets = new Map();
  let commands = 0;
  let rejected = 0;

  function execute(command) {
    commands++;
    try {
      if (!Array.isArray(command)) throw new Error("Expected command array");
      const [operation, script, keyCount, ...rest] = command;
      const op = String(operation).toLowerCase();
      if (!["evalsha", "eval"].includes(op)) {
        throw new Error("Unsupported Redis command");
      }
      const hash = op === "evalsha" ? String(script) :
        crypto.createHash("sha1").update(String(script)).digest("hex");
      if (hash !== SCRIPT_HASH) throw new Error("Unsupported Lua script");
      if (Number(keyCount) !== 3 || rest.length !== 7) {
        throw new Error("Unexpected sliding-window arguments");
      }

      const [currentKey, previousKey, dynamicKey, limitValue,
        timeValue, windowValue, incrementValue] = rest;
      const limit = Number(limitValue);
      const now = Number(timeValue);
      const window = Number(windowValue);
      const increment = Number(incrementValue);
      if (![currentKey, previousKey].every(key =>
        typeof key === "string" && key.startsWith("host:"))) {
        throw new Error("Unexpected key namespace");
      }
      if (dynamicKey !== "" ||
          !Number.isInteger(limit) || limit < 1 ||
          !Number.isSafeInteger(now) || now < 0 ||
          !Number.isSafeInteger(window) || window < 1 ||
          !Number.isInteger(increment) || increment < 1) {
        throw new Error("Unsupported limiter parameters");
      }

      function read(key) {
        const bucket = buckets.get(key);
        if (!bucket || bucket.expires <= now) {
          buckets.delete(key);
          return 0;
        }
        return bucket.count;
      }
      const current = read(currentKey);
      const previous = Math.floor((1 - (now % window) / window) * read(previousKey));
      if (current + previous >= limit) return { result: [-1, limit] };

      const count = current + increment;
      const existing = buckets.get(currentKey);
      buckets.set(currentKey, {
        count,
        expires: existing?.expires ?? now + window * 2 + 1000
      });
      return { result: [limit - count - previous, limit] };
    } catch (error) {
      rejected++;
      return { error: error.message };
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST" ||
        !["/", "/pipeline"].includes(request.url)) {
      response.writeHead(404).end(JSON.stringify({ error: "Unsupported request" }));
      return;
    }
    if (request.headers.authorization !== "Bearer local-fixture-only") {
      response.writeHead(401).end(JSON.stringify({ error: "Fixture token required" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw new Error("Request too large");
      }
      const input = JSON.parse(body);
      if (request.url === "/pipeline" &&
          (!Array.isArray(input) || input.length > 20)) {
        throw new Error("Invalid pipeline");
      }
      const result = request.url === "/pipeline"
        ? input.map(execute) : execute(input);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });

  return { server, stats: () => ({ commands, rejected }) };
}

module.exports = { createFixture };

if (require.main === module) {
  const { server } = createFixture();
  server.listen(8079, "127.0.0.1", () => {
    console.log("LOCAL TEST FIXTURE: http://127.0.0.1:8079");
  });
}
