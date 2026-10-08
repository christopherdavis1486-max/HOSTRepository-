"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AvailabilityCalendar } from "./AvailabilityCalendar";
import { formatDate } from "@/lib/presentation/formatters";
import styles from "./HotelBookingPanel.module.css";
import { validateBookingForm } from "@/lib/booking/bookingFormValidation";
import { formatCurrency } from "@/lib/presentation/formatters";
import type { PriceBreakdown } from "@/lib/booking/types";
export type PublicRoomType={id:string;name:string;description:string;maxGuests:number;totalRooms:number;nightlyPrice:string|number;cleaningFee:string|number;images:{id:string;url:string;altText:string|null}[]};
export function HotelBookingPanel({propertyId,currency,rooms,selectedRoomId,onSelectRoom,onReservationBusyChange}:{propertyId:string;currency:string;rooms:PublicRoomType[];selectedRoomId:string;onSelectRoom:(id:string)=>void;onReservationBusyChange:(busy:boolean)=>void}) {
 const roomId=rooms.some(r=>r.id===selectedRoomId)?selectedRoomId:(rooms[0]?.id??"");
 const [quantity,setQuantity]=useState(1),[guests,setGuests]=useState(1);
 const initializedProperty=useRef<string|null>(null);
 const [checkIn,setCheckIn]=useState(""),[checkOut,setCheckOut]=useState(""),[name,setName]=useState(""),[email,setEmail]=useState("");
 const [quote,setQuote]=useState<{key:string;availableRooms:number;breakdown:PriceBreakdown}|null>(null);
 const [message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 const calendarSection=useRef<HTMLElement>(null);
 const [calendarOpen,setCalendarOpen]=useState(false);
 const [calendarTarget,setCalendarTarget]=useState<HTMLElement|null>(null);
 useEffect(()=>{setCalendarTarget(document.getElementById("hotel-calendar-container"));},[propertyId]);
 const dateOpener=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(!calendarOpen)return;
  calendarSection.current?.scrollIntoView({behavior:"smooth",block:"start"});
  calendarSection.current?.focus({preventScroll:true});
 },[calendarOpen,calendarTarget]);
 function closeCalendar(){
  setCalendarOpen(false);
  requestAnimationFrame(()=>{
   dateOpener.current?.scrollIntoView({behavior:"smooth",block:"center"});
   dateOpener.current?.focus({preventScroll:true});
  });
 }
 const [calendarRange,setCalendarRange]=useState<{start:string;end:string}|null>(null);
 const [calendarData,setCalendarData]=useState<{key:string;dates:Set<string>}|null>(null);
 const [calendarError,setCalendarError]=useState("");
 const visibleRange=useCallback((start:string,end:string)=>setCalendarRange({start,end}),[]);
 const calendarKey=JSON.stringify({propertyId,roomId,quantity,calendarRange,refresh});
 useEffect(()=>{
  setCalendarData(null);setCalendarError("");if(!calendarRange||!roomId)return;
  const controller=new AbortController();
  const params=new URLSearchParams({roomTypeId:roomId,roomQuantity:String(quantity),...calendarRange});
  fetch(`/api/properties/${propertyId}/room-availability?${params}`,{cache:"no-store",signal:controller.signal})
   .then(async response=>{const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to load room availability");if(!controller.signal.aborted)setCalendarData({key:calendarKey,dates:new Set<string>(data.unavailableDates)});})
   .catch(e=>{if(!controller.signal.aborted)setCalendarError(e.message);});
  return()=>controller.abort();
 },[calendarKey,propertyId,roomId,quantity,calendarRange]);
 const calendarReady=calendarData?.key===calendarKey;
 const calendarDates=calendarData && calendarReady?calendarData.dates:new Set<string>();
 const firstClosed=calendarReady&&checkIn&&!checkOut?[...calendarDates].filter(d=>d>checkIn).sort()[0]:undefined;
 function selectCalendarDate(date:string) {
  if(!calendarReady||busy)return;
  if(!checkIn||checkOut||date<=checkIn){setCheckIn(date);setCheckOut("");return;}
  if(calendarRange && checkIn<calendarRange.start){setCalendarError("Return to your check-in month to choose checkout, or choose a new check-in date.");return;}
  if([...calendarDates].some(d=>d>=checkIn&&d<date)){setCalendarError("Choose a range with enough rooms on every night.");return;}
  setCheckOut(date);setCalendarError("");
 }
 const requestKey=useRef<string>(crypto.randomUUID());
 const selection=JSON.stringify({roomTypeId:roomId,roomQuantity:quantity,guests,checkIn,checkOut});
 const feedbackKey=calendarKey+"|"+selection;
 const [refreshTarget,setRefreshTarget]=useState("");
 const [quoteCheck,setQuoteCheck]=useState<{key:string;error:string}|null>(null);
 const refreshActive=refreshTarget===feedbackKey;
 const refreshFailure=calendarError || (quoteCheck?.key===feedbackKey?quoteCheck.error:"");
 const refreshPending=refreshActive&&!refreshFailure&&(!calendarReady || (!!checkIn&&!!checkOut&&quoteCheck?.key!==feedbackKey));
 const refreshFeedback=refreshActive?(refreshFailure?"Unable to refresh availability: "+refreshFailure:refreshPending?"Refreshing…":"Availability updated"):"";
 function refreshAvailability() {
  const next=refresh+1;
  setRefreshTarget(JSON.stringify({propertyId,roomId,quantity,calendarRange,refresh:next})+"|"+selection);
  setQuoteCheck(null);setCalendarError("");setRefresh(next);
 }
 const selected=rooms.find(r=>r.id===roomId);
 useEffect(()=>{
  if(initializedProperty.current===propertyId)return;
  initializedProperty.current=propertyId;
  const query=new URLSearchParams(window.location.search);
  if(query.get("checkIn"))setCheckIn(query.get("checkIn")!);if(query.get("checkOut"))setCheckOut(query.get("checkOut")!);
  if(query.get("roomTypeId")&&rooms.some(r=>r.id===query.get("roomTypeId")))onSelectRoom(query.get("roomTypeId")!);
  if(query.get("roomQuantity"))setQuantity(Number(query.get("roomQuantity"))||1);if(query.get("guests"))setGuests(Number(query.get("guests"))||1);
 },[propertyId,rooms,onSelectRoom]);
 useEffect(()=>{requestKey.current=crypto.randomUUID();setError("");},[selection]);
 useEffect(()=>{
  setQuote(null);setQuoteCheck(null);setMessage("");if(!roomId||!checkIn||!checkOut)return;
  const controller=new AbortController();setMessage("Checking rooms and total…");
  const params=new URLSearchParams({roomTypeId:roomId,roomQuantity:String(quantity),guests:String(guests),checkIn,checkOut});
  fetch(`/api/properties/${propertyId}/room-quote?${params}`,{signal:controller.signal,cache:"no-store"}).then(async response=>{
   const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to check rooms");
   if(controller.signal.aborted)return;
   setQuote({...data.quote,key:selection});setQuoteCheck({key:feedbackKey,error:""});setMessage("");
  }).catch(e=>{if(!controller.signal.aborted){setMessage(e.message);setQuoteCheck({key:feedbackKey,error:e.message});}});return()=>controller.abort();
 },[propertyId,selection,refresh,roomId,quantity,guests,checkIn,checkOut]);
 async function reserve() {
  setError("");const validation=validateBookingForm({checkIn,checkOut,guests,maxGuests:Math.min(50,(selected?.maxGuests??0)*quantity),guestName:name,guestEmail:email});
  if(validation){setError(validation);return;}if(!quote||quote.key!==selection){setError("Check room availability first.");return;}
  setBusy(true);onReservationBusyChange(true);
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
  }catch(e){setError((e as Error).message);setRefresh(v=>v+1);}finally{setBusy(false);onReservationBusyChange(false);}
 }
 return <div id="hotel-booking-panel" className="booking-panel" tabIndex={-1}>
 <h2>Choose your rooms</h2>{rooms.length===0?<p>Rooms are being prepared for this hotel.</p>:<>
 <div className="booking-fields">
 <div className="booking-field full"><label htmlFor="hotel-room">Room type</label><select id="hotel-room" disabled={busy} value={roomId} onChange={e=>{onSelectRoom(e.target.value);setQuantity(1);setGuests(1);}} className={styles.roomSelect}>{rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><p className={styles.roomHint}>Up to {selected?.maxGuests} guests per room. Select dates to check availability.</p></div>
 <div className="booking-field"><label htmlFor="hotel-quantity">Rooms</label><input id="hotel-quantity" disabled={busy} type="number" min={1} max={Math.min(50,selected?.totalRooms??1)} value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/></div>
 <div className="booking-field"><label htmlFor="hotel-guests">Guests in total</label><input id="hotel-guests" disabled={busy} type="number" min={1} max={Math.min(50,(selected?.maxGuests??1)*quantity)} value={guests} onChange={e=>setGuests(Number(e.target.value))}/></div>
 <div className="booking-field"><label htmlFor="hotel-check-in">Check-in</label><input id="hotel-check-in" disabled={busy} type="date" min={new Date().toISOString().slice(0,10)} value={checkIn} onChange={e=>setCheckIn(e.target.value)}/></div>
 <div className="booking-field"><label htmlFor="hotel-check-out">Check-out</label><input id="hotel-check-out" disabled={busy} type="date" min={checkIn} value={checkOut} onChange={e=>setCheckOut(e.target.value)}/></div>
 <div className="booking-field full"><button type="button" ref={dateOpener} disabled={busy} className={styles.bookingCalendarButton} onClick={()=>setCalendarOpen(true)} aria-expanded={calendarOpen} aria-controls="hotel-calendar-container">Choose dates on calendar</button></div>
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
 <button type="button" disabled={busy||refreshPending} onClick={refreshAvailability} className={styles.refreshButton}><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg><span>{refreshPending?"Refreshing…":"Refresh availability"}</span></button>
 <p role="status" aria-live="polite">{refreshFeedback}</p>
 </>}
 {calendarTarget && calendarOpen && createPortal(<section ref={calendarSection} tabIndex={-1} className={styles.inlineCalendar} aria-labelledby="hotel-calendar-title">
 <div className={styles.dateHeader}><div><h2 id="hotel-calendar-title">Choose your dates</h2><p>{selected?.name} · {quantity} {quantity===1?"room":"rooms"}</p></div><button type="button" aria-label="Close calendar" onClick={closeCalendar}>×</button></div>
 <p className={styles.dateHelp}>Select check-in, then check-out. Crossed-out dates cannot be reserved as nights. Checkout on the first unavailable night is allowed.</p>
 <p role="status" aria-live="polite" className={styles.dateHelp}>{refreshFeedback || calendarError || (!calendarReady?"Loading room availability…":"Availability is checked again before reservation.")}</p>
 <AvailabilityCalendar spacious maxViewOffset={12} onVisibleRangeChange={visibleRange} disabledDates={calendarDates} interactive={!!calendarReady&&!busy} checkIn={checkIn} checkOut={checkOut} selectableCheckoutDate={calendarReady&&!busy?firstClosed:undefined} onSelectDate={selectCalendarDate}/>
 <div className={styles.dateFooter}><button type="button" disabled={busy||refreshPending} onClick={refreshAvailability}>{refreshPending?"Refreshing…":"Refresh availability"}</button><span>{checkIn?formatDate(checkIn):"Check-in"} → {checkOut?formatDate(checkOut):"Check-out"}</span><button type="button" disabled={busy} onClick={()=>{setCheckIn("");setCheckOut("");}}>Clear dates</button><button type="button" onClick={closeCalendar}>Back to reservation</button></div>
 </section>,calendarTarget)}
 </div>;
}
export { HotelRoomGallery } from "./HotelRoomGallery";
