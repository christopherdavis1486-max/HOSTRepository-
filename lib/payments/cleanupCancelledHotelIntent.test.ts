import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { createBooking } from "../booking/createBooking";
import { cancelBooking } from "../booking/cancelBooking";
import { saveRoomType } from "../hotels/rooms";
import { cleanupCancelledHotelIntent } from "./cleanupCancelledHotelIntent";

after(async () => { await db.end(); });

async function fixture(cancelled = true) {
  const key = crypto.randomUUID();
  const user = (await db.query(
    "INSERT INTO users(email,password_hash,status) VALUES($1,'test','active') RETURNING id",
    ["cleanup-" + key + "@test.host"]
  )).rows[0];
  const host = (await db.query(
    "INSERT INTO host_profiles(user_id,payout_account_status,stripe_connect_account_id) " +
    "VALUES($1,'active','acct_cleanup_fixture') RETURNING id", [user.id]
  )).rows[0];
  const property = (await db.query(
    "INSERT INTO properties(host_id,name,city,property_type,status,currency,nightly_price," +
    "max_guests,compliance_status,accommodation_vat_rate,cleaning_vat_rate) " +
    "VALUES($1,'Cleanup fixture','Liverpool','Hotel','draft','GBP',100,2,'approved',0,0) RETURNING id",
    [host.id]
  )).rows[0];
  const image = (await db.query(
    "INSERT INTO property_images(property_id,blob_url,blob_pathname,content_type,size_bytes) " +
    "VALUES($1,$2,$3,'image/jpeg',100) RETURNING id",
    [property.id, "https://example.invalid/" + key + ".jpg", key + ".jpg"]
  )).rows[0];
  const room = await saveRoomType(property.id, null, {
    name: "Double", description: "Cleanup test", maxGuests: 2,
    totalRooms: 3, nightlyPrice: 100, cleaningFee: 0,
    active: true, imageIds: [image.id],
  });
  await db.query("UPDATE properties SET status='published' WHERE id=$1", [property.id]);
  const date = (days: number) =>
    new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const booking = await createBooking({
    propertyId: property.id, guestId: user.id,
    roomTypeId: room.id, roomQuantity: 1, guests: 2,
    checkIn: date(30), checkOut: date(32),
    guestName: "Test", guestEmail: "guest@test.host", idempotencyKey: key,
  });
  const pc = (await db.query(
    "SELECT * FROM booking_price_components WHERE booking_id=$1", [booking.id]
  )).rows[0];
  const intentId = "pi_cleanup_" + key.replace(/-/g, "");
  const payment = (await db.query(
    "INSERT INTO payments(booking_id,provider,provider_payment_intent_id,status,amount_minor,currency) " +
    "VALUES($1,'stripe',$2,'pending',$3,$4) RETURNING id",
    [booking.id, intentId, pc.guest_total_minor, pc.currency]
  )).rows[0];
  if (cancelled) await cancelBooking({ bookingId: booking.id, cancelledBy: "guest" });
  let current: any = {
    id: intentId, object: "payment_intent", status: "requires_payment_method",
    metadata: { booking_id: booking.id, host_payment_id: payment.id },
    amount: pc.guest_total_minor, currency: String(pc.currency).trim().toLowerCase(),
    transfer_data: { destination: "acct_cleanup_fixture" },
    application_fee_amount: pc.host_revenue_minor,
    amount_received: 0, amount_capturable: 0,
  };
  let cancels = 0;
  const provider = {
    async retrieve() { return { ...current }; },
    async cancel() { cancels++; current = { ...current, status: "canceled" }; return current; },
  };
  return {
    bookingId: booking.id, paymentId: payment.id, provider,
    setIntent: (value: any) => { current = { ...current, ...value }; },
    cancels: () => cancels,
    payment: async () => (await db.query(
      "SELECT * FROM payments WHERE id=$1", [payment.id])).rows[0],
  };
}

test("cleanup records verified cancellation and preserves booking history", async () => {
  const f = await fixture();
  const result = await cleanupCancelledHotelIntent(f.bookingId, f.provider);
  assert.equal(result.outcome, "cancelled_unpaid");
  assert.equal((await f.payment()).failure_code, "legacy_intent_cancelled_unpaid");
  assert.equal((await db.query("SELECT status FROM bookings WHERE id=$1",
    [f.bookingId])).rows[0].status, "cancelled");
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id=$1 AND action='legacy_unpaid_intent_cancelled'",
    [f.paymentId])).rows[0].count), 1);
});

test("concurrent cleanup requests issue one provider cancellation", async () => {
  const f = await fixture();
  const results = await Promise.all([
    cleanupCancelledHotelIntent(f.bookingId, f.provider),
    cleanupCancelledHotelIntent(f.bookingId, f.provider),
  ]);
  assert.ok(results.every(r => r.outcome === "cancelled_unpaid"));
  assert.equal(f.cancels(), 1);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id=$1 AND action='legacy_unpaid_intent_cancelled'",
    [f.paymentId])).rows[0].count), 1);
});

test("provider success blocks cleanup without overwriting payment", async () => {
  const f = await fixture();
  f.setIntent({ status: "succeeded", amount_received: 20000 });
  const before = await f.payment();
  assert.equal((await cleanupCancelledHotelIntent(f.bookingId, f.provider)).outcome, "blocked");
  assert.deepEqual(await f.payment(), before);
  assert.equal(f.cancels(), 0);
});

test("uncertain provider outcome preserves pending payment for reconciliation", async () => {
  const f = await fixture();
  const before = await f.payment();
  const provider = {
    retrieve: f.provider.retrieve,
    async cancel() { throw new Error("fixture timeout"); },
  };
  assert.equal((await cleanupCancelledHotelIntent(f.bookingId, provider)).outcome, "unresolved");
  assert.deepEqual(await f.payment(), before);
});

test("late-payment flag blocks cleanup before provider access", async () => {
  const f = await fixture();
  await db.query("UPDATE bookings SET hotel_late_payment=TRUE WHERE id=$1", [f.bookingId]);
  let reads = 0;
  const provider = {
    async retrieve() { reads++; throw new Error("Unexpected lookup"); },
    async cancel() { throw new Error("Unexpected cancellation"); },
  };
  assert.equal((await cleanupCancelledHotelIntent(f.bookingId, provider)).outcome, "blocked");
  assert.equal(reads, 0);
});

test("database rollback recovers without repeating provider cancellation", async () => {
  const f = await fixture();
  const before = await f.payment();
  const name = "cleanup_test_" + crypto.randomUUID().replace(/-/g, "");
  let functionCreated = false;
  let triggerCreated = false;

  try {
    await db.query(
      'CREATE FUNCTION "' + name + '"() RETURNS trigger LANGUAGE plpgsql AS $$ ' +
      "BEGIN IF NEW.object_id = '" + f.paymentId + "'::uuid " +
      "AND NEW.action = 'legacy_unpaid_intent_cancelled' THEN " +
      "RAISE EXCEPTION 'fixture cleanup audit failure'; END IF; RETURN NEW; END $$"
    );
    functionCreated = true;
    await db.query(
      'CREATE TRIGGER "' + name + '" BEFORE INSERT ON audit_log ' +
      'FOR EACH ROW EXECUTE FUNCTION "' + name + '"()'
    );
    triggerCreated = true;

    await assert.rejects(
      cleanupCancelledHotelIntent(f.bookingId, f.provider),
      /fixture cleanup audit failure/
    );
    assert.equal(f.cancels(), 1);
    assert.deepEqual(await f.payment(), before,
      "Provider success must not leave a partial database update");

    await db.query('DROP TRIGGER "' + name + '" ON audit_log');
    triggerCreated = false;
    await db.query('DROP FUNCTION "' + name + '"()');
    functionCreated = false;

    const recovered = await cleanupCancelledHotelIntent(f.bookingId, f.provider);
    assert.equal(recovered.outcome, "cancelled_unpaid");
    assert.equal(f.cancels(), 1,
      "Fresh canceled evidence must recover without another cancel request");
    assert.equal((await f.payment()).failure_code, "legacy_intent_cancelled_unpaid");
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM audit_log WHERE object_id=$1 " +
      "AND action='legacy_unpaid_intent_cancelled'", [f.paymentId]
    )).rows[0].count), 1);
  } finally {
    if (triggerCreated) {
      await db.query('DROP TRIGGER IF EXISTS "' + name + '" ON audit_log');
    }
    if (functionCreated) {
      await db.query('DROP FUNCTION IF EXISTS "' + name + '"()');
    }
  }
});

test("payment update winning the row lock blocks cleanup before provider access", async () => {
  const f = await fixture();
  const connection = await db.connect();
  let cleanup: Promise<any> | undefined;
  let settled = false;
  let reads = 0;

  try {
    await connection.query("BEGIN");
    await connection.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE",
      [f.paymentId]);
    await connection.query("UPDATE payments SET status='paid' WHERE id=$1",
      [f.paymentId]);

    cleanup = cleanupCancelledHotelIntent(f.bookingId, {
      async retrieve() { reads++; throw new Error("Unexpected lookup"); },
      async cancel() { throw new Error("Unexpected cancellation"); },
    }).then(
      value => ({ value }),
      error => ({ error })
    ).finally(() => { settled = true; });

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, "Cleanup must wait for the payment row owner");
    await connection.query("COMMIT");
  } finally {
    try { await connection.query("ROLLBACK"); }
    finally { connection.release(); }
  }

  const result = await cleanup;
  assert.ifError(result.error);
  assert.equal(result.value.outcome, "blocked");
  assert.equal(reads, 0);
  assert.equal((await f.payment()).status, "paid");
});

async function assertNoProviderCleanup(f: Awaited<ReturnType<typeof fixture>>) {
  let calls = 0;
  const before = await f.payment();
  const result = await cleanupCancelledHotelIntent(f.bookingId, {
    async retrieve() { calls++; throw new Error("Unexpected provider lookup"); },
    async cancel() { calls++; throw new Error("Unexpected provider cancellation"); },
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(calls, 0);
  assert.deepEqual(await f.payment(), before);
}

test("active unpaid hotel booking cannot enter cleanup", async () => {
  const f = await fixture(false);
  await assertNoProviderCleanup(f);
});

test("confirmed hotel booking cannot enter cleanup", async () => {
  const f = await fixture(false);
  await db.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [f.bookingId]);
  await assertNoProviderCleanup(f);
});

for (const status of ["paid", "processing", "refunded", "partially_refunded", "disputed"]) {
  test("stored payment status blocks provider cleanup: " + status, async () => {
    const f = await fixture();
    await db.query("UPDATE payments SET status=$2 WHERE id=$1", [f.paymentId, status]);
    await assertNoProviderCleanup(f);
  });
}

test("unresolved intent creation reservation blocks cleanup", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE payments SET failure_code='legacy_intent_creation_reserved' WHERE id=$1",
    [f.paymentId]
  );
  await assertNoProviderCleanup(f);
});

test("stored price mismatch blocks cleanup before provider access", async () => {
  const f = await fixture();
  await db.query("UPDATE payments SET amount_minor=amount_minor+1 WHERE id=$1",
    [f.paymentId]);
  await assertNoProviderCleanup(f);
});

test("existing refund blocks unpaid cleanup", async () => {
  const f = await fixture();
  await db.query(
    "INSERT INTO refunds(booking_id,payment_id,amount_minor,currency,reason,initiated_by,status) " +
    "VALUES($1,$2,1,'GBP','guest_cancellation','guest','pending')",
    [f.bookingId, f.paymentId]
  );
  await assertNoProviderCleanup(f);
});

test("existing ledger entry blocks unpaid cleanup", async () => {
  const f = await fixture();
  await db.query(
    "INSERT INTO ledger_entries(booking_id,property_id,host_id,type,amount_minor,currency,status,occurred_at) " +
    "SELECT id,property_id,host_id,'guest_charge',1,'GBP','paid',NOW() FROM bookings WHERE id=$1",
    [f.bookingId]
  );
  await assertNoProviderCleanup(f);
});

async function integratedCleanupRoute(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { denied?: boolean; disabled?: boolean; live?: boolean } = {}
) {
  const actor = (await db.query(
    "SELECT guest_id FROM bookings WHERE id=$1", [f.bookingId]
  )).rows[0].guest_id;
  const exports: any = {};
  class RouteAuthError extends Error {
    status = 403;
  }
  const compiled = ts.transpileModule(fs.readFileSync(
    "app/api/admin/payments/cleanup-unpaid-hotel/route.ts", "utf8"
  ), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  }}).outputText;

  vm.runInNewContext(compiled, {
    exports,
    process: { env: {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "host-staging-preview",
      ENABLE_STAGING_UNPAID_INTENT_CLEANUP: options.disabled ? "false" : "true",
      STRIPE_SECRET_KEY: "sk_test_fake_provider_only",
    }},
    console: { error() {} },
    require(name: string) {
      if (name === "next/server") return {
        NextResponse: { json: (body: any, init: any) => ({ body, ...init }) },
      };
      if (name === "@/lib/auth/session") return { AuthError: RouteAuthError };
      if (name === "@/lib/auth/permissions") return {
        async requirePermission(resource: string, action: string) {
          assert.equal(resource, "refunds"); assert.equal(action, "write");
          if (options.denied) throw new RouteAuthError("Denied");
          return { user: { id: actor, adminRole: "finance" } };
        },
      };
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/payments/cleanupCancelledHotelIntent") {
        return { cleanupCancelledHotelIntent };
      }
      if (name === "@/lib/payments/stripeClient") return { stripe: {
        paymentIntents: {
          async retrieve() {
            return { ...await f.provider.retrieve(), livemode: options.live ?? false };
          },
          async cancel() { return f.provider.cancel(); },
        },
      }};
      throw new Error("Unexpected route import: " + name);
    },
  });

  const origin = "https://host-git-host-staging-preview-host-team1.vercel.app";
  return exports.POST({
    nextUrl: { origin },
    headers: { get(name: string) {
      return name === "origin" ? origin :
        name === "content-type" ? "application/json" : null;
    }},
    async json() { return { bookingId: f.bookingId }; },
  });
}

test("route and real worker record cleanup with operator audit", async () => {
  const f = await fixture();
  const response = await integratedCleanupRoute(f);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal((await f.payment()).failure_code, "legacy_intent_cancelled_unpaid");
  assert.equal(f.cancels(), 1);
  const audit = (await db.query(
    "SELECT actor_user_id FROM audit_log WHERE object_id=$1 " +
    "AND action='staging_unpaid_intent_cleanup_requested'", [f.bookingId]
  )).rows;
  assert.equal(audit.length, 1);
  assert.ok(audit[0].actor_user_id);
  const again = await integratedCleanupRoute(f);
  assert.equal(again.status, 200);
  assert.equal(f.cancels(), 1);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id=$1 " +
    "AND action='legacy_unpaid_intent_cancelled'", [f.paymentId]
  )).rows[0].count), 1);
});

test("route denial leaves real payment and cleanup audit unchanged", async () => {
  const f = await fixture();
  const before = await f.payment();
  const response = await integratedCleanupRoute(f, { denied: true });
  assert.equal(response.status, 403);
  assert.deepEqual(await f.payment(), before);
  assert.equal(f.cancels(), 0);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id=$1 " +
    "AND action='staging_unpaid_intent_cleanup_requested'", [f.bookingId]
  )).rows[0].count), 0);
});

test("disabled route cannot reach real cleanup worker", async () => {
  const f = await fixture();
  const before = await f.payment();
  assert.equal((await integratedCleanupRoute(f, { disabled: true })).status, 404);
  assert.deepEqual(await f.payment(), before);
  assert.equal(f.cancels(), 0);
});

test("live response through real worker remains unresolved without cancellation", async () => {
  const f = await fixture();
  const before = await f.payment();
  const response = await integratedCleanupRoute(f, { live: true });
  assert.equal(response.status, 409);
  assert.equal(response.body.outcome, "unresolved");
  assert.equal(response.body.success, false);
  assert.deepEqual(await f.payment(), before);
  assert.equal(f.cancels(), 0);
});
