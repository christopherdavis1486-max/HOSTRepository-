import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

function harness(replies: any[], account: any = {}) {
  const queries: {sql: string; args: any[]}[] = [];
  const creates: any[] = [];
  const links: any[] = [];
  const retrieves: any[] = [];
  const remaining = [...replies];
  const context: any = {
    db: {query: async (sql: string, args: any[]) => {
      queries.push({sql, args});
      assert.ok(remaining.length > 0, "Unexpected database query");
      return remaining.shift();
    }},
    stripe: {v2: {core: {
      accounts: {
        create: async (input: any) => {
          creates.push(input);
          return {id: "acct_fixture_new"};
        },
        retrieve: async (...args: any[]) => {
          retrieves.push(args);
          return account;
        }
      },
      accountLinks: {create: async (input: any) => {
        links.push(input);
        return {url: "https://example.test/onboarding"};
      }}
    }}}
  };
  const original = fs.readFileSync("lib/hosts/onboarding.ts", "utf8");
  const executable = stripTypeScriptTypes(
    original.replace(/^import .*;\r?\n/gm, "")
      .replace(/^export /gm, "")
  );
  vm.runInNewContext(executable + `
    globalThis.api = {
      ensureHostProfile, recordHostAgreementAcceptance,
      startHostConnectOnboarding, getHostOnboardingStatus,
      computeReadinessStatus
    };
  `, context);
  return {
    api: context.api, queries, creates, links, retrieves,
    done: () => assert.equal(remaining.length, 0)
  };
}

test("existing profile is reused and a missing profile is created unverified", async () => {
  const existing = harness([{rows: [{id: "host-existing"}]}]);
  assert.equal(await existing.api.ensureHostProfile("user-fixture"), "host-existing");
  assert.equal(existing.queries.length, 1);
  assert.equal(existing.queries[0].args[0], "user-fixture");
  existing.done();

  const fresh = harness([{rows: []}, {rows: [{id: "host-new"}]}]);
  assert.equal(await fresh.api.ensureHostProfile("user-fixture"), "host-new");
  assert.match(fresh.queries[1].sql, /'unverified', 'not_connected'/);
  assert.equal(fresh.queries[1].args[0], "user-fixture");
  fresh.done();
});

test("agreement acceptance records server version and timestamps and rejects missing profile", async () => {
  const h = harness([{rowCount: 1}]);
  await h.api.recordHostAgreementAcceptance("host-fixture");
  assert.equal(h.queries[0].args[0], "host-fixture");
  assert.equal(h.queries[0].args[1], "pilot-2026-09");
  assert.match(h.queries[0].sql, /host_agreement_accepted_at = NOW\(\)/);
  assert.match(h.queries[0].sql, /default_policies_accepted_at = NOW\(\)/);
  h.done();

  const absent = harness([{rowCount: 0}]);
  await assert.rejects(
    absent.api.recordHostAgreementAcceptance("missing"),
    /Host profile not found/
  );
  absent.done();
});

test("new Stripe account uses recipient configuration and is saved before link creation", async () => {
  const h = harness([
    {rows: [{stripe_connect_account_id: null}]},
    {rowCount: 1}
  ]);
  const result = await h.api.startHostConnectOnboarding(
    "host-fixture", "GB", "host@example.test",
    "https://example.test/complete", "https://example.test/refresh"
  );
  assert.equal(result.accountId, "acct_fixture_new");
  assert.equal(result.onboardingUrl, "https://example.test/onboarding");
  assert.equal(h.creates.length, 1);
  const payload = h.creates[0];
  assert.equal(payload.identity.country, "gb");
  assert.equal(payload.identity.entity_type, "individual");
  assert.equal(payload.configuration.merchant, undefined);
  assert.equal(payload.configuration.recipient.capabilities
    .stripe_balance.stripe_transfers.requested, true);
  assert.equal(payload.defaults.currency, "gbp");
  assert.equal(h.queries[1].args[1], "acct_fixture_new");
  assert.match(h.queries[1].sql, /payout_account_status = 'pending'/);
  assert.equal(h.links[0].account, "acct_fixture_new");
  assert.equal(h.links[0].use_case.account_onboarding.return_url,
    "https://example.test/complete");
  h.done();
});

test("stored Stripe account is reused and missing host invokes no Stripe calls", async () => {
  const h = harness([{rows: [{stripe_connect_account_id: "acct_existing"}]}]);
  await h.api.startHostConnectOnboarding(
    "host-fixture", "GB", "host@example.test",
    "https://example.test/complete", "https://example.test/refresh"
  );
  assert.equal(h.creates.length, 0);
  assert.equal(h.links.length, 1);
  assert.equal(h.links[0].account, "acct_existing");
  assert.equal(h.queries.length, 1);
  h.done();

  const absent = harness([{rows: []}]);
  await assert.rejects(absent.api.startHostConnectOnboarding(
    "missing", "GB", "host@example.test", "return", "refresh"
  ), /Host profile not found/);
  assert.equal(absent.creates.length, 0);
  assert.equal(absent.links.length, 0);
  absent.done();
});

test("status refresh checks recipient capability and only writes changed status", async () => {
  const active = {configuration: {recipient: {
    applied: true,
    capabilities: {stripe_balance: {stripe_transfers: {status: "active"}}}
  }}};
  const h = harness([
    {rows: [{stripe_connect_account_id: "acct_existing",
      payout_account_status: "pending"}]},
    {rowCount: 1}
  ], active);
  assert.equal((await h.api.getHostOnboardingStatus("host-fixture")).status,
    "active");
  assert.equal(h.retrieves[0][0], "acct_existing");
  assert.equal(h.retrieves[0][1].include[0], "configuration.recipient");
  assert.equal(h.queries[1].args[1], "active");
  assert.equal(h.api.computeReadinessStatus({}), "not_connected");
  assert.equal(h.api.computeReadinessStatus({
    configuration: {recipient: {applied: true}}
  }), "pending");
  h.done();

  const unchanged = harness([{rows: [{
    stripe_connect_account_id: "acct_existing", payout_account_status: "active"
  }]}], active);
  assert.equal((await unchanged.api.getHostOnboardingStatus("host-fixture"))
    .status, "active");
  assert.equal(unchanged.queries.length, 1);
  unchanged.done();

  const disconnected = harness([{rows: [{
    stripe_connect_account_id: null, payout_account_status: "not_connected"
  }]}]);
  assert.equal((await disconnected.api.getHostOnboardingStatus("host-fixture"))
    .status, "not_connected");
  assert.equal(disconnected.retrieves.length, 0);
  disconnected.done();
});
