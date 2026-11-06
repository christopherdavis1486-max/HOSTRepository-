import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";
import {
  hostOnboardingStartSchema, validationErrorResponse
} from "../validation/schemas";

class FixtureAuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function harness(options: {
  denied?: boolean;
  profile?: string | null;
} = {}) {
  const calls: {name: string; args: any[]}[] = [];
  const session = {user: {
    id: "session-user", email: "session@example.test",
    hostProfileId: options.profile === undefined ? "session-host" : options.profile
  }};
  const context: any = {
    process: {env: {APP_URL: "https://host.example.test"}},
    console: {error: () => {}},
    AuthError: FixtureAuthError,
    NextResponse: {json: (body: any, init?: any) => ({
      status: init?.status ?? 200, body
    })},
    hostOnboardingStartSchema,
    validationErrorResponse,
    requireSession: async () => {
      if (options.denied) throw new FixtureAuthError("Sign in required", 401);
      return session;
    },
    requireRole: async (role: string) => {
      calls.push({name: "role", args: [role]});
      if (options.denied) throw new FixtureAuthError("Host access required", 403);
      return session;
    },
    ensureHostProfile: async (...args: any[]) => {
      calls.push({name: "profile", args});
      return "resolved-host";
    },
    recordHostAgreementAcceptance: async (...args: any[]) => {
      calls.push({name: "agreement", args});
    },
    startHostConnectOnboarding: async (...args: any[]) => {
      calls.push({name: "connect", args});
      return {onboardingUrl: "https://stripe.example.test/fixture"};
    },
    getHostOnboardingStatus: async (...args: any[]) => {
      calls.push({name: "status", args});
      return {status: "pending"};
    }
  };
  for (const [route, handler] of [
    ["connect-account", "POST"], ["status", "GET"]
  ]) {
    const original = fs.readFileSync(
      "app/api/hosts/onboarding/" + route + "/route.ts", "utf8"
    );
    const executable = stripTypeScriptTypes(
      original.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "")
        .replace(/^export /gm, "")
    );
    vm.runInNewContext(
      executable + "\nglobalThis." + handler + "Handler = " + handler + ";",
      context
    );
  }
  return {context, calls};
}

const valid = {
  country: "GB", hostAgreementAccepted: true, defaultPoliciesAccepted: true
};
function request(body: any, malformed = false) {
  return {
    nextUrl: {origin: "https://request.example.test"},
    json: async () => {
      if (malformed) throw new Error("Invalid JSON");
      return body;
    }
  };
}

test("unauthenticated onboarding is rejected before service calls", async () => {
  const h = harness({denied: true});
  const response = await h.context.POSTHandler(request(valid));
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");
  assert.equal(h.calls.length, 0);
});

test("missing false and string consents are rejected before service calls", async () => {
  for (const field of ["hostAgreementAccepted", "defaultPoliciesAccepted"]) {
    for (const value of [undefined, false, "true"]) {
      const h = harness();
      const body = {...valid, [field]: value};
      const response = await h.context.POSTHandler(request(body));
      assert.equal(response.status, 400);
      assert.equal(h.calls.length, 0);
    }
  }
});

test("malformed JSON and non-GB country are rejected before service calls", async () => {
  for (const [body, malformed] of [
    [null, true], [{...valid, country: "US"}, false]
  ] as const) {
    const h = harness();
    const response = await h.context.POSTHandler(request(body, malformed));
    assert.equal(response.status, 400);
    assert.equal(h.calls.length, 0);
  }
});

test("valid onboarding uses session identity and records consent before connecting", async () => {
  const h = harness();
  const response = await h.context.POSTHandler(request({
    ...valid, country: " gb ",
    userId: "untrusted-user", hostProfileId: "untrusted-host",
    email: "untrusted@example.test", agreementVersion: "untrusted-version"
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.onboardingUrl, "https://stripe.example.test/fixture");
  assert.deepEqual(h.calls.map(row => row.name),
    ["profile", "agreement", "connect"]);
  assert.equal(h.calls[0].args[0], "session-user");
  assert.equal(h.calls[1].args[0], "resolved-host");
  const args = h.calls[2].args;
  assert.equal(args[0], "resolved-host");
  assert.equal(args[1], "GB");
  assert.equal(args[2], "session@example.test");
  assert.equal(args[3], "https://host.example.test/host/onboarding/complete");
  assert.equal(args[4], "https://host.example.test/host/onboarding/connect-account");
});

test("status requires host authorization and uses only the session profile", async () => {
  const denied = harness({denied: true});
  const rejected = await denied.context.GETHandler({});
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, "UNAUTHORIZED");
  assert.equal(denied.calls.some(row => row.name === "status"), false);

  const h = harness();
  const response = await h.context.GETHandler({
    hostProfileId: "untrusted-host"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "pending");
  assert.equal(h.calls[0].args[0], "host");
  assert.equal(h.calls[1].name, "status");
  assert.equal(h.calls[1].args[0], "session-host");
});

test("status without a session host profile returns disconnected without lookup", async () => {
  const h = harness({profile: null});
  const response = await h.context.GETHandler({});
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_connected");
  assert.equal(h.calls.some(row => row.name === "status"), false);
});
