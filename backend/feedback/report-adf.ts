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
  description: string;
  impactAnswer: string;
  category: string;
  submitterType?: 'authenticated' | 'anonymous';
  contact: {
    name: string | null;
    email: string | null;
    company: string | null;
  };
  reportId: string;
  submittedAtIso: string;
}

/**
 * Issue body: the description (one paragraph per line — structural split only;
 * every user string stays inside a text node), then a plain-text contact block
 * and submission metadata. Literal label prefixes are concatenated into the
 * text values, never expressed as marks.
 */
export function buildReportAdf(input: ReportAdfInput): AdfNode {
  const content: AdfNode[] = [];

  const lines = input.description.split(/\r?\n/);
  for (const line of lines) {
    content.push(paragraph(line.trim()));
  }

  content.push(paragraph('— Report details —'));
  content.push(paragraph(`Impact: ${input.impactAnswer}`));
  content.push(paragraph(`Category: ${input.category}`));

  content.push(paragraph('— Contact —'));
  if (input.submitterType === 'anonymous') {
    content.push(paragraph('Submitter: Anonymous'));
  } else {
    content.push(paragraph(`Name: ${input.contact.name ?? 'unknown'}`));
    content.push(paragraph(`Email: ${input.contact.email ?? 'unknown'}`));
    content.push(paragraph(`Company: ${input.contact.company ?? 'unknown'}`));
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
