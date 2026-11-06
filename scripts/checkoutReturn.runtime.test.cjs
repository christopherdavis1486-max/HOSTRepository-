const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");
const React = require("react");
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://localhost:3001"
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require("react-dom/client");

const filename = "app/checkout/[bookingId]/return/page.tsx";
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

const id = "8c57fd26-6403-434b-8e08-6c279b867345";
const booking = {
  id,
  status: "pending_payment",
  guestPaymentStatus: "payment_method_needed",
  checkIn: "2026-11-11",
  checkOut: "2026-11-13"
};
const good = () => ({
  ok: true,
  json: async () => ({ success: true, booking })
});
const gt = key => key;

async function check(name, respond, expected) {
  const intervals = new Map();
  const signals = [];
  let nextTimer = 1;
  let requests = 0;
  const mod = { exports: {} };
  const context = {
    module: mod,
    exports: mod.exports,
    AbortController,
    console,
    require(name) {
      if (name === "react" || name === "react/jsx-runtime") {
        return require(name);
      }
      if (name === "@/components/CustomerNav") {
        return { CustomerNav: () => null };
      }
      if (name === "@/lib/i18n/useGuestI18n") {
        return { useGuestI18n: () => ({ gt }) };
      }
      if (name === "@/lib/presentation/formatters") {
        return {
          formatDate: String,
          formatStatus: String,
          formatCurrency: String
        };
      }
      throw new Error("Unexpected import: " + name);
    },
    setInterval(callback, delay) {
      assert.equal(delay, 2000);
      const timer = nextTimer++;
      intervals.set(timer, callback);
      return timer;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
    async fetch(url, options) {
      assert.equal(url, "/api/bookings/" + id);
      assert.equal(options.credentials, "include");
      signals.push(options.signal);
      requests++;
      return respond(requests);
    }
  };
  vm.runInNewContext(compiled, context, { filename });
  const container = document.getElementById("root");
  const root = createRoot(container);

  try {
    await React.act(async () => {
      root.render(React.createElement(mod.exports.default, {
        params: Promise.resolve({ bookingId: id })
      }));
    });

    for (let tick = 0; tick < 16; tick++) {
      await React.act(async () => {
        for (const callback of [...intervals.values()]) callback();
      });
    }

    assert.equal(intervals.size, 0, "Polling must stop");
    assert.ok(container.textContent.includes(expected),
      "Expected guidance missing: " + expected);
    assert.ok(!container.textContent.includes("confirmingPayment"),
      "Loading message must disappear");
    assert.ok(!container.textContent.includes("PRIVATE_ERROR"),
      "Raw server errors must not appear");

    const count = requests;
    for (let tick = 0; tick < 5; tick++) {
      await React.act(async () => {
        for (const callback of [...intervals.values()]) callback();
      });
    }
    assert.equal(requests, count, "Requests continued after timeout");

    if (expected.includes("couldn't load")) {
      assert.equal(
        container.querySelector('a[href="/trips"]')?.textContent,
        "Open My Trips"
      );
    }
  } finally {
    await React.act(async () => root.unmount());
    assert.equal(intervals.size, 0);
    assert.ok(signals.every(signal => signal.aborted),
      "Unmount must abort outstanding requests");
  }
  console.log("PASS: " + name);
}

(async () => {
  const fallback = "We couldn't load your booking";

  for (const status of [401, 403, 404, 500]) {
    await check("HTTP " + status + " reaches safe fallback", async () => ({
      ok: false,
      status,
      json: async () => ({
        success: true,
        booking,
        message: "PRIVATE_ERROR"
      })
    }), fallback);
  }

  await check("network failure reaches safe fallback", async () => {
    throw new Error("PRIVATE_ERROR");
  }, fallback);

  await check("invalid JSON reaches safe fallback", async () => ({
    ok: true,
    json: async () => { throw new Error("PRIVATE_ERROR"); }
  }), fallback);

  for (const data of [
    { success: false, message: "PRIVATE_ERROR" },
    { success: true, booking: null },
    { success: true, booking: { id, status: 123 } },
    { success: true, booking: { ...booking, id: "wrong-booking" } }
  ]) {
    await check("invalid booking response is rejected", async () => ({
      ok: true,
      json: async () => data
    }), fallback);
  }

  await check("pending booking retains payment timeout guidance",
    async () => good(),
    "Check your trip status before trying to pay again.");

  await check("temporary failure can recover to a valid booking",
    async count => {
      if (count === 1) throw new Error("temporary failure");
      return good();
    },
    "Check your trip status before trying to pay again.");

  console.log("12 component scenarios passed.");
  console.log("Simulated only; no network or database access.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => dom.window.close());
