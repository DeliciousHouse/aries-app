import assert from "node:assert/strict";
import test from "node:test";

import { getAuthErrorMessage } from "../../lib/auth-error-message";

const INFRASTRUCTURE_HINT = /Postgres|database connection|AUTH_SECRET|AUTH_URL|NEXTAUTH_URL|AUTH_TRUST_HOST|OAuth|server logs/i;

test("returns null when there is no auth error", () => {
  assert.equal(getAuthErrorMessage(null), null);
  assert.equal(getAuthErrorMessage(undefined), null);
});

test("maps known auth errors to safe user-facing guidance", () => {
  assert.equal(getAuthErrorMessage("CredentialsSignin"), "Invalid email or password.");
  assert.equal(getAuthErrorMessage("EmailDoesNotExist"), "Invalid email or password.");
  assert.match(getAuthErrorMessage("GoogleSignInRequired") ?? "", /continue with google/i);

  for (const code of ["AccessDenied", "DatabaseUnavailable", "Configuration", "UntrustedHost"]) {
    const message = getAuthErrorMessage(code) ?? "";
    assert.doesNotMatch(message, INFRASTRUCTURE_HINT);
    assert.match(message, /Authentication|try again/i);
  }
});

test("falls back to a generic message for unknown auth errors", () => {
  assert.equal(
    getAuthErrorMessage("SomeNewError"),
    "Authentication failed. Please try again.",
  );
});
