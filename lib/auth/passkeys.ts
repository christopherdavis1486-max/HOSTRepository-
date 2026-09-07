import { createHash, randomBytes } from "crypto";

export function webAuthnConfig() {
  const configured = process.env.AUTH_WEBAUTHN_ORIGIN?.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && !configured) throw new Error("AUTH_WEBAUTHN_ORIGIN is required in production");
  const origin = configured || "http://localhost:3000";
  const url = new URL(origin);
  return { origin, rpID: url.hostname, rpName: "HOST" };
}

export function hashLoginToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newLoginToken() {
  return randomBytes(32).toString("base64url");
}
