# Shared Pi extensions

Verified with Pi 0.99.1 on macOS and Pi 1.0.0 on Linux. CLIProxy transport discovers the running Pi installation and rejects unverified versions. Keep `pi` on PATH when running tests outside the CLI. Do not copy a macOS `node_modules` directory to Linux.

`settings.json` selects the configured `cliproxy` provider. Its device-local `models.json` must retain the existing proxy URL, API key source and model definitions, with provider API `openai-codex-responses`. Credentials and generated npm dependencies are intentionally excluded from Git.

For the remote headless installation, preserve Linux-specific disabled extensions, existing reviewer configuration, learned approval rules, sessions and connector credentials. The remote Pi 1.0.0 runtime and newer extension packages do not need to be downgraded to the Mac's versions.

- `search` is the default entry point for paths, content, web and library docs. Native backend options remain available under `options`.
- Subagent supervision sends actionable steering notifications. Interrupted persisted children require explicit `parallel_agents_control` action `resume`, selected `agents`, and a continuation `message`; recovery never repeats work automatically.
- Todo mutations return deltas and checkpoint restoration retains active requirements.
- Transport fallback is visible and stops retrying once response output begins.

Runnable checks are documented in [`lib/tests/README.md`](lib/tests/README.md).
