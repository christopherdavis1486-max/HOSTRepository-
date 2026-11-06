
import { mock, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";

const sdk = new Stripe("sk_test_local_webhook_readiness");
let blockedProviderCalls = 0;

function blockedResource(path) {
  return new Proxy(function () {}, {
    get(_target, key) {
      return blockedResource(path + "." + String(key));
    },
    apply() {
      blockedProviderCalls++;
      throw new Error("Unexpected Stripe call blocked by readiness mock: " + path);
    },
  });
}

const stripe = new Proxy({ webhooks: sdk.webhooks }, {
  get(target, key) {
    if (key === "webhooks") return target.webhooks;
    return blockedResource("stripe." + String(key));
  },
});

mock.module(new URL("../payments/stripeClient.ts", import.meta.url).href, {
  namedExports: { stripe },
});

mock.module(new URL("../notifications/emailProvider.ts", import.meta.url).href, {
  namedExports: { sendEmail: async () => {} },
});

after(() => {
  assert.equal(blockedProviderCalls, 0,
    "Selected webhook suites must not attempt provider network operations");
});
