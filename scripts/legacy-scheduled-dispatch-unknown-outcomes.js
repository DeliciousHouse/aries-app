'use strict';

const LEGACY_UNKNOWN_OUTCOME_PREFIXES = Object.freeze([
  'video_publish_outcome_unknown',
  'provider_publish_outcome_unknown',
  'provider_publish_missing_id',
  'facebook_video_publish_missing_id',
  'facebook_video_story_finish_missing_id',
  'facebook_story_publish_missing_id',
  'facebook_publish_missing_id',
  'instagram_publish_missing_id',
]);

const LEGACY_UNKNOWN_OUTCOME_SQL_REGEX = `^(${LEGACY_UNKNOWN_OUTCOME_PREFIXES.join('|')})`;

module.exports = {
  LEGACY_UNKNOWN_OUTCOME_PREFIXES,
  LEGACY_UNKNOWN_OUTCOME_SQL_REGEX,
};
