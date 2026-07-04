import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJiraIssueKeys,
  findJiraIssueKeyForPushCommit,
  findJiraIssueKeyInTextSources,
  parseAllowedProjectKeys
} from '../src/issue-key.js';
import {
  buildDescriptionMarker,
  buildGitHubDescriptionComment,
  buildMirroredCommentMarker,
  buildMirroredJiraCommentFromGitHubPullRequestDescription,
  buildPullRequestLifecycleComment,
  buildPullRequestLifecycleMarker,
  buildPullRequestDescriptionMarker,
  containsAnySyncMarker
} from '../src/comment-format.js';
import { adfToMarkdown, markdownToSimpleAdf } from '../src/markdown.js';
import { stableHash, syncStateKeys } from '../src/sync-state.js';
import { isHumanGitHubUser } from '../src/github-webhook.js';
import { isOpenGitHubPullRequest } from '../src/sync-service.js';

test('extracts unique Jira issue keys case-insensitively', () => {
  assert.deepEqual(extractJiraIssueKeys('abc-12 ABC-12 DEF-7'), ['ABC-12', 'DEF-7']);
});

test('finds Jira key from allowed projects only', () => {
  const issueKey = findJiraIssueKeyInTextSources({
    allowedProjectKeys: parseAllowedProjectKeys('DEF'),
    textSources: ['ABC-12 title', 'feature/def-34-branch']
  });

  assert.equal(issueKey, 'DEF-34');
});

test('finds Jira key for pushed commits from branch or commit message', () => {
  const previousProjectKeys = process.env.JIRA_PROJECT_KEYS;

  try {
    delete process.env.JIRA_PROJECT_KEYS;

    assert.equal(
      findJiraIssueKeyForPushCommit({
        branchName: 'feature/abc-12-login-sync',
        commitMessage: 'Update login behavior'
      }),
      'ABC-12'
    );
    assert.equal(
      findJiraIssueKeyForPushCommit({
        branchName: 'feature/login-sync',
        commitMessage: 'DEF-34 Update login behavior'
      }),
      'DEF-34'
    );
  } finally {
    if (previousProjectKeys === undefined) {
      delete process.env.JIRA_PROJECT_KEYS;
    } else {
      process.env.JIRA_PROJECT_KEYS = previousProjectKeys;
    }
  }
});

test('builds and detects sync markers', () => {
  assert.equal(buildDescriptionMarker('ABC-12'), '<!-- jira-description-sync:ABC-12 -->');
  assert.equal(buildMirroredCommentMarker('github', '1'), '<!-- jira-github-comment-sync:github:1 -->');
  assert.equal(
    buildPullRequestDescriptionMarker({ owner: 'owner', repo: 'repo', pullRequestNumber: 5 }),
    '<!-- jira-github-pr-description-sync:owner/repo:5 -->'
  );
  assert.equal(
    buildPullRequestLifecycleMarker({
      owner: 'owner',
      repo: 'repo',
      pullRequestNumber: 5,
      lifecycleAction: 'merged'
    }),
    '<!-- jira-github-pr-lifecycle-sync:owner/repo:5:merged -->'
  );
  assert.equal(containsAnySyncMarker('hello'), false);
  assert.equal(containsAnySyncMarker('<!-- jira-github-comment-sync:jira:2 -->'), true);
  assert.equal(containsAnySyncMarker('<!-- jira-github-pr-description-sync:owner/repo:1 -->'), true);
  assert.equal(containsAnySyncMarker('<!-- jira-github-pr-lifecycle-sync:owner/repo:1:closed -->'), true);
  assert.equal(containsAnySyncMarker('<!-- jira-github-review-summary-sync:owner/repo:1 -->'), true);
});

test('identifies human GitHub comment authors', () => {
  assert.equal(isHumanGitHubUser({ login: 'b9-mourud', type: 'User' }), true);
  assert.equal(isHumanGitHubUser({ login: 'coderabbitai[bot]', type: 'Bot' }), false);
  assert.equal(isHumanGitHubUser({ login: 'github-actions[bot]', type: 'Bot' }), false);
  assert.equal(isHumanGitHubUser(undefined), false);
});

test('identifies active GitHub pull requests', () => {
  assert.equal(isOpenGitHubPullRequest({ number: 12, state: 'open' }), true);
  assert.equal(isOpenGitHubPullRequest({ number: 11, state: 'closed' }), false);
  assert.equal(isOpenGitHubPullRequest(undefined), false);
});

test('renders a managed Jira description comment', () => {
  const body = buildGitHubDescriptionComment({
    jiraIssue: {
      key: 'ABC-12',
      fields: {
        summary: 'Fix sync',
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Mirror this' }]
            }
          ]
        }
      }
    }
  });

  assert.match(body, /jira-description-sync:ABC-12/);
  assert.match(body, /Mirror this/);
  assert.match(body, /managed comment/);
});

test('renders a mirrored GitHub PR description Jira comment', () => {
  const body = buildMirroredJiraCommentFromGitHubPullRequestDescription({
    pullRequest: {
      body: 'This PR changes sync behavior.',
      html_url: 'https://github.com/owner/repo/pull/5',
      user: { login: 'b9-mourud' }
    },
    owner: 'owner',
    repo: 'repo',
    pullRequestNumber: 5
  });

  assert.match(body, /jira-github-pr-description-sync:owner\/repo:5/);
  assert.match(body, /This PR changes sync behavior\./);
  assert.match(body, /GitHub PR description/);
  assert.match(body, /https:\/\/github.com\/owner\/repo\/pull\/5/);
});

test('renders GitHub PR lifecycle Jira comments', () => {
  const body = buildPullRequestLifecycleComment({
    pullRequest: {
      title: 'ABC-12 Add lifecycle comments',
      html_url: 'https://github.com/owner/repo/pull/5',
      user: { login: 'b9-mourud' }
    },
    owner: 'owner',
    repo: 'repo',
    pullRequestNumber: 5,
    lifecycleAction: 'merged',
    actor: 'reviewer'
  });

  assert.match(body, /GitHub pull request merged: ABC-12 Add lifecycle comments/);
  assert.match(body, /Repository: owner\/repo/);
  assert.match(body, /Actor: @reviewer/);
  assert.match(body, /jira-github-pr-lifecycle-sync:owner\/repo:5:merged/);
});

test('converts basic ADF to Markdown', () => {
  const markdown = adfToMarkdown({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Heading' }]
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Body', marks: [{ type: 'strong' }] }]
      }
    ]
  });

  assert.equal(markdown, '## Heading\n\n**Body**');
});

test('converts Markdown text to simple Jira ADF paragraphs', () => {
  const adf = markdownToSimpleAdf('one\n\nOriginal: https://example.com/review');

  assert.equal(adf.type, 'doc');
  assert.equal(adf.content.length, 3);
  assert.deepEqual(adf.content[0].content[0], { type: 'text', text: 'one' });
  assert.deepEqual(adf.content[2].content[1], {
    type: 'text',
    text: 'https://example.com/review',
    marks: [
      {
        type: 'link',
        attrs: {
          href: 'https://example.com/review'
        }
      }
    ]
  });
});

test('uses stable KVS keys and stable hashes', () => {
  assert.equal(syncStateKeys.issueLinks('ABC-12'), 'issue-links:QUJDLTEy');
  assert.equal(
    syncStateKeys.pullRequestIssueLink('owner', 'repo', 5),
    'pull-request-issue-link:b3duZXI:cmVwbw:NQ'
  );
  assert.equal(
    syncStateKeys.descriptionComment('ABC-12', 'owner', 'repo', 5),
    'description-comment:QUJDLTEy:b3duZXI:cmVwbw:NQ'
  );
  assert.equal(
    syncStateKeys.pullRequestDescriptionComment('ABC-12', 'owner', 'repo', 5),
    'pull-request-description-comment:QUJDLTEy:b3duZXI:cmVwbw:NQ'
  );
  assert.equal(
    syncStateKeys.commentMap('github', 'owner/repo/123'),
    'comment-map:Z2l0aHVi:b3duZXIvcmVwby8xMjM'
  );
  assert.equal(
    syncStateKeys.commitAnnouncement('owner', 'repo', 'abc123'),
    'commit-announcement:b3duZXI:cmVwbw:YWJjMTIz'
  );
  assert.equal(
    syncStateKeys.reviewNotification('owner', 'repo', 'review-comment', '99'),
    'review-notification:b3duZXI:cmVwbw:cmV2aWV3LWNvbW1lbnQ:OTk'
  );
  assert.equal(
    syncStateKeys.pullRequestLifecycleNotification('owner', 'repo', 5, 'merged'),
    'pull-request-lifecycle-notification:b3duZXI:cmVwbw:NQ:bWVyZ2Vk'
  );
  assert.equal(
    syncStateKeys.reviewSummaryComment('ABC-12', 'owner', 'repo', 5),
    'review-summary-comment:QUJDLTEy:b3duZXI:cmVwbw:NQ'
  );
  assert.equal(
    syncStateKeys.reviewSummaryLock('ABC-12', 'owner', 'repo', 5),
    'review-summary-lock:QUJDLTEy:b3duZXI:cmVwbw:NQ'
  );
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }));
});
