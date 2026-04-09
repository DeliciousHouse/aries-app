import assert from "node:assert/strict";
import test from "node:test";

import {
  getLoginAuthErrorMessage,
  resolveLoginErrorCode,
  shouldRedirectLoginToSignup,
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

test("flags unknown-email credentials failures for signup redirect", () => {
  assert.equal(shouldRedirectLoginToSignup("CredentialsSignin", "EmailDoesNotExist"), true);
  assert.equal(shouldRedirectLoginToSignup("CredentialsSignin", "credentials"), false);
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
