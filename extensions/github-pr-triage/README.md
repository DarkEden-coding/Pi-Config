# GitHub PR triage extension

Provides one compact `github_pr_triage` tool backed by the authenticated GitHub CLI.

Actions:

- `inspect`: PR summary/checks by default. Request `comments` or `threads` explicitly and filter with `botLogins`, `commentIds`, or `threadIds`.
- `poll`: wait for terminal checks and selected bot signals.
- `reply`: reply to one inline review comment.
- `resolve`: resolve selected review thread IDs.
- `check_logs`: return failed logs for a workflow run.
- `rerun_check`: rerun failed jobs in a workflow run.

Examples:

```json
{"action":"inspect","pr":139,"sections":["threads"],"botLogins":["macroscopeapp"],"unresolvedOnly":true,"includeBodies":true}
```

```json
{"action":"resolve","pr":139,"threadIds":["PRRT_..."]}
```

The current GitHub repository is used unless `repo` is supplied as `owner/repo`. Run `gh auth status` if authentication fails.
