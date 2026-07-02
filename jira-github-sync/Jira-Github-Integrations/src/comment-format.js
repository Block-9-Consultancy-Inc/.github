import {
  DESCRIPTION_MARKER_PREFIX,
  COMMIT_MARKER_PREFIX,
  MAX_GITHUB_COMMENT_BODY_LENGTH,
  MIRRORED_COMMENT_MARKER_PREFIX,
  PR_DESCRIPTION_MARKER_PREFIX,
  REVIEW_COMMENT_MARKER_PREFIX,
  REVIEW_MARKER_PREFIX,
  REVIEW_SUMMARY_MARKER_PREFIX,
  REVIEW_THREAD_RESOLVED_MARKER_PREFIX,
  normalizeJiraSiteUrl
} from './config.js';
import { adfToMarkdown } from './markdown.js';

export function buildDescriptionMarker(issueKey) {
  return `${DESCRIPTION_MARKER_PREFIX}${issueKey} -->`;
}

export function buildGitHubDescriptionComment({ jiraIssue }) {
  const marker = buildDescriptionMarker(jiraIssue.key);
  const issueHeading = buildIssueHeading(jiraIssue.key, jiraIssue.fields?.summary);
  const descriptionMarkdown = adfToMarkdown(jiraIssue.fields?.description);
  const footer = '_Synced from Jira by Forge. This managed comment is updated when the Jira description changes._';
  const commentBody = [marker, issueHeading, descriptionMarkdown, footer].join('\n\n');

  return truncateGitHubComment(commentBody);
}

export function buildMirroredGitHubCommentFromJira({ jiraIssueKey, jiraComment }) {
  const marker = buildMirroredCommentMarker('jira', jiraComment.id);
  const authorName = jiraComment.author?.displayName || 'Unknown Jira user';
  const sourceUrl = buildJiraCommentUrl(jiraIssueKey, jiraComment.id);
  const bodyMarkdown = adfToMarkdown(jiraComment.body);
  const footer = buildVisibleFooter({
    source: 'Jira',
    author: authorName,
    originalUrl: sourceUrl
  });

  return truncateGitHubComment([marker, bodyMarkdown, footer].join('\n\n'));
}

export function buildMirroredJiraCommentFromGitHub({ githubComment, owner, repo, pullRequestNumber }) {
  const marker = buildMirroredCommentMarker('github', githubComment.id);
  const authorName = githubComment.user?.login || 'unknown-github-user';
  const originalUrl = githubComment.html_url ||
    `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}#issuecomment-${githubComment.id}`;
  const footer = buildVisibleFooter({
    source: 'GitHub',
    author: `@${authorName}`,
    originalUrl
  });

  return [marker, githubComment.body || '', footer].join('\n\n');
}

export function buildMirroredJiraCommentFromGitHubPullRequestDescription({
  pullRequest,
  owner,
  repo,
  pullRequestNumber
}) {
  const marker = buildPullRequestDescriptionMarker({ owner, repo, pullRequestNumber });
  const authorName = pullRequest.user?.login || 'unknown-github-user';
  const originalUrl = pullRequest.html_url || `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}`;
  const footer = buildVisibleFooter({
    source: 'GitHub PR description',
    author: `@${authorName}`,
    originalUrl
  });

  return [marker, pullRequest.body || '', footer].join('\n\n');
}

export function buildMirroredCommentMarker(sourceSystem, sourceId) {
  return `${MIRRORED_COMMENT_MARKER_PREFIX}${sourceSystem}:${sourceId} -->`;
}

export function buildPullRequestDescriptionMarker({ owner, repo, pullRequestNumber }) {
  return `${PR_DESCRIPTION_MARKER_PREFIX}${owner}/${repo}:${pullRequestNumber} -->`;
}

export function containsAnySyncMarker(body) {
  return (
    Boolean(body?.includes(DESCRIPTION_MARKER_PREFIX)) ||
    Boolean(body?.includes(MIRRORED_COMMENT_MARKER_PREFIX)) ||
    Boolean(body?.includes(PR_DESCRIPTION_MARKER_PREFIX)) ||
    Boolean(body?.includes(COMMIT_MARKER_PREFIX)) ||
    Boolean(body?.includes(REVIEW_MARKER_PREFIX)) ||
    Boolean(body?.includes(REVIEW_COMMENT_MARKER_PREFIX)) ||
    Boolean(body?.includes(REVIEW_SUMMARY_MARKER_PREFIX)) ||
    Boolean(body?.includes(REVIEW_THREAD_RESOLVED_MARKER_PREFIX))
  );
}

function buildIssueHeading(issueKey, summary = 'Untitled Jira issue') {
  const escapedSummary = escapeMarkdownText(summary);
  const jiraSiteUrl = normalizeJiraSiteUrl();

  if (!jiraSiteUrl) {
    return `### ${issueKey}: ${escapedSummary}`;
  }

  return `### [${issueKey}](${jiraSiteUrl}/browse/${encodeURIComponent(issueKey)}): ${escapedSummary}`;
}

function buildVisibleFooter({ source, author, originalUrl }) {
  const originalPart = originalUrl ? `Original: ${originalUrl}` : 'Original: unavailable';
  return [
    '---',
    `_Synced from ${source}. Author: ${author}. ${originalPart}._`
  ].join('\n');
}

function buildJiraCommentUrl(issueKey, commentId) {
  const jiraSiteUrl = normalizeJiraSiteUrl();

  if (!jiraSiteUrl) {
    return undefined;
  }

  return `${jiraSiteUrl}/browse/${encodeURIComponent(issueKey)}?focusedCommentId=${encodeURIComponent(commentId)}`;
}

function truncateGitHubComment(commentBody) {
  if (commentBody.length <= MAX_GITHUB_COMMENT_BODY_LENGTH) {
    return commentBody;
  }

  const truncationNotice = '\n\n_The synced content was truncated because GitHub comments have a size limit._';
  return `${commentBody.slice(
    0,
    MAX_GITHUB_COMMENT_BODY_LENGTH - truncationNotice.length
  )}${truncationNotice}`;
}

function escapeMarkdownText(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
