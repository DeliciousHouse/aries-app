/**
 * Atlassian Document Format builders for customer incident reports (SC-70
 * port). Pure — no I/O.
 *
 * INVARIANT (SC-70): user-controlled text appears ONLY as the `text` value of
 * `{"type":"text","text":...}` nodes. Node types, marks, and links are never
 * derived from user input — this builder emits NO marks and no link nodes at
 * all, and the node-type set is exactly {doc, paragraph, text}. The ADF test
 * walks the tree and asserts both properties against malicious payloads.
 */

export type AdfNode = {
  type: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
};

function textNode(text: string): AdfNode {
  // Jira rejects empty text nodes; substitute a single space.
  return { type: 'text', text: text.length > 0 ? text : ' ' };
}

function paragraph(text: string): AdfNode {
  return { type: 'paragraph', content: [textNode(text)] };
}

export interface ReportAdfInput {
  impactAnswer: string;
  category: string;
  submitterType?: 'authenticated' | 'anonymous';
  tenantId: string | null;
  submitterId: string | null;
  reportId: string;
  submittedAtIso: string;
}

/**
 * Jira is a redacted triage projection, never the durable report record. Raw
 * title/description/contact/screenshot values are deliberately absent from the
 * input type, making accidental exfiltration impossible at this boundary.
 */
export function buildReportAdf(input: ReportAdfInput): AdfNode {
  const content: AdfNode[] = [paragraph('Customer incident details are retained in Aries.')];

  content.push(paragraph('— Redacted triage details —'));
  content.push(paragraph(`Impact: ${input.impactAnswer}`));
  content.push(paragraph(`Category: ${input.category}`));

  if (input.submitterType === 'anonymous') {
    content.push(paragraph('Submitter: Anonymous'));
  } else {
    content.push(paragraph(`Tenant ID: ${input.tenantId ?? 'unknown'}`));
    content.push(paragraph(`Submitter ID: ${input.submitterId ?? 'unknown'}`));
  }

  content.push(paragraph(`Submission ID: ${input.reportId}`));
  content.push(paragraph(`Submitted: ${input.submittedAtIso}`));

  return { type: 'doc', version: 1, content };
}

const SUMMARY_MAX = 255;

/**
 * INVARIANT (SC-70): summary = title, whitespace-flattened, capped at 255
 * inside the service (Jira's hard limit) regardless of what upstream
 * validation allowed through.
 */
export function buildReportSummary(title: string): string {
  const flattened = title.replace(/\s+/g, ' ').trim();
  const capped = flattened.slice(0, SUMMARY_MAX);
  return capped.length > 0 ? capped : 'Customer incident report';
}
