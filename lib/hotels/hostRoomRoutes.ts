import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, AuthError } from "../auth/session";
import { resolveHostPropertyAccess } from "../auth/hostAccess";
import { BookingError } from "../booking/types";
import { validationErrorResponse } from "../validation/schemas";
import { roomTypeSchema, inventorySchema, hotelDate } from "./schemas";
import { listRoomTypes, saveRoomType, saveInventory, roomNights } from "./rooms";
import { db } from "../db";

type Context = {params: Promise<{id: string; roomId?: string}>};
const rangeSchema = z.object({start:hotelDate,end:hotelDate}).refine(v=>v.end>v.start && (Date.parse(v.end)-Date.parse(v.start))/86400000<=366);
export function hostRoomRoute(operation: "list" | "create" | "update" | "inventoryRead" | "inventoryWrite") {
  return async (request: NextRequest, context: Context) => {
    try {
      const { id, roomId } = await context.params;
      if (!z.string().uuid().safeParse(id).success || (roomId && !z.string().uuid().safeParse(roomId).success))
        return NextResponse.json({success:false,error:{message:"Invalid property or room ID"}},{status:400});
      const session = await requireSession();
      await resolveHostPropertyAccess(session,id);
      if (operation === "list") return NextResponse.json({success:true,rooms:await listRoomTypes(id)},{headers:{"Cache-Control":"private, no-store"}});
      if (operation === "inventoryRead") {
        const range = rangeSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
        if (!range.success) return NextResponse.json(validationErrorResponse(range.error),{status:400});
        const room = await db.query(`SELECT id FROM hotel_room_types WHERE id=$1 AND property_id=$2`,[roomId,id]);
        if (!room.rows[0]) throw new BookingError("ROOM_NOT_FOUND","Room type not found");
        const nights = await roomNights(db,roomId!,range.data.start,range.data.end);
        return NextResponse.json({success:true,nights:nights.map(n=>({...n,available:n.capacity-n.reserved}))},{headers:{"Cache-Control":"private, no-store"}});
      }
      const body = await request.json().catch(()=>null);
      if (operation === "inventoryWrite") {
        const parsed=inventorySchema.safeParse(body);
        if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error),{status:400});
        return NextResponse.json({success:true,...await saveInventory(id,roomId!,parsed.data)});
      }
      const parsed=roomTypeSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error),{status:400});
      return NextResponse.json({success:true,room:await saveRoomType(id,roomId??null,parsed.data)});
    } catch (error) {
      if (error instanceof AuthError) return NextResponse.json({success:false,error:{message:error.message}},{status:error.status});
      if (error instanceof BookingError) return NextResponse.json({success:false,error:{code:error.code,message:error.message}},{status:error.code==="ROOM_NOT_FOUND"?404:409});
      console.error("[HOST hotel rooms]",error);
      return NextResponse.json({success:false,error:{message:"Unable to manage hotel rooms"}},{status:500});
    }
  };
}
