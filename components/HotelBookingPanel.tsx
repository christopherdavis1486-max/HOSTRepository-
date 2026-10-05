"use client";
import { useEffect, useRef, useState } from "react";
import { validateBookingForm } from "@/lib/booking/bookingFormValidation";
import { formatCurrency } from "@/lib/presentation/formatters";
import type { PriceBreakdown } from "@/lib/booking/types";
export type PublicRoomType={id:string;name:string;description:string;maxGuests:number;totalRooms:number;nightlyPrice:string|number;cleaningFee:string|number;images:{id:string;url:string;altText:string|null}[]};
export function HotelBookingPanel({propertyId,currency,rooms}:{propertyId:string;currency:string;rooms:PublicRoomType[]}) {
 const [roomId,setRoomId]=useState(rooms[0]?.id??""),[quantity,setQuantity]=useState(1),[guests,setGuests]=useState(1);
 const [checkIn,setCheckIn]=useState(""),[checkOut,setCheckOut]=useState(""),[name,setName]=useState(""),[email,setEmail]=useState("");
 const [quote,setQuote]=useState<{key:string;availableRooms:number;breakdown:PriceBreakdown}|null>(null);
 const [message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 const requestKey=useRef<string>(crypto.randomUUID());
 const selection=JSON.stringify({roomTypeId:roomId,roomQuantity:quantity,guests,checkIn,checkOut});
 const selected=rooms.find(r=>r.id===roomId);
 useEffect(()=>{
  const query=new URLSearchParams(window.location.search);
  if(query.get("checkIn"))setCheckIn(query.get("checkIn")!);if(query.get("checkOut"))setCheckOut(query.get("checkOut")!);
  if(query.get("roomTypeId")&&rooms.some(r=>r.id===query.get("roomTypeId")))setRoomId(query.get("roomTypeId")!);
  if(query.get("roomQuantity"))setQuantity(Number(query.get("roomQuantity"))||1);if(query.get("guests"))setGuests(Number(query.get("guests"))||1);
 },[rooms]);
 useEffect(()=>{requestKey.current=crypto.randomUUID();setError("");},[selection]);
 useEffect(()=>{
  setQuote(null);setMessage("");if(!roomId||!checkIn||!checkOut)return;
  const controller=new AbortController();setMessage("Checking rooms and total…");
  const params=new URLSearchParams({roomTypeId:roomId,roomQuantity:String(quantity),guests:String(guests),checkIn,checkOut});
  fetch(`/api/properties/${propertyId}/room-quote?${params}`,{signal:controller.signal,cache:"no-store"}).then(async response=>{
   const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to check rooms");
   setQuote({...data.quote,key:selection});setMessage("");
  }).catch(e=>{if(e.name!=="AbortError")setMessage(e.message);});return()=>controller.abort();
 },[propertyId,selection,refresh,roomId,quantity,guests,checkIn,checkOut]);
 async function reserve() {
  setError("");const validation=validateBookingForm({checkIn,checkOut,guests,maxGuests:Math.min(50,(selected?.maxGuests??0)*quantity),guestName:name,guestEmail:email});
  if(validation){setError(validation);return;}if(!quote||quote.key!==selection){setError("Check room availability first.");return;}
  setBusy(true);
  try{
   const response=await fetch("/api/bookings",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":requestKey.current},
    body:JSON.stringify({propertyId,roomTypeId:roomId,roomQuantity:quantity,guests,checkIn,checkOut,guestName:name,guestEmail:email})});
   if(response.status===401){const query=new URLSearchParams({checkIn,checkOut,guests:String(guests),roomTypeId:roomId,roomQuantity:String(quantity)});
    window.location.href=`/login?returnTo=${encodeURIComponent(window.location.pathname+"?"+query)}`;return;}
   const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to reserve rooms");
   if(data.booking.status!=="pending_payment" || (data.booking.holdExpiresAt && Date.parse(data.booking.holdExpiresAt)<=Date.now())) {
    requestKey.current=crypto.randomUUID();throw new Error("This reservation hold has ended. Refresh availability and reserve again.");
   }
   window.location.href=`/checkout/${data.booking.id}`;
  }catch(e){setError((e as Error).message);setRefresh(v=>v+1);}finally{setBusy(false);}
 }
 return <div className="booking-panel">
 <h2>Choose your rooms</h2>{rooms.length===0?<p>Rooms are being prepared for this hotel.</p>:<>
 <div className="booking-fields">
 <div className="booking-field full"><label htmlFor="hotel-room">Room type</label><select id="hotel-room" disabled={busy} value={roomId} onChange={e=>setRoomId(e.target.value)} style={{padding:12,width:"100%"}}>{rooms.map(r=><option key={r.id} value={r.id}>{r.name} · up to {r.maxGuests} guests per room</option>)}</select></div>
 <div className="booking-field"><label htmlFor="hotel-quantity">Rooms</label><input id="hotel-quantity" disabled={busy} type="number" min={1} max={Math.min(50,selected?.totalRooms??1)} value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/></div>
 <div className="booking-field"><label htmlFor="hotel-guests">Guests in total</label><input id="hotel-guests" disabled={busy} type="number" min={1} max={Math.min(50,(selected?.maxGuests??1)*quantity)} value={guests} onChange={e=>setGuests(Number(e.target.value))}/></div>
 <div className="booking-field"><label htmlFor="hotel-check-in">Check-in</label><input id="hotel-check-in" disabled={busy} type="date" min={new Date().toISOString().slice(0,10)} value={checkIn} onChange={e=>setCheckIn(e.target.value)}/></div>
 <div className="booking-field"><label htmlFor="hotel-check-out">Check-out</label><input id="hotel-check-out" disabled={busy} type="date" min={checkIn} value={checkOut} onChange={e=>setCheckOut(e.target.value)}/></div>
 <div className="booking-field full"><label htmlFor="hotel-name">Full name</label><input id="hotel-name" disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></div>
 <div className="booking-field full"><label htmlFor="hotel-email">Email</label><input id="hotel-email" disabled={busy} type="email" value={email} onChange={e=>setEmail(e.target.value)}/></div>
 </div>
 <p role="status">{message}</p>
 {quote&&quote.key===selection&&<div className="price-summary">
 <p>{quote.availableRooms} rooms available throughout your stay</p>
 <div className="price-row"><span>{quantity} × {selected?.name} · {quote.breakdown.nights} nights</span><span>{formatCurrency(quote.breakdown.accommodationMinor,currency)}</span></div>
 <div className="price-row"><span>Cleaning</span><span>{formatCurrency(quote.breakdown.cleaningMinor,currency)}</span></div>
 {!!quote.breakdown.guestServiceFeeMinor&&<div className="price-row"><span>Guest service fee</span><span>{formatCurrency(quote.breakdown.guestServiceFeeMinor,currency)}</span></div>}
 <div className="price-row"><span>Taxes</span><span>{formatCurrency(quote.breakdown.taxesMinor,currency)}</span></div>
 <div className="price-row price-total"><span>Total</span><span>{formatCurrency(quote.breakdown.guestTotalMinor,currency)}</span></div></div>}
 {error&&<p role="alert" className="field-error">{error}</p>}
 <button className="btn-primary" disabled={busy||!quote||quote.key!==selection} onClick={reserve}>{busy?"Reserving…":"Reserve rooms"}</button>
 <p className="booking-note">Your rooms are held for 15 minutes during checkout. The final total is confirmed at checkout. One room type per booking.</p>
 <button type="button" disabled={busy} onClick={()=>setRefresh(v=>v+1)} style={{marginTop:12}}>Refresh availability</button>
 </>}
 </div>;
}
export function HotelRoomGallery({rooms,currency}:{rooms:PublicRoomType[];currency:string}) {
 return <section style={{margin:"28px 0"}}><h2>Room types</h2>{rooms.map(room=><article key={room.id} style={{borderTop:"1px solid #ddd8cf",padding:"20px 0"}}>
 <h3>{room.name}</h3><p>{room.description}</p><p>Up to {room.maxGuests} guests per room · From {formatCurrency(Math.round(Number(room.nightlyPrice)*100),currency)} per room/night</p>
 <div style={{display:"flex",gap:12,overflowX:"auto"}}>{room.images.map(photo=><img key={photo.id} src={photo.url} alt={photo.altText??room.name} loading="lazy" style={{width:220,height:160,objectFit:"cover",borderRadius:8}}/>)}</div>
 </article>)}</section>;
}
