import { getHeaderValue, jsonResponse, parseJsonBody } from './http.js';
import {
  getRequiredConfiguration,
  SUPPORTED_PULL_REQUEST_ACTIONS
} from './config.js';
import {
  isAllowedGitHubOrganization,
  isDebugResponseEnabled,
  isHumanGitHubUser,
  isValidGitHubSignature,
  sanitizeErrorMessage
} from './github-webhook.js';
import { findJiraIssueKey } from './issue-key.js';
import { getJiraIssue } from './jira-client.js';
import { getGitHubPullRequest } from './github-client.js';
import { getIssueKeyForPullRequest, rememberPullRequestLink } from './sync-state.js';
import {
  addGitHubReviewerToJira,
  announceGitHubPullRequestCommitsToJira,
  announceGitHubPullRequestReviewCommentToJira,
  announceGitHubPullRequestReviewThreadResolvedToJira,
  announceGitHubPullRequestReviewToJira,
  mirrorGitHubCommentToJira,
  syncGitHubAssigneesToJira,
  syncGitHubReviewersToJira,
  syncJiraDescriptionToGitHubPullRequest,
  syncJiraPeopleToGitHubPullRequest
} from './sync-service.js';

export async function githubPullRequestWebhook(event) {
  try {
    console.info('Received GitHub webhook request.', {
      method: event.method,
      githubEvent: getHeaderValue(event.headers, 'x-github-event'),
      deliveryId: getHeaderValue(event.headers, 'x-github-delivery')
    });

    if (event.method !== 'POST') {
      return jsonResponse(405, { message: 'Only POST requests are supported.' });
    }

    const missingConfiguration = getMissingConfiguration();

    if (missingConfiguration.length > 0) {
      console.error('Required environment variables are missing.', { missingConfiguration });
      return jsonResponse(500, {
        message: 'The Forge app is missing required environment variables.'
      });
    }

    const rawBody = event.body || '';

    if (!isValidGitHubSignature(rawBody, event.headers)) {
      console.warn('Rejected GitHub webhook with an invalid signature.');
      return jsonResponse(401, { message: 'Invalid GitHub webhook signature.' });
    }

    const githubEventName = getHeaderValue(event.headers, 'x-github-event');
    const payload = parseJsonBody(rawBody);

    if (githubEventName === 'pull_request') {
      return handlePullRequestEvent(payload);
    }

    if (githubEventName === 'issue_comment') {
      return handleIssueCommentEvent(payload);
    }

    if (githubEventName === 'pull_request_review') {
      return handlePullRequestReviewEvent(payload);
    }

    if (githubEventName === 'pull_request_review_comment') {
      return handlePullRequestReviewCommentEvent(payload);
    }

    if (githubEventName === 'pull_request_review_thread') {
      return handlePullRequestReviewThreadEvent(payload);
    }

    console.info('Ignored unsupported GitHub event.', {
      githubEvent: githubEventName || 'unknown'
    });

    return jsonResponse(202, {
      message: `Ignored GitHub event: ${githubEventName || 'unknown'}.`
    });
  } catch (error) {
    console.error('Failed to process the GitHub webhook.', {
      message: error.message,
      stack: error.stack
    });

    return jsonResponse(500, {
      message: 'Failed to process the GitHub webhook.',
      ...(isDebugResponseEnabled() ? { debug: sanitizeErrorMessage(error.message) } : {})
    });
  }
}

async function handlePullRequestEvent(payload) {
  if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(payload.action)) {
    return jsonResponse(202, {
      message: `Ignored pull_request action: ${payload.action || 'unknown'}.`
    });
  }

  const pullRequest = payload.pull_request;
  const repository = payload.repository;
  const repositoryOwner = repository?.owner?.login || repository?.owner?.name;
  const repositoryName = repository?.name;
  const pullRequestNumber = pullRequest?.number;
  const installationId = payload.installation?.id;

  if (!pullRequest || !repositoryOwner || !repositoryName || !pullRequestNumber) {
    return jsonResponse(400, {
      message: 'The GitHub webhook payload is missing repository or pull request identifiers.'
    });
  }

  console.info('Processing GitHub pull request event.', {
    action: payload.action || 'unknown',
    repositoryOwner,
    repositoryName,
    pullRequestNumber,
    pullRequestState: pullRequest.state || 'unknown',
    assigneeCount: pullRequest.assignees?.length || 0,
    requestedReviewerCount: pullRequest.requested_reviewers?.length || 0
  });

  if (!isAllowedGitHubOrganization(repositoryOwner)) {
    return jsonResponse(202, {
      message: `Ignored pull request from GitHub owner ${repositoryOwner}.`
    });
  }

  const jiraIssueKey = findJiraIssueKey(pullRequest);

  if (!jiraIssueKey) {
    return jsonResponse(202, {
      message: 'No Jira issue key was found in the pull request title or branch name.'
    });
  }

  await rememberPullRequestLink({
    issueKey: jiraIssueKey,
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber,
    installationId
  });

  const jiraIssue = await getJiraIssue(jiraIssueKey);

  if (!jiraIssue) {
    return jsonResponse(202, {
      message: `Jira issue ${jiraIssueKey} was not found or cannot be read by this app.`
    });
  }

  await syncJiraDescriptionToGitHubPullRequest({
    jiraIssue,
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber,
    installationId
  });

  if (payload.action === 'opened' || payload.action === 'synchronize') {
    await announceGitHubPullRequestCommitsToJira({
      issueKey: jiraIssueKey,
      owner: repositoryOwner,
      repo: repositoryName,
      pullRequestNumber,
      installationId
    });
  }

  if (payload.action === 'assigned' || payload.action === 'unassigned') {
    await syncGitHubAssigneesToJira({
      issueKey: jiraIssueKey,
      githubAssignees: pullRequest.assignees || [],
      installationId,
      eventTime: pullRequest.updated_at
    });
  } else if (payload.action === 'review_requested' || payload.action === 'review_request_removed') {
    await syncGitHubReviewersToJira({
      issueKey: jiraIssueKey,
      githubReviewers: pullRequest.requested_reviewers || [],
      owner: repositoryOwner,
      repo: repositoryName,
      pullRequestNumber,
      installationId,
      eventTime: pullRequest.updated_at
    });
  } else {
    await syncJiraPeopleToGitHubPullRequest({
      jiraIssue,
      owner: repositoryOwner,
      repo: repositoryName,
      pullRequestNumber,
      installationId,
      pullRequestAuthor: pullRequest.user?.login,
      eventTime: pullRequest.updated_at
    });
  }

  return jsonResponse(200, {
    message: `Processed GitHub PR #${pullRequestNumber} for Jira issue ${jiraIssueKey}.`
  });
}

async function handleIssueCommentEvent(payload) {
  if (payload.action !== 'created') {
    return jsonResponse(202, {
      message: `Ignored issue_comment action: ${payload.action || 'unknown'}.`
    });
  }

  if (!payload.issue?.pull_request) {
    return jsonResponse(202, {
      message: 'Ignored issue comment because it was not on a pull request.'
    });
  }

  if (!isHumanGitHubUser(payload.comment?.user)) {
    return jsonResponse(202, {
      message: 'Ignored GitHub comment because it was not created by a human user.'
    });
  }

  const repository = payload.repository;
  const repositoryOwner = repository?.owner?.login || repository?.owner?.name;
  const repositoryName = repository?.name;
  const pullRequestNumber = payload.issue?.number;
  const installationId = payload.installation?.id;

  if (!repositoryOwner || !repositoryName || !pullRequestNumber) {
    return jsonResponse(400, {
      message: 'The GitHub issue_comment payload is missing repository or pull request identifiers.'
    });
  }

  if (!isAllowedGitHubOrganization(repositoryOwner)) {
    return jsonResponse(202, {
      message: `Ignored issue comment from GitHub owner ${repositoryOwner}.`
    });
  }

  const pullRequest = await getGitHubPullRequest({
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber,
    installationId
  });
  const jiraIssueKey = findJiraIssueKey(pullRequest);

  if (!jiraIssueKey) {
    return jsonResponse(202, {
      message: 'No Jira issue key was found in the pull request title or branch name.'
    });
  }

  await rememberPullRequestLink({
    issueKey: jiraIssueKey,
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber,
    installationId
  });

  const mirroredComment = await mirrorGitHubCommentToJira({
    jiraIssueKey,
    githubComment: payload.comment,
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber
  });

  return jsonResponse(200, {
    message: mirroredComment
      ? `Mirrored GitHub comment ${payload.comment.id} to Jira issue ${jiraIssueKey}.`
      : `Skipped GitHub comment ${payload.comment.id}; it was already synced or marked.`
  });
}

async function handlePullRequestReviewEvent(payload) {
  if (payload.action !== 'submitted') {
    console.info('Ignored pull request review action.', {
      action: payload.action || 'unknown'
    });
    return jsonResponse(202, {
      message: `Ignored pull_request_review action: ${payload.action || 'unknown'}.`
    });
  }

  const pullRequestContext = await getLinkedPullRequestContext({
    pullRequest: payload.pull_request,
    repository: payload.repository,
    installation: payload.installation
  });

  if (pullRequestContext.response) {
    return pullRequestContext.response;
  }

  const createdComment = await announceGitHubPullRequestReviewToJira({
    issueKey: pullRequestContext.jiraIssueKey,
    review: payload.review,
    owner: pullRequestContext.repositoryOwner,
    repo: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber,
    installationId: pullRequestContext.installationId
  });
  await addGitHubReviewerToJira({
    issueKey: pullRequestContext.jiraIssueKey,
    githubUsername: payload.review?.user?.login,
    owner: pullRequestContext.repositoryOwner,
    repo: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber,
    installationId: pullRequestContext.installationId,
    eventTime: payload.review?.submitted_at
  });

  console.info('Processed GitHub pull request review event.', {
    jiraIssueKey: pullRequestContext.jiraIssueKey,
    repositoryOwner: pullRequestContext.repositoryOwner,
    repositoryName: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber,
    reviewId: payload.review?.id,
    createdOrUpdatedJiraComment: Boolean(createdComment)
  });

  return jsonResponse(200, {
    message: createdComment
      ? `Notified Jira issue ${pullRequestContext.jiraIssueKey} about GitHub review ${payload.review?.id}.`
      : `Skipped GitHub review ${payload.review?.id}; it was already notified.`
  });
}

async function handlePullRequestReviewCommentEvent(payload) {
  if (payload.action !== 'created') {
    console.info('Ignored pull request review comment action.', {
      action: payload.action || 'unknown'
    });
    return jsonResponse(202, {
      message: `Ignored pull_request_review_comment action: ${payload.action || 'unknown'}.`
    });
  }

  const pullRequestContext = await getLinkedPullRequestContext({
    pullRequest: payload.pull_request,
    repository: payload.repository,
    installation: payload.installation
  });

  if (pullRequestContext.response) {
    return pullRequestContext.response;
  }

  const createdComment = await announceGitHubPullRequestReviewCommentToJira({
    reviewComment: payload.comment,
    owner: pullRequestContext.repositoryOwner,
    repo: pullRequestContext.repositoryName
  });

  console.info('Processed GitHub pull request review comment event.', {
    jiraIssueKey: pullRequestContext.jiraIssueKey,
    repositoryOwner: pullRequestContext.repositoryOwner,
    repositoryName: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber,
    reviewCommentId: payload.comment?.id,
    storedForParentReview: true,
    createdJiraComment: Boolean(createdComment)
  });

  return jsonResponse(200, {
    message: `Stored GitHub review comment ${payload.comment?.id} for parent review sync.`
  });
}

async function handlePullRequestReviewThreadEvent(payload) {
  if (payload.action !== 'resolved') {
    console.info('Ignored pull request review thread action.', {
      action: payload.action || 'unknown'
    });
    return jsonResponse(202, {
      message: `Ignored pull_request_review_thread action: ${payload.action || 'unknown'}.`
    });
  }

  const pullRequestContext = await getLinkedPullRequestContext({
    pullRequest: payload.pull_request,
    repository: payload.repository,
    installation: payload.installation
  });

  if (pullRequestContext.response) {
    return pullRequestContext.response;
  }

  const updatedComment = await announceGitHubPullRequestReviewThreadResolvedToJira({
    issueKey: pullRequestContext.jiraIssueKey,
    thread: payload.thread,
    sender: payload.sender,
    owner: pullRequestContext.repositoryOwner,
    repo: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber
  });

  console.info('Processed GitHub pull request review thread event.', {
    jiraIssueKey: pullRequestContext.jiraIssueKey,
    repositoryOwner: pullRequestContext.repositoryOwner,
    repositoryName: pullRequestContext.repositoryName,
    pullRequestNumber: pullRequestContext.pullRequestNumber,
    action: payload.action,
    updatedJiraComment: Boolean(updatedComment)
  });

  return jsonResponse(200, {
    message: updatedComment
      ? `Updated Jira issue ${pullRequestContext.jiraIssueKey} for resolved GitHub review thread.`
      : `Skipped resolved GitHub review thread; it was already recorded.`
  });
}

async function getLinkedPullRequestContext({ pullRequest, repository, installation }) {
  const repositoryOwner = repository?.owner?.login || repository?.owner?.name;
  const repositoryName = repository?.name;
  const pullRequestNumber = pullRequest?.number;
  const installationId = installation?.id;

  if (!pullRequest || !repositoryOwner || !repositoryName || !pullRequestNumber) {
    console.warn('Ignored review event because required pull request context was missing.', {
      hasPullRequest: Boolean(pullRequest),
      repositoryOwner,
      repositoryName,
      pullRequestNumber
    });
    return {
      response: jsonResponse(400, {
        message: 'The GitHub review payload is missing repository or pull request identifiers.'
      })
    };
  }

  if (!isAllowedGitHubOrganization(repositoryOwner)) {
    console.info('Ignored review event from an unconfigured GitHub owner.', {
      repositoryOwner,
      configuredOrganization: process.env.GITHUB_ORGANIZATION
    });
    return {
      response: jsonResponse(202, {
        message: `Ignored review event from GitHub owner ${repositoryOwner}.`
      })
    };
  }

  const jiraIssueKey = findJiraIssueKey(pullRequest) || await getIssueKeyForPullRequest({
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber
  });

  if (!jiraIssueKey) {
    console.info('Ignored review event because no Jira issue key was found.', {
      repositoryOwner,
      repositoryName,
      pullRequestNumber,
      pullRequestTitle: pullRequest.title,
      pullRequestBranch: pullRequest.head?.ref
    });
    return {
      response: jsonResponse(202, {
        message: 'No Jira issue key was found in the pull request title or branch name.'
      })
    };
  }

  await rememberPullRequestLink({
    issueKey: jiraIssueKey,
    owner: repositoryOwner,
    repo: repositoryName,
    pullRequestNumber,
    installationId
  });

  return {
    jiraIssueKey,
    repositoryOwner,
    repositoryName,
    pullRequestNumber,
    installationId
  };
}

function getMissingConfiguration() {
  return getRequiredConfiguration().filter((variableName) => !process.env[variableName]);
}
