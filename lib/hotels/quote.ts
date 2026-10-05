import type { PoolClient } from "pg";
import { BookingError } from "../booking/types";
import { calculatePrice, getActiveFeeConfig, nightsBetween } from "../booking/priceEngine";
import { roomNights } from "./rooms";
import { roomQuoteSchema } from "./schemas";
import type { z } from "zod";

export async function quoteRoom(client: Pick<PoolClient,"query">, propertyId:string, input:z.infer<typeof roomQuoteSchema>) {
  const validated=roomQuoteSchema.safeParse(input);
  if(!validated.success)throw new BookingError("INVALID_ROOM_SELECTION","Choose a valid room, quantity and date range");
  const result=await client.query(`SELECT r.*,p.currency,p.min_stay_nights,p.max_stay_nights,
    p.accommodation_vat_rate,p.cleaning_vat_rate FROM hotel_room_types r JOIN properties p ON p.id=r.property_id
    WHERE r.id=$1 AND r.property_id=$2 AND r.active`,[input.roomTypeId,propertyId]);
  const room=result.rows[0];
  if(!room)throw new BookingError("ROOM_NOT_FOUND","Room type is unavailable");
  if(input.guests>room.max_guests*input.roomQuantity)throw new BookingError("TOO_MANY_GUESTS","Guest count exceeds the selected rooms’ capacity");
  const nights=nightsBetween(input.checkIn,input.checkOut);
  if(nights<room.min_stay_nights||nights>room.max_stay_nights)throw new BookingError("INVALID_STAY_LENGTH","Dates do not meet this property’s stay limits");
  const blocked=await client.query(`SELECT 1 FROM availability_blocks WHERE property_id=$1 AND date >= $2 AND date < $3 AND status<>'available' LIMIT 1`,[propertyId,input.checkIn,input.checkOut]);
  if(blocked.rows.length)throw new BookingError("DATES_UNAVAILABLE","The hotel is closed for one or more selected nights");
  const rows=await roomNights(client,input.roomTypeId,input.checkIn,input.checkOut);
  if(rows.length!==nights)throw new BookingError("DATES_UNAVAILABLE","Room inventory is unavailable");
  const availableRooms=Math.min(...rows.map(n=>n.capacity-n.reserved));
  if(availableRooms<input.roomQuantity)throw new BookingError("DATES_UNAVAILABLE","Not enough rooms remain for every selected night");
  const accommodationMinor=rows.reduce((sum,n)=>sum+Math.round(Number(n.price)*100)*input.roomQuantity,0);
  const cleaningMinor=Math.round(Number(room.cleaning_fee)*100)*input.roomQuantity;
  const feeConfig=await getActiveFeeConfig(client);
  if(feeConfig.version==="host-15-inclusive-v1"&&(room.accommodation_vat_rate==null||room.cleaning_vat_rate==null))
    throw new BookingError("TAX_UNCONFIGURED","HOST must confirm this hotel’s tax treatment before bookings open");
  const breakdown=calculatePrice({id:propertyId,currency:room.currency,nightlyPriceMinor:0,cleaningFeeMinor:cleaningMinor,
    accommodationVatRate:room.accommodation_vat_rate==null?null:Number(room.accommodation_vat_rate),
    cleaningVatRate:room.cleaning_vat_rate==null?null:Number(room.cleaning_vat_rate)},nights,feeConfig,accommodationMinor);
  if(!Number.isSafeInteger(breakdown.guestTotalMinor)||breakdown.guestTotalMinor>2147483647)
    throw new BookingError("PRICE_TOO_HIGH","Please reduce the room quantity or stay length");
  return {room,availableRooms,breakdown,nightlyPrices:rows.map(n=>({date:n.date,priceMinor:Math.round(Number(n.price)*100)}))};
}
