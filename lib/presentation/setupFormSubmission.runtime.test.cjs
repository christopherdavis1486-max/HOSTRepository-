const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness(check, confirm = async () => ({ error: { message: "Test decline" } })) {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  let stripeCalls = 0;
  const dependencies = {
    react: {
      useState(initial) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = value; }];
      },
      useRef(initial) {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
    },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "@stripe/react-stripe-js": {
      PaymentElement: "PaymentElement",
      useStripe: () => ({
        async confirmSetup(options) {
          stripeCalls++;
          assert.equal(options.confirmParams.return_url, "https://staging.example/return");
          return confirm();
        },
      }),
      useElements: () => ({ fixture: true }),
    },
    "@/lib/i18n/config": { LOCALE_TAGS: { en: "en-GB" } },
    "@/lib/i18n/useGuestI18n": {
      useGuestI18n: () => ({ locale: "en", gt: key => key }),
    },
    "@/lib/presentation/setupSubmission": {
      checkSetupCheckoutSubmission: check,
    },
  };
  const code = ts.transpileModule(
    fs.readFileSync("components/SetupIntentForm.tsx", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    } }
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (!(name in dependencies)) throw new Error("Unexpected import: " + name);
      return dependencies[name];
    },
  });
  function render() {
    stateIndex = 0;
    refIndex = 0;
    return module.exports.default({
      bookingId: "test-booking",
      returnUrl: "https://staging.example/return",
      isTestMode: true,
    });
  }
  function find(node, predicate) {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const initial = render();
  find(initial, node => node.type === "PaymentElement").props.onReady();
  return {
    submit: () => render().props.onSubmit({ preventDefault() {} }),
    calls: () => stripeCalls,
    error: () => states[1],
    submitting: () => states[0],
  };
}

test("setup form: blocked eligibility never calls Stripe and displays guidance", async () => {
  const form = harness(async () => ({ allowed: false, message: "Hold expired" }));
  await form.submit();
  assert.equal(form.calls(), 0);
  assert.equal(form.error(), "Hold expired");
  assert.equal(form.submitting(), false);
});

test("setup form: active eligibility reaches Stripe once", async () => {
  const form = harness(async () => ({ allowed: true }));
  await form.submit();
  assert.equal(form.calls(), 1);
  assert.equal(form.error(), "Test decline");
  assert.equal(form.submitting(), false);
});

test("setup form: confirmation waits for the fresh eligibility response", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const form = harness(() => pending);
  const submission = form.submit();
  assert.equal(form.calls(), 0);
  resolve({ allowed: false, message: "Booking cancelled" });
  await submission;
  assert.equal(form.calls(), 0);
});

test("setup form: repeated clicks during the eligibility check cannot duplicate confirmation", async () => {
  let resolve;
  let checks = 0;
  const pending = new Promise(done => { resolve = done; });
  const form = harness(() => { checks++; return pending; });
  const first = form.submit();
  await form.submit();
  assert.equal(checks, 1);
  resolve({ allowed: true });
  await first;
  assert.equal(form.calls(), 1);
});

test("setup form: repeated clicks during Stripe confirmation cannot duplicate confirmation", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const form = harness(async () => ({ allowed: true }), () => pending);
  const first = form.submit();
  await Promise.resolve();
  await form.submit();
  assert.equal(form.calls(), 1);
  resolve({ error: { message: "Test decline" } });
  await first;
  assert.equal(form.calls(), 1);
});

test("setup form: unexpected verification failure blocks Stripe and releases the busy state", async () => {
  const form = harness(async () => { throw new Error("Verification failed"); });
  await form.submit();
  assert.equal(form.calls(), 0);
  assert.equal(form.submitting(), false);
  assert.match(form.error(), /Check My Trips/);
});

test("setup form: uncertain Stripe exception displays review guidance without automatic replay", async () => {
  const form = harness(
    async () => ({ allowed: true }),
    async () => { throw new Error("Connection lost"); }
  );
  await form.submit();
  assert.equal(form.calls(), 1);
  assert.equal(form.submitting(), false);
  assert.match(form.error(), /Check My Trips/);
});
