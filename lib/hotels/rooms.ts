import type { PoolClient } from "pg";
import { db, withTransaction } from "../db";
import { BookingError } from "../booking/types";
import { hashToBigint } from "../utils/advisoryLock";
import { isHotelType, roomTypeSchema, inventorySchema } from "./schemas";
import type { z } from "zod";

type Queryable = Pick<PoolClient, "query">;
export const RESERVING_STATUSES = "'pending_payment','confirmed','completed','disputed'";

export async function listRoomTypes(propertyId: string, publicOnly = false, client: Queryable = db) {
  const result = await client.query(`SELECT r.id, r.name, r.description, r.max_guests AS "maxGuests",
    r.total_rooms AS "totalRooms", r.nightly_price AS "nightlyPrice", r.cleaning_fee AS "cleaningFee", r.active,
    COALESCE((SELECT json_agg(json_build_object('id',pi.id,'url',pi.blob_url,'altText',pi.alt_text)
      ORDER BY ri.sort_order) FROM hotel_room_images ri JOIN property_images pi ON pi.id=ri.image_id
      WHERE ri.room_type_id=r.id AND pi.property_id=r.property_id), '[]'::json) AS images
    FROM hotel_room_types r WHERE r.property_id=$1 ${publicOnly ? "AND r.active" : ""} ORDER BY r.created_at,r.id`, [propertyId]);
  return result.rows;
}

export async function lockHotel(client: Queryable, propertyId: string) {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [hashToBigint(propertyId)]);
  const result = await client.query(`SELECT property_type FROM properties WHERE id=$1 FOR SHARE`, [propertyId]);
  if (!result.rows[0] || !isHotelType(result.rows[0].property_type))
    throw new BookingError("NOT_A_HOTEL", "Room management requires a Hotel or Aparthotel listing");
}

// Pending holds continue to count until the existing expiry sweep cancels them.
// This prevents a late Stripe webhook confirming stock already sold to another guest.
export async function roomNights(client: Queryable, roomTypeId: string, checkIn: string, checkOut: string) {
  const result = await client.query(`SELECT to_char(d.date,'YYYY-MM-DD') AS date,
      COALESCE(i.total_rooms,r.total_rooms)::int AS capacity,
      COALESCE(i.nightly_price,r.nightly_price) AS price,
      COALESCE((SELECT SUM(b.room_quantity) FROM bookings b WHERE b.room_type_id=r.id
        AND b.status IN (${RESERVING_STATUSES}) AND (b.status<>'pending_payment' OR b.hold_expires_at IS NULL OR b.hold_expires_at>NOW()) AND b.check_in<=d.date AND b.check_out>d.date),0)::int AS reserved
    FROM hotel_room_types r CROSS JOIN generate_series($2::date,$3::date-1,interval '1 day') AS d(date)
    LEFT JOIN hotel_room_inventory i ON i.room_type_id=r.id AND i.date=d.date
    WHERE r.id=$1 ORDER BY d.date`, [roomTypeId, checkIn, checkOut]);
  return result.rows as {date: string; capacity: number; price: string; reserved: number}[];
}

export async function saveRoomType(propertyId: string, roomId: string | null, input: z.infer<typeof roomTypeSchema>) {
  return withTransaction(async (client) => {
    await lockHotel(client, propertyId);
    let contentChanged=!roomId;
    if (roomId) {
      const previous = await client.query(`SELECT * FROM hotel_room_types WHERE id=$1 AND property_id=$2 FOR UPDATE`, [roomId, propertyId]);
      if (!previous.rows[0]) throw new BookingError("ROOM_NOT_FOUND", "Room type not found");
      const old=previous.rows[0];
      const oldImages=await client.query(`SELECT image_id FROM hotel_room_images WHERE room_type_id=$1 ORDER BY sort_order`,[roomId]);
      contentChanged=old.name!==input.name || old.description!==input.description || old.max_guests!==input.maxGuests || (!old.active&&input.active) ||
        JSON.stringify(oldImages.rows.map(r=>r.image_id))!==JSON.stringify([...new Set(input.imageIds)]);
      const excess = await client.query(`SELECT 1 FROM bookings b CROSS JOIN LATERAL
        generate_series(GREATEST(b.check_in,CURRENT_DATE),b.check_out-1,interval '1 day') d(date)
        LEFT JOIN hotel_room_inventory i ON i.room_type_id=b.room_type_id AND i.date=d.date
        WHERE b.room_type_id=$1 AND b.status IN (${RESERVING_STATUSES}) AND (b.status<>'pending_payment' OR b.hold_expires_at IS NULL OR b.hold_expires_at>NOW())
        GROUP BY d.date,i.total_rooms HAVING SUM(b.room_quantity)>LEAST($2,COALESCE(i.total_rooms,$2)) LIMIT 1`, [roomId, input.totalRooms]);
      if (excess.rows.length) throw new BookingError("INVENTORY_IN_USE", "Room count cannot be reduced below existing reservations");
      const overrides = await client.query(`SELECT 1 FROM hotel_room_inventory WHERE room_type_id=$1 AND date>=CURRENT_DATE AND total_rooms>$2 LIMIT 1`, [roomId,input.totalRooms]);
      if (overrides.rows.length) throw new BookingError("INVALID_INVENTORY", "Reduce nightly inventory overrides before reducing the room count");
    }
    const imageIds = [...new Set(input.imageIds)];
    if (imageIds.length) {
      const images = await client.query(`SELECT id FROM property_images WHERE property_id=$1 AND id=ANY($2::uuid[]) FOR SHARE`, [propertyId,imageIds]);
      if (images.rows.length !== imageIds.length) throw new BookingError("INVALID_IMAGES", "Choose photos belonging to this property");
    }
    const values = [propertyId,input.name,input.description,input.maxGuests,input.totalRooms,input.nightlyPrice,input.cleaningFee,input.active];
    const result = roomId
      ? await client.query(`UPDATE hotel_room_types SET name=$2,description=$3,max_guests=$4,total_rooms=$5,
          nightly_price=$6,cleaning_fee=$7,active=$8,updated_at=NOW() WHERE property_id=$1 AND id=$9 RETURNING id`, [...values,roomId])
      : await client.query(`INSERT INTO hotel_room_types(property_id,name,description,max_guests,total_rooms,nightly_price,cleaning_fee,active)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, values);
    const id = result.rows[0].id;
    await client.query(`DELETE FROM hotel_room_images WHERE room_type_id=$1`, [id]);
    for (const [order,imageId] of imageIds.entries())
      await client.query(`INSERT INTO hotel_room_images(room_type_id,image_id,sort_order) VALUES($1,$2,$3)`, [id,imageId,order]);
    if(contentChanged) await client.query(`UPDATE properties SET pilot_review_status='pending',pilot_reviewed_at=NULL,pilot_reviewed_by=NULL,
      pilot_review_note=NULL,status=CASE WHEN status='published' THEN 'draft' ELSE status END,updated_at=NOW() WHERE id=$1`,[propertyId]);
    return { id };
  });
}

export async function saveInventory(propertyId: string, roomId: string, input: z.infer<typeof inventorySchema>) {
  return withTransaction(async (client) => {
    await lockHotel(client,propertyId);
    const result = await client.query(`SELECT total_rooms FROM hotel_room_types WHERE id=$1 AND property_id=$2 FOR UPDATE`,[roomId,propertyId]);
    if (!result.rows[0]) throw new BookingError("ROOM_NOT_FOUND", "Room type not found");
    if (input.totalRooms > result.rows[0].total_rooms) throw new BookingError("INVALID_INVENTORY", "Nightly inventory cannot exceed the room count");
    const nights = await roomNights(client,roomId,input.start,input.end);
    if (nights.some(n=>n.reserved>input.totalRooms)) throw new BookingError("INVENTORY_IN_USE", "Inventory cannot be reduced below existing reservations");
    await client.query(`INSERT INTO hotel_room_inventory(room_type_id,date,total_rooms,nightly_price)
      SELECT $1,d,$4,$5 FROM generate_series($2::date,$3::date-1,interval '1 day') d
      ON CONFLICT(room_type_id,date) DO UPDATE SET total_rooms=EXCLUDED.total_rooms,nightly_price=EXCLUDED.nightly_price`,
      [roomId,input.start,input.end,input.totalRooms,input.nightlyPrice]);
    return { saved: nights.length };
  });
}
