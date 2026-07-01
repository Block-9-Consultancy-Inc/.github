import {
  loadAndSyncJiraIssueToKnownPullRequests,
  mirrorJiraCommentToGitHub
} from './sync-service.js';

export async function jiraIssueUpdated(event) {
  const issueKey = event.issue?.key;

  if (!issueKey) {
    console.warn('Ignored Jira issue update event without an issue key.');
    return;
  }

  await loadAndSyncJiraIssueToKnownPullRequests({
    issueKey,
    eventTime: event.timestamp
  });
}

export async function jiraIssueAssigned(event) {
  const issueKey = event.issue?.key;

  if (!issueKey) {
    console.warn('Ignored Jira issue assigned event without an issue key.');
    return;
  }

  await loadAndSyncJiraIssueToKnownPullRequests({
    issueKey,
    eventTime: event.timestamp
  });
}

export async function jiraIssueCommented(event) {
  const issueKey = event.issue?.key;
  const commentId = event.comment?.id || event.commentId || event.associatedComment?.id;

  if (!issueKey || !commentId) {
    console.warn('Ignored Jira comment event without an issue key or comment ID.', {
      hasIssueKey: Boolean(issueKey),
      hasCommentId: Boolean(commentId)
    });
    return;
  }

  await mirrorJiraCommentToGitHub({ issueKey, commentId });
}
