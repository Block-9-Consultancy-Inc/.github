import crypto from 'node:crypto';
import { kvs } from '@forge/kvs';

export const syncStateKeys = {
  issueLinks(issueKey) {
    return `issue-links:${encodeKeyPart(issueKey)}`;
  },

  pullRequestIssueLink(owner, repo, pullRequestNumber) {
    return [
      'pull-request-issue-link',
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(pullRequestNumber)
    ].join(':');
  },

  descriptionComment(issueKey, owner, repo, pullRequestNumber) {
    return [
      'description-comment',
      encodeKeyPart(issueKey),
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(pullRequestNumber)
    ].join(':');
  },

  commentMap(sourceSystem, sourceId) {
    return `comment-map:${encodeKeyPart(sourceSystem)}:${encodeKeyPart(sourceId)}`;
  },

  commitAnnouncement(owner, repo, commitSha) {
    return [
      'commit-announcement',
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(commitSha)
    ].join(':');
  },

  reviewNotification(owner, repo, notificationType, sourceId) {
    return [
      'review-notification',
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(notificationType),
      encodeKeyPart(sourceId)
    ].join(':');
  },

  reviewComment(owner, repo, reviewId, reviewCommentId) {
    return [
      'review-comment',
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(reviewId),
      encodeKeyPart(reviewCommentId)
    ].join(':');
  },

  reviewCommentIndex(owner, repo, reviewId) {
    return [
      'review-comment-index',
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(reviewId)
    ].join(':');
  },

  reviewSummaryComment(issueKey, owner, repo, pullRequestNumber) {
    return [
      'review-summary-comment',
      encodeKeyPart(issueKey),
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(pullRequestNumber)
    ].join(':');
  },

  reviewActivities(issueKey, owner, repo, pullRequestNumber) {
    return [
      'review-activities',
      encodeKeyPart(issueKey),
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(pullRequestNumber)
    ].join(':');
  },

  reviewSummaryLock(issueKey, owner, repo, pullRequestNumber) {
    return [
      'review-summary-lock',
      encodeKeyPart(issueKey),
      encodeKeyPart(owner),
      encodeKeyPart(repo),
      encodeKeyPart(pullRequestNumber)
    ].join(':');
  },

  fieldState(issueKey, fieldName) {
    return `field-state:${encodeKeyPart(issueKey)}:${encodeKeyPart(fieldName)}`;
  }
};

export async function rememberPullRequestLink({
  issueKey,
  owner,
  repo,
  pullRequestNumber,
  installationId
}) {
  const key = syncStateKeys.issueLinks(issueKey);
  const existingLinks = (await kvs.get(key)) || [];
  const nextLink = removeUndefinedValues({ owner, repo, pullRequestNumber, installationId });
  const existingLinkIndex = existingLinks.findIndex((link) => {
    return (
      link.owner === owner &&
      link.repo === repo &&
      Number(link.pullRequestNumber) === Number(pullRequestNumber)
    );
  });

  if (existingLinkIndex >= 0) {
    const updatedLinks = [...existingLinks];
    updatedLinks[existingLinkIndex] = {
      ...updatedLinks[existingLinkIndex],
      ...nextLink
    };
    await kvs.set(key, updatedLinks);
    await kvs.set(syncStateKeys.pullRequestIssueLink(owner, repo, pullRequestNumber), issueKey);
    return updatedLinks;
  }

  const updatedLinks = [...existingLinks, nextLink];
  await kvs.set(key, updatedLinks);
  await kvs.set(syncStateKeys.pullRequestIssueLink(owner, repo, pullRequestNumber), issueKey);
  return updatedLinks;
}

export async function getPullRequestLinks(issueKey) {
  return (await kvs.get(syncStateKeys.issueLinks(issueKey))) || [];
}

export async function getIssueKeyForPullRequest({ owner, repo, pullRequestNumber }) {
  return kvs.get(syncStateKeys.pullRequestIssueLink(owner, repo, pullRequestNumber));
}

export async function getDescriptionCommentId({ issueKey, owner, repo, pullRequestNumber }) {
  return kvs.get(syncStateKeys.descriptionComment(issueKey, owner, repo, pullRequestNumber));
}

export async function rememberDescriptionCommentId({
  issueKey,
  owner,
  repo,
  pullRequestNumber,
  commentId
}) {
  await kvs.set(syncStateKeys.descriptionComment(issueKey, owner, repo, pullRequestNumber), commentId);
}

export async function hasCommentMapping(sourceSystem, sourceId) {
  return Boolean(await kvs.get(syncStateKeys.commentMap(sourceSystem, sourceId)));
}

export async function rememberCommentMapping({
  sourceSystem,
  sourceId,
  targetSystem,
  targetId,
  issueKey
}) {
  await kvs.set(syncStateKeys.commentMap(sourceSystem, sourceId), {
    sourceSystem,
    sourceId,
    targetSystem,
    targetId,
    issueKey,
    syncedAt: new Date().toISOString()
  });
}

export async function hasCommitAnnouncement({ owner, repo, commitSha }) {
  return Boolean(await kvs.get(syncStateKeys.commitAnnouncement(owner, repo, commitSha)));
}

export async function rememberCommitAnnouncement({ owner, repo, commitSha, issueKey }) {
  await kvs.set(syncStateKeys.commitAnnouncement(owner, repo, commitSha), {
    owner,
    repo,
    commitSha,
    issueKey,
    announcedAt: new Date().toISOString()
  });
}

export async function hasReviewNotification({ owner, repo, notificationType, sourceId }) {
  return Boolean(await kvs.get(
    syncStateKeys.reviewNotification(owner, repo, notificationType, sourceId)
  ));
}

export async function rememberReviewNotification({
  owner,
  repo,
  notificationType,
  sourceId,
  issueKey
}) {
  await kvs.set(syncStateKeys.reviewNotification(owner, repo, notificationType, sourceId), {
    owner,
    repo,
    notificationType,
    sourceId,
    issueKey,
    notifiedAt: new Date().toISOString()
  });
}

export async function rememberReviewComment({ owner, repo, reviewId, reviewComment }) {
  const commentId = reviewComment.id;

  if (!reviewId || !commentId) {
    return [];
  }

  const commentKey = syncStateKeys.reviewComment(owner, repo, reviewId, commentId);
  const indexKey = syncStateKeys.reviewCommentIndex(owner, repo, reviewId);
  const existingCommentIds = (await kvs.get(indexKey)) || [];
  const nextCommentIds = existingCommentIds.includes(commentId)
    ? existingCommentIds
    : [...existingCommentIds, commentId];

  await kvs.set(commentKey, reviewComment);
  await kvs.set(indexKey, nextCommentIds);

  return nextCommentIds;
}

export async function getReviewCommentsForReview({ owner, repo, reviewId }) {
  const commentIds = (await kvs.get(syncStateKeys.reviewCommentIndex(owner, repo, reviewId))) || [];
  const comments = [];

  for (const commentId of commentIds) {
    const comment = await kvs.get(syncStateKeys.reviewComment(owner, repo, reviewId, commentId));

    if (comment) {
      comments.push(comment);
    }
  }

  return comments.sort((left, right) => {
    return new Date(left.created_at || 0) - new Date(right.created_at || 0);
  });
}

export async function getReviewSummaryCommentId({ issueKey, owner, repo, pullRequestNumber }) {
  return kvs.get(syncStateKeys.reviewSummaryComment(issueKey, owner, repo, pullRequestNumber));
}

export async function rememberReviewSummaryCommentId({
  issueKey,
  owner,
  repo,
  pullRequestNumber,
  commentId
}) {
  await kvs.set(
    syncStateKeys.reviewSummaryComment(issueKey, owner, repo, pullRequestNumber),
    commentId
  );
}

export async function appendReviewActivity({ issueKey, owner, repo, pullRequestNumber, activity }) {
  const key = syncStateKeys.reviewActivities(issueKey, owner, repo, pullRequestNumber);
  const activities = (await kvs.get(key)) || [];
  const alreadyStored = activities.some((storedActivity) => storedActivity.id === activity.id);

  if (alreadyStored) {
    return { activities, appended: false };
  }

  const updatedActivities = [...activities, activity].slice(-50);
  await kvs.set(key, updatedActivities);

  return { activities: updatedActivities, appended: true };
}

export async function acquireReviewSummaryLock({ issueKey, owner, repo, pullRequestNumber }) {
  try {
    await kvs.set(
      syncStateKeys.reviewSummaryLock(issueKey, owner, repo, pullRequestNumber),
      { lockedAt: new Date().toISOString() },
      {
        keyPolicy: 'FAIL_IF_EXISTS',
        ttl: {
          value: 30,
          unit: 'SECONDS'
        }
      }
    );

    return true;
  } catch (error) {
    console.info('Skipped acquiring review summary lock because another invocation owns it.', {
      issueKey,
      owner,
      repo,
      pullRequestNumber,
      message: error.message
    });
    return false;
  }
}

export async function releaseReviewSummaryLock({ issueKey, owner, repo, pullRequestNumber }) {
  await kvs.delete(syncStateKeys.reviewSummaryLock(issueKey, owner, repo, pullRequestNumber));
}

export async function shouldAcceptFieldChange({ issueKey, fieldName, value, source, eventTime }) {
  const key = syncStateKeys.fieldState(issueKey, fieldName);
  const existingState = await kvs.get(key);
  const nextTimestamp = normalizeTimestamp(eventTime);
  const valueHash = stableHash(value);

  if (existingState?.valueHash === valueHash) {
    return false;
  }

  if (existingState?.updatedAt && new Date(existingState.updatedAt) > new Date(nextTimestamp)) {
    return false;
  }

  await kvs.set(key, {
    source,
    valueHash,
    updatedAt: nextTimestamp
  });

  return true;
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeForHash(value))).digest('hex');
}

function normalizeTimestamp(eventTime) {
  if (!eventTime) {
    return new Date().toISOString();
  }

  const timestamp = typeof eventTime === 'number' ? eventTime : Number(eventTime);

  if (!Number.isNaN(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  return new Date(eventTime).toISOString();
}

function normalizeForHash(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item)).sort();
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, normalizeForHash(nestedValue)])
    );
  }

  return value ?? null;
}

function encodeKeyPart(value) {
  /*
   * Forge KVS keys allow alphanumeric characters and a small punctuation set,
   * but repository identifiers such as "owner/repo" contain slashes. Encoding
   * every dynamic segment keeps keys valid without restricting GitHub names.
   */
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function removeUndefinedValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, nestedValue]) => nestedValue !== undefined)
  );
}
