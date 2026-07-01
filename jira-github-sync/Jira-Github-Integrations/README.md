# Jira Description to GitHub PR Comment

This Forge app exposes a GitHub webhook endpoint. When a GitHub pull request is
opened, reopened, edited, updated with new commits, or marked ready for review,
the app looks for a Jira issue key in the PR title or source branch. If it finds
an issue key, it loads that Jira issue and adds the Jira description as a GitHub
PR comment.

This intentionally treats the Jira issue key as the connection signal. That
matches the common Jira/GitHub development-linking workflow and avoids polling
Jira development metadata.

For a whole Jira project and all repositories in a GitHub organization, configure
`JIRA_PROJECT_KEYS` with the Jira project key for that project and configure the
webhook at the GitHub organization level instead of one repository at a time.

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

- `GITHUB_TOKEN` must be able to read issue comments and create issue comments
  on the target repository. GitHub uses issue comments for pull request
  conversation comments.
- `GITHUB_WEBHOOK_SECRET` must match the secret configured on the GitHub webhook.
- `GITHUB_ORGANIZATION` restricts accepted webhook traffic to one GitHub
  organization. This is recommended when using a GitHub organization webhook.
- `JIRA_PROJECT_KEYS` restricts matches to specific Jira project keys. If unset,
  any key matching `ABC-123` style Jira syntax can be used.
- `JIRA_SITE_URL` is only used to link the heading in the GitHub comment back to
  Jira.

Forge environment variable changes take effect after redeploying the app.

## Deploy and install

```sh
forge deploy --non-interactive --e development
forge install --non-interactive --site <site-url> --product jira --environment development
```

If you add or change scopes later, deploy first and then run `forge install` with
`--upgrade`.

## Create the GitHub webhook URL

After the app is installed, create a web trigger URL:

```sh
forge webtrigger create
```

Choose the installed site and the `github-pull-request-webhook` module.

## Configure GitHub

In the GitHub organization settings, create a webhook:

- Payload URL: the Forge web trigger URL
- Content type: `application/json`
- Secret: the same value used for `GITHUB_WEBHOOK_SECRET`
- Event: `Pull requests`

The app ignores all GitHub events except `pull_request`. An organization webhook
lets one Forge endpoint receive pull request events for every repository in the
GitHub organization.

## Validation

Run the local checks before deploying:

```sh
npm run lint
forge lint
```
