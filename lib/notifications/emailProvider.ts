import { Resend } from "resend";

// Deliberately lazy — `new Resend(undefined)` throws immediately, at
// construction time, regardless of whether .emails.send() is ever
// called. Constructing this eagerly at module load meant any route that
// merely *imported* this file (even transitively, e.g. the Stripe
// webhook handler importing the messaging module importing this) would
// crash outright if RESEND_API_KEY wasn't set — long before sendEmail()'s
// own "throw clearly if unconfigured" logic ever got a chance to run.
// Found by actually sending a webhook through the real handler, not by
// reading the code.
let resendClient: Resend | null = null;
function getResendClient(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured — cannot send email");
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

export async function sendEmail(to: string, subject: string, body: string) {
  const client = getResendClient(); // throws here, at send time — not at import time
  return client.emails.send({
    from: process.env.EMAIL_FROM_ADDRESS ?? "HOST <notifications@example.com>",
    to,
    subject,
    text: body,
  });
}
