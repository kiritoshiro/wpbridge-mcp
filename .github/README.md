# Repository automation

- **Bridge checks** runs the tests, JavaScript syntax checks, and OpenAPI route parity checks on Node 20/22/24 on Linux and Windows, plus PHP helper syntax validation.
- **Security and workflow checks** scans full Git history with Gitleaks (findings are redacted), checks GitHub Actions expressions and shell scripts with actionlint, and fails on npm advisories of moderate severity or higher. It runs on pushes, pull requests, Mondays, and manual dispatch.
- **Dependabot** opens weekly update PRs for pinned GitHub Actions and npm dependencies. Updates are reviewed normally; they are not automatically merged.

Actions have read-only repository permissions and checkout credentials are not retained. Scanner releases are version-pinned and checked against their upstream SHA-256 manifests; update both the version and filenames together in security.yml. Dependabot does not update these scanner shell commands.

No production WordPress credentials are needed. Tests use simulated WordPress responses. These checks do not deploy the bridge or validate a live WordPress installation. CodeQL is not configured because private repositories require an eligible GitHub Code Security setup.
