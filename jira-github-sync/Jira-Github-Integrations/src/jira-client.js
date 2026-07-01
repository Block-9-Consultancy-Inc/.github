import api, { route } from '@forge/api';
import { JIRA_REVIEWERS_FIELD_ID } from './config.js';
import { adfToMarkdown, markdownToSimpleAdf } from './markdown.js';

export async function getJiraIssue(issueKey) {
  const response = await api
    .asApp()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,description,assignee,${JIRA_REVIEWERS_FIELD_ID}`
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

export async function updateJiraAssignee(issueKey, jiraAccountId) {
  await updateJiraIssueFields(issueKey, {
    assignee: jiraAccountId ? { accountId: jiraAccountId } : null
  });
}

export async function updateJiraReviewers(issueKey, jiraAccountIds) {
  await updateJiraIssueFields(issueKey, {
    [JIRA_REVIEWERS_FIELD_ID]: jiraAccountIds.map((accountId) => ({ accountId }))
  });
}

export async function updateJiraIssueFields(issueKey, fields) {
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      /*
       * Forge Jira events include this value in webhookTraceValue. That gives
       * logs a way to connect a Jira event back to the API call that caused it.
       * The trigger ignoreSelf filter is still the primary loop guard.
       */
      'X-Atlassian-Webhook-Trace': `forge-jira-github-sync-${Date.now()}`
    },
    body: JSON.stringify({ fields })
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jira issue update failed for ${issueKey}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }
}

export async function addJiraComment({ issueKey, body }) {
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Atlassian-Webhook-Trace': `forge-jira-github-sync-${Date.now()}`
    },
    body: JSON.stringify({
      body: markdownToSimpleAdf(body)
    })
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jira comment creation failed for ${issueKey}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  return JSON.parse(responseBody);
}

export async function updateJiraComment({ issueKey, commentId, body }) {
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}/comment/${commentId}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Atlassian-Webhook-Trace': `forge-jira-github-sync-${Date.now()}`
      },
      body: JSON.stringify({
        body: markdownToSimpleAdf(body)
      })
    });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jira comment update failed for ${issueKey}/${commentId}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  return JSON.parse(responseBody);
}

export async function getJiraComment({ issueKey, commentId }) {
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}/comment/${commentId}`);
  const responseBody = await response.text();

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `Jira comment lookup failed for ${issueKey}/${commentId}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  return JSON.parse(responseBody);
}

export async function findJiraCommentContaining({ issueKey, marker }) {
  /*
   * KVS stores the managed comment ID, but Jira itself is the durable source of
   * truth for comments. Searching by marker lets the app recover if KVS was
   * empty or two webhook deliveries raced before the ID was stored.
   */
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}/comment?maxResults=100&orderBy=created`);
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jira comment search failed for ${issueKey}: ${response.status} ${response.statusText} ${responseBody}`
    );
  }

  const result = JSON.parse(responseBody);
  return (result.comments || []).find((comment) => {
    return adfToMarkdown(comment.body).includes(marker);
  });
}
