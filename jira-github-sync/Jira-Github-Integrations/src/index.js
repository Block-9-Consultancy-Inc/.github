import api, { route } from '@forge/api';
import crypto from 'node:crypto';
import { JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME } from './github-user-mapping.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const JIRA_ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/gi;
const COMMENT_MARKER_PREFIX = '<!-- jira-description-sync:';
const JIRA_REVIEWERS_FIELD_ID = 'customfield_10251';
const MAX_GITHUB_COMMENT_BODY_LENGTH = 65536;
const MAX_GITHUB_COMMENT_PAGES_TO_SCAN = 10;

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'reopened',
  'edited',
  'synchronize',
  'ready_for_review'
]);

export const githubPullRequestWebhook = async (event) => {
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
      console.error('Required environment variables are missing.', {
        missingConfiguration
      });

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

    if (githubEventName !== 'pull_request') {
      console.info('Ignored non-pull-request GitHub event.', {
        githubEvent: githubEventName || 'unknown'
      });

      return jsonResponse(202, {
        message: `Ignored GitHub event: ${githubEventName || 'unknown'}.`
      });
    }

    const payload = parseJsonBody(rawBody);

    if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(payload.action)) {
      console.info('Ignored unsupported pull request action.', {
        action: payload.action || 'unknown'
      });

      return jsonResponse(202, {
        message: `Ignored pull_request action: ${payload.action || 'unknown'}.`
      });
    }

    const pullRequest = payload.pull_request;
    const repository = payload.repository;

    if (!pullRequest || !repository) {
      return jsonResponse(400, {
        message: 'The GitHub webhook payload does not include a pull request and repository.'
      });
    }

    const repositoryOwner = repository.owner?.login || repository.owner?.name;
    const repositoryName = repository.name;
    const pullRequestNumber = pullRequest.number;

    if (!repositoryOwner || !repositoryName || !pullRequestNumber) {
      return jsonResponse(400, {
        message: 'The GitHub webhook payload is missing repository or pull request identifiers.'
      });
    }

    if (!isAllowedGitHubOrganization(repositoryOwner)) {
      console.info('Ignored pull request from an unconfigured GitHub owner.', {
        repositoryOwner,
        configuredOrganization: process.env.GITHUB_ORGANIZATION
      });

      return jsonResponse(202, {
        message: `Ignored pull request from GitHub owner ${repositoryOwner}.`
      });
    }

    console.info('Processing GitHub pull request webhook.', {
      action: payload.action,
      repositoryOwner,
      repositoryName,
      pullRequestNumber,
      pullRequestTitle: pullRequest.title,
      pullRequestBranch: pullRequest.head?.ref
    });

    const jiraIssueKey = findJiraIssueKey(pullRequest);

    if (!jiraIssueKey) {
      console.info('No Jira issue key was found in the configured PR fields.', {
        pullRequestTitle: pullRequest.title,
        pullRequestBranch: pullRequest.head?.ref,
        allowedProjectKeys: process.env.JIRA_PROJECT_KEYS || ''
      });

      return jsonResponse(202, {
        message: 'No Jira issue key was found in the pull request title or branch name.'
      });
    }

    console.info('Found Jira issue key on pull request.', { jiraIssueKey });

    const jiraIssue = await getJiraIssue(jiraIssueKey);

    if (!jiraIssue) {
      return jsonResponse(202, {
        message: `Jira issue ${jiraIssueKey} was not found or cannot be read by this app.`
      });
    }

    console.info('Loaded Jira issue.', {
      jiraIssueKey: jiraIssue.key,
      hasDescription: Boolean(jiraIssue.fields?.description),
      hasAssignee: Boolean(jiraIssue.fields?.assignee),
      reviewerCount: getJiraUsersFromField(jiraIssue.fields?.[JIRA_REVIEWERS_FIELD_ID]).length
    });

    await syncJiraPeopleToGitHubPullRequest({
      jiraIssue,
      owner: repositoryOwner,
      repo: repositoryName,
      pullRequestNumber,
      pullRequestAuthor: pullRequest.user?.login
    });

    const commentMarker = buildCommentMarker(jiraIssue.key);

    const alreadyCommented = await hasExistingGitHubComment({
      owner: repositoryOwner,
      repo: repositoryName,
      issueNumber: pullRequestNumber,
      marker: commentMarker
    });

    if (alreadyCommented) {
      console.info('Skipped GitHub comment because the Jira description was already synced.', {
        jiraIssueKey: jiraIssue.key,
        repositoryOwner,
        repositoryName,
        pullRequestNumber
      });

      return jsonResponse(200, {
        message: `A Jira description comment for ${jiraIssue.key} already exists on this pull request.`
      });
    }

    await createGitHubComment({
      owner: repositoryOwner,
      repo: repositoryName,
      issueNumber: pullRequestNumber,
      body: buildGitHubComment({ jiraIssue, marker: commentMarker })
    });

    console.info('Created GitHub pull request comment with Jira description.', {
      jiraIssueKey: jiraIssue.key,
      repositoryOwner,
      repositoryName,
      pullRequestNumber
    });

    return jsonResponse(200, {
      message: `Added the Jira description from ${jiraIssue.key} to GitHub PR #${pullRequestNumber}.`
    });
  } catch (error) {
    console.error('Failed to process the GitHub pull request webhook.', {
      message: error.message,
      stack: error.stack
    });

    return jsonResponse(500, {
      message: 'Failed to process the GitHub pull request webhook.',
      ...(isDebugResponseEnabled() ? { debug: sanitizeErrorMessage(error.message) } : {})
    });
  }
};

function getMissingConfiguration() {
  const requiredEnvironmentVariables = [
    'GITHUB_TOKEN',
    'GITHUB_WEBHOOK_SECRET'
  ];

  return requiredEnvironmentVariables.filter((variableName) => !process.env[variableName]);
}

function isDebugResponseEnabled() {
  /*
   * GitHub's webhook delivery screen shows the response body, while Forge logs
   * require a working local CLI login. This opt-in flag exposes sanitized error
   * text in the webhook response during setup without changing normal production
   * behavior.
   */
  return process.env.DEBUG_WEBHOOK_RESPONSES === 'true';
}

function sanitizeErrorMessage(errorMessage) {
  if (!errorMessage) {
    return 'Unknown error';
  }

  return errorMessage
    .replace(new RegExp(escapeRegExp(process.env.GITHUB_TOKEN || 'a^'), 'g'), '[redacted-github-token]')
    .replace(
      new RegExp(escapeRegExp(process.env.GITHUB_WEBHOOK_SECRET || 'a^'), 'g'),
      '[redacted-webhook-secret]'
    );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAllowedGitHubOrganization(repositoryOwner) {
  /*
   * GitHub organization webhooks can send events for every repository in the
   * organization. This optional guard lets the same Forge endpoint reject
   * accidental traffic from another organization if the webhook URL leaks or is
   * copied into the wrong GitHub settings page.
   */
  const configuredOrganization = process.env.GITHUB_ORGANIZATION;

  if (!configuredOrganization) {
    return true;
  }

  return repositoryOwner.toLowerCase() === configuredOrganization.trim().toLowerCase();
}

function getHeaderValue(headers, requestedHeaderName) {
  const normalizedRequestedHeaderName = requestedHeaderName.toLowerCase();
  const matchingHeader = Object.entries(headers || {}).find(([headerName]) => {
    return headerName.toLowerCase() === normalizedRequestedHeaderName;
  });

  if (!matchingHeader) {
    return undefined;
  }

  const headerValue = matchingHeader[1];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

function isValidGitHubSignature(rawBody, headers) {
  const receivedSignature = getHeaderValue(headers, 'x-hub-signature-256');

  if (!receivedSignature || !receivedSignature.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex')}`;

  const receivedSignatureBuffer = Buffer.from(receivedSignature, 'utf8');
  const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf8');

  return (
    receivedSignatureBuffer.length === expectedSignatureBuffer.length &&
    crypto.timingSafeEqual(receivedSignatureBuffer, expectedSignatureBuffer)
  );
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`GitHub webhook body was not valid JSON: ${error.message}`);
  }
}

function findJiraIssueKey(pullRequest) {
  const allowedProjectKeys = parseAllowedProjectKeys(process.env.JIRA_PROJECT_KEYS);
  return findJiraIssueKeyInTextSources({
    allowedProjectKeys,
    textSources: [
      pullRequest.title,
      pullRequest.head?.ref
    ]
  });
}

function findJiraIssueKeyInTextSources({ allowedProjectKeys, textSources }) {
  /*
   * This app intentionally mirrors the team's PR hygiene rule: a pull request is
   * considered connected to Jira only when the issue key is present in the PR
   * title or source branch name. PR bodies and commit messages are ignored so
   * incidental references do not trigger a GitHub comment.
   */
  for (const textSource of textSources) {
    const issueKeys = extractJiraIssueKeys(textSource);

    for (const issueKey of issueKeys) {
      if (allowedProjectKeys.size === 0 || allowedProjectKeys.has(issueKey.split('-')[0])) {
        return issueKey;
      }
    }
  }

  return undefined;
}

function parseAllowedProjectKeys(rawProjectKeys) {
  if (!rawProjectKeys) {
    return new Set();
  }

  return new Set(
    rawProjectKeys
      .split(',')
      .map((projectKey) => projectKey.trim().toUpperCase())
      .filter(Boolean)
  );
}

function extractJiraIssueKeys(text) {
  if (!text) {
    return [];
  }

  const issueKeys = text.match(JIRA_ISSUE_KEY_PATTERN) || [];
  return [...new Set(issueKeys.map((issueKey) => issueKey.toUpperCase()))];
}

async function getJiraIssue(issueKey) {
  const response = await api
    .asApp()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,description,assignee,customfield_10251`
    );
  const responseBody = await response.text();

  if (response.status === 404) {
    console.warn(`Jira issue ${issueKey} was not found.`);
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `Jira issue lookup failed for ${issueKey}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  return JSON.parse(responseBody);
}

async function syncJiraPeopleToGitHubPullRequest({
  jiraIssue,
  owner,
  repo,
  pullRequestNumber,
  pullRequestAuthor
}) {
  /*
   * People sync is deliberately best-effort. The core promise of this app is to
   * copy the Jira description into GitHub; a private email address, missing user
   * match, or GitHub permission issue should be visible in logs without blocking
   * the description comment.
   */
  try {
    const jiraAssignee = jiraIssue.fields?.assignee;
    const githubAssignee = await findGitHubUsernameForJiraUser(jiraAssignee);

    if (githubAssignee) {
      await addGitHubPullRequestAssignee({
        owner,
        repo,
        issueNumber: pullRequestNumber,
        assignee: githubAssignee
      });

      console.info('Synced Jira assignee to GitHub pull request assignee.', {
        jiraIssueKey: jiraIssue.key,
        githubAssignee
      });
    }

    const jiraReviewers = getJiraUsersFromField(jiraIssue.fields?.[JIRA_REVIEWERS_FIELD_ID]);
    const githubReviewers = await findGitHubUsernamesForJiraUsers(jiraReviewers);
    const requestableReviewers = githubReviewers.filter((reviewer) => {
      return reviewer.toLowerCase() !== (pullRequestAuthor || '').toLowerCase();
    });

    if (requestableReviewers.length > 0) {
      await requestGitHubPullRequestReviewers({
        owner,
        repo,
        pullRequestNumber,
        reviewers: requestableReviewers
      });

      console.info('Synced Jira reviewer field to GitHub requested reviewers.', {
        jiraIssueKey: jiraIssue.key,
        githubReviewers: requestableReviewers
      });
    }
  } catch (error) {
    console.warn('Skipped some or all Jira people sync for this pull request.', {
      jiraIssueKey: jiraIssue.key,
      message: error.message
    });
  }
}

function getJiraUsersFromField(fieldValue) {
  /*
   * Jira custom user fields can be configured as a single-user picker or a
   * multi-user picker. Normalizing here lets the GitHub reviewer sync support
   * either configuration without additional app settings.
   */
  if (!fieldValue) {
    return [];
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue.filter(Boolean);
  }

  return [fieldValue];
}

async function findGitHubUsernamesForJiraUsers(jiraUsers) {
  const githubUsernames = [];

  for (const jiraUser of jiraUsers) {
    const githubUsername = await findGitHubUsernameForJiraUser(jiraUser);

    if (githubUsername && !githubUsernames.some((username) => username === githubUsername)) {
      githubUsernames.push(githubUsername);
    }
  }

  return githubUsernames;
}

async function findGitHubUsernameForJiraUser(jiraUser) {
  const mappedUsername = findMappedGitHubUsernameForJiraUser(jiraUser);

  if (mappedUsername) {
    return mappedUsername;
  }

  const emailAddress = jiraUser?.emailAddress;

  if (!emailAddress) {
    console.info('Skipped Jira user because Jira did not expose an email address.', {
      jiraAccountId: jiraUser?.accountId,
      displayName: jiraUser?.displayName
    });

    return undefined;
  }

  const searchResult = await githubRequestJson(
    `/search/users?q=${encodeURIComponent(`${emailAddress} in:email`)}&per_page=2`,
    { method: 'GET' }
  );

  if (searchResult.total_count !== 1 || !searchResult.items?.[0]?.login) {
    console.info('Skipped Jira user because no unique GitHub user matched the email address.', {
      jiraAccountId: jiraUser.accountId,
      githubSearchMatches: searchResult.total_count || 0
    });

    return undefined;
  }

  return searchResult.items[0].login;
}

function findMappedGitHubUsernameForJiraUser(jiraUser) {
  const accountId = jiraUser?.accountId;

  if (!accountId) {
    return undefined;
  }

  const mappedUsername = JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME[accountId]?.trim();

  if (!mappedUsername) {
    return undefined;
  }

  console.info('Matched Jira user to GitHub username from local mapping.', {
    jiraAccountId: accountId,
    githubUsername: mappedUsername
  });

  return mappedUsername;
}

async function addGitHubPullRequestAssignee({ owner, repo, issueNumber, assignee }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/assignees`,
    {
      method: 'POST',
      body: JSON.stringify({ assignees: [assignee] })
    }
  );
}

async function requestGitHubPullRequestReviewers({ owner, repo, pullRequestNumber, reviewers }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      method: 'POST',
      body: JSON.stringify({ reviewers })
    }
  );
}

async function hasExistingGitHubComment({ owner, repo, issueNumber, marker }) {
  for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES_TO_SCAN; page += 1) {
    const comments = await githubRequestJson(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { method: 'GET' }
    );

    if (!Array.isArray(comments) || comments.length === 0) {
      return false;
    }

    if (comments.some((comment) => comment.body?.includes(marker))) {
      return true;
    }

    if (comments.length < 100) {
      return false;
    }
  }

  /*
   * This is intentionally conservative. If a PR has more comments than we scan,
   * we prefer posting a useful comment over silently doing nothing.
   */
  return false;
}

async function createGitHubComment({ owner, repo, issueNumber, body }) {
  await githubRequestJson(
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body })
    }
  );
}

async function githubRequestJson(path, options) {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'forge-jira-github-pr-commenter',
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

function buildGitHubComment({ jiraIssue, marker }) {
  const issueKey = jiraIssue.key;
  const summary = jiraIssue.fields?.summary || 'Untitled Jira issue';
  const issueHeading = buildIssueHeading(issueKey, summary);
  const descriptionMarkdown = adfToMarkdown(jiraIssue.fields?.description);
  const footer = '_Synced from Jira by Forge when this pull request was connected to the issue._';
  const commentBody = [marker, issueHeading, descriptionMarkdown, footer].join('\n\n');

  return truncateGitHubComment(commentBody);
}

function buildIssueHeading(issueKey, summary) {
  const escapedSummary = escapeMarkdownText(summary);
  const jiraSiteUrl = normalizeJiraSiteUrl(process.env.JIRA_SITE_URL);

  if (!jiraSiteUrl) {
    return `### ${issueKey}: ${escapedSummary}`;
  }

  return `### [${issueKey}](${jiraSiteUrl}/browse/${encodeURIComponent(issueKey)}): ${escapedSummary}`;
}

function normalizeJiraSiteUrl(rawSiteUrl) {
  if (!rawSiteUrl) {
    return undefined;
  }

  return rawSiteUrl.replace(/\/+$/, '');
}

function truncateGitHubComment(commentBody) {
  if (commentBody.length <= MAX_GITHUB_COMMENT_BODY_LENGTH) {
    return commentBody;
  }

  const truncationNotice = '\n\n_The Jira description was truncated because GitHub comments have a size limit._';
  return `${commentBody.slice(
    0,
    MAX_GITHUB_COMMENT_BODY_LENGTH - truncationNotice.length
  )}${truncationNotice}`;
}

function buildCommentMarker(issueKey) {
  return `${COMMENT_MARKER_PREFIX}${issueKey} -->`;
}

function adfToMarkdown(adfDocument) {
  if (!adfDocument) {
    return '_No Jira description was provided._';
  }

  if (typeof adfDocument === 'string') {
    return adfDocument.trim() || '_No Jira description was provided._';
  }

  const renderedMarkdown = renderAdfBlocks(adfDocument.content || []).trim();
  return renderedMarkdown || '_No Jira description was provided._';
}

function renderAdfBlocks(nodes, context = {}) {
  return nodes
    .map((node) => renderAdfBlock(node, context))
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

function renderAdfBlock(node, context = {}) {
  if (!node) {
    return '';
  }

  switch (node.type) {
    case 'blockquote':
      return prefixLines(renderAdfBlocks(node.content || [], context), '> ');
    case 'bulletList':
      return renderAdfList(node, { ...context, ordered: false });
    case 'codeBlock':
      return renderAdfCodeBlock(node);
    case 'doc':
      return renderAdfBlocks(node.content || [], context);
    case 'heading':
      return renderAdfHeading(node);
    case 'orderedList':
      return renderAdfList(node, { ...context, ordered: true });
    case 'panel':
      return renderAdfBlocks(node.content || [], context);
    case 'paragraph':
      return renderAdfInlineContent(node.content || []);
    case 'rule':
      return '---';
    case 'table':
      return renderAdfTable(node);
    default:
      /*
       * Jira descriptions can include ADF nodes this app does not explicitly
       * format. Flattening their children keeps the important text visible in
       * GitHub instead of dropping content because of an unfamiliar node type.
       */
      return renderAdfBlocks(node.content || [], context);
  }
}

function renderAdfHeading(node) {
  const level = Math.min(Math.max(node.attrs?.level || 3, 1), 6);
  const headingText = renderAdfInlineContent(node.content || []);
  return `${'#'.repeat(level)} ${headingText}`;
}

function renderAdfList(node, context) {
  const depth = context.depth || 0;
  const startOrder = node.attrs?.order || 1;

  return (node.content || [])
    .map((listItem, index) => {
      const marker = context.ordered ? `${startOrder + index}.` : '-';
      return renderAdfListItem(listItem, marker, depth);
    })
    .filter(Boolean)
    .join('\n');
}

function renderAdfListItem(listItem, marker, depth) {
  const indent = '  '.repeat(depth);
  const nestedIndent = '  '.repeat(depth + 1);
  const renderedChildren = (listItem.content || [])
    .map((child) => {
      if (child.type === 'bulletList') {
        return renderAdfList(child, { ordered: false, depth: depth + 1 });
      }

      if (child.type === 'orderedList') {
        return renderAdfList(child, { ordered: true, depth: depth + 1 });
      }

      return renderAdfBlock(child, { depth: depth + 1 });
    })
    .filter(Boolean);

  if (renderedChildren.length === 0) {
    return `${indent}${marker}`;
  }

  const firstChild = renderedChildren[0].replace(/\n/g, `\n${nestedIndent}`);
  const remainingChildren = renderedChildren
    .slice(1)
    .map((child) => `${nestedIndent}${child.replace(/\n/g, `\n${nestedIndent}`)}`);

  return [`${indent}${marker} ${firstChild}`, ...remainingChildren].join('\n');
}

function renderAdfCodeBlock(node) {
  const language = node.attrs?.language || '';
  const codeText = extractPlainText(node).replace(/```/g, '`` `');
  return `\`\`\`${language}\n${codeText}\n\`\`\``;
}

function renderAdfTable(node) {
  const rows = (node.content || []).map((row) => {
    return (row.content || []).map((cell) => {
      const cellMarkdown = renderAdfBlocks(cell.content || [])
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();

      return cellMarkdown || ' ';
    });
  });

  if (rows.length === 0) {
    return '';
  }

  const header = rows[0];
  const divider = header.map(() => '---');
  const bodyRows = rows.slice(1);
  const markdownRows = [header, divider, ...bodyRows];

  return markdownRows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderAdfInlineContent(nodes) {
  return nodes.map(renderAdfInlineNode).join('');
}

function renderAdfInlineNode(node) {
  if (!node) {
    return '';
  }

  switch (node.type) {
    case 'emoji':
      return node.attrs?.shortName || '';
    case 'hardBreak':
      return '\n';
    case 'inlineCard':
      return node.attrs?.url || '';
    case 'mention':
      return escapeMarkdownText(node.attrs?.text || 'mentioned user');
    case 'text':
      return applyMarks(escapeMarkdownText(node.text || ''), node.marks || []);
    default:
      return renderAdfInlineContent(node.content || []);
  }
}

function applyMarks(markdownText, marks) {
  return marks.reduce((markedText, mark) => {
    switch (mark.type) {
      case 'code':
        return `\`${markedText.replace(/`/g, '\\`')}\``;
      case 'em':
        return `_${markedText}_`;
      case 'link':
        return `[${markedText}](${mark.attrs?.href || ''})`;
      case 'strike':
        return `~~${markedText}~~`;
      case 'strong':
        return `**${markedText}**`;
      case 'subsup':
        return mark.attrs?.type === 'sub' ? `<sub>${markedText}</sub>` : `<sup>${markedText}</sup>`;
      default:
        return markedText;
    }
  }, markdownText);
}

function extractPlainText(node) {
  if (!node) {
    return '';
  }

  if (node.type === 'text') {
    return node.text || '';
  }

  return (node.content || []).map(extractPlainText).join('');
}

function escapeMarkdownText(text) {
  return text.replace(/[\\`*_{}[\]()#+.!|>-]/g, '\\$&');
}

function prefixLines(text, prefix) {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function encodePathSegment(pathSegment) {
  return encodeURIComponent(pathSegment);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    contentType: 'application/json',
    body: JSON.stringify(body)
  };
}
