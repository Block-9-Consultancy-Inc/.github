import crypto from 'node:crypto';
import {
  DESCRIPTION_MARKER_PREFIX,
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  MAX_GITHUB_COMMENT_PAGES_TO_SCAN
} from './config.js';

const INSTALLATION_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const installationTokenCache = new Map();
const repositoryInstallationCache = new Map();

export async function githubRequestJson(path, options = {}) {
  const { installationId, headers = {}, ...fetchOptions } = options;
  const authorizationHeader = await getGitHubAuthorizationHeader({ installationId, path });
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    ...fetchOptions,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: authorizationHeader,
      'Content-Type': 'application/json',
      'User-Agent': 'forge-jira-github-pr-sync',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...headers
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

export async function addGitHubPullRequestAssignee({
  owner,
  repo,
  issueNumber,
  assignee,
  installationId
}) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
    {
      installationId,
      method: 'POST',
      body: JSON.stringify({ assignees: [assignee] })
    }
  );
}

export async function removeGitHubPullRequestAssignee({
  owner,
  repo,
  issueNumber,
  assignee,
  installationId
}) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
    {
      installationId,
      method: 'DELETE',
      body: JSON.stringify({ assignees: [assignee] })
    }
  );
}

export async function requestGitHubPullRequestReviewers({
  owner,
  repo,
  pullRequestNumber,
  reviewers,
  installationId
}) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      installationId,
      method: 'POST',
      body: JSON.stringify({ reviewers })
    }
  );
}

export async function removeGitHubPullRequestReviewers({
  owner,
  repo,
  pullRequestNumber,
  reviewers,
  installationId
}) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      installationId,
      method: 'DELETE',
      body: JSON.stringify({ reviewers })
    }
  );
}

export async function syncGitHubAssignees({
  owner,
  repo,
  issueNumber,
  desiredAssignees,
  installationId
}) {
  const issue = await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}`,
    { installationId, method: 'GET' }
  );
  const currentAssignees = (issue.assignees || []).map((assignee) => assignee.login);
  const toAdd = desiredAssignees.filter((assignee) => !currentAssignees.includes(assignee));
  const toRemove = currentAssignees.filter((assignee) => !desiredAssignees.includes(assignee));

  if (toAdd.length > 0) {
    await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
      {
        installationId,
        method: 'POST',
        body: JSON.stringify({ assignees: toAdd })
      }
    );
  }

  if (toRemove.length > 0) {
    await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
      {
        installationId,
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
  desiredReviewers,
  installationId
}) {
  const pullRequest = await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}`,
    { installationId, method: 'GET' }
  );
  const currentReviewers = (pullRequest.requested_reviewers || []).map((reviewer) => reviewer.login);
  const toAdd = desiredReviewers.filter((reviewer) => !currentReviewers.includes(reviewer));
  const toRemove = currentReviewers.filter((reviewer) => !desiredReviewers.includes(reviewer));

  if (toAdd.length > 0) {
    await requestGitHubPullRequestReviewers({
      owner,
      repo,
      pullRequestNumber,
      reviewers: toAdd,
      installationId
    });
  }

  if (toRemove.length > 0) {
    await removeGitHubPullRequestReviewers({
      owner,
      repo,
      pullRequestNumber,
      reviewers: toRemove,
      installationId
    });
  }
}

export async function getGitHubPullRequest({ owner, repo, pullRequestNumber, installationId }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}`,
    { installationId, method: 'GET' }
  );
}

export async function getGitHubPullRequestCommits({
  owner,
  repo,
  pullRequestNumber,
  installationId
}) {
  /*
   * GitHub returns PR commits in chronological order. Fetching a generous page is
   * enough for normal PRs and keeps this Forge function simple; if the team
   * starts opening PRs with more than 100 commits we can add pagination.
   */
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/commits?per_page=100`,
    { installationId, method: 'GET' }
  );
}

export async function getGitHubPullRequestReviews({
  owner,
  repo,
  pullRequestNumber,
  installationId
}) {
  /*
   * Requested reviewers are removed by GitHub once they submit a review. Jira's
   * reviewer field should represent everyone who participated in review, so the
   * sync service combines pending requested reviewers with these submitted
   * review authors.
   */
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/reviews?per_page=100`,
    { installationId, method: 'GET' }
  );
}

export async function findManagedDescriptionComment({
  owner,
  repo,
  issueNumber,
  issueKey,
  installationId
}) {
  const marker = `${DESCRIPTION_MARKER_PREFIX}${issueKey} -->`;

  for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES_TO_SCAN; page += 1) {
    const comments = await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { installationId, method: 'GET' }
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

export async function createGitHubIssueComment({ owner, repo, issueNumber, body, installationId }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments`,
    {
      installationId,
      method: 'POST',
      body: JSON.stringify({ body })
    }
  );
}

export async function updateGitHubIssueComment({ owner, repo, commentId, body, installationId }) {
  return githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/comments/${commentId}`,
    {
      installationId,
      method: 'PATCH',
      body: JSON.stringify({ body })
    }
  );
}

async function getGitHubAuthorizationHeader({ installationId, path }) {
  if (hasGitHubAppConfiguration()) {
    const resolvedInstallationId =
      installationId || await getRepositoryInstallationIdFromRequestPath(path);

    if (resolvedInstallationId) {
      return `Bearer ${await getInstallationAccessToken(resolvedInstallationId)}`;
    }
  }

  if (process.env.GITHUB_TOKEN) {
    return `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  throw new Error(
    'GitHub authentication is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64, or set GITHUB_TOKEN as a fallback.'
  );
}

function hasGitHubAppConfiguration() {
  return Boolean(process.env.GITHUB_APP_ID && getGitHubAppPrivateKey());
}

async function getInstallationAccessToken(installationId) {
  const cachedToken = installationTokenCache.get(String(installationId));

  if (cachedToken && cachedToken.expiresAt - Date.now() > INSTALLATION_TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.token;
  }

  const appJwt = createGitHubAppJwt();
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/app/installations/${encodePathSegment(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'Content-Type': 'application/json',
        'User-Agent': 'forge-jira-github-pr-sync',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    }
  );
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub installation token request failed: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  const tokenResponse = JSON.parse(responseBody);
  installationTokenCache.set(String(installationId), {
    token: tokenResponse.token,
    expiresAt: new Date(tokenResponse.expires_at).getTime()
  });

  return tokenResponse.token;
}

function createGitHubAppJwt() {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };
  const payload = {
    iat: nowInSeconds - 60,
    exp: nowInSeconds + 9 * 60,
    iss: process.env.GITHUB_APP_ID
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = createGitHubAppPrivateKeyObject();
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function createGitHubAppPrivateKeyObject() {
  const privateKeyPem = getGitHubAppPrivateKey();

  try {
    /*
     * Converting the PEM string into a KeyObject up front gives us a clearer
     * failure point than letting crypto.sign throw a low-level OpenSSL decoder
     * error. The key material itself is never logged.
     */
    return crypto.createPrivateKey(privateKeyPem);
  } catch (error) {
    const keyShape = describeConfiguredPrivateKeyShape(privateKeyPem);
    throw new Error(
      `GitHub App private key could not be parsed as a PEM private key. ${keyShape}. ` +
      'Set GITHUB_APP_PRIVATE_KEY_BASE64 to the base64-encoded PEM contents generated by GitHub.',
      { cause: error }
    );
  }
}

function getGitHubAppPrivateKey() {
  const rawBase64Value = normalizeEnvironmentSecret(process.env.GITHUB_APP_PRIVATE_KEY_BASE64);

  if (rawBase64Value) {
    /*
     * The expected production value is base64-encoded PEM. If the variable was
     * accidentally set to raw PEM, accept it anyway so a common setup mistake
     * does not produce an opaque OpenSSL error.
     */
    if (looksLikePemPrivateKey(rawBase64Value)) {
      return normalizePemPrivateKey(rawBase64Value);
    }

    return decodeBase64PemPrivateKey(rawBase64Value) || normalizePemPrivateKey(rawBase64Value);
  }

  const rawPemValue = normalizeEnvironmentSecret(process.env.GITHUB_APP_PRIVATE_KEY);

  if (rawPemValue) {
    /*
     * Base64 is the recommended Forge variable format because multiline PEM
     * values are awkward to set in a shell. This fallback keeps local tunnels
     * and manually-entered variables working if the raw PEM is provided. It
     * also accepts a base64 value here because it is easy to paste the encoded
     * key into the raw-key variable while setting Forge variables by hand.
     */
    if (looksLikePemPrivateKey(rawPemValue)) {
      return normalizePemPrivateKey(rawPemValue);
    }

    return decodeBase64PemPrivateKey(rawPemValue) || normalizePemPrivateKey(rawPemValue);
  }

  return undefined;
}

function normalizeEnvironmentSecret(value) {
  if (!value) {
    return undefined;
  }

  return value.trim().replace(/^['"]|['"]$/g, '');
}

function normalizePemPrivateKey(value) {
  return value.replace(/\\n/g, '\n').trim();
}

function decodeBase64PemPrivateKey(value) {
  /*
   * Forge variable values should be only the base64 text. During manual setup,
   * it is easy to paste the terminal prompt suffix as a trailing "$"; removing
   * only a trailing "$" keeps the recovery narrow and predictable.
   */
  const base64Candidate = value.replace(/\s/g, '').replace(/\$+$/g, '');
  const decodedValue = Buffer.from(base64Candidate, 'base64').toString('utf8');

  if (!looksLikePemPrivateKey(decodedValue)) {
    return undefined;
  }

  return normalizePemPrivateKey(decodedValue);
}

function looksLikePemPrivateKey(value) {
  return value.includes('-----BEGIN') && value.includes('PRIVATE KEY-----');
}

function describeConfiguredPrivateKeyShape(privateKeyPem) {
  if (!privateKeyPem) {
    return 'No private key value was found';
  }

  const hasPemHeader = looksLikePemPrivateKey(privateKeyPem);

  return [
    `PEM header present: ${hasPemHeader}`,
    `single-line value: ${!privateKeyPem.includes('\n')}`,
    `length: ${privateKeyPem.length}`
  ].join('; ');
}

async function getRepositoryInstallationIdFromRequestPath(path) {
  const repository = getRepositoryFromRequestPath(path);

  if (!repository) {
    return undefined;
  }

  const cacheKey = `${repository.owner}/${repository.repo}`;
  const cachedInstallationId = repositoryInstallationCache.get(cacheKey);

  if (cachedInstallationId) {
    return cachedInstallationId;
  }

  const appJwt = createGitHubAppJwt();
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/installation`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'User-Agent': 'forge-jira-github-pr-sync',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    }
  );
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub repository installation lookup failed: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  const installation = JSON.parse(responseBody);
  repositoryInstallationCache.set(cacheKey, installation.id);
  return installation.id;
}

function getRepositoryFromRequestPath(path) {
  const match = path.match(/^\/repos\/([^/]+)\/([^/?]+)/);

  if (!match) {
    return undefined;
  }

  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2])
  };
}

function base64UrlEncode(value) {
  return Buffer
    .from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodePathSegment(value) {
  return encodeURIComponent(value);
}
