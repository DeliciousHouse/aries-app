/**
 * Shared feedback types. Server-side only consumers import these; the dependency-
 * free option lists live in ./options so the client can share them.
 */

import type { FeedbackCategory, FeedbackSeverity } from './options';

export type FeedbackAuthState = 'authenticated' | 'unauthenticated';

export type FeedbackSheetSyncStatus = 'pending' | 'synced' | 'skipped' | 'failed';

/** Which external mirror a submission was sent to (or none). */
export type FeedbackSyncDestination = 'jira' | 'sheet' | 'none';

/**
 * Outcome of mirroring one submission to an external tracker. Shared by every
 * sink (Google Sheet, JIRA) and the dispatcher, so the route records a uniform
 * result regardless of destination. `status` reuses the sheet-sync vocabulary
 * (the DB column predates JIRA): 'synced' | 'skipped' | 'failed' | 'pending'.
 */
export interface FeedbackSyncResult {
  status: FeedbackSheetSyncStatus;
  screenshotLink: string | null;
  error: string | null;
  /** Which mirror handled it (for the response + logs). */
  destination?: FeedbackSyncDestination;
  /** The created JIRA issue key (e.g. "AA-123"), when destination is 'jira'. */
  issueKey?: string | null;
}

/** Context the client captures from the browser (untrusted — validated on input). */
export interface FeedbackClientContext {
  /** The exact page the feedback was submitted from. */
  pageUrl: string | null;
  /** navigator.userAgent (browser/OS). */
  userAgent: string | null;
  /** Viewport / screen size, e.g. "1920x1080". */
  viewport: string | null;
  /** Most recent JS/console errors from the session, newest last. */
  consoleErrors: string[];
}

/** A fully-resolved submission ready to persist. */
export interface FeedbackSubmissionRecord {
  submissionId: string;
  tenantId: string;
  authState: FeedbackAuthState;
  userId: string | null;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  comment: string;
  pageUrl: string | null;
  userAgent: string | null;
  viewport: string | null;
  consoleErrors: string[];
  environment: string;
  /** Optional screenshot bytes + mime, decoded server-side from the upload. */
  screenshot: { bytes: Buffer; mime: string } | null;
  /** SHA-256 of the client IP (privacy-preserving), for abuse throttling. */
  ipHash: string | null;
  /** Submission time (ISO). */
  createdAtIso: string;
}

/** The row shape mirrored into the Google Sheet (column order matters). */
export interface FeedbackSheetRow {
  submissionId: string;
  timestamp: string;
  tenantId: string;
  authState: string;
  category: string;
  severity: string;
  comment: string;
  pageUrl: string;
  userAgent: string;
  viewport: string;
  consoleErrors: string;
  screenshotLink: string;
  environment: string;
}
