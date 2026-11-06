import { runScheduledSetupReviewDigest } from "./runScheduledSetupReviewDigest";

type Runner = typeof runScheduledSetupReviewDigest;

function parseUtcTimestamp(value: string, field: string): Date {
  const timestamp = new Date(value);
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== value
  ) {
    throw new Error(`Invalid ${field}. Expected a UTC timestamp with milliseconds.`);
  }
  return timestamp;
}

/** The scheduler supplies the original window on every invocation and retry. */
export async function invokeScheduledSetupReviewDigest(
  pool: Parameters<Runner>[0],
  input: { scope: string; windowStartUtc: string; recoveryCutoffUtc: string },
  send: Parameters<Runner>[2],
) {
  const windowStart = parseUtcTimestamp(input.windowStartUtc, "windowStartUtc");
  const recoveryCutoff = parseUtcTimestamp(input.recoveryCutoffUtc, "recoveryCutoffUtc");
  const now = Date.now();

  if (windowStart.getTime() > now || recoveryCutoff.getTime() > now) {
    throw new Error("Scheduler window and recovery cutoff must not be in the future.");
  }

  return runScheduledSetupReviewDigest(
    pool,
    { scope: input.scope, windowStart, recoveryCutoff },
    send,
  );
}
