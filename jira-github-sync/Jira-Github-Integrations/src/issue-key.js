import { JIRA_ISSUE_KEY_PATTERN } from './config.js';

export function findJiraIssueKey(pullRequest) {
  const allowedProjectKeys = parseAllowedProjectKeys(process.env.JIRA_PROJECT_KEYS);
  return findJiraIssueKeyInTextSources({
    allowedProjectKeys,
    textSources: [
      pullRequest?.title,
      pullRequest?.head?.ref
    ]
  });
}

export function findJiraIssueKeyInTextSources({ allowedProjectKeys, textSources }) {
  /*
   * The PR title or branch name is the contract that connects GitHub to Jira.
   * This avoids accidentally syncing a PR because someone mentioned an issue key
   * in a comment, description, or commit message.
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

export function parseAllowedProjectKeys(rawProjectKeys) {
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

export function extractJiraIssueKeys(text) {
  if (!text) {
    return [];
  }

  const issueKeys = text.match(JIRA_ISSUE_KEY_PATTERN) || [];
  return [...new Set(issueKeys.map((issueKey) => issueKey.toUpperCase()))];
}
