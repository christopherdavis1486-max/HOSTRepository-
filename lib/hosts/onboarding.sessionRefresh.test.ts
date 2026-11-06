import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

function harness(data: any, refreshFails = false, consent = true) {
  const page = fs.readFileSync(
    "app/host/onboarding/connect-account/page.tsx", "utf8");
  const start = page.indexOf("  const handleContinue = async (");
  const end = page.indexOf("\n  return (", start);
  assert.ok(start >= 0 && end > start, "Submit handler boundary missing");
  const events: string[] = [];
  let state = "", error: string | null = null, destination = "";
  const context: any = {
    hostAgreementAccepted: consent, defaultPoliciesAccepted: consent,
    ht: (value: string) => value,
    setState: (value: string) => {state = value;},
    setErrorMessage: (value: string | null) => {error = value;},
    fetch: async (_url: string, options: any) => {
      events.push("request");
      const body = JSON.parse(options.body);
      assert.equal(body.hostAgreementAccepted, true);
      assert.equal(body.defaultPoliciesAccepted, true);
      assert.equal("roles" in body, false);
      return {json: async () => data};
    },
    update: async (...args: any[]) => {
      events.push("refresh");
      assert.equal(args.length, 0, "Do not submit client role claims");
      if (refreshFails) throw new Error("Fixture refresh failure");
      return {user: {id: "fixture-user", roles: ["guest", "host"]}};
    },
    window: {location: {
      set href(value: string) {events.push("redirect"); destination = value;}
    }}
  };
  vm.runInNewContext(stripTypeScriptTypes(page.slice(start, end)) +
    "\nglobalThis.submit = handleContinue;", context);
  return {
    events,
    submit: () => context.submit({preventDefault() {}}),
    result: () => ({state, error, destination})
  };
}

test("successful onboarding refreshes the session before redirecting", async () => {
  const h = harness({success: true, onboardingUrl: "https://example.test/setup"});
  await h.submit();
  assert.deepEqual(h.events, ["request", "refresh", "redirect"]);
  assert.equal(h.result().destination, "https://example.test/setup");
});

test("provider failure still refreshes roles and preserves the failure state", async () => {
  const h = harness({success: false, error: {
    code: "ONBOARDING_FAILED", message: "Fixture provider failure"
  }});
  await h.submit();
  assert.deepEqual(h.events, ["request", "refresh"]);
  assert.equal(h.result().state, "error");
  assert.equal(h.result().error, "Fixture provider failure");
  assert.equal(h.result().destination, "");
});

test("refresh failure prevents redirect and advises signing in again", async () => {
  const h = harness({success: true, onboardingUrl: "https://example.test/setup"}, true);
  await h.submit();
  assert.deepEqual(h.events, ["request", "refresh"]);
  assert.equal(h.result().state, "error");
  assert.match(h.result().error!, /Sign in again/);
  assert.equal(h.result().destination, "");
});

test("missing consent invokes neither onboarding nor session refresh", async () => {
  const h = harness({success: true}, false, false);
  await h.submit();
  assert.deepEqual(h.events, []);
  assert.match(h.result().error!, /Accept both/);
});

test("resuming uses the consent page instead of a consent-free POST", () => {
  const page = fs.readFileSync(
    "app/host/onboarding/complete/page.tsx", "utf8");
  assert.match(page, /href="\/host\/onboarding\/connect-account"/);
  assert.doesNotMatch(page, /const handleResume/);
  assert.doesNotMatch(page, /method: "POST"/);
});
