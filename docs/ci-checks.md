# CI checks

## WordPress checks and link checking (2026-10-06)

`wordpress-checks.yml` runs on pull requests and pushes to the default branch, and on demand.
- **Plugin Check**: WordPress's official [Plugin Check](https://github.com/WordPress/plugin-check-action), in a throwaway WordPress (wp-env).
  - It runs the general, security, performance and accessibility categories. Errors fail the job; warnings show as annotations.
  - The `plugin_repo` category is left out. It holds WordPress.org listing rules (for example "no own updater"), and this plugin is self-hosted.
  - The `slug` is the text domain, so translation calls are checked against it.
- **Playground smoke test**: `.github/playground/smoke.py` boots [WordPress Playground](https://wordpress.github.io/wordpress-playground/) on each PHP version in the matrix and activates the plugin. It adds a fixture page, logs in, and loads the front end and every wp-admin menu page. It fails on:
  - activation errors;
  - pages that don't answer 200;
  - a PHP error or the critical-error screen on a page;
  - any PHP error, warning, notice or deprecation in `debug.log` from this repository's code.

  The site, its database and its admin account exist only inside the job. To run it locally (needs Node 24 with npx, and Python 3): `python3 .github/playground/smoke.py --php 8.4`. Settings are in `.github/playground/config.json`.
- **Links**: `links.yml` checks the links in Markdown and `readme.txt` files with [lychee](https://github.com/lycheeverse/lychee). It runs on pull requests that change them, monthly and on demand. It is not part of the security gate, because a third-party site being down should not block a merge. Exclusions are in `.lychee.toml`; adventistai.lt is excluded because its Cloudflare bot protection answers GitHub runners with 403.
