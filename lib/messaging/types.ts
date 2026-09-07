export type SenderType = "guest" | "host" | "system";

export type Message = {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderUserId: string | null;
  body: string;
  attachmentUrl: string | null;
  isSystemMessage: boolean;
  readAt: string | null;
  createdAt: string;
};

/** System message types — these are the "automated messages" the brief
 *  asks for. Each maps to a template in notifications/templates.ts so the
 *  in-conversation text and the emailed notification stay consistent. */
export type SystemMessageType =
  | "booking_confirmed"
  | "checkin_reminder"
  | "checkin_info_available"
  | "booking_cancelled";
