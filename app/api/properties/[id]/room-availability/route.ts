import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hotelDate, isHotelType } from "@/lib/hotels/schemas";
import { roomNights } from "@/lib/hotels/rooms";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const querySchema = z.object({ roomTypeId: z.string().uuid(), roomQuantity: z.coerce.number().int().min(1).max(50), start: hotelDate, end: hotelDate })
  .refine(v => v.end > v.start && (Date.parse(v.end) - Date.parse(v.start)) / 86400000 <= 62);
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!z.string().uuid().safeParse(id).success || !parsed.success) return NextResponse.json({ success: false, error: { message: "Choose a valid room, quantity and calendar range" } }, { status: 400, headers });
    const input = parsed.data;
    const property = await db.query(`SELECT p.property_type FROM properties p WHERE p.id=$1 AND p.status='published' AND p.compliance_status='approved'
      AND NOT EXISTS(SELECT 1 FROM property_compliance_items i WHERE i.property_id=p.id AND i.applicability='required' AND i.valid_until<CURRENT_DATE)`, [id]);
    if (!property.rows[0] || !isHotelType(property.rows[0].property_type)) return NextResponse.json({ success: false, error: { message: "Hotel unavailable" } }, { status: 404, headers });
    const room = await db.query("SELECT id FROM hotel_room_types WHERE id=$1 AND property_id=$2 AND active", [input.roomTypeId, id]);
    if (!room.rows[0]) return NextResponse.json({ success: false, error: { message: "Room unavailable" } }, { status: 404, headers });
    const [nights, blocks] = await Promise.all([
      roomNights(db, input.roomTypeId, input.start, input.end),
      db.query("SELECT to_char(date,'YYYY-MM-DD') AS date FROM availability_blocks WHERE property_id=$1 AND date >= $2 AND date < $3 AND status<>'available'", [id, input.start, input.end]),
    ]);
    const closed = new Set(blocks.rows.map(row => row.date));
    return NextResponse.json({ success: true, unavailableDates: nights.filter(n => closed.has(n.date) || n.capacity - n.reserved < input.roomQuantity).map(n => n.date) }, { headers });
  } catch (error) {
    console.error("[HOST room availability]", error);
    return NextResponse.json({ success: false, error: { message: "Unable to load room availability" } }, { status: 500, headers });
  }
}
