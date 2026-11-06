export type MonitoringEmailMessage = {
  to: string;
  subject: string;
  body: string;
};

export type MonitoringEmailSender = (
  message: MonitoringEmailMessage
) => Promise<unknown>;

export type MonitoringEmailAttempt =
  | {status: "accepted"; providerMessageId: string}
  | {status: "rejected"}
  | {status: "uncertain"};

/**
 * One explicit attempt through a caller-supplied sender.
 * No default provider, retries, persistence or inbox-delivery claim.
 * Raw provider errors are deliberately excluded from the result.
 */
export async function attemptFinancialMonitoringEmail(
  message: MonitoringEmailMessage,
  sender: MonitoringEmailSender
): Promise<MonitoringEmailAttempt> {
  if (!message || typeof message.to !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) ||
      typeof message.subject !== "string" || !message.subject.trim() ||
      /[\r\n]/.test(message.subject) ||
      typeof message.body !== "string" || !message.body.trim() ||
      typeof sender !== "function") {
    throw new Error("Invalid monitoring email attempt");
  }

  const captured = {
    to: message.to, subject: message.subject, body: message.body
  };
  try {
    const response = await sender(captured);
    if (!response || typeof response !== "object") {
      return {status: "uncertain"};
    }
    const result = response as {
      data?: {id?: unknown} | null;
      error?: unknown;
    };
    const id = result.data?.id;
    const accepted = typeof id === "string" && id.trim().length > 0;
    if (accepted && !result.error) {
      return {status: "accepted", providerMessageId: id};
    }
    if (result.error && !accepted) return {status: "rejected"};
    return {status: "uncertain"};
  } catch {
    // A thrown error does not establish whether the provider accepted the email.
    return {status: "uncertain"};
  }
}
