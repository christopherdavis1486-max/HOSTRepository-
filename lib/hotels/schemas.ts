import { z } from "zod";

export const isHotelType = (value: string | null | undefined) =>
  ["hotel", "aparthotel"].includes(value?.trim().toLowerCase() ?? "");

export const hotelDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "Enter a valid calendar date"
);
export const roomTypeSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(3000).default(""),
  maxGuests: z.number().int().min(1).max(50),
  totalRooms: z.number().int().min(1).max(10000),
  nightlyPrice: z.number().min(0.01).max(100000),
  cleaningFee: z.number().min(0).max(100000).default(0),
  active: z.boolean().default(true),
  imageIds: z.array(z.string().uuid()).max(20).default([]),
}).strict();
export const inventorySchema = z.object({
  start: hotelDate,
  end: hotelDate, // exclusive
  totalRooms: z.number().int().min(0).max(10000),
  nightlyPrice: z.number().min(0.01).max(100000).nullable().default(null),
}).strict().refine((v) => v.end > v.start && (Date.parse(v.end) - Date.parse(v.start)) / 86400000 <= 366,
  "Inventory range must contain between 1 and 366 nights");
export const roomQuoteSchema = z.object({
  roomTypeId: z.string().uuid(), checkIn: hotelDate, checkOut: hotelDate,
  roomQuantity: z.coerce.number().int().min(1).max(50),
  guests: z.coerce.number().int().min(1).max(50),
}).refine((v) => v.checkOut > v.checkIn && (Date.parse(v.checkOut) - Date.parse(v.checkIn)) / 86400000 <= 365,
  "Choose a stay of between 1 and 365 nights").refine(v=>v.checkIn>=new Date().toISOString().slice(0,10),"Check-in cannot be in the past").refine(v=>{
    const limit=new Date();limit.setUTCFullYear(limit.getUTCFullYear()+1);return v.checkIn<=limit.toISOString().slice(0,10);
  },"Check-in cannot be more than a year ahead");
