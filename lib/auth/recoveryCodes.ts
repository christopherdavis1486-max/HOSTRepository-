import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const CODE_BYTES = 8;

function recoverySecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for recovery codes");
  return secret;
}

export function normalizeRecoveryCode(code: string) {
  return code.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

export function hashRecoveryCode(code: string) {
  return createHmac("sha256", recoverySecret()).update(normalizeRecoveryCode(code)).digest("hex");
}

export function recoveryCodeMatches(code: string, expectedHash: string) {
  const actual = Buffer.from(hashRecoveryCode(code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(CODE_BYTES).toString("hex").toUpperCase();
    return raw.match(/.{1,4}/g)!.join("-");
  });
}

