import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { roomQuoteSchema, isHotelType } from "@/lib/hotels/schemas";
import { quoteRoom } from "@/lib/hotels/quote";
import { BookingError } from "@/lib/booking/types";
import { validationErrorResponse } from "@/lib/validation/schemas";
import { z } from "zod";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
 try {
  const {id}=await params;
  const parsed=roomQuoteSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if(!z.string().uuid().safeParse(id).success||!parsed.success)
   return NextResponse.json(parsed.success?{success:false,error:{message:"Invalid property ID"}}:validationErrorResponse(parsed.error),{status:400,headers});
  const property=await db.query(`SELECT p.property_type FROM properties p WHERE p.id=$1 AND p.status='published' AND p.compliance_status='approved'
   AND NOT EXISTS(SELECT 1 FROM property_compliance_items i WHERE i.property_id=p.id AND i.applicability='required' AND i.valid_until<CURRENT_DATE)`,[id]);
  if(!property.rows[0]||!isHotelType(property.rows[0].property_type))return NextResponse.json({success:false,error:{message:"Hotel unavailable"}},{status:404,headers});
  const quote=await quoteRoom(db,id,parsed.data);
  return NextResponse.json({success:true,quote:{availableRooms:quote.availableRooms,breakdown:quote.breakdown,nightlyPrices:quote.nightlyPrices}},{headers});
 }catch(error){
  if(error instanceof BookingError)return NextResponse.json({success:false,error:{code:error.code,message:error.message}},{status:409,headers});
  console.error("[HOST room quote]",error);return NextResponse.json({success:false,error:{message:"Unable to quote rooms"}},{status:500,headers});
 }
}
