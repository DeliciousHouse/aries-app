const AUTH_ERROR_MESSAGES: Record<string, string> = {
  AccessDenied:
    "Google sign-in failed during account setup. Check the server logs, database connection, and Google OAuth callback configuration.",
  DatabaseUnavailable:
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
