import assert from "node:assert/strict";
import test from "node:test";

import { getAuthErrorMessage } from "../../lib/auth-error-message";

test("returns null when there is no auth error", () => {
  assert.equal(getAuthErrorMessage(null), null);
  assert.equal(getAuthErrorMessage(undefined), null);
});

test("maps known auth errors to user-facing guidance", () => {
  assert.match(getAuthErrorMessage("AccessDenied") ?? "", /database connection/i);
  assert.match(getAuthErrorMessage("DatabaseUnavailable") ?? "", /Postgres database/i);
  assert.match(getAuthErrorMessage("Configuration") ?? "", /AUTH_SECRET/i);
  assert.match(getAuthErrorMessage("UntrustedHost") ?? "", /AUTH_TRUST_HOST=true/i);
});

test("falls back to a generic message for unknown auth errors", () => {
  assert.equal(
    getAuthErrorMessage("SomeNewError"),
    "Authentication failed. Check the server logs and try again."
  );
});
