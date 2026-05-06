export const EMAIL_DOES_NOT_EXIST_ERROR = "EmailDoesNotExist";
export const DATABASE_UNAVAILABLE_ERROR = "DatabaseUnavailable";
export const GOOGLE_SIGN_IN_REQUIRED_ERROR = "GoogleSignInRequired";

const GENERIC_AUTH_FAILURE_MESSAGE = "Authentication failed. Please try again.";
const TEMPORARY_AUTH_UNAVAILABLE_MESSAGE =
  "Authentication is temporarily unavailable. Please try again shortly.";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: "Invalid email or password.",
  // Kept for defense-in-depth so any lingering surface that still emits this
  // code shows the same generic response as wrong-password (no enumeration).
  // The server no longer emits it — see auth.ts authorize() — but a stale
  // client referencing the old query param still renders the safe string.
  [EMAIL_DOES_NOT_EXIST_ERROR]: "Invalid email or password.",
  [GOOGLE_SIGN_IN_REQUIRED_ERROR]:
    "This account uses Google sign-in. Continue with Google to access it.",
  AccessDenied: GENERIC_AUTH_FAILURE_MESSAGE,
  [DATABASE_UNAVAILABLE_ERROR]: TEMPORARY_AUTH_UNAVAILABLE_MESSAGE,
  Configuration: TEMPORARY_AUTH_UNAVAILABLE_MESSAGE,
  Verification:
    "The authentication link or callback is no longer valid. Start the sign-in flow again.",
  UntrustedHost: TEMPORARY_AUTH_UNAVAILABLE_MESSAGE,
};

export function getAuthErrorMessage(error: string | null | undefined): string | null {
  if (!error) {
    return null;
  }

  return AUTH_ERROR_MESSAGES[error] ?? GENERIC_AUTH_FAILURE_MESSAGE;
}
