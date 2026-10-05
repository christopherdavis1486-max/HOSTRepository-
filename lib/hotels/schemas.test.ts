import {test} from "node:test";
import assert from "node:assert/strict";
import {isHotelType,hotelDate,roomTypeSchema,inventorySchema,roomQuoteSchema} from "./schemas";
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
test("hotel types normalize case and whitespace while preserving whole-property types",()=>{
 assert.ok(isHotelType(" HOTEL "));assert.ok(isHotelType("Aparthotel"));assert.ok(!isHotelType("House"));assert.ok(!isHotelType(null));
});
test("impossible calendar dates are rejected",()=>{
 assert.ok(!hotelDate.safeParse("2027-02-30").success);assert.ok(hotelDate.safeParse("2028-02-29").success);
});
test("room capacity and quantity must be positive integers",()=>{
 const room={name:"Double",maxGuests:2,totalRooms:3,nightlyPrice:100};
 assert.ok(roomTypeSchema.safeParse(room).success);
 assert.ok(!roomTypeSchema.safeParse({...room,totalRooms:1.5}).success);
 assert.ok(!roomTypeSchema.safeParse({...room,maxGuests:0}).success);
});
test("nightly closures allow zero stock and require a bounded exclusive date range",()=>{
 assert.ok(inventorySchema.safeParse({start:date(1),end:date(2),totalRooms:0}).success);
 assert.ok(!inventorySchema.safeParse({start:date(1),end:date(1),totalRooms:1}).success);
 assert.ok(!inventorySchema.safeParse({start:date(1),end:date(369),totalRooms:1}).success);
});
test("quote selection rejects fractional rooms and dates in the past",()=>{
 const input={roomTypeId:"20000000-0000-4000-8000-000000000001",roomQuantity:2,guests:4,checkIn:date(1),checkOut:date(3)};
 assert.ok(roomQuoteSchema.safeParse(input).success);
 assert.ok(!roomQuoteSchema.safeParse({...input,roomQuantity:1.5}).success);
 assert.ok(!roomQuoteSchema.safeParse({...input,checkIn:date(-2),checkOut:date(-1)}).success);
});
