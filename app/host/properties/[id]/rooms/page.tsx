"use client";
import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { HotelRoomManager } from "@/components/HotelRoomManager";
export default function HotelRoomsPage({params}:{params:Promise<{id:string}>}) {
  const [id,setId]=useState<string|null>(null);
  useEffect(()=>{params.then(p=>setId(p.id));},[params]);
  return <><HostNav active="properties"/>{id?<HotelRoomManager propertyId={id}/>:<p>Loading…</p>}</>;
}
