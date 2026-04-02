const LINKEDIN_API = 'https://api.linkedin.com';
const RESTLI_VERSION = '2.0.0';

async function linkedInJson<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = path.startsWith('http') ? path : `${LINKEDIN_API}${path}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${accessToken}`,
    'X-Restli-Protocol-Version': RESTLI_VERSION,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !('Content-Type' in headers)) {
    (headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
  }

  if (!res.ok) {
    const msg =
      body &&
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
        ? (body as { message: string }).message
        : text || res.statusText;
    throw new Error(`LinkedIn API ${res.status}: ${msg}`);
  }

  return body as T;
}

export type LinkedInPublishResult = {
  id?: string;
  [key: string]: unknown;
};

/**
 * Publishes a text-only post via UGC Posts API.
 * @see https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api
 */
export async function linkedInPublishTextPost(input: {
  accessToken: string;
  personUrn: string;
  text: string;
}): Promise<LinkedInPublishResult> {
  const { accessToken, personUrn, text } = input;

  const payload = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  return linkedInJson<LinkedInPublishResult>(accessToken, '/v2/ugcPosts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type LinkedInSharesListResult = {
  elements?: unknown[];
  paging?: { count?: number; start?: number; total?: number };
  [key: string]: unknown;
};

/**
 * Lists recent shares owned by the member (Shares API).
 * @see https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/share-api
 */
export async function linkedInListRecentShares(input: {
  accessToken: string;
  personUrn: string;
  count: number;
}): Promise<LinkedInSharesListResult> {
  const { accessToken, personUrn, count } = input;
  const owners = encodeURIComponent(`List(${personUrn})`);
  const path = `/v2/shares?q=owners&owners=${owners}&count=${count}&sortBy=LAST_MODIFIED`;

  return linkedInJson<LinkedInSharesListResult>(accessToken, path, { method: 'GET' });
}
