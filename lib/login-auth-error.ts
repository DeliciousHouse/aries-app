import { getAuthErrorMessage } from "./auth-error-message";

export function resolveLoginErrorCode(
  error: string | null | undefined,
  code: string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }

  if (error !== "CredentialsSignin") {
    return error;
  }

  if (!code || code === "credentials") {
    return "CredentialsSignin";
  }

  return code;
}

export function getLoginAuthErrorMessage(
  error: string | null | undefined,
  code: string | null | undefined,
  missingClaims: string | null | undefined,
): string | null {
  const resolvedError = resolveLoginErrorCode(error, code);
  if (!resolvedError) {
    return null;
  }

  if (resolvedError === "TenantClaimsIncomplete") {
    return missingClaims
      ? `Your account is authenticated but missing required tenant claims: ${missingClaims
          .split(",")
          .filter(Boolean)
          .join(", ")}.`
      : "Your account is authenticated but missing required tenant claims.";
  }

  if (resolvedError === "OAuthAccountNotLinked") {
    return "This email is already linked to a different sign-in method.";
  }

  if (resolvedError === "CallbackRouteError") {
    return "Unable to complete sign-in right now.";
  }

  if (resolvedError === "AccessDenied") {
    return "Access was denied. Try a different sign-in method.";
  }

  return getAuthErrorMessage(resolvedError) || "Unable to sign in right now.";
}
