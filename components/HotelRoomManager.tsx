"use client";
import { useCallback, useEffect, useRef, useState } from "react";
type Photo = {id:string;url:string;altText:string|null};
type Room = {id:string;name:string;description:string;maxGuests:number;totalRooms:number;nightlyPrice:string|number;cleaningFee:string|number;active:boolean;images:Photo[]};
type Night = {date:string;capacity:number;reserved:number;available:number;price:string};
const emptyRoom={name:"",description:"",maxGuests:2,totalRooms:1,nightlyPrice:100,cleaningFee:0,active:true,imageIds:[] as string[]};
export function HotelRoomManager({propertyId}:{propertyId:string}) {
 const editorHeading=useRef<HTMLHeadingElement>(null);
 const endpoint=`/api/host/properties/${propertyId}/rooms`;
 const [rooms,setRooms]=useState<Room[]>([]),[photos,setPhotos]=useState<Photo[]>([]);
 const [form,setForm]=useState(emptyRoom),[editing,setEditing]=useState<string|null>(null);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 const [inventoryRoom,setInventoryRoom]=useState(""),[start,setStart]=useState(""),[end,setEnd]=useState(""),[count,setCount]=useState(1),[price,setPrice]=useState("");
 const [nights,setNights]=useState<Night[]>([]);
 async function request(url:string,init?:RequestInit) {
  const response=await fetch(url,{cache:"no-store",...init});const data=await response.json();
  if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to save room details. Check all fields.");return data;
 }
 const load=useCallback(async()=>{
  const response=await fetch(endpoint,{cache:"no-store"});const data=await response.json();
  if(!response.ok||!data.success)throw new Error(data.error?.message??"Unable to load rooms");setRooms(data.rooms);setLoaded(true);
  const imageResponse=await fetch(`/api/host/properties/${propertyId}/images`,{cache:"no-store"});const images=await imageResponse.json();
  if(!imageResponse.ok||!images.success)throw new Error("Unable to load room photos");setPhotos(images.images);
 },[endpoint,propertyId]);
 useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
 async function saveRoom(event:React.FormEvent) {
  event.preventDefault();setBusy(true);setError("");setMessage("");
  try{await request(editing?`${endpoint}/${editing}`:endpoint,{method:editing?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(form)});
   await load();setForm({...emptyRoom,imageIds:[]});setEditing(null);setMessage("Room type saved. Changes to room details or photos require HOST review before publishing.");
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function inventory(save:boolean) {
  setBusy(true);setError("");setMessage("");setNights([]);
  try{if(!inventoryRoom||!start||!end)throw new Error("Choose a room type and date range.");const url=`${endpoint}/${inventoryRoom}/inventory`;
   if(save)await request(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({start,end,totalRooms:count,nightlyPrice:price===""?null:Number(price)})});
   const data=await request(`${url}?start=${start}&end=${end}`);setNights(data.nights);if(save)setMessage("Nightly inventory saved.");
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="room-manager">
 <style>{`.room-manager{max-width:1050px;margin:32px auto;padding:24px;color:#14120e;font-family:system-ui}.room-manager h1,.room-manager h2{font-family:Georgia,serif}.room-manager section{border:1px solid #ddd8cf;border-radius:16px;padding:24px;margin:24px 0;background:white}.room-manager .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}.room-manager label{display:block;font-size:14px}.room-manager input:not([type=checkbox]),.room-manager select,.room-manager textarea{display:block;box-sizing:border-box;width:100%;padding:10px;margin:6px 0 14px;border:1px solid #aaa;border-radius:6px}.room-manager button{padding:10px 18px;margin:8px 8px 8px 0;background:#1f1b15;color:white;border:0;border-radius:6px;cursor:pointer}.room-manager button:disabled{opacity:.5}.room-manager .photos{display:flex;gap:12px;flex-wrap:wrap}.room-manager .photos img{width:100px;height:75px;object-fit:cover;display:block}.room-manager table{width:100%;border-collapse:collapse}.room-manager td,.room-manager th{text-align:left;padding:10px;border-bottom:1px solid #ddd}.room-manager .table{overflow:auto;max-height:380px}.room-manager .error{color:#9b2626}`}</style>
 <a href={`/host/properties/${propertyId}`}>← Back to property</a><h1>Rooms and nightly inventory</h1>
 <p>Set capacity and prices for each room type. Reservations keep the room name and price agreed at booking.</p>
 <p role="status">{message}</p>{error&&<p role="alert" className="error">{error}</p>}{!loaded&&<p>Loading room types…</p>}
 <section><h2>Room types</h2>{rooms.length===0&&loaded&&<p>Add your first room type below.</p>}
 {rooms.map(room=><div key={room.id}><h3>{room.name} {room.active?"":"(paused)"}</h3><p>{room.totalRooms} rooms · {room.maxGuests} guests per room · {Number(room.nightlyPrice).toFixed(2)} per room/night</p>
 <button disabled={busy} onClick={()=>{setEditing(room.id);setForm({name:room.name,description:room.description,maxGuests:room.maxGuests,totalRooms:room.totalRooms,nightlyPrice:Number(room.nightlyPrice),cleaningFee:Number(room.cleaningFee),active:room.active,imageIds:room.images.map(i=>i.id)});requestAnimationFrame(()=>{editorHeading.current?.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});editorHeading.current?.focus({preventScroll:true});});}} aria-controls="room-type-editor">Edit {room.name}</button></div>)}</section>
 <section id="room-type-editor" aria-labelledby="room-type-editor-heading"><h2 id="room-type-editor-heading" ref={editorHeading} tabIndex={-1} style={{scrollMarginTop:96}}>{editing?`Edit room type: ${form.name}`:"Add room type"}</h2><form onSubmit={saveRoom}>
 <label>Room name<input required maxLength={150} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
 <label>Description<textarea maxLength={3000} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
 <div className="grid">
 <label>Guests per room<input required type="number" min={1} max={50} value={form.maxGuests} onChange={e=>setForm({...form,maxGuests:Number(e.target.value)})}/></label>
 <label>Total rooms<input required type="number" min={1} max={10000} value={form.totalRooms} onChange={e=>setForm({...form,totalRooms:Number(e.target.value)})}/></label>
 <label>Price per room/night (property currency)<input required type="number" min={.01} max={100000} step=".01" value={form.nightlyPrice} onChange={e=>setForm({...form,nightlyPrice:Number(e.target.value)})}/></label>
 <label>Cleaning fee per room/stay<input required type="number" min={0} max={100000} step=".01" value={form.cleaningFee} onChange={e=>setForm({...form,cleaningFee:Number(e.target.value)})}/></label></div>
 <label><input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}/> Available for new bookings</label>
 <h3>Room photos</h3><p>Upload photos on the property page, then choose photos for this room type.</p><button type="button" disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>Refresh photos</button>
 <div className="photos">{photos.map(photo=><label key={photo.id}><img src={photo.url} alt={photo.altText??"Property photo"}/><input type="checkbox" checked={form.imageIds.includes(photo.id)} onChange={e=>setForm({...form,imageIds:e.target.checked?[...form.imageIds,photo.id]:form.imageIds.filter(id=>id!==photo.id)})}/> Select photo</label>)}</div>
 <button disabled={busy||!loaded} type="submit">{busy?"Saving…":"Save room type"}</button>{editing&&<button type="button" disabled={busy} onClick={()=>{setEditing(null);setForm({...emptyRoom,imageIds:[]});}}>Cancel edit</button>}</form></section>
 <section><h2>Nightly inventory</h2><p>Dates without overrides use the room type’s count and price. Set zero rooms to close a night. Inventory cannot be reduced below existing reservations.</p><div className="grid">
 <label>Room type<select value={inventoryRoom} onChange={e=>{setInventoryRoom(e.target.value);setNights([]);}}><option value="">Select room type</option>{rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
 <label>First night<input type="date" value={start} onChange={e=>{setStart(e.target.value);setNights([]);}}/></label><label>End date (not included)<input type="date" value={end} onChange={e=>{setEnd(e.target.value);setNights([]);}}/></label>
 <label>Rooms for sale<input type="number" min={0} max={rooms.find(r=>r.id===inventoryRoom)?.totalRooms??10000} value={count} onChange={e=>setCount(Number(e.target.value))}/></label>
 <label>Nightly price override (blank uses base price)<input type="number" min={.01} max={100000} step=".01" value={price} onChange={e=>setPrice(e.target.value)}/></label></div>
 <button disabled={busy} onClick={()=>inventory(false)}>View nights</button><button disabled={busy} onClick={()=>inventory(true)}>Save date range</button>
 {!!nights.length&&<div className="table"><table><thead><tr><th>Night</th><th>For sale</th><th>Reserved</th><th>Remaining</th><th>Room price</th></tr></thead><tbody>{nights.map(n=><tr key={n.date}><td>{n.date}</td><td>{n.capacity}</td><td>{n.reserved}</td><td>{n.available}</td><td>{Number(n.price).toFixed(2)}</td></tr>)}</tbody></table></div>}</section>
 </div>;
}
