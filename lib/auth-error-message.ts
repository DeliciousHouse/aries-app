export const EMAIL_DOES_NOT_EXIST_ERROR = "EmailDoesNotExist";
export const DATABASE_UNAVAILABLE_ERROR = "DatabaseUnavailable";
export const GOOGLE_SIGN_IN_REQUIRED_ERROR = "GoogleSignInRequired";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: "Invalid email or password.",
  // Kept for defense-in-depth so any lingering surface that still emits this
  // code shows the same generic response as wrong-password (no enumeration).
  // The server no longer emits it — see auth.ts authorize() — but a stale
  // client referencing the old query param still renders the safe string.
  [EMAIL_DOES_NOT_EXIST_ERROR]: "Invalid email or password.",
  [GOOGLE_SIGN_IN_REQUIRED_ERROR]:
    "This account uses Google sign-in. Continue with Google to access it.",
  AccessDenied:
    "Google sign-in failed during account setup. Check the server logs, database connection, and Google OAuth callback configuration.",
  [DATABASE_UNAVAILABLE_ERROR]:
    "Authentication cannot reach the Postgres database. Start Postgres or update the DB connection settings.",
  Configuration:
    "Authentication is misconfigured. Check AUTH_SECRET, AUTH_URL or NEXTAUTH_URL, AUTH_TRUST_HOST, and Google OAuth environment variables.",
  Verification:
    "The authentication link or callback is no longer valid. Start the sign-in flow again.",
  UntrustedHost:
    "The auth host is not trusted. Set AUTH_TRUST_HOST=true for local development or configure AUTH_URL/NEXTAUTH_URL.",
};

export function getAuthErrorMessage(error: string | null | undefined): string | null {
  if (!error) {
    return null;
  }

  return AUTH_ERROR_MESSAGES[error] ?? "Authentication failed. Check the server logs and try again.";
}
