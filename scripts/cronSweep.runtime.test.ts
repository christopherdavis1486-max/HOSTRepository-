import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(failure = "", secret: string | undefined = "fixture-secret") {
  const calls: string[] = [];
  const job = (name: string, result: unknown) => async () => {
    calls.push(name);
    if (failure === name) throw new Error("fixture failure");
    return result;
  };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/booking/createBooking": {
      findExpiredHoldBookingIds: job("holds", []),
      releaseExpiredHold: job("release", null),
    },
    "@/lib/notifications/scheduledNotifications": {
      sendCheckinReminders: job("reminders", 0),
      completeStaysAndRequestReviews: job("stays", 0),
    },
    "@/lib/notifications/sendNotification": {
      notifyUser: job("notify", undefined),
    },
    "@/lib/payments/scheduledCharges": {
      findBookingsDueForScheduledCharge: job("charges", []),
      attemptScheduledCharge: job("attempt", { attempted: false }),
    },
    "@/lib/db": { db: {
      query: job("sessions", { rows: [], rowCount: 0 }),
    } },
    "@/lib/privacy/retention": {
      purgeExpiredSecurityData: job("security", 0),
      executeDuePrivacyDeletions: job("privacy", 0),
    },
    "@/lib/calendar/calendarSync": {
      syncDueCalendarFeeds: job("calendar", {}),
    },
  };
  const source = fs.readFileSync("app/api/cron/sweep/route.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, {
    exports,
    process: { env: { CRON_SECRET: secret } },
    console: { error() {} },
    require(name: string) {
      assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name),
        "Unexpected dependency: " + name);
      return dependencies[name];
    },
  });
  return { get: exports.GET, calls };
}

const request = (authorization?: string) => new Request(
  "http://localhost/api/cron/sweep",
  { headers: authorization ? { authorization } : {} },
);
const jobs = ["holds", "reminders", "stays", "charges",
  "security", "sessions", "privacy", "calendar"];

test("sweep reports success when every job completes", async () => {
  const fixture = setup();
  const response = await fixture.get(request("Bearer fixture-secret"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.failedJobs, []);
  assert.deepEqual(fixture.calls, jobs);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

for (const [job, errorKey] of [
  ["holds", "expiredHoldsError"],
  ["reminders", "checkinRemindersError"],
  ["stays", "completedStaysError"],
  ["charges", "scheduledChargesError"],
  ["security", "expiredSecurityDataError"],
  ["sessions", "inactiveSessionsError"],
  ["privacy", "privacyDeletionsError"],
  ["calendar", "calendarSyncError"],
]) {
  test("sweep reports failure and continues other jobs: " + job, async () => {
    const fixture = setup(job);
    const response = await fixture.get(request("Bearer fixture-secret"));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.success, false);
    assert.deepEqual(body.failedJobs, [errorKey]);
    assert.equal(body.results[errorKey], "fixture failure");
    assert.deepEqual(fixture.calls, jobs);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  });
}

for (const authorization of [undefined, "Bearer wrong-secret"]) {
  test("sweep rejects unauthorized requests without running jobs: " +
    String(authorization), async () => {
    const fixture = setup();
    const response = await fixture.get(request(authorization));
    assert.equal(response.status, 401);
    assert.deepEqual(fixture.calls, []);
  });
}

test("sweep refuses an unconfigured secret without running jobs", async () => {
  const fixture = setup("", "");
  const response = await fixture.get(request());
  assert.equal(response.status, 503);
  assert.deepEqual(fixture.calls, []);
});
