import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { auth } from '@/auth';
import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { getTenantContext } from '@/lib/tenant-context';
import { renderSimpleMarkdown } from '@/lib/simple-markdown';

export const dynamic = 'force-dynamic';

type ViewerParams = { jobId: string; assetId: string };

function labelForKind(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'Markdown';
  if (ext === '.css') return 'Stylesheet';
  if (ext === '.json') return 'JSON';
  if (ext === '.html') return 'HTML';
  if (ext === '.txt') return 'Text';
  return 'Asset';
}

function isRenderableImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** Viewer for supporting materials (brand bible, website brand analysis,
 * design system, etc.) linked from the review screens. Without this, the
 * attachment URL served raw `text/plain` bytes and the browser would open
 * a black tab of unformatted markdown — or worse, start a file download
 * when the content-type fell through to `application/octet-stream`. */
export default async function MaterialsViewerPage({
  params,
}: {
  params: Promise<ViewerParams>;
}) {
  const { jobId: rawJobId, assetId: rawAssetId } = await params;
  const jobId = decodeURIComponent(rawJobId);
  const assetId = decodeURIComponent(rawAssetId);

  const session = await auth();
  if (!session?.user?.id) {
    notFound();
  }

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    notFound();
  }

  // Tenant-scope the viewer: only the job's own tenant may see its assets.
  // getTenantContext() throws when the request has no membership; treat
  // that the same as a missing asset so we never leak tenant shape.
  let tenantId: string;
  try {
    const tenantContext = await getTenantContext();
    tenantId = tenantContext.tenantId;
  } catch {
    notFound();
  }
  if (runtimeDoc.tenant_id !== tenantId) {
    notFound();
  }

  const asset = findMarketingAsset(jobId, runtimeDoc, assetId);
  if (!asset) {
    notFound();
  }

  let raw: string | null = null;
  let rawBuffer: Buffer | null = null;
  try {
    rawBuffer = await readFile(asset.filePath);
    raw = rawBuffer.toString('utf8');
  } catch {
    notFound();
  }

  const contentType = asset.contentType;
  const kindLabel = labelForKind(asset.filePath);
  const fileName = path.basename(asset.filePath);
  const downloadHref = `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`;

  let rendered: React.ReactNode;

  if (isRenderableImage(contentType)) {
    rendered = (
      <div className="overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={downloadHref}
          alt={asset.label}
          className="mx-auto max-h-[80vh] w-auto object-contain"
        />
      </div>
    );
  } else if (contentType.startsWith('text/html')) {
    rendered = (
      <iframe
        src={downloadHref}
        title={asset.label}
        sandbox="allow-same-origin"
        className="h-[80vh] w-full rounded-[1.5rem] border border-white/10 bg-white"
      />
    );
  } else if (path.extname(asset.filePath).toLowerCase() === '.md' || contentType.startsWith('text/markdown')) {
    const html = renderSimpleMarkdown(raw);
    rendered = (
      <article
        className="prose-aries max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } else {
    // CSS, JSON, TXT, unknown text -> formatted code block
    rendered = (
      <pre className="overflow-auto rounded-[1.25rem] border border-white/10 bg-black/40 p-6 text-sm leading-6 text-white/85">
        <code>{raw}</code>
      </pre>
    );
  }

  return (
    <main className="min-h-screen bg-[#050505] text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
              {kindLabel} preview
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-white">{asset.label}</h1>
            <p className="mt-1 text-sm text-white/50">{fileName}</p>
          </div>
          <a
            href={downloadHref}
            download={fileName}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white/85 transition hover:border-white/25 hover:text-white"
          >
            Download source
          </a>
        </header>
        {rendered}
      </div>
      <style>{proseStyles}</style>
    </main>
  );
}

// Inline prose typography for rendered markdown. Matches the app's dark
// theme without pulling in @tailwindcss/typography as a new dependency.
const proseStyles = `
  .prose-aries {
    color: rgba(255, 255, 255, 0.82);
    line-height: 1.7;
    font-size: 15px;
  }
  .prose-aries h1 { font-size: 1.875rem; font-weight: 700; color: #fff; margin: 2rem 0 1rem; line-height: 1.25; }
  .prose-aries h2 { font-size: 1.5rem;   font-weight: 700; color: #fff; margin: 1.75rem 0 0.9rem; line-height: 1.3; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.4rem; }
  .prose-aries h3 { font-size: 1.25rem;  font-weight: 600; color: #fff; margin: 1.5rem 0 0.75rem; line-height: 1.35; }
  .prose-aries h4 { font-size: 1.1rem;   font-weight: 600; color: #fff; margin: 1.25rem 0 0.5rem; }
  .prose-aries h5, .prose-aries h6 { font-size: 1rem; font-weight: 600; color: rgba(255,255,255,0.9); margin: 1rem 0 0.4rem; }
  .prose-aries p { margin: 0 0 1rem; }
  .prose-aries strong { color: #fff; font-weight: 600; }
  .prose-aries em { font-style: italic; color: rgba(255,255,255,0.9); }
  .prose-aries a { color: #c8a6ff; text-decoration: underline; text-underline-offset: 3px; }
  .prose-aries a:hover { color: #e2cfff; }
  .prose-aries ul, .prose-aries ol { margin: 0 0 1rem 1.5rem; padding: 0; }
  .prose-aries ul { list-style: disc; }
  .prose-aries ol { list-style: decimal; }
  .prose-aries li { margin-bottom: 0.4rem; }
  .prose-aries code {
    background: rgba(255,255,255,0.08);
    color: #f0e4ff;
    border-radius: 4px;
    padding: 0.12em 0.35em;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .prose-aries pre {
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 1rem;
    padding: 1rem 1.25rem;
    margin: 1rem 0;
    overflow-x: auto;
  }
  .prose-aries pre code {
    background: transparent;
    padding: 0;
    color: rgba(255,255,255,0.88);
    font-size: 0.9em;
  }
  .prose-aries blockquote {
    margin: 1rem 0;
    padding-left: 1rem;
    border-left: 3px solid rgba(200, 166, 255, 0.5);
    color: rgba(255,255,255,0.75);
    font-style: italic;
  }
  .prose-aries hr {
    border: 0;
    border-top: 1px solid rgba(255,255,255,0.1);
    margin: 2rem 0;
  }
`;
