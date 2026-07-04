import {
  createGitHubIssueComment,
  findManagedDescriptionComment,
  getGitHubPullRequest,
  getGitHubPullRequestCommits,
  getGitHubPullRequestReviews,
  syncGitHubAssignees,
  syncGitHubRequestedReviewers,
  updateGitHubIssueComment
} from './github-client.js';
import {
  addJiraComment,
  findJiraCommentContaining,
  getJiraComment,
  getJiraIssue,
  updateJiraComment,
  updateJiraAssignee,
  updateJiraReviewers
} from './jira-client.js';
import {
  findGitHubUsernameForJiraUser,
  findGitHubUsernamesForJiraUsers,
  findJiraAccountIdForGitHubUsername,
  getJiraUsersFromField
} from './user-mapping.js';
import {
  buildGitHubDescriptionComment,
  buildMirroredGitHubCommentFromJira,
  buildMirroredJiraCommentFromGitHub,
  buildMirroredJiraCommentFromGitHubPullRequestDescription,
  buildPullRequestLifecycleComment,
  buildPullRequestDescriptionMarker,
  containsAnySyncMarker
} from './comment-format.js';
import { adfToMarkdown } from './markdown.js';
import {
  getDescriptionCommentId,
  getPullRequestLinks,
  getPullRequestDescriptionCommentId,
  getReviewCommentsForReview,
  hasPullRequestLifecycleNotification,
  hasCommitAnnouncement,
  hasCommentMapping,
  hasReviewNotification,
  rememberCommitAnnouncement,
  rememberCommentMapping,
  rememberDescriptionCommentId,
  rememberPullRequestLifecycleNotification,
  rememberPullRequestDescriptionCommentId,
  rememberReviewComment,
  rememberReviewNotification,
  shouldAcceptFieldChange
} from './sync-state.js';
import { JIRA_REVIEWERS_FIELD_ID } from './config.js';

export async function syncJiraFieldsToKnownPullRequests({ jiraIssue, eventTime }) {
  const activePullRequestLinks = await getOpenPullRequestLinks(jiraIssue.key);

  for (const { link, pullRequest } of activePullRequestLinks) {
    await syncJiraDescriptionToGitHubPullRequest({
      jiraIssue,
      owner: link.owner,
      repo: link.repo,
      pullRequestNumber: link.pullRequestNumber,
      installationId: link.installationId
    });

    await syncJiraPeopleToGitHubPullRequest({
      jiraIssue,
      owner: link.owner,
      repo: link.repo,
      pullRequestNumber: link.pullRequestNumber,
      installationId: link.installationId,
      pullRequestAuthor: pullRequest.user?.login,
      eventTime
    });
  }
}

export async function syncJiraDescriptionToGitHubPullRequest({
  jiraIssue,
  owner,
  repo,
  pullRequestNumber,
  installationId
}) {
  const body = buildGitHubDescriptionComment({ jiraIssue });
  const storedCommentId = await getDescriptionCommentId({
    issueKey: jiraIssue.key,
    owner,
    repo,
    pullRequestNumber
  });

  if (storedCommentId) {
    await updateGitHubIssueComment({ owner, repo, commentId: storedCommentId, body, installationId });
    return storedCommentId;
  }

  const fallbackComment = await findManagedDescriptionComment({
    owner,
    repo,
    issueNumber: pullRequestNumber,
    issueKey: jiraIssue.key,
    installationId
  });

  if (fallbackComment?.id) {
    await updateGitHubIssueComment({
      owner,
      repo,
      commentId: fallbackComment.id,
      body,
      installationId
    });
    await rememberDescriptionCommentId({
      issueKey: jiraIssue.key,
      owner,
      repo,
      pullRequestNumber,
      commentId: fallbackComment.id
    });
    return fallbackComment.id;
  }

  const createdComment = await createGitHubIssueComment({
    owner,
    repo,
    issueNumber: pullRequestNumber,
    body,
    installationId
  });
  await rememberDescriptionCommentId({
    issueKey: jiraIssue.key,
    owner,
    repo,
    pullRequestNumber,
    commentId: createdComment.id
  });

  return createdComment.id;
}

export async function mirrorGitHubPullRequestDescriptionToJira({
  issueKey,
  pullRequest,
  owner,
  repo,
  pullRequestNumber
}) {
  if (!pullRequest.body?.trim()) {
    console.info('Skipped GitHub PR description sync because the PR body is empty.', {
      issueKey,
      owner,
      repo,
      pullRequestNumber
    });
    return undefined;
  }

  const body = buildMirroredJiraCommentFromGitHubPullRequestDescription({
    pullRequest,
    owner,
    repo,
    pullRequestNumber
  });
  const storedCommentId = await getPullRequestDescriptionCommentId({
    issueKey,
    owner,
    repo,
    pullRequestNumber
  });

  if (storedCommentId) {
    const existingComment = await getJiraComment({ issueKey, commentId: storedCommentId });

    if (existingComment) {
      return updateJiraComment({ issueKey, commentId: storedCommentId, body });
    }
  }

  const marker = buildPullRequestDescriptionMarker({ owner, repo, pullRequestNumber });
  const fallbackComment = await findJiraCommentContaining({ issueKey, marker });

  if (fallbackComment?.id) {
    const updatedComment = await updateJiraComment({ issueKey, commentId: fallbackComment.id, body });
    await rememberPullRequestDescriptionCommentId({
      issueKey,
      owner,
      repo,
      pullRequestNumber,
      commentId: fallbackComment.id
    });
    return updatedComment;
  }

  const createdComment = await addJiraComment({ issueKey, body });
  await rememberPullRequestDescriptionCommentId({
    issueKey,
    owner,
    repo,
    pullRequestNumber,
    commentId: createdComment.id
  });

  return createdComment;
}

export async function syncJiraPeopleToGitHubPullRequest({
  jiraIssue,
  owner,
  repo,
  pullRequestNumber,
  installationId,
  pullRequestAuthor,
  eventTime
}) {
  /*
   * People sync is best-effort because a user can be unmapped, hidden by email
   * privacy, or unavailable to assign/request in GitHub. Description and comment
   * sync should still proceed when one person mapping fails.
   */
  try {
    const jiraAssignee = jiraIssue.fields?.assignee;
    const githubAssignee = await findGitHubUsernameForJiraUser(jiraAssignee);
    const desiredAssignees = githubAssignee ? [githubAssignee] : [];
    const canonicalAssignee = jiraAssignee?.accountId || null;
    const shouldSyncAssignee = await shouldAcceptFieldChange({
      issueKey: jiraIssue.key,
      fieldName: 'assignee',
      value: canonicalAssignee,
      source: 'jira',
      eventTime
    });

    if (shouldSyncAssignee) {
      await syncGitHubAssignees({
        owner,
        repo,
        issueNumber: pullRequestNumber,
        desiredAssignees,
        installationId
      });
    }

    const jiraReviewers = getJiraUsersFromField(jiraIssue.fields?.[JIRA_REVIEWERS_FIELD_ID]);
    const githubReviewers = await findGitHubUsernamesForJiraUsers(jiraReviewers);
    const canonicalReviewers = jiraReviewers.map((reviewer) => reviewer.accountId).filter(Boolean);
    const desiredReviewers = githubReviewers.filter((reviewer) => {
      return reviewer.toLowerCase() !== (pullRequestAuthor || '').toLowerCase();
    });
    const shouldSyncReviewers = await shouldAcceptFieldChange({
      issueKey: jiraIssue.key,
      fieldName: 'reviewers',
      value: canonicalReviewers,
      source: 'jira',
      eventTime
    });

    if (shouldSyncReviewers) {
      await syncGitHubRequestedReviewers({
        owner,
        repo,
        pullRequestNumber,
        desiredReviewers,
        installationId
      });
    }
  } catch (error) {
    console.warn('Skipped some or all Jira people sync for this pull request.', {
      jiraIssueKey: jiraIssue.key,
      message: error.message
    });
  }
}

export async function syncGitHubAssigneesToJira({
  issueKey,
  githubAssignees,
  eventTime
}) {
  const jiraAccountIds = githubAssignees
    .map((assignee) => findJiraAccountIdForGitHubUsername(assignee.login))
    .filter(Boolean);
  const nextAssigneeAccountId = jiraAccountIds[0] || null;
  const shouldSync = await shouldAcceptFieldChange({
    issueKey,
    fieldName: 'assignee',
    value: nextAssigneeAccountId,
    source: 'github',
    eventTime
  });

  if (shouldSync) {
    await updateJiraAssignee(issueKey, nextAssigneeAccountId);
  }
}

export async function syncGitHubReviewersToJira({
  issueKey,
  githubReviewers,
  owner,
  repo,
  pullRequestNumber,
  installationId,
  eventTime
}) {
  const jiraIssue = await getJiraIssue(issueKey);

  if (!jiraIssue) {
    return;
  }

  const submittedReviewAuthors = owner && repo && pullRequestNumber
    ? await getSubmittedReviewAuthors({ owner, repo, pullRequestNumber, installationId })
    : [];

  const existingJiraReviewerAccountIds = getJiraUsersFromField(
    jiraIssue.fields?.[JIRA_REVIEWERS_FIELD_ID]
  )
    .map((reviewer) => reviewer.accountId)
    .filter(Boolean);
  const githubReviewerAccountIds = githubReviewers
    .map((reviewer) => findJiraAccountIdForGitHubUsername(reviewer.login))
    .filter(Boolean);
  const submittedReviewerAccountIds = submittedReviewAuthors
    .map((reviewer) => findJiraAccountIdForGitHubUsername(reviewer.login))
    .filter(Boolean);
  const jiraAccountIds = mergeUniqueValues([
    ...existingJiraReviewerAccountIds,
    ...githubReviewerAccountIds,
    ...submittedReviewerAccountIds
  ]);
  const shouldSync = await shouldAcceptFieldChange({
    issueKey,
    fieldName: 'reviewers',
    value: jiraAccountIds,
    source: 'github',
    eventTime
  });

  if (shouldSync) {
    await updateJiraReviewers(issueKey, jiraAccountIds);
  }
}

export async function addGitHubReviewerToJira({
  issueKey,
  githubUsername,
  owner,
  repo,
  pullRequestNumber,
  installationId,
  eventTime
}) {
  const jiraAccountId = findJiraAccountIdForGitHubUsername(githubUsername);

  if (!jiraAccountId) {
    console.info('Skipped GitHub review author because no Jira account mapping exists.', {
      issueKey,
      githubUsername
    });
    return false;
  }

  await syncGitHubReviewersToJira({
    issueKey,
    githubReviewers: [{ login: githubUsername }],
    owner,
    repo,
    pullRequestNumber,
    installationId,
    eventTime
  });

  return true;
}

function mergeUniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

async function getSubmittedReviewAuthors({ owner, repo, pullRequestNumber, installationId }) {
  const reviews = await getGitHubPullRequestReviews({
    owner,
    repo,
    pullRequestNumber,
    installationId
  });
  const reviewAuthorsByLogin = new Map();

  for (const review of reviews || []) {
    const login = review.user?.login;

    if (login) {
      reviewAuthorsByLogin.set(login.toLowerCase(), { login });
    }
  }

  return [...reviewAuthorsByLogin.values()];
}

export async function announceGitHubPullRequestCommitsToJira({
  issueKey,
  owner,
  repo,
  pullRequestNumber,
  installationId
}) {
  const commits = await getGitHubPullRequestCommits({
    owner,
    repo,
    pullRequestNumber,
    installationId
  });
  const createdComments = [];

  for (const commit of commits || []) {
    const commitSha = commit.sha;

    if (!commitSha || await hasCommitAnnouncement({ owner, repo, commitSha })) {
      continue;
    }

    const jiraComment = await addJiraComment({
      issueKey,
      body: buildCommitAnnouncementComment({
        commit,
        owner,
        repo,
        pullRequestNumber
      })
    });

    await rememberCommitAnnouncement({ owner, repo, commitSha, issueKey });
    createdComments.push(jiraComment);
  }

  return createdComments;
}

export async function announceGitHubPullRequestLifecycleToJira({
  issueKey,
  pullRequest,
  owner,
  repo,
  pullRequestNumber,
  lifecycleAction,
  actor
}) {
  /*
   * GitHub retries webhook deliveries when the app is slow or unavailable. This
   * KVS marker keeps lifecycle comments from piling up when the same opened,
   * closed, or merged delivery is received more than once.
   */
  if (await hasPullRequestLifecycleNotification({
    owner,
    repo,
    pullRequestNumber,
    lifecycleAction
  })) {
    return undefined;
  }

  const createdComment = await addJiraComment({
    issueKey,
    body: buildPullRequestLifecycleComment({
      pullRequest,
      owner,
      repo,
      pullRequestNumber,
      lifecycleAction,
      actor
    })
  });

  await rememberPullRequestLifecycleNotification({
    owner,
    repo,
    pullRequestNumber,
    lifecycleAction,
    issueKey
  });

  return createdComment;
}

export async function announceGitHubPushCommitsToJira({
  issueKey,
  owner,
  repo,
  branchName,
  commits
}) {
  const createdComments = [];

  for (const commit of commits || []) {
    const commitSha = commit.id || commit.sha;

    if (!commitSha || await hasCommitAnnouncement({ owner, repo, commitSha })) {
      continue;
    }

    const jiraComment = await addJiraComment({
      issueKey,
      body: buildCommitAnnouncementComment({
        commit,
        owner,
        repo,
        branchName
      })
    });

    await rememberCommitAnnouncement({ owner, repo, commitSha, issueKey });
    createdComments.push(jiraComment);
  }

  return createdComments;
}

export async function mirrorGitHubCommentToJira({
  jiraIssueKey,
  githubComment,
  owner,
  repo,
  pullRequestNumber
}) {
  const sourceId = `${owner}/${repo}/${githubComment.id}`;

  if (containsAnySyncMarker(githubComment.body) || await hasCommentMapping('github', sourceId)) {
    return undefined;
  }

  const createdJiraComment = await addJiraComment({
    issueKey: jiraIssueKey,
    body: buildMirroredJiraCommentFromGitHub({
      githubComment,
      owner,
      repo,
      pullRequestNumber
    })
  });

  await rememberCommentMapping({
    sourceSystem: 'github',
    sourceId,
    targetSystem: 'jira',
    targetId: createdJiraComment.id,
    issueKey: jiraIssueKey
  });

  await rememberCommentMapping({
    sourceSystem: 'jira',
    sourceId: createdJiraComment.id,
    targetSystem: 'github',
    targetId: sourceId,
    issueKey: jiraIssueKey
  });

  return createdJiraComment;
}

export async function announceGitHubPullRequestReviewToJira({
  issueKey,
  review,
  owner,
  repo,
  pullRequestNumber
}) {
  const sourceId = review?.id || `${pullRequestNumber}:${review?.submitted_at || Date.now()}`;

  if (await hasReviewNotification({
    owner,
    repo,
    notificationType: 'review',
    sourceId
  })) {
    return undefined;
  }

  await wait(1500);

  const reviewComments = await getReviewCommentsForReview({
    owner,
    repo,
    reviewId: review?.id
  });
  const createdComment = await addJiraComment({
    issueKey,
    body: buildSingleReviewComment({
      review,
      reviewComments,
      owner,
      repo,
      pullRequestNumber
    })
  });

  await rememberReviewNotification({
    owner,
    repo,
    notificationType: 'review',
    sourceId,
    issueKey
  });

  return createdComment;
}

export async function announceGitHubPullRequestReviewCommentToJira({
  reviewComment,
  owner,
  repo
}) {
  const sourceId = reviewComment?.id;

  if (!sourceId) {
    return undefined;
  }

  await rememberReviewComment({
    owner,
    repo,
    reviewId: reviewComment?.pull_request_review_id,
    reviewComment
  });

  /*
   * Review comments are rendered inside the Jira comment created for the parent
   * submitted review. Creating separate Jira comments here would split one
   * GitHub review across multiple Jira comments, which is explicitly not the
   * desired workflow.
   */
  return undefined;
}

export async function announceGitHubPullRequestReviewThreadResolvedToJira({
  issueKey,
  thread,
  sender,
  owner,
  repo,
  pullRequestNumber
}) {
  const sourceId = thread?.id || thread?.node_id || `${pullRequestNumber}:${thread?.updated_at || Date.now()}`;
  const notificationType = 'review-thread-resolved';

  if (await hasReviewNotification({ owner, repo, notificationType, sourceId })) {
    return undefined;
  }

  const firstComment = Array.isArray(thread?.comments) ? thread.comments[0] : undefined;
  const path = thread?.path || firstComment?.path || 'an unknown file';
  const line = thread?.line || thread?.original_line || firstComment?.line || firstComment?.original_line;
  const createdComment = await addJiraComment({
    issueKey,
    body: buildResolvedReviewThreadComment({
      actor: sender?.login || 'unknown GitHub user',
      file: line ? `${path}:${line}` : path,
      url: thread?.html_url || firstComment?.html_url || `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}`,
      owner,
      repo,
      pullRequestNumber,
      sourceId
    })
  });

  await rememberReviewNotification({
    owner,
    repo,
    notificationType,
    sourceId,
    issueKey
  });

  return createdComment;
}

export async function mirrorJiraCommentToGitHub({ issueKey, commentId }) {
  if (await hasCommentMapping('jira', commentId)) {
    return [];
  }

  const jiraComment = await getJiraComment({ issueKey, commentId });

  if (!jiraComment) {
    return [];
  }

  if (containsAnySyncMarker(adfToMarkdown(jiraComment.body))) {
    return [];
  }

  const bodyMarkdown = buildMirroredGitHubCommentFromJira({
    jiraIssueKey: issueKey,
    jiraComment
  });

  const activePullRequestLinks = await getOpenPullRequestLinks(issueKey);
  const createdComments = [];

  for (const { link } of activePullRequestLinks) {
    const createdGitHubComment = await createGitHubIssueComment({
      owner: link.owner,
      repo: link.repo,
      issueNumber: link.pullRequestNumber,
      body: bodyMarkdown,
      installationId: link.installationId
    });
    const githubSourceId = `${link.owner}/${link.repo}/${createdGitHubComment.id}`;

    await rememberCommentMapping({
      sourceSystem: 'jira',
      sourceId: commentId,
      targetSystem: 'github',
      targetId: githubSourceId,
      issueKey
    });

    await rememberCommentMapping({
      sourceSystem: 'github',
      sourceId: githubSourceId,
      targetSystem: 'jira',
      targetId: commentId,
      issueKey
    });

    createdComments.push(createdGitHubComment);
  }

  return createdComments;
}

async function getOpenPullRequestLinks(issueKey) {
  const links = await getPullRequestLinks(issueKey);
  const activePullRequestLinks = [];

  for (const link of links) {
    const pullRequest = await getGitHubPullRequest({
      owner: link.owner,
      repo: link.repo,
      pullRequestNumber: link.pullRequestNumber,
      installationId: link.installationId
    });

    if (!isOpenGitHubPullRequest(pullRequest)) {
      console.info('Skipped Jira-to-GitHub sync for a closed pull request.', {
        issueKey,
        owner: link.owner,
        repo: link.repo,
        pullRequestNumber: link.pullRequestNumber,
        pullRequestState: pullRequest?.state || 'unknown'
      });
      continue;
    }

    activePullRequestLinks.push({ link, pullRequest });
  }

  return activePullRequestLinks;
}

export function isOpenGitHubPullRequest(pullRequest) {
  /*
   * A Jira issue can be linked to multiple PRs over time. Closed PRs are history,
   * so Jira-side changes should only be mirrored to PRs that are still active.
   */
  return pullRequest?.state === 'open';
}

export async function loadAndSyncJiraIssueToKnownPullRequests({ issueKey, eventTime }) {
  const jiraIssue = await getJiraIssue(issueKey);

  if (!jiraIssue) {
    return;
  }

  await syncJiraFieldsToKnownPullRequests({ jiraIssue, eventTime });
}

function buildCommitAnnouncementComment({ commit, owner, repo, pullRequestNumber, branchName }) {
  const commitSha = commit.sha || commit.id;
  const shortSha = commitSha.slice(0, 7);
  const author = commit.author?.login ||
    commit.author?.username ||
    commit.commit?.author?.name ||
    commit.author?.name ||
    commit.commit?.committer?.name ||
    commit.committer?.name ||
    'unknown GitHub user';
  const message = (commit.commit?.message || commit.message || 'No commit message').split('\n')[0];
  const commitUrl = commit.html_url || commit.url || `https://github.com/${owner}/${repo}/commit/${commitSha}`;
  const contextLine = pullRequestNumber
    ? `Pull request: #${pullRequestNumber}`
    : `Branch: ${branchName || 'unknown branch'}`;

  return [
    `GitHub commit made by ${author}: ${message}`,
    '',
    `Repository: ${owner}/${repo}`,
    contextLine,
    `Commit: ${shortSha}`,
    `Original: ${commitUrl}`,
    '',
    `<!-- jira-github-commit-sync:${owner}/${repo}:${commitSha} -->`
  ].join('\n');
}

function buildSingleReviewComment({ review, reviewComments, owner, repo, pullRequestNumber }) {
  const reviewer = review?.user?.login || 'unknown GitHub user';
  const reviewId = review?.id || 'unknown';
  const reviewUrl = review?.html_url || `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}`;
  const reviewCommentLines = reviewComments.flatMap((reviewComment) => {
    const path = reviewComment?.path || 'an unknown file';
    const line = reviewComment?.line || reviewComment?.original_line;
    const location = line ? `${path}:${line}` : path;
    const commentAuthor = reviewComment?.user?.login || reviewer;
    const commentUrl = reviewComment?.html_url || reviewUrl;

    return [
      `- @${commentAuthor} commented on ${location}. Original: ${commentUrl}`,
      ...formatIndentedBody(reviewComment?.body)
    ];
  });
  return [
    `GitHub review by @${reviewer}: ${formatReviewState(review?.state)}`,
    '',
    `Repository: ${owner}/${repo}`,
    `Pull request: #${pullRequestNumber}`,
    `Original: ${reviewUrl}`,
    '',
    ...formatIndentedBody(review?.body),
    ...(reviewCommentLines.length > 0 ? ['Review comments:', '', ...reviewCommentLines] : []),
    '',
    '_This GitHub review is managed by the Jira/GitHub sync app and is not mirrored back to GitHub._',
    '',
    `<!-- jira-github-review-sync:${owner}/${repo}:${reviewId} -->`
  ].join('\n');
}

function buildResolvedReviewThreadComment({
  actor,
  file,
  url,
  owner,
  repo,
  pullRequestNumber,
  sourceId
}) {
  return [
    `GitHub review thread resolved by @${actor}.`,
    '',
    `Repository: ${owner}/${repo}`,
    `Pull request: #${pullRequestNumber}`,
    `File: ${file}`,
    `Original: ${url}`,
    '',
    '_This GitHub review resolution is managed by the Jira/GitHub sync app and is not mirrored back to GitHub._',
    '',
    `<!-- jira-github-review-thread-resolved-sync:${owner}/${repo}:${sourceId} -->`
  ].join('\n');
}

function formatIndentedBody(body) {
  if (!body?.trim()) {
    return [];
  }

  return [
    '',
    ...body.trim().split('\n').map((line) => `  > ${line}`),
    ''
  ];
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatReviewState(state) {
  switch (state) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'requested changes';
    case 'commented':
      return 'commented';
    case 'dismissed':
      return 'dismissed';
    default:
      return state || 'submitted';
  }
}
