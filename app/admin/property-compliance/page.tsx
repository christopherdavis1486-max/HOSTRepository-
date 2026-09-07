"use client";
import { useEffect,useState } from "react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useHostI18n } from "@/lib/i18n/useHostI18n";
type Property={id:string;name:string;city:string;country_code:string;status:string;compliance_status:string;owner_email:string;compliance_submitted_at:string|null};
type Detail={property:Record<string,unknown>;items:Array<Record<string,unknown>>};
const box={background:"#1d1a15",border:"1px solid #342c20",padding:24,marginBottom:16};

export default function AdminPropertyCompliancePage(){
  const {ht,hStatus}=useHostI18n();
  const [properties,setProperties]=useState<Property[]>([]);const [detail,setDetail]=useState<Detail|null>(null);const [selected,setSelected]=useState("");const [note,setNote]=useState("");const [message,setMessage]=useState("");
  async function load(){setMessage(ht("Loading review queue…"));const response=await fetch("/api/admin/property-compliance",{credentials:"include",cache:"no-store"});const body=await response.json();if(!response.ok){setMessage(body.error?.message??ht("Unable to load queue."));return;}setProperties(body.properties);setMessage("");}
  useEffect(()=>{void load();},[]);
  async function open(id:string){setSelected(id);const response=await fetch(`/api/admin/property-compliance?propertyId=${id}`,{credentials:"include",cache:"no-store"});const body=await response.json();if(response.ok)setDetail(body.compliance);else setMessage(body.error?.message??ht("Unable to load record."));}
  async function decide(decision:"approved"|"changes_required"){const response=await fetch("/api/admin/property-compliance",{method:"PATCH",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({propertyId:selected,decision,note})});const body=await response.json();if(!response.ok){setMessage(body.error?.message??ht("Review failed."));return;}setDetail(null);setSelected("");setNote("");await load();setMessage(ht(decision==="approved"?"Compliance approved and audited.":"Changes requested and audited."));}
  return <main style={{minHeight:"100vh",background:"#100f0c",color:"#fff8e8",padding:"48px 6vw",fontFamily:"Arial,sans-serif"}}><div style={{maxWidth:1100,margin:"0 auto"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><a href="/admin/security" style={{color:"#c4a98b"}}>← {ht("Admin security")}</a><LanguageSelector compact/></div>
    <h1 style={{fontFamily:"Georgia,serif",fontSize:42}}>{ht("Property compliance")}</h1><p style={{color:"#c4a98b"}}>Review owner-supplied evidence. Approval records the review; it does not transfer the owner’s legal responsibility to HOST.</p>
    {properties.map(property=><section key={property.id} style={box}><strong>{property.name}</strong><p style={{color:"#c4a98b"}}>{property.city}, {property.country_code} · {property.owner_email} · {hStatus(property.compliance_status)}</p><button onClick={()=>open(property.id)}>{ht("Review record")}</button></section>)}
    {detail&&<section style={box}><h2>{String(detail.property.name)}</h2>{detail.items.map(item=><div key={String(item.category)} style={{borderTop:"1px solid #342c20",padding:"14px 0"}}><strong>{ht(String(item.category).replace(/_/g," "))}</strong><p style={{color:"#c4a98b"}}>{hStatus(String(item.applicability))} · {ht("owner declaration")}: {Boolean(item.owner_declared_compliant)?ht("yes"):ht("no")} · {ht("valid until")}: {String(item.valid_until??ht("not stated"))}</p>{Boolean(item.evidence_url)&&<a href={String(item.evidence_url)} target="_blank" rel="noopener noreferrer" style={{color:"#d49a3f"}}>{ht("Open evidence")} ↗</a>}</div>)}<textarea placeholder={ht("Required review note (minimum 8 characters)")} value={note} onChange={event=>setNote(event.target.value)} style={{display:"block",width:"100%",minHeight:90,margin:"18px 0",padding:12}}/><button onClick={()=>decide("changes_required")} style={{marginRight:10}}>{ht("Request changes")}</button><button onClick={()=>decide("approved")} style={{background:"#d49a3f",border:0,padding:"10px 14px"}}>{ht("Approve compliance")}</button></section>}
    {message&&<p role="status" style={{color:"#d49a3f"}}>{message}</p>}
  </div></main>;
}
