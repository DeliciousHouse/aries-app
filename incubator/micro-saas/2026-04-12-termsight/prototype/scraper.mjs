import { createHash } from 'crypto';
import * as cheerio from 'cheerio';

export async function fetchPolicyText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TermSight/0.1 (policy-monitor; +https://termsight.app)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  return extractText(html);
}

function extractText(html) {
  const $ = cheerio.load(html);

  $('script, style, nav, header, footer, iframe, noscript, svg, img').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

  const mainContent =
    $('main').text() ||
    $('article').text() ||
    $('[role="main"]').text() ||
    $('.content, .policy, .terms, .privacy, .legal, #content, #terms, #privacy').text() ||
    $('body').text();

  return mainContent
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

export function hashContent(text) {
  return createHash('sha256').update(text).digest('hex');
}

const RISK_PATTERNS = [
  { category: 'ai_training', patterns: [/\b(ai|artificial intelligence|machine learning|model training|train(ing)?\s+(models?|algorithms?))\b/i], label: 'AI/ML Training' },
  { category: 'data_sharing', patterns: [/\b(shar(e|ing)\s+(your\s+)?data|third.?part(y|ies)|affiliates?|partners?)\b/i], label: 'Data Sharing' },
  { category: 'liability', patterns: [/\b(limit(ation)?\s+of\s+liability|indemnif|arbitration|waiv(e|er)|class.?action)\b/i], label: 'Liability & Arbitration' },
  { category: 'pricing', patterns: [/\b(pric(e|ing)|fee|charg(e|es)|subscription|billing|payment|cost)\b/i], label: 'Pricing & Billing' },
  { category: 'cancellation', patterns: [/\b(cancel|terminat|auto.?renew|renewal|refund|notice\s+period)\b/i], label: 'Cancellation & Renewal' },
  { category: 'jurisdiction', patterns: [/\b(jurisdiction|governing\s+law|venue|dispute\s+resolution|applicable\s+law)\b/i], label: 'Jurisdiction & Disputes' },
  { category: 'data_retention', patterns: [/\b(retain|retention|delet(e|ion)|storage\s+period|keep\s+(your\s+)?data)\b/i], label: 'Data Retention' },
  { category: 'consent', patterns: [/\b(consent|opt.?(in|out)|permission|agree(ment)?)\b/i], label: 'Consent & Opt-out' },
];

export function detectRiskFlags(diffText) {
  const flags = [];
  for (const { category, patterns, label } of RISK_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(diffText)) {
        flags.push({ category, label });
        break;
      }
    }
  }
  return flags;
}

export function generateMockAiSummary(diffText, riskFlags) {
  const addedLines = diffText.split('\n').filter(l => l.startsWith('+')).length;
  const removedLines = diffText.split('\n').filter(l => l.startsWith('-')).length;

  const flagList = riskFlags.map(f => f.label).join(', ');
  const severity = riskFlags.length >= 3 ? 'significant' : riskFlags.length >= 1 ? 'moderate' : 'minor';

  let summary = `This policy update contains ${severity} changes. `;
  summary += `${addedLines} sections were added or modified and ${removedLines} sections were removed or replaced. `;

  if (riskFlags.length > 0) {
    summary += `\n\nKey areas affected: ${flagList}. `;
    summary += `\n\nReview recommended for: `;
    summary += riskFlags.map(f => {
      switch (f.category) {
        case 'ai_training': return 'Changes to how your data may be used for AI/ML model training.';
        case 'data_sharing': return 'Updates to third-party data sharing practices.';
        case 'liability': return 'Modifications to liability limitations or dispute resolution.';
        case 'pricing': return 'Changes to pricing, fees, or billing terms.';
        case 'cancellation': return 'Updates to cancellation, renewal, or refund policies.';
        case 'jurisdiction': return 'Changes to governing law or dispute jurisdiction.';
        case 'data_retention': return 'Updates to data retention or deletion practices.';
        case 'consent': return 'Changes to consent requirements or opt-out mechanisms.';
        default: return `Changes related to ${f.label}.`;
      }
    }).join(' ');
  } else {
    summary += 'No high-risk categories detected in this update, but manual review is still recommended.';
  }

  summary += '\n\n⚠️ This is an automated summary. Always review the full diff for accuracy.';
  return summary;
}
