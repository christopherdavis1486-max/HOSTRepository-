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

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: { replyTo?: string },
) {
  const client = getResendClient(); // throws here, at send time — not at import time
  const result = await client.emails.send({
    from: process.env.EMAIL_FROM_ADDRESS ?? "HOST <notifications@example.com>",
    to,
    subject,
    text: body,
    replyTo: options?.replyTo,
  });
  // Resend can resolve with an error object rather than rejecting the promise.
  // Callers must not record a rejected email as sent.
  if (result.error) throw new Error(`Email provider rejected the message: ${result.error.message}`);
  if (!result.data?.id) throw new Error("Email provider did not confirm acceptance of the message");
  return result;
}
