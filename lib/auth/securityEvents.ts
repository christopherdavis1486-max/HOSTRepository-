import { db } from "../db";

const SAFE_METADATA_KEYS = new Set(["provider", "reason", "route", "role", "action"]);
export async function recordSecurityEvent(userId: string | null, eventType: string, outcome: "success" | "failure", metadata: Record<string, string> = {}) {
  const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => SAFE_METADATA_KEYS.has(key)));
  try {
    await db.query(`INSERT INTO security_events (user_id, event_type, outcome, metadata) VALUES ($1, $2, $3, $4)`, [userId, eventType, outcome, JSON.stringify(safeMetadata)]);
  } catch (error) {
    console.error("[HOST security event write failed]", eventType, (error as Error).message);
  }
}
