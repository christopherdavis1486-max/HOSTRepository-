import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import {
  hostOnboardingStartSchema, validationErrorResponse
} from "../validation/schemas";

function load(file: string, context: any, expose: string) {
  const source = fs.readFileSync(file, "utf8")
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "")
    .replace(/^export /gm, "");
  vm.runInNewContext(
    stripTypeScriptTypes(source) + "\n" + expose, Object.assign(context, { Error })
  );
}

for (const failure of ["account", "link", "success"] as const) {
  test(`fresh guest onboarding joined flow: ${failure}`, async () => {
    let profile: any = null;
    const events: string[] = [];
    let clientState = "";
    let clientError = "";
    let redirects = 0;
    let redirectUrl = "";
    let refreshedSession: any;

    const db = { query: async (sql: string, args: any[]) => {
      if (sql.startsWith("SELECT id FROM host_profiles")) {
        assert.equal(args[0], "fixture-user");
        return { rows: profile ? [{ id: profile.id }] : [] };
      }
      if (sql.startsWith("INSERT INTO host_profiles")) {
        assert.equal(profile, null);
        assert.equal(args[0], "fixture-user");
        assert.match(sql, /'unverified', 'not_connected'/);
        profile = { id: "fixture-host", account: null, agreement: null };
        events.push("profile");
        return { rows: [{ id: profile.id }] };
      }
      if (sql.includes("SET host_agreement_version")) {
        assert.equal(args[0], profile.id);
        assert.equal(args[1], "pilot-2026-09");
        profile.agreement = args[1];
        events.push("agreement");
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT stripe_connect_account_id")) {
        assert.equal(args[0], profile.id);
        return { rows: [{ stripe_connect_account_id: profile.account }] };
      }
      if (sql.startsWith("UPDATE host_profiles SET stripe_connect_account_id")) {
        assert.equal(args[0], profile.id);
        profile.account = args[1];
        events.push("save-account");
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT role FROM admin_roles")) {
        assert.equal(args[0], "fixture-user");
        return { rows: [] };
      }
      throw new Error("Unexpected database query: " + sql);
    }};

    const service: any = {
      db,
      stripe: { v2: { core: {
        accounts: { create: async () => {
          events.push("provider-account");
          assert.equal(profile.agreement, "pilot-2026-09");
          if (failure === "account") throw new Error("Mock account failure");
          return { id: "acct_fixture" };
        }},
        accountLinks: { create: async () => {
          events.push("provider-link");
          assert.equal(profile.account, "acct_fixture");
          if (failure === "link") throw new Error("Mock link failure");
          return { url: "https://example.test/onboarding" };
        }}
      }}}
    };
    load("lib/hosts/onboarding.ts", service,
      "globalThis.api = {ensureHostProfile, recordHostAgreementAcceptance, startHostConnectOnboarding};");

    const auth: any = {
      db, process: { env: {} },
      CredentialsProvider: (options: any) => options,
      GoogleProvider: () => { throw new Error("Unexpected OAuth"); }
    };
    load("lib/auth/authOptions.ts", auth,
      "globalThis.callbacks = authOptions.callbacks;");
    const token: any = {
      userId: "fixture-user", roles: ["guest"],
      hostProfileId: null, adminRole: null,
      sessionId: "original-session", sessionVersion: 7
    };

    class FixtureAuthError extends Error {}
    const route: any = {
      ...service.api,
      AuthError: FixtureAuthError,
      requireSession: async () => ({ user: {
        id: "fixture-user", email: "fixture@example.test", roles: ["guest"]
      }}),
      hostOnboardingStartSchema, validationErrorResponse,
      process: { env: { APP_URL: "http://localhost:3000" } },
      console: { error: () => {} },
      NextResponse: { json: (body: any, options: any = {}) => ({
        body, status: options.status ?? 200
      })}
    };
    load("app/api/hosts/onboarding/connect-account/route.ts", route,
      "globalThis.handler = POST;");

    const client: any = {
      hostAgreementAccepted: true, defaultPoliciesAccepted: true,
      ht: (text: string) => text,
      setState: (value: string) => { clientState = value; },
      setErrorMessage: (value: string) => { clientError = value; },
      fetch: async (url: string, options: any) => {
        assert.equal(url, "/api/hosts/onboarding/connect-account");
        const body = JSON.parse(options.body);
        assert.equal(body.hostAgreementAccepted, true);
        assert.equal(body.defaultPoliciesAccepted, true);
        assert.equal("roles" in body, false);
        const response = await route.handler({
          nextUrl: { origin: "http://localhost:3000" },
          json: async () => body
        });
        assert.equal(response.status, failure === "success" ? 200 : 400);
        if (failure === "success") {
          assert.equal(response.body.success, true);
          assert.equal(response.body.onboardingUrl, "https://example.test/onboarding");
        } else {
          assert.equal(response.body.error.code, "ONBOARDING_FAILED");
        }
        return { json: async () => response.body };
      },
      update: async (...args: any[]) => {
        assert.equal(args.length, 0);
        events.push("refresh");
        const result = await auth.callbacks.jwt({ token, trigger: "update" });
        refreshedSession = await auth.callbacks.session({
          session: { user: { email: "fixture@example.test" } }, token: result
        });
        return refreshedSession;
      },
      window: { location: {
        set href(value: string) {
          assert.equal(events[events.length - 1], "refresh");
          assert.equal(refreshedSession.user.hostProfileId, profile.id);
          assert.ok(refreshedSession.user.roles.includes("host"));
          redirects++;
          redirectUrl = value;
          events.push("redirect");
        }
      }}
    };
    const page = fs.readFileSync(
      "app/host/onboarding/connect-account/page.tsx", "utf8"
    );
    const start = page.indexOf("  const handleContinue = async (");
    const end = page.indexOf("\n  return (", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(
      stripTypeScriptTypes(page.slice(start, end)) +
      "\nglobalThis.submit = handleContinue;", client
    );

    await client.submit({ preventDefault() {} });

    assert.equal(clientState, failure === "success" ? "starting" : "error");
    assert.equal(clientError, failure === "success" ? null : `Mock ${failure} failure`);
    assert.equal(redirects, failure === "success" ? 1 : 0);
    assert.equal(redirectUrl, failure === "success" ? "https://example.test/onboarding" : "");
    assert.equal(profile.agreement, "pilot-2026-09");
    assert.deepEqual(
      JSON.parse(JSON.stringify(refreshedSession.user.roles)),
      ["guest", "host"]
    );
    assert.equal(refreshedSession.user.hostProfileId, profile.id);
    assert.equal(refreshedSession.user.adminRole, null);
    assert.equal(refreshedSession.user.sessionId, "original-session");
    assert.equal(refreshedSession.user.sessionVersion, 7);
    assert.deepEqual(events, failure === "account"
      ? ["profile", "agreement", "provider-account", "refresh"]
      : failure === "link"
        ? ["profile", "agreement", "provider-account", "save-account",
           "provider-link", "refresh"]
        : ["profile", "agreement", "provider-account", "save-account",
           "provider-link", "refresh", "redirect"]);
  });
}
