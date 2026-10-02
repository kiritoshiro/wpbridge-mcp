# Repository automation

- **Bridge checks** runs JavaScript syntax checks, GPT instruction-size validation, 114 automated tests, and OpenAPI parity checks on Node 20/22/24 on Linux and Windows. It also lints all four WordPress PHP helpers.
- **Debug tests** is a manual workflow with focused MCP, site-control, and editorial suites. It enables Node stack traces and points to the failed step logs.
- **Failure triage** runs after a failed or timed-out Bridge checks, Security and workflow checks, or CodeQL run. It summarizes failed jobs and links to the source run without checking out or executing its code.
- **Security and workflow checks** scans full Git history with Gitleaks, validates Actions with actionlint, and audits npm dependencies. It runs on pushes, pull requests, Mondays, and manual dispatch.
- **CodeQL** scans JavaScript/TypeScript and GitHub Actions workflows on pushes, pull requests, Tuesdays, and manual dispatch.
- **Dependabot** opens weekly update PRs for pinned GitHub Actions and npm dependencies. Updates are reviewed normally; they are not automatically merged.

To debug a failure, open the failed Actions run and its step logs. Then run **Debug tests** manually and choose the affected suite. For runner-level diagnostics, temporarily set the repository variable `ACTIONS_STEP_DEBUG` to `true` and rerun.

The workflows do not use production WordPress credentials or deploy to live sites. Tests use simulated WordPress responses. Checkout credentials are not retained. The CodeQL job has only the additional permission needed to upload code-scanning results; other workflows use read-only repository permissions. Scanner releases and third-party actions are pinned to immutable commits or verified checksums.
