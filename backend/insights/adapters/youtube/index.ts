/**
 * backend/insights/adapters/youtube/index.ts
 *
 * YouTube Analytics adapter — Phase 2 skeleton.
 *
 * This file satisfies the InsightsAdapter interface so the rest of the
 * codebase compiles. The actual YouTube API calls will be added in Phase 3.
 *
 * Phase 3 will add:
 *   - YouTube Data API v3  — fetchPostList (search.list / playlistItems.list)
 *   - YouTube Data API v3  — fetchComments (commentThreads.list)
 *   - YouTube Analytics v2 — fetchAccountMetrics (reports.query)
 *   - YouTube Analytics v2 — fetchPostMetrics  (reports.query with video filter)
 *
 * Required env vars (Phase 3):
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REFRESH_TOKEN   ← service-account-style offline token per tenant
 */

import type {
  InsightsAdapter,
  DateRange,
  RawAccountMetricsDay,
  RawPost,
  RawPostMetricsDay,
  RawComment,
} from '../_adapter.types';

export class YouTubeInsightsAdapter implements InsightsAdapter {
  readonly platform = 'youtube' as const;

  async fetchAccountMetrics(
    _externalAccountId: string,
    _range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    // Phase 3: GET https://youtubeanalytics.googleapis.com/v2/reports
    //   ?ids=channel==<channelId>&startDate=<from>&endDate=<to>
    //   &metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares
    throw new Error(
      'YouTubeInsightsAdapter.fetchAccountMetrics: not implemented — Phase 3',
    );
  }

  async fetchPostList(
    _externalAccountId: string,
    _publishedAfter?: Date,
  ): Promise<RawPost[]> {
    // Phase 3: GET https://www.googleapis.com/youtube/v3/search
    //   ?channelId=<channelId>&type=video&order=date&publishedAfter=<ISO>
    throw new Error(
      'YouTubeInsightsAdapter.fetchPostList: not implemented — Phase 3',
    );
  }

  async fetchPostMetrics(
    _externalPostId: string,
    _range?: DateRange,
  ): Promise<RawPostMetricsDay[]> {
    // Phase 3: GET https://youtubeanalytics.googleapis.com/v2/reports
    //   ?filters=video==<videoId>&metrics=views,estimatedMinutesWatched,
    //     averageViewDuration,averageViewPercentage,likes,comments,shares
    throw new Error(
      'YouTubeInsightsAdapter.fetchPostMetrics: not implemented — Phase 3',
    );
  }

  async fetchComments(
    _externalPostId: string,
    _limit?: number,
  ): Promise<RawComment[]> {
    // Phase 3: GET https://www.googleapis.com/youtube/v3/commentThreads
    //   ?videoId=<videoId>&part=snippet&maxResults=<limit>
    throw new Error(
      'YouTubeInsightsAdapter.fetchComments: not implemented — Phase 3',
    );
  }
}

/** Singleton instance — import this in the adapter factory (Phase 3). */
export const youTubeInsightsAdapter = new YouTubeInsightsAdapter();
