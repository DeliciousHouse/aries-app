import assert from "node:assert/strict";
import test from "node:test";

import {
  getLoginAuthErrorMessage,
  resolveLoginErrorCode,
} from "../../lib/login-auth-error";

test("uses the credentials code when Auth.js returns a custom credentials error", () => {
  assert.equal(
    resolveLoginErrorCode("CredentialsSignin", "EmailDoesNotExist"),
    "EmailDoesNotExist",
  );
});

test("falls back to CredentialsSignin when Auth.js returns the default credentials code", () => {
  assert.equal(
    resolveLoginErrorCode("CredentialsSignin", "credentials"),
    "CredentialsSignin",
  );
  assert.equal(resolveLoginErrorCode("CredentialsSignin", undefined), "CredentialsSignin");
});

test("does not expose an 'email doesn't exist' user-facing message (enumeration protection)", () => {
  // Even if some stale client still has the old code in the query string, we
  // render the generic credentials-invalid message — the server side of this
  // fix (auth.ts authorize()) no longer emits this code at all.
  assert.equal(
    getLoginAuthErrorMessage("CredentialsSignin", "EmailDoesNotExist", null),
    "Invalid email or password.",
  );
});

test("shows a Google-specific message for Google-managed accounts", () => {
  assert.match(
    getLoginAuthErrorMessage("CredentialsSignin", "GoogleSignInRequired", null) ?? "",
    /google sign-in/i,
  );
});

test("keeps invalid-password messaging for generic credentials failures", () => {
  assert.equal(
    getLoginAuthErrorMessage("CredentialsSignin", "credentials", null),
    "Invalid email or password.",
  );
});
