import {
  DESCRIPTION_MARKER_PREFIX,
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  MAX_GITHUB_COMMENT_PAGES_TO_SCAN
} from './config.js';

export async function githubRequestJson(path, options = {}) {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'forge-jira-github-pr-sync',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(options.headers || {})
    }
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  return responseBody ? JSON.parse(responseBody) : undefined;
}

export async function addGitHubPullRequestAssignee({ owner, repo, issueNumber, assignee }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
    {
      method: 'POST',
      body: JSON.stringify({ assignees: [assignee] })
    }
  );
}

export async function removeGitHubPullRequestAssignee({ owner, repo, issueNumber, assignee }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
    {
      method: 'DELETE',
      body: JSON.stringify({ assignees: [assignee] })
    }
  );
}

export async function requestGitHubPullRequestReviewers({ owner, repo, pullRequestNumber, reviewers }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      method: 'POST',
      body: JSON.stringify({ reviewers })
    }
  );
}

export async function removeGitHubPullRequestReviewers({ owner, repo, pullRequestNumber, reviewers }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      method: 'DELETE',
      body: JSON.stringify({ reviewers })
    }
  );
}

export async function syncGitHubAssignees({ owner, repo, issueNumber, desiredAssignees }) {
  const issue = await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}`,
    { method: 'GET' }
  );
  const currentAssignees = (issue.assignees || []).map((assignee) => assignee.login);
  const toAdd = desiredAssignees.filter((assignee) => !currentAssignees.includes(assignee));
  const toRemove = currentAssignees.filter((assignee) => !desiredAssignees.includes(assignee));

  if (toAdd.length > 0) {
    await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
      {
        method: 'POST',
        body: JSON.stringify({ assignees: toAdd })
      }
    );
  }

  if (toRemove.length > 0) {
    await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
      {
        method: 'DELETE',
        body: JSON.stringify({ assignees: toRemove })
      }
    );
  }
}

export async function syncGitHubRequestedReviewers({
  owner,
  repo,
  pullRequestNumber,
  desiredReviewers
}) {
  const pullRequest = await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}`,
    { method: 'GET' }
  );
  const currentReviewers = (pullRequest.requested_reviewers || []).map((reviewer) => reviewer.login);
  const toAdd = desiredReviewers.filter((reviewer) => !currentReviewers.includes(reviewer));
  const toRemove = currentReviewers.filter((reviewer) => !desiredReviewers.includes(reviewer));

  if (toAdd.length > 0) {
    await requestGitHubPullRequestReviewers({ owner, repo, pullRequestNumber, reviewers: toAdd });
  }

  if (toRemove.length > 0) {
    await removeGitHubPullRequestReviewers({ owner, repo, pullRequestNumber, reviewers: toRemove });
  }
}

export async function getGitHubPullRequest({ owner, repo, pullRequestNumber }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}`,
    { method: 'GET' }
  );
}

export async function getGitHubPullRequestCommits({ owner, repo, pullRequestNumber }) {
  /*
   * GitHub returns PR commits in chronological order. Fetching a generous page is
   * enough for normal PRs and keeps this Forge function simple; if the team
   * starts opening PRs with more than 100 commits we can add pagination.
   */
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/commits?per_page=100`,
    { method: 'GET' }
  );
}

export async function getGitHubPullRequestReviews({ owner, repo, pullRequestNumber }) {
  /*
   * Requested reviewers are removed by GitHub once they submit a review. Jira's
   * reviewer field should represent everyone who participated in review, so the
   * sync service combines pending requested reviewers with these submitted
   * review authors.
   */
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/reviews?per_page=100`,
    { method: 'GET' }
  );
}

export async function findManagedDescriptionComment({ owner, repo, issueNumber, issueKey }) {
  const marker = `${DESCRIPTION_MARKER_PREFIX}${issueKey} -->`;

  for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES_TO_SCAN; page += 1) {
    const comments = await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { method: 'GET' }
    );

    if (!Array.isArray(comments) || comments.length === 0) {
      return undefined;
    }

    const matchingComment = comments.find((comment) => comment.body?.includes(marker));

    if (matchingComment) {
      return matchingComment;
    }

    if (comments.length < 100) {
      return undefined;
    }
  }

  return undefined;
}

export async function createGitHubIssueComment({ owner, repo, issueNumber, body }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body })
    }
  );
}

export async function updateGitHubIssueComment({ owner, repo, commentId, body }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/comments/${commentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ body })
    }
  );
}

function encodePathSegment(value) {
  return encodeURIComponent(value);
}
