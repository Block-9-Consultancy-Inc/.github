export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const JIRA_ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/gi;
export const JIRA_REVIEWERS_FIELD_ID = 'customfield_10251';
export const MAX_GITHUB_COMMENT_BODY_LENGTH = 65536;
export const MAX_GITHUB_COMMENT_PAGES_TO_SCAN = 10;

export const DESCRIPTION_MARKER_PREFIX = '<!-- jira-description-sync:';
export const MIRRORED_COMMENT_MARKER_PREFIX = '<!-- jira-github-comment-sync:';
export const PR_DESCRIPTION_MARKER_PREFIX = '<!-- jira-github-pr-description-sync:';
export const COMMIT_MARKER_PREFIX = '<!-- jira-github-commit-sync:';
export const REVIEW_MARKER_PREFIX = '<!-- jira-github-review-sync:';
export const REVIEW_COMMENT_MARKER_PREFIX = '<!-- jira-github-review-comment-sync:';
export const REVIEW_SUMMARY_MARKER_PREFIX = '<!-- jira-github-review-summary-sync:';
export const REVIEW_THREAD_RESOLVED_MARKER_PREFIX = '<!-- jira-github-review-thread-resolved-sync:';

export const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'reopened',
  'edited',
  'synchronize',
  'ready_for_review',
  'assigned',
  'unassigned',
  'review_requested',
  'review_request_removed'
]);

export function getRequiredConfiguration() {
  return ['GITHUB_WEBHOOK_SECRET'];
}

export function normalizeJiraSiteUrl(rawSiteUrl = process.env.JIRA_SITE_URL) {
  if (!rawSiteUrl) {
    return undefined;
  }

  return rawSiteUrl.replace(/\/+$/, '');
}
