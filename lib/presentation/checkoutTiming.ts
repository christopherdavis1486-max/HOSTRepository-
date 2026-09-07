export function isChargeDeferred(scheduledChargeDate: string | null | undefined, nowMs = Date.now()): boolean {
  if (!scheduledChargeDate) return false;
  const scheduledMs = new Date(scheduledChargeDate).getTime();
  return Number.isFinite(scheduledMs) && scheduledMs > nowMs;
}
