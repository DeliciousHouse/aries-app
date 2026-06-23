'use client';

/**
 * A tiny, bounded ring buffer of recent client-side errors, attached to the
 * feedback widget so a submission can carry "what just went wrong" without the
 * user copy-pasting a stack trace (spec §6: recent console errors).
 *
 * It captures three sources:
 *   - console.error(...) calls (wrapped, original behavior preserved)
 *   - uncaught errors (window 'error')
 *   - unhandled promise rejections (window 'unhandledrejection')
 *
 * It is install-once and SSR-safe. It deliberately does NOT capture console.log
 * / warn — only errors — to keep the payload signal-dense and avoid leaking
 * incidental logs.
 */

import { FEEDBACK_LIMITS } from '@/lib/feedback/options';

const MAX = FEEDBACK_LIMITS.consoleErrorsMax;
const LINE_MAX = FEEDBACK_LIMITS.consoleErrorLineMax;

const buffer: string[] = [];
let installed = false;

function push(line: string): void {
  const trimmed = line.slice(0, LINE_MAX);
  if (!trimmed) return;
  buffer.push(trimmed);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Install the capture hooks once. Safe to call repeatedly and on the server. */
export function installConsoleCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const original = window.console?.error?.bind(window.console);
  if (window.console && typeof original === 'function') {
    window.console.error = (...args: unknown[]) => {
      try {
        push(args.map(formatArg).join(' '));
      } catch {
        // never let capture break logging
      }
      original(...args);
    };
  }

  window.addEventListener('error', (event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno ?? 0})` : '';
    push(`Uncaught ${event.message}${where}`);
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    push(`Unhandled rejection: ${formatArg(event.reason)}`);
  });
}

/** Snapshot of the most recent errors (oldest first, newest last). */
export function getRecentConsoleErrors(): string[] {
  return buffer.slice();
}

/** Test seam. */
export function __resetConsoleCaptureForTests(): void {
  buffer.length = 0;
  installed = false;
}
