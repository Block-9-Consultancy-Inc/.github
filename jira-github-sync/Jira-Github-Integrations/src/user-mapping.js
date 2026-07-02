import {
  GITHUB_USERNAME_TO_JIRA_ACCOUNT_ID,
  JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME
} from './github-user-mapping.js';
import { githubRequestJson } from './github-client.js';

export async function findGitHubUsernamesForJiraUsers(jiraUsers) {
  const githubUsernames = [];

  for (const jiraUser of jiraUsers) {
    const githubUsername = await findGitHubUsernameForJiraUser(jiraUser);

    if (githubUsername && !githubUsernames.some((username) => username === githubUsername)) {
      githubUsernames.push(githubUsername);
    }
  }

  return githubUsernames;
}

export async function findGitHubUsernameForJiraUser(jiraUser) {
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

  if (!process.env.GITHUB_TOKEN) {
    console.info('Skipped Jira user email lookup because personal token fallback is not configured.', {
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

export function findMappedGitHubUsernameForJiraUser(jiraUser) {
  const accountId = jiraUser?.accountId;

  if (!accountId) {
    return undefined;
  }

  const mappedUsername = JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME[accountId]?.trim();

  if (!mappedUsername) {
    return undefined;
  }

  return mappedUsername;
}

export function findJiraAccountIdForGitHubUsername(githubUsername) {
  if (!githubUsername) {
    return undefined;
  }

  return GITHUB_USERNAME_TO_JIRA_ACCOUNT_ID[githubUsername.toLowerCase()];
}

export function getJiraUsersFromField(fieldValue) {
  if (!fieldValue) {
    return [];
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue.filter(Boolean);
  }

  return [fieldValue];
}
