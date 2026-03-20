import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import type { PipelineInput, Goal, Channel, ExecutionMode } from '@/frontend/onboarding/pipeline-intake/types';

const VALID_GOALS: Goal[] = ['lead_generation', 'content_growth', 'product_sales', 'brand_awareness'];
const VALID_CHANNELS: Channel[] = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x'];
const VALID_MODES: ExecutionMode[] = ['strategy_only', 'strategy_plus_assets', 'full_pipeline'];

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const BLOCKLIST = ['localhost', '127.0.0.1', 'example.com', '0.0.0.0'];

function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url}`;
  }

  if (parsed.protocol !== 'https:') return `URL must use HTTPS: ${url}`;

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKLIST.some((b) => hostname === b || hostname.endsWith('.' + b))) {
    return `Domain not allowed: ${hostname}`;
  }

  if (IP_REGEX.test(hostname)) {
    return `IP addresses are not allowed: ${hostname}`;
  }

  return null;
}

function slugify(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
  } catch {
    return 'brand';
  }
}

const JOBS_DIR = path.resolve(process.cwd(), 'data/generated/draft/marketing-jobs');

export async function POST(req: NextRequest) {
  let body: Partial<PipelineInput>;

  try {
    body = await req.json() as Partial<PipelineInput>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { brand_url, competitor_url, goal, channels, mode } = body;

  // Validate brand_url
  if (!brand_url || typeof brand_url !== 'string') {
    return NextResponse.json({ error: 'brand_url is required' }, { status: 400 });
  }
  const brandErr = validateUrl(brand_url);
  if (brandErr) return NextResponse.json({ error: brandErr }, { status: 400 });

  // Validate competitor_url
  if (!competitor_url || typeof competitor_url !== 'string') {
    return NextResponse.json({ error: 'competitor_url is required' }, { status: 400 });
  }
  const compErr = validateUrl(competitor_url);
  if (compErr) return NextResponse.json({ error: compErr }, { status: 400 });

  // Check they're different domains
  try {
    const brandHost = new URL(brand_url).hostname.toLowerCase();
    const compHost = new URL(competitor_url).hostname.toLowerCase();
    if (brandHost === compHost) {
      return NextResponse.json({ error: 'brand_url and competitor_url must be different domains' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  // Validate goal
  if (!goal || !VALID_GOALS.includes(goal as Goal)) {
    return NextResponse.json({ error: `goal must be one of: ${VALID_GOALS.join(', ')}` }, { status: 400 });
  }

  // Validate channels
  if (!Array.isArray(channels) || channels.length === 0) {
    return NextResponse.json({ error: 'channels must be a non-empty array' }, { status: 400 });
  }
  const invalidChannels = channels.filter((c) => !VALID_CHANNELS.includes(c as Channel));
  if (invalidChannels.length > 0) {
    return NextResponse.json({ error: `Invalid channels: ${invalidChannels.join(', ')}` }, { status: 400 });
  }

  // Validate mode
  if (!mode || !VALID_MODES.includes(mode as ExecutionMode)) {
    return NextResponse.json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` }, { status: 400 });
  }

  // Generate job ID
  const slug = slugify(brand_url);
  const timestamp = Date.now();
  const job_id = `mkt_${slug}_${timestamp}`;

  const jobData = {
    job_id,
    status: 'accepted',
    created_at: new Date().toISOString(),
    input: {
      brand_url,
      competitor_url,
      goal,
      channels,
      mode,
    } satisfies PipelineInput,
  };

  // Ensure directory exists and write file
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(JOBS_DIR, `${job_id}.json`),
      JSON.stringify(jobData, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[pipeline/start] Failed to write job file:', err);
    return NextResponse.json({ error: 'Failed to persist job' }, { status: 500 });
  }

  return NextResponse.json({ job_id, status: 'accepted' }, { status: 201 });
}
