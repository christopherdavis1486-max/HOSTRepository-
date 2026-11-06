/**
 * Use the original scheduled window start on every attempt, including retries.
 * The scope identifies the environment and logical delivery destination.
 */
export function setupReviewDigestKey(scope: string, windowStart: Date): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope) ||
      !Number.isFinite(windowStart.getTime())) {
    throw new Error("Invalid setup review digest scope or window.");
  }

  return "setup-review-digest:v1:" + scope + ":" + windowStart.toISOString();
}
