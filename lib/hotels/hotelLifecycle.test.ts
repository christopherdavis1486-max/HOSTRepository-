import {test,after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {db} from "../db";
import {createBooking,releaseExpiredHold} from "../booking/createBooking";
import {cancelBooking} from "../booking/cancelBooking";
import {saveRoomType,saveInventory,roomNights} from "./rooms";
import {quoteRoom} from "./quote";
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
after(async()=>{await db.end();});
async function fixture(totalRooms=2) {
 const key=crypto.randomUUID();
 const user=await db.query(`INSERT INTO users(email,password_hash,status) VALUES($1,'test','active') RETURNING id`,[`hotel-${key}@test.host`]);
 const userId=user.rows[0].id as string;
 const profile=await db.query(`INSERT INTO host_profiles(user_id,payout_account_status) VALUES($1,'active') RETURNING id`,[userId]);
 const property=await db.query(`INSERT INTO properties(host_id,name,city,property_type,status,currency,nightly_price,max_guests,compliance_status,accommodation_vat_rate,cleaning_vat_rate)
  VALUES($1,'Hotel test','Liverpool','Hotel','draft','GBP',100,2,'approved',0,0) RETURNING id`,[profile.rows[0].id]);
 const propertyId=property.rows[0].id as string;
 const image=await db.query(`INSERT INTO property_images(property_id,blob_url,blob_pathname,content_type,size_bytes) VALUES($1,$2,$3,'image/jpeg',100) RETURNING id`,[propertyId,`https://example.invalid/${key}.jpg`,`${key}.jpg`]);
 const roomInput={name:"Double",description:"Double room",maxGuests:2,totalRooms,nightlyPrice:100,cleaningFee:10,active:true,imageIds:[image.rows[0].id]};
 const room=await saveRoomType(propertyId,null,roomInput);
 await db.query(`UPDATE properties SET status='published' WHERE id=$1`,[propertyId]);
 const input={propertyId,guestId:userId,roomTypeId:room.id,roomQuantity:1,guests:2,checkIn:date(30),checkOut:date(32),guestName:"Test guest",guestEmail:"guest@test.host",idempotencyKey:crypto.randomUUID()};
 return {propertyId,roomId:room.id,roomInput,input};
}
test("concurrent requests cannot oversell the last room",async()=>{
 const f=await fixture(1);
 const outcomes=await Promise.allSettled([createBooking(f.input),createBooking({...f.input,idempotencyKey:crypto.randomUUID()})]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
 assert.equal((await roomNights(db,f.roomId,date(30),date(32)))[0].reserved,1);
});
test("overlapping ranges and room quantities reserve every night",async()=>{
 const f=await fixture(3);await createBooking({...f.input,roomQuantity:2,guests:4});
 await createBooking({...f.input,checkIn:date(31),checkOut:date(33),idempotencyKey:crypto.randomUUID()});
 await assert.rejects(createBooking({...f.input,checkIn:date(32),checkOut:date(34),roomQuantity:3,guests:6,idempotencyKey:crypto.randomUUID()}),/Not enough/);
});
test("same-key concurrent retries return one reservation and reject changed selections",async()=>{
 const f=await fixture(3);const [a,b]=await Promise.all([createBooking(f.input),createBooking(f.input)]);assert.equal(a.id,b.id);
 await assert.rejects(createBooking({...f.input,roomQuantity:2}),/already used/);
 const blocks=await db.query(`SELECT COUNT(*) FROM availability_blocks WHERE property_id=$1`,[f.propertyId]);assert.equal(Number(blocks.rows[0].count),0);
});
test("nightly prices multiply by quantity and cannot reduce reserved stock",async()=>{
 const f=await fixture(3);await saveInventory(f.propertyId,f.roomId,{start:date(31),end:date(32),totalRooms:2,nightlyPrice:150});
 const booking=await createBooking({...f.input,roomQuantity:2,guests:4});assert.ok("breakdown" in booking);assert.equal(booking.breakdown.accommodationMinor,50000);assert.equal(booking.breakdown.cleaningMinor,2000);
 await assert.rejects(saveInventory(f.propertyId,f.roomId,{start:date(30),end:date(32),totalRooms:1,nightlyPrice:null}),/below existing/);
});
test("cancellation releases only the booked room quantity",async()=>{
 const f=await fixture(2);const a=await createBooking(f.input);await createBooking({...f.input,idempotencyKey:crypto.randomUUID()});
 await cancelBooking({bookingId:a.id,cancelledBy:"guest"});assert.equal((await roomNights(db,f.roomId,date(30),date(32)))[0].reserved,1);
 await createBooking({...f.input,idempotencyKey:crypto.randomUUID()});
});
test("expired holds free rooms and late confirmation is rejected at the database",async()=>{
 const f=await fixture(1);const old=await createBooking(f.input);
 await db.query(`UPDATE bookings SET hold_expires_at=NOW()-interval '1 minute' WHERE id=$1`,[old.id]);
 const q=await quoteRoom(db,f.propertyId,{roomTypeId:f.roomId,roomQuantity:1,guests:2,checkIn:date(30),checkOut:date(32)});assert.equal(q.availableRooms,1);
 await createBooking({...f.input,idempotencyKey:crypto.randomUUID()});
 await db.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`,[old.id]);
 const row=await db.query(`SELECT status,hotel_late_payment FROM bookings WHERE id=$1`,[old.id]);assert.equal(row.rows[0].status,'cancelled');assert.equal(row.rows[0].hotel_late_payment,true);
});
test("expiry sweep cancels a room hold without removing a hotel closure",async()=>{
 const f=await fixture();const booking=await createBooking(f.input);
 await db.query(`INSERT INTO availability_blocks(property_id,date,status,source) VALUES($1,$2,'blocked','host')`,[f.propertyId,date(30)]);
 await db.query(`UPDATE bookings SET hold_expires_at=NOW()-interval '1 minute' WHERE id=$1`,[booking.id]);await releaseExpiredHold(booking.id);
 assert.equal((await roomNights(db,f.roomId,date(30),date(32)))[0].reserved,0);
 assert.equal((await db.query(`SELECT status FROM availability_blocks WHERE property_id=$1`,[f.propertyId])).rows[0].status,'blocked');
});
test("room snapshots and inventory-model conversion are protected",async()=>{
 const f=await fixture();const booking=await createBooking(f.input);
 await assert.rejects(db.query(`UPDATE bookings SET room_quantity=2 WHERE id=$1`,[booking.id]),/immutable/);
 await assert.rejects(db.query(`UPDATE properties SET property_type='House' WHERE id=$1`,[f.propertyId]),/Pause room types/);
 await cancelBooking({bookingId:booking.id,cancelledBy:"guest"});
 await db.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`,[booking.id]);assert.equal((await db.query(`SELECT status FROM bookings WHERE id=$1`,[booking.id])).rows[0].status,'cancelled');
});
test("late signed payment is refunded once without reactivating rooms or scheduling payout",async()=>{
 const f=await fixture(1);const booking=await createBooking(f.input);
 await db.query(`UPDATE bookings SET hold_expires_at=NOW()-interval '1 minute' WHERE id=$1`,[booking.id]);
 await releaseExpiredHold(booking.id);
 const intentId=`pi_hotel_test_${crypto.randomUUID()}`;
 await db.query(`INSERT INTO payments(booking_id,provider,provider_payment_intent_id,status,amount_minor,currency)
  SELECT $1,'stripe',$2,'pending',guest_total_minor,currency FROM booking_price_components WHERE booking_id=$1`,[booking.id,intentId]);
 process.env.STRIPE_SECRET_KEY??="sk_test_local_validation";
 const originalSecret=process.env.STRIPE_WEBHOOK_SECRET;process.env.STRIPE_WEBHOOK_SECRET="whsec_local_hotel_test";
 const {stripe}=await import("../payments/stripeClient");const originalCreate=stripe.refunds.create;let calls=0;
 stripe.refunds.create=(async(args:any)=>{calls++;assert.equal(args.reverse_transfer,true);assert.equal(args.refund_application_fee,true);
  return {id:`re_hotel_test_${booking.id}`,status:"pending",amount:args.amount};}) as any;
 try{
  const {handleStripeWebhook}=await import("../payments/webhookHandler");
  const payload=JSON.stringify({id:`evt_${booking.id}`,type:"payment_intent.succeeded",data:{object:{id:intentId,metadata:{booking_id:booking.id}}}});
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret:process.env.STRIPE_WEBHOOK_SECRET});
  await handleStripeWebhook(payload,signature);await handleStripeWebhook(payload,signature);assert.equal(calls,1);
  assert.equal((await db.query(`SELECT status FROM bookings WHERE id=$1`,[booking.id])).rows[0].status,"cancelled");
  assert.equal(Number((await db.query(`SELECT COUNT(*) FROM payouts WHERE booking_id=$1`,[booking.id])).rows[0].count),0);
 }finally{stripe.refunds.create=originalCreate;if(originalSecret===undefined)delete process.env.STRIPE_WEBHOOK_SECRET;else process.env.STRIPE_WEBHOOK_SECRET=originalSecret;}
});
test("room photos and management access cannot cross property ownership",async()=>{
 const f=await fixture(),other=await fixture();
 await assert.rejects(saveRoomType(other.propertyId,other.roomId,f.roomInput),/belonging to this property/);
 const {resolveHostPropertyAccess}=await import("../auth/hostAccess");
 await assert.rejects(resolveHostPropertyAccess({user:{id:f.input.guestId,hostProfileId:crypto.randomUUID(),roles:["host"]},expires:"2099-01-01"} as any,f.propertyId),/permission/);
});


test("hotel cancellation stays on the legacy flow and preserves another booking and host closure", async () => {
  const originalFlag = process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  try {
    const f = await fixture(3);
    const first = await createBooking({ ...f.input, roomQuantity: 2, guests: 4 });
    const second = await createBooking({ ...f.input, idempotencyKey: crypto.randomUUID() });
    const flow = await db.query(
      "SELECT payment_flow_version FROM bookings WHERE id = $1",
      [first.id]
    );
    assert.equal(flow.rows[0].payment_flow_version, "destination_charge_legacy");

    const before = await roomNights(db, f.roomId, f.input.checkIn, f.input.checkOut);
    assert.equal(before.length, 2);
    assert.ok(before.every(night => night.reserved === 3));
    await db.query(
      "INSERT INTO availability_blocks(property_id,date,status,source) VALUES($1,$2,'blocked','host')",
      [f.propertyId, f.input.checkIn]
    );
    const closureBefore = await db.query(
      "SELECT * FROM availability_blocks WHERE property_id = $1 ORDER BY date",
      [f.propertyId]
    );
    const otherBefore = await db.query("SELECT * FROM bookings WHERE id = $1", [second.id]);

    await cancelBooking({ bookingId: first.id, cancelledBy: "guest" });

    const after = await roomNights(db, f.roomId, f.input.checkIn, f.input.checkOut);
    assert.equal(after.length, 2);
    assert.ok(after.every(night => night.reserved === 1));
    const closureAfter = await db.query(
      "SELECT * FROM availability_blocks WHERE property_id = $1 ORDER BY date",
      [f.propertyId]
    );
    assert.deepEqual(closureAfter.rows, closureBefore.rows);
    const otherAfter = await db.query("SELECT * FROM bookings WHERE id = $1", [second.id]);
    assert.deepEqual(otherAfter.rows, otherBefore.rows);
    const cancelled = await db.query("SELECT status FROM bookings WHERE id = $1", [first.id]);
    assert.equal(cancelled.rows[0].status, "cancelled");
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
    else process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = originalFlag;
  }
});
