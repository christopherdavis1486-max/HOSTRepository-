import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { initiateRefund } from "../payments/refund";

// Retries of the payment webhook retry an interrupted refund, but never issue
// another refund for a completed or already-submitted late-payment reversal.
export async function refundLateHotelPayment(bookingId:string,intentId:string) {
 return withTransaction(async client=>{
  await client.query(`SELECT pg_advisory_xact_lock($1)`,[hashToBigint("hotel-late-refund:"+intentId)]);
  const result=await client.query(`SELECT p.id,p.amount_minor,p.currency FROM payments p JOIN bookings b ON b.id=p.booking_id
   WHERE b.id=$1 AND b.room_type_id IS NOT NULL AND b.hotel_late_payment AND b.status IN ('cancelled','refunded')
    AND p.provider_payment_intent_id=$2 AND p.status IN ('paid','partially_refunded')`,[bookingId,intentId]);
  if(!result.rows[0])return;
  const payment=result.rows[0];
  const existing=await client.query(`SELECT status,provider_refund_id,amount_minor FROM refunds WHERE payment_id=$1 AND status IN ('pending','succeeded')`,[payment.id]);
  if(existing.rows.some(r=>r.status==='pending'&&r.provider_refund_id))return;
  const refunded=existing.rows.filter(r=>r.status==='succeeded').reduce((sum,r)=>sum+Number(r.amount_minor),0);
  const remaining=Number(payment.amount_minor)-refunded;
  if(remaining<=0)return;
  await initiateRefund({bookingId,paymentId:payment.id,providerPaymentIntentId:intentId,amountMinor:remaining,currency:payment.currency,reason:"pricing_error",initiatedBy:"system"});
 });
}
