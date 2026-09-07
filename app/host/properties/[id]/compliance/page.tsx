"use client";
import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

const categories = [
  ["authority_to_list","Authority to offer the property",false],
  ["fire_safety","Fire-safety assessment and precautions",false],
  ["gas_safety","Gas safety checks (where gas is present)",true],
  ["electrical_safety","Electrical installation and appliance safety",false],
  ["smoke_co_alarms","Smoke and carbon-monoxide alarms",false],
  ["public_liability_insurance","Property and public-liability insurance",false],
  ["licences_permissions","Required licences, registrations and permissions",true],
] as const;
type Item={category:string;applicability:"required"|"not_applicable";ownerDeclaredCompliant:boolean;evidenceUrl:string;evidenceReference:string;validUntil:string;ownerNote:string;reviewStatus?:string;reviewerNote?:string|null};
const blankItems=()=>categories.map(([category])=>({category,applicability:"required" as const,ownerDeclaredCompliant:false,evidenceUrl:"",evidenceReference:"",validUntil:"",ownerNote:""}));
const card={background:"#1d1a15",border:"1px solid #342c20",padding:24,marginTop:16};
const input={display:"block",width:"100%",marginTop:6,padding:11,background:"#100f0c",color:"#fff8e8",border:"1px solid #3c3225"};

export default function PropertyCompliancePage({params}:{params:Promise<{id:string}>}){
  const {ht,hStatus}=useHostI18n();
  const [id,setId]=useState(""); const [name,setName]=useState(""); const [status,setStatus]=useState("loading");
  const [items,setItems]=useState<Item[]>(blankItems()); const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false);
  useEffect(()=>{params.then(value=>setId(value.id));},[params]);
  useEffect(()=>{if(!id)return;fetch(`/api/host/properties/${id}/compliance`,{credentials:"include",cache:"no-store"}).then(async response=>{const body=await response.json();if(!response.ok){setMessage(body.error?.message??ht("Unable to load compliance."));return;}const saved=new Map(body.compliance.items.map((item:Record<string,unknown>)=>[item.category,item]));setName(body.compliance.property.name);setStatus(body.compliance.property.compliance_status);setItems(blankItems().map(item=>{const row=saved.get(item.category) as Record<string,unknown>|undefined;return row?{category:item.category,applicability:row.applicability as Item["applicability"],ownerDeclaredCompliant:Boolean(row.owner_declared_compliant),evidenceUrl:String(row.evidence_url??""),evidenceReference:String(row.evidence_reference??""),validUntil:String(row.valid_until??"").slice(0,10),ownerNote:String(row.owner_note??""),reviewStatus:String(row.review_status??""),reviewerNote:row.reviewer_note as string|null}:item;}));}).catch(()=>setMessage(ht("Unable to load compliance.")));},[id,ht]);
  const update=(index:number,changes:Partial<Item>)=>setItems(current=>current.map((item,i)=>i===index?{...item,...changes}:item));
  async function save(submit:boolean){setBusy(true);setMessage("");const response=await fetch(`/api/host/properties/${id}/compliance`,{method:"PUT",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({submit,items})});const body=await response.json();setBusy(false);if(!response.ok){setMessage(body.error?.message??ht("Unable to save compliance."));return;}setStatus(body.status);setMessage(ht(submit?"Compliance record submitted to HOST for review.":"Compliance draft saved."));}
  return <main style={{minHeight:"100vh",background:"#100f0c",color:"#fff8e8",padding:"28px 6vw 80px",fontFamily:"Arial,sans-serif"}}><div style={{maxWidth:980,margin:"0 auto"}}>
    <a href={`/host/properties/${id}`} style={{color:"#c4a98b"}}>← {ht("Back to property")}</a><h1 style={{fontFamily:"Georgia,serif",fontSize:40}}>{name||ht("Property compliance")}</h1><HostNav active="properties"/>
    <section style={card}><p><strong>{ht("Status")}:</strong> {hStatus(status)}</p><p style={{color:"#c4a98b",lineHeight:1.6}}>The property owner is responsible for accurate declarations and keeping evidence current. HOST review records the evidence checked; it is not a guarantee that hazards cannot exist.</p></section>
    {items.map((item,index)=>{const category=categories.find(([key])=>key===item.category);const label=category?.[1]??item.category;const allowsNA=category?.[2]??false;const na=item.applicability==="not_applicable";return <section key={item.category} style={card}><h2 style={{fontSize:19}}>{ht(label)}</h2>
      <label style={{display:"block",margin:"12px 0"}}>{ht("Applicability")} <select value={item.applicability} disabled={!allowsNA} onChange={event=>{const applicability=event.target.value as Item["applicability"];update(index,{applicability,ownerDeclaredCompliant:applicability==="not_applicable"?false:item.ownerDeclaredCompliant,evidenceUrl:applicability==="not_applicable"?"":item.evidenceUrl,validUntil:applicability==="not_applicable"?"":item.validUntil});}} style={{marginLeft:12,padding:9}}><option value="required">{ht("Applicable")}</option>{allowsNA&&<option value="not_applicable">{ht("Not applicable")}</option>}</select></label>
      {!na&&<><label style={{display:"block",margin:"12px 0"}}><input type="checkbox" checked={item.ownerDeclaredCompliant} onChange={event=>update(index,{ownerDeclaredCompliant:event.target.checked})}/> {ht("I confirm this check is current and the property complies with the applicable requirements.")}</label><label style={{display:"block",margin:"12px 0"}}>{ht("Evidence HTTPS link")}<input value={item.evidenceUrl} onChange={event=>update(index,{evidenceUrl:event.target.value})} placeholder="https://secure-document-provider.example/..." style={input}/></label><label>{ht("Valid until (if the document expires)")}<input type="date" value={item.validUntil} onChange={event=>update(index,{validUntil:event.target.value})} style={{display:"block",marginTop:6,padding:10}}/></label></>}
      <label style={{display:"block",marginTop:12}}>{ht("Reference or explanation")}<input value={item.evidenceReference} onChange={event=>update(index,{evidenceReference:event.target.value})} style={input}/></label>{item.reviewStatus&&item.reviewStatus!=="not_reviewed"&&<p style={{color:"#d49a3f"}}>{ht("HOST review")}: {hStatus(item.reviewStatus)}{item.reviewerNote?` — ${item.reviewerNote}`:""}</p>}
    </section>;})}
    <div style={{marginTop:24}}><button disabled={busy} onClick={()=>save(false)} style={{padding:"13px 18px",marginRight:10}}>{ht("Save draft")}</button><button disabled={busy} onClick={()=>save(true)} style={{padding:"13px 18px",background:"#d49a3f",border:0}}>{ht("Submit for HOST review")}</button></div>{message&&<p role="status" style={{color:"#d49a3f"}}>{message}</p>}
  </div></main>;
}
