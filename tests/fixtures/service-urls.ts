/**
 * Canonical service URLs for tests.
 *
 * Tests should reference these constants instead of inlining hostnames or
 * ports. Single source of truth keeps test fixtures aligned with the values
 * documented in `.env.example` and `docker-compose.yml`, and makes a future
 * port/host change a one-line edit.
 *
 * These are the local-dev defaults — production reads URLs from env. Tests
 * never actually connect to these URLs (fetch is mocked or test invokers
 * intercept), so the values are labels, not connection targets. Using the
 * real defaults rather than fictional placeholders means a reader doesn't
 * have to verify "is this a real port?" while reviewing a test.
 */

export const TEST_OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:3456';
export const TEST_HERMES_GATEWAY_URL = 'http://127.0.0.1:8642';
export const TEST_APP_BASE_URL = 'http://127.0.0.1:3000';

/** A URL intended to be unreachable for "service down" / unreachable-path tests. */
export const TEST_UNREACHABLE_URL = 'http://127.0.0.1:65500';
