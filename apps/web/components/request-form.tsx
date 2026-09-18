"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createJobSchema, type CreateJobInput, type Job, type TriageSuggestion } from "@rescue/contracts";
import { apiRequest } from "@/lib/api";

const defaultOrg = "22222222-2222-4222-8222-222222222222";
type CreateJobFormInput = z.input<typeof createJobSchema>;
export function RequestForm() {
  const [result,setResult]=useState<{job:Job;triage:TriageSuggestion}|null>(null); const [serverError,setServerError]=useState<string>();
  const { register, handleSubmit, formState:{errors,isSubmitting} }=useForm<CreateJobFormInput>({ resolver:zodResolver(createJobSchema), defaultValues:{ organizationId:defaultOrg, type:"FAILED_DELIVERY", urgency:"SCHEDULED", pickup:{countryCode:"DE"}, destination:{countryCode:"DE"}, items:[{name:"",quantity:1}], stairs:0, liftAvailable:false } });
  const submit=async(raw:CreateJobFormInput)=>{ setServerError(undefined); try { const input:CreateJobInput=createJobSchema.parse(raw); const response=await apiRequest<{data:{job:Job;triage:TriageSuggestion}}>("/v1/jobs",{method:"POST",body:JSON.stringify(input)}); setResult(response.data); } catch(error){setServerError(error instanceof Error?error.message:"Request failed");}};
  if(result) return <div className="success"><strong>Request {result.job.id.slice(0,8)} created.</strong><br/>Suggested vehicle: {result.triage.vehicleClass.replaceAll("_"," ")} · Team: {result.triage.workers} · Human approval required.</div>;
  return <form className="form" onSubmit={handleSubmit(submit)} noValidate>
    <div className="form-grid"><label>What happened?<select {...register("type")}><option value="FAILED_DELIVERY">Failed delivery</option><option value="BULKY_RETURN">Bulky return</option><option value="COMPANY_SURPLUS">Company surplus</option></select></label><label>Urgency<select {...register("urgency")}><option value="SCHEDULED">Scheduled</option><option value="SAME_DAY">Same day</option><option value="URGENT">Urgent</option></select></label></div>
    <h3>Pickup</h3><div className="form-grid"><label>Street and number<input {...register("pickup.line1")}/>{errors.pickup?.line1&&<span className="error">{errors.pickup.line1.message}</span>}</label><label>Postal code<input inputMode="numeric" {...register("pickup.postalCode")}/>{errors.pickup?.postalCode&&<span className="error">{errors.pickup.postalCode.message}</span>}</label><label>City<input {...register("pickup.city")}/></label><label>Customer reference<input {...register("customerReference")}/></label></div>
    <h3>Destination</h3><div className="form-grid"><label>Street and number<input {...register("destination.line1")}/></label><label>Postal code<input inputMode="numeric" {...register("destination.postalCode")}/></label><label>City<input {...register("destination.city")}/></label></div>
    <h3>First item</h3><div className="form-grid"><label>Item name<input {...register("items.0.name")}/>{errors.items?.[0]?.name&&<span className="error">{errors.items[0].name.message}</span>}</label><label>Estimated weight kg<input type="number" step="1" {...register("items.0.estimatedWeightKg",{valueAsNumber:true})}/></label><label>Quantity<input type="number" min="1" {...register("items.0.quantity",{valueAsNumber:true})}/></label><label>Stair floors<input type="number" min="0" {...register("stairs",{valueAsNumber:true})}/></label></div>
    <label>Additional information<textarea {...register("notes")} placeholder="Access, parking, condition and deadline"/></label>{serverError&&<div className="error">{serverError}</div>}<button className="button" disabled={isSubmitting}>{isSubmitting?"Creating…":"Create recovery request"}</button>
  </form>;
}
