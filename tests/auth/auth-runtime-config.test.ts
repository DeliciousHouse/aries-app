import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthRuntimeConfig } from "../../lib/auth-runtime-config";

test("prefers NEXTAUTH_URL when provided", () => {
  const config = resolveAuthRuntimeConfig({
    NODE_ENV: "production",
    NEXTAUTH_URL: "https://aries.sugarandleather.com",
    APP_BASE_URL: "https://ignored.example.com",
  });

  assert.equal(config.authUrl, "https://aries.sugarandleather.com");
  assert.equal(config.trustHost, true);
});

test("falls back to APP_BASE_URL when auth URLs are unset", () => {
  const config = resolveAuthRuntimeConfig({
    NODE_ENV: "production",
    APP_BASE_URL: "https://aries.sugarandleather.com",
  });

  assert.equal(config.authUrl, "https://aries.sugarandleather.com");
});

test("uses AUTH_TRUST_HOST when explicitly set", () => {
  const trustDisabled = resolveAuthRuntimeConfig({
    NODE_ENV: "production",
    AUTH_TRUST_HOST: "false",
  });
  const trustEnabled = resolveAuthRuntimeConfig({
    NODE_ENV: "development",
    AUTH_TRUST_HOST: "true",
  });

  assert.equal(trustDisabled.trustHost, false);
  assert.equal(trustEnabled.trustHost, true);
});

test("defaults trustHost based on NODE_ENV when AUTH_TRUST_HOST is unset", () => {
  const productionConfig = resolveAuthRuntimeConfig({
    NODE_ENV: "production",
  });
  const developmentConfig = resolveAuthRuntimeConfig({
    NODE_ENV: "development",
  });

  assert.equal(productionConfig.trustHost, false);
  assert.equal(developmentConfig.trustHost, true);
});
