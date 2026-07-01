# PR-Linked Jira/GitHub Sync

This Forge app keeps selected Jira issue fields and GitHub pull request details
in sync when a PR is connected to Jira by issue key. A PR is connected when the
Jira issue key appears in the PR title or source branch name.

The app is intentionally PR-linked. It does not create GitHub Issues for Jira
issues, and Jira-originated events only sync to PRs the app has already seen
from GitHub webhooks.

## What syncs

- Jira description -> one managed GitHub PR conversation comment.
- Jira assignee <-> GitHub PR assignee.
- Jira reviewer field `customfield_10251` <-> GitHub requested reviewers.
- New Jira issue comments -> top-level GitHub PR conversation comments.
- New top-level GitHub PR conversation comments -> Jira issue comments.
- New GitHub PR commits -> Jira comments that identify the commit author.
- GitHub PR reviews -> one Jira comment per submitted review, including the line comments in that review.
- Resolved GitHub review threads -> separate Jira resolution comments.

Comment edits and deletes are intentionally out of scope for this version.
Each submitted GitHub review becomes one Jira comment. Line-level comments that
belong to that review are grouped into the same Jira comment. Resolved review
threads create separate Jira comments. These generated Jira comments include sync
markers so they are not mirrored back to GitHub as normal Jira comments.

Commit announcements are created from GitHub pull request `opened` and
`synchronize` events. The GitHub webhook event named `Commit comments` is not
required for this; that event is only for comments left on commits or diffs.

## How loops are avoided

The app stores sync bookkeeping in Forge KVS:

- known Jira issue -> GitHub PR links
- managed description comment IDs
- mirrored comment source/target IDs
- field hashes and timestamps for last-write-wins behavior

Mirrored comments also include visible source footers and hidden sync markers.
These markers make synced comments easy to inspect and give the app a fallback
way to skip comments it created itself.

## Required configuration

Set these Forge environment variables before deploying:

```sh
forge variables set --encrypt GITHUB_TOKEN <github-token>
forge variables set --encrypt GITHUB_WEBHOOK_SECRET <shared-webhook-secret>
```

Optional variables:

```sh
forge variables set GITHUB_ORGANIZATION your-github-org
forge variables set JIRA_PROJECT_KEYS ABC,DEF
forge variables set JIRA_SITE_URL https://your-site.atlassian.net
```

- `GITHUB_TOKEN` must be able to read and write issue comments, assign issues,
  request pull request reviewers, and search GitHub users.
- `GITHUB_WEBHOOK_SECRET` must match the secret configured on the GitHub webhook.
- `GITHUB_ORGANIZATION` restricts accepted webhook traffic to one GitHub
  organization.
- `JIRA_PROJECT_KEYS` restricts issue-key matches to specific Jira project keys.
  If unset, any key matching `ABC-123` style Jira syntax can be used.
- `JIRA_SITE_URL` is used to link synced comments back to Jira.

Forge environment variable changes take effect after redeploying the app.

## User mapping

User sync depends on `src/github-user-mapping.js`.

The map is keyed by Jira account ID and stores the matching GitHub username. The
app derives the reverse GitHub username -> Jira account ID map from the same
file for GitHub-to-Jira assignee and reviewer sync.

If no local mapping exists, Jira-to-GitHub sync attempts an email search in
GitHub when Jira exposes the user's email address. GitHub-to-Jira sync requires
the local mapping.

## GitHub webhook

Create a Forge webtrigger URL:

```sh
forge webtrigger create
```

Choose the installed site and the `github-pull-request-webhook` module.

In the GitHub organization settings, create a webhook:

- Payload URL: the Forge webtrigger URL
- Content type: `application/json`
- Secret: the same value used for `GITHUB_WEBHOOK_SECRET`
- Events: `Pull requests`, `Issue comments`, `Pull request reviews`,
  `Pull request review comments`, and `Pull request review threads`

The app ignores `issue_comment` events that are not attached to a pull request.

## Deploy and install

This app uses Jira write scopes and Forge KVS storage. After changing scopes or
storage permissions, deploy first and then upgrade the installation:

```sh
forge deploy --non-interactive -e development
forge install --non-interactive --upgrade --site <site-url> --product jira --environment development
```

For a first install, omit `--upgrade`.

## Validation

Run the local checks before deploying:

```sh
npm test
npm run lint
forge lint
```
