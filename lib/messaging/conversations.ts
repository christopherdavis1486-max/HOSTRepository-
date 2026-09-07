import { db, withTransaction } from "../db";
import { Message, SenderType } from "./types";

/** One conversation per booking — created lazily on first message rather
 *  than at booking-creation time, since not every booking generates a
 *  conversation before payment succeeds. */
export async function getOrCreateConversation(bookingId: string) {
  const existing = await db.query(`SELECT * FROM conversations WHERE booking_id = $1`, [bookingId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const booking = await db.query(`SELECT property_id, guest_id, host_id FROM bookings WHERE id = $1`, [bookingId]);
  if (booking.rows.length === 0) throw new Error("Booking not found");
  const { property_id, guest_id, host_id } = booking.rows[0];

  const created = await db.query(
    `INSERT INTO conversations (booking_id, property_id, guest_id, host_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (booking_id) DO UPDATE SET updated_at = conversations.updated_at
     RETURNING *`,
    [bookingId, property_id, guest_id, host_id]
  );
  return created.rows[0];
}

export async function sendMessage(bookingId: string, senderType: SenderType, senderUserId: string | null, body: string, attachmentUrl?: string): Promise<Message> {
  return withTransaction(async (client) => {
    const conversation = await getOrCreateConversationInTx(client, bookingId);
    const result = await client.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_user_id, body, attachment_url, is_system_message)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [conversation.id, senderType, senderUserId, body, attachmentUrl ?? null, senderType === "system"]
    );
    await client.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversation.id]);
    return mapMessageRow(result.rows[0]);
  });
}

async function getOrCreateConversationInTx(client: { query: Function }, bookingId: string) {
  const existing = await client.query(`SELECT * FROM conversations WHERE booking_id = $1`, [bookingId]);
  if (existing.rows.length > 0) return existing.rows[0];
  const booking = await client.query(`SELECT property_id, guest_id, host_id FROM bookings WHERE id = $1`, [bookingId]);
  if (booking.rows.length === 0) throw new Error("Booking not found");
  const { property_id, guest_id, host_id } = booking.rows[0];
  const created = await client.query(
    `INSERT INTO conversations (booking_id, property_id, guest_id, host_id) VALUES ($1,$2,$3,$4) RETURNING *`,
    [bookingId, property_id, guest_id, host_id]
  );
  return created.rows[0];
}

export async function listMessages(bookingId: string): Promise<Message[]> {
  const conversation = await db.query(`SELECT id FROM conversations WHERE booking_id = $1`, [bookingId]);
  if (conversation.rows.length === 0) return []; // no messages sent yet — not an error
  const result = await db.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversation.rows[0].id]);
  return result.rows.map(mapMessageRow);
}

/** Marks every unread message NOT sent by `readerUserId` as read — a
 *  guest reading their conversation marks the host's/system's messages
 *  read, never their own. */
export async function markConversationRead(bookingId: string, readerUserId: string) {
  const conversation = await db.query(`SELECT id FROM conversations WHERE booking_id = $1`, [bookingId]);
  if (conversation.rows.length === 0) return { updated: 0 };
  const result = await db.query(
    `UPDATE messages SET read_at = NOW()
     WHERE conversation_id = $1 AND read_at IS NULL AND (sender_user_id IS DISTINCT FROM $2)`,
    [conversation.rows[0].id, readerUserId]
  );
  return { updated: result.rowCount };
}

export async function getUnreadCount(userId: string): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS count FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.read_at IS NULL
       AND m.sender_user_id IS DISTINCT FROM $1
       AND ($1 = c.guest_id OR $1 IN (SELECT user_id FROM host_profiles WHERE id = c.host_id))`,
    [userId]
  );
  return Number(result.rows[0].count);
}

function mapMessageRow(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    body: row.body,
    attachmentUrl: row.attachment_url,
    isSystemMessage: row.is_system_message,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
