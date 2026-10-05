type SignInResult = { ok: boolean; status: number; error?: string | null } | undefined;

/** Only an explicit successful sign-in may proceed to the return path. */
export function signInFeedback(result: SignInResult, fallback = "Sign-in could not be completed. Please try again."): string | null {
  if (result?.status === 429 || result?.error === "RateLimited") {
    return "Too many sign-in attempts. Please wait 15 minutes before trying again.";
  }
  if (result?.status === 503 || result?.error === "SecurityUnavailable") {
    return "Sign-in is temporarily unavailable. Please try again later.";
  }
  if (result?.error === "CredentialsSignin") return "Incorrect email or password.";
  if (result?.ok && !result.error) return null;
  return fallback;
}
