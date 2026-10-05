import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

// Execute the actual provider and notification code with isolated adapters.
// No real email, credentials, database or network is used.
function harness(options: { result?: unknown; thrown?: string; missingKey?: boolean; optedOut?: boolean } = {}) {
  const sends: any[] = [];
  const queries: { sql: string; args: any[] }[] = [];
  let constructions = 0;
  const context: any = {
    process: { env: { EMAIL_FROM_ADDRESS: "HOST <test@example.test>", ...(options.missingKey ? {} : { RESEND_API_KEY: "test-placeholder" }) } },
    Resend: class {
      constructor() { constructions++; }
      emails = { send: async (input: any) => {
        sends.push(input);
        if (options.thrown) throw new Error(options.thrown);
        return options.result ?? { data: { id: "email-test-id" }, error: null };
      } };
    },
    db: { query: async (sql: string, args: any[]) => {
      queries.push({ sql, args });
      if (sql.startsWith("SELECT email, push")) return { rows: [{ email: !options.optedOut }] };
      if (sql.startsWith("SELECT email FROM users")) return { rows: [{ email: "guest@example.test" }] };
      return { rows: [{ id: "notification-test-id" }] };
    } },
    renderNotification: () => ({ subject: "Booking cancelled", body: "Local test notification" }),
    console: { error: () => {} },
  };
  for (const name of ["emailProvider", "sendNotification"]) {
    const source = fs.readFileSync(`lib/notifications/${name}.ts`, "utf8")
      .replace(/^import .*;\r?\n/gm, "")
      .replace(/export async function /g, "async function ");
    vm.runInNewContext(stripTypeScriptTypes(source), context);
  }
  return { context, sends, queries, constructions: () => constructions };
}

test("missing configuration fails at send time without constructing a client during import", async () => {
  const h = harness({ missingKey: true });
  assert.equal(h.constructions(), 0);
  await assert.rejects(h.context.sendEmail("guest@example.test", "Test", "Body"), /RESEND_API_KEY is not configured/);
  assert.equal(h.sends.length, 0);
});

test("a resolved provider error is rejected rather than reported as success", async () => {
  const h = harness({ result: { data: null, error: { message: "Sender is not verified" } } });
  await assert.rejects(h.context.sendEmail("guest@example.test", "Test", "Body"), /Sender is not verified/);
});

test("a response without an accepted message id is rejected", async () => {
  const h = harness({ result: { data: {}, error: null } });
  await assert.rejects(h.context.sendEmail("guest@example.test", "Test", "Body"), /did not confirm acceptance/);
});

test("a network rejection still propagates", async () => {
  const h = harness({ thrown: "Network unavailable" });
  await assert.rejects(h.context.sendEmail("guest@example.test", "Test", "Body"), /Network unavailable/);
});

test("accepted email retains the original result and message fields", async () => {
  const h = harness();
  const result = await h.context.sendEmail("guest@example.test", "Test", "Body", { replyTo: "reply@example.test" });
  assert.equal(result.data.id, "email-test-id");
  assert.equal(h.sends[0].from, "HOST <test@example.test>");
  assert.equal(h.sends[0].to, "guest@example.test");
  assert.equal(h.sends[0].subject, "Test");
  assert.equal(h.sends[0].text, "Body");
  assert.equal(h.sends[0].replyTo, "reply@example.test");
});

test("notification provider rejection records failed while retaining the in-app notification", async () => {
  const h = harness({ result: { data: null, error: { message: "Sender rejected" } } });
  const result = await h.context.notifyUser("host-test-id", "host_booking_cancelled", {});
  assert.ok(result.inAppNotificationId);
  assert.ok(h.queries.some(q => q.sql.includes("'in_app'")));
  assert.ok(h.queries.some(q => q.sql.includes("SET status = 'failed'") && /Sender rejected/.test(q.args[1])));
  assert.equal(h.queries.some(q => q.sql.includes("SET status = 'sent'")), false);
});

test("accepted notification email is recorded as sent", async () => {
  const h = harness();
  await h.context.notifyUser("host-test-id", "host_booking_cancelled", {});
  assert.ok(h.queries.some(q => q.sql.includes("SET status = 'sent'")));
  assert.equal(h.queries.some(q => q.sql.includes("SET status = 'failed'")), false);
});

test("opting out of email still creates the in-app record without sending", async () => {
  const h = harness({ optedOut: true });
  await h.context.notifyUser("host-test-id", "host_booking_cancelled", {});
  assert.equal(h.sends.length, 0);
  assert.ok(h.queries.some(q => q.sql.includes("'in_app'")));
});
