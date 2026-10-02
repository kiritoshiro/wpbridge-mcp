# WPBridge MCP and plugin setup

This repository contains three new parts: `mcp/` (the multi-site MCP gateway), `plugins/wpbridge/` (the Codex/ChatGPT workflow package), and `wordpress/wpbridge-control/` (a WordPress companion for selected site settings and plugin updates). The existing bridge remains the editorial engine. Each site has its own running bridge instance, keys, WordPress accounts, and enabled actions.

## 1. Install the code

On the `feature/mcp-plugin-gateway` branch, run `npm ci`. Set `PUBLIC_BASE_URL` to your intended HTTPS bridge origin (for example `$env:PUBLIC_BASE_URL="https://wpbridge.site-one.example"` in PowerShell), then run `npm run ci`. The plugin's `.mcp.json` points to the current local checkout path; edit its `args[0]` if the repository moves. Do not commit `.env` files or `mcp/sites.local.json`.

Run a separate bridge instance for each enrolled site and verify its configuration before enabling site control.

## 2. Configure each WordPress site and bridge

For editorial access, use the existing WPBridge setup: a dedicated WordPress user with an Application Password, `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`, and `BRIDGE_API_KEY` in that site's bridge `.env`. Start each bridge separately and check its `/health` endpoint locally.

To use site control, install the `wordpress/wpbridge-control` folder as a WordPress plugin on that site. Create a separate WordPress administrator or a dedicated account with the required capabilities and give it its own Application Password. Add these values to **that site's bridge** `.env`:

```dotenv
SITE_CONTROL_API_KEY=<new random 32-byte-or-longer secret>
WP_CONTROL_USERNAME=<site-control account username>
WP_CONTROL_APP_PASSWORD=<site-control Application Password>
```

The companion requires `manage_options` for site settings, `activate_plugins` to list plugins, and `update_plugins` to update one. Its site-setting API changes only title, tagline, timezone, and posts per page. It does not install or remove plugins, edit themes/templates/menus, manage users, or provide a site backup. Use a recent restorable backup before plugin updates.

Generate a different random key for every site's editorial bridge, every site's control bridge, and the MCP HTTP endpoint. WPBridge already has `npm run generate-key` for this. Keep the keys out of chat and Git.

## 3. Enroll sites in MCP

Copy `mcp/sites.example.json` to `mcp/sites.local.json`. Copy `mcp/.env.example` to `mcp/.env`. Both destination files are Git ignored.

For each site, set `id` (the name used in tool calls), fixed loopback `bridge_url`, `bridge_key_env`, and its permissions. Put the matching **editorial bridge key** in the named variable in `mcp/.env`. For a site with `site_read`, `site_settings`, or `plugin_updates`, also set `control_key_env` and its matching **site-control key**. The gateway refuses non-loopback bridge URLs and missing keys.

`allowed_actions` is optional. If present, it is an additional action allowlist. If omitted, the site's permission classes decide which WPBridge actions are available. Available classes are `read`, `editorial`, `publish`, `site_read`, `site_settings`, and `plugin_updates`. The existing bridge's `ALLOW_PUBLISH` and `ALLOW_LIVE_EDITS` switches still apply. To revoke one site immediately, remove its entry and restart the MCP process; rotate its keys if they may have been exposed.

The sample configuration is intentionally narrow. Add site permissions and actions only after testing that site. `list_sites` returns IDs and permission classes without secrets.

## 4. Run and connect locally

`npm run mcp` starts an MCP server over stdio. In Codex, open this repository and install `wpbridge` from its local repository marketplace (`.agents/plugins/marketplace.json`), or configure an MCP server whose command is `node` and whose arguments are the absolute path to `mcp/server.js` plus `--stdio`. The package includes a workflow skill and a local `.mcp.json` entry pointing at this checkout. Restart Codex after changing the plugin or site registry.

Run `npm run mcp:http` for a loopback HTTP endpoint at `http://127.0.0.1:8790/mcp`. It requires a 32-character-or-longer `WPBRIDGE_MCP_TOKEN` from `mcp/.env`. This mode is suitable for local MCP clients that can send a Bearer header. The endpoint refuses a non-loopback bind.

Try `list_sites`, then a read action such as `wpbridge_contentRead` with `site_id` and `action: listPosts`. Verify that a disabled action is refused. Test an edit with a draft and a fresh preview token before enabling publishing or maintenance.

## 5. Connect ChatGPT Work remotely

ChatGPT needs a stable HTTPS MCP URL and OAuth 2.1; it cannot send an arbitrary static API key. Put a TLS reverse proxy or named tunnel in front of the loopback HTTP MCP endpoint. Configure an OAuth provider that supports MCP authorization-code + PKCE and publishes authorization-server metadata and JWKS. Give the provider an API audience for the MCP URL and a `wpbridge:access` scope. Set the following in `mcp/.env`:

```dotenv
WPBRIDGE_MCP_OAUTH_ISSUER=https://issuer.example/
WPBRIDGE_MCP_OAUTH_AUDIENCE=https://mcp.example.com/mcp
WPBRIDGE_MCP_OAUTH_SUBJECT=<exact owner subject claim>
WPBRIDGE_MCP_OAUTH_JWKS_URL=https://issuer.example/.well-known/jwks.json
WPBRIDGE_MCP_PUBLIC_URL=https://mcp.example.com/mcp
```

When `WPBRIDGE_MCP_OAUTH_ISSUER` is set, the gateway validates signature, issuer, audience, exact owner subject, and scope. It serves `/.well-known/oauth-protected-resource` for client discovery. The OAuth provider must support the ChatGPT client registration method in current OpenAI documentation. Register the HTTPS `/mcp` URL in ChatGPT developer mode, complete OAuth, and add the `manage-wordpress` skill from this package to the resulting personal plugin. Do not publish the plugin before testing all required workflows. This repository does not create the external identity-provider account, HTTPS route, or live WordPress credentials.

## 6. Verify and operate

Run `npm run ci`, `php -l wordpress/wpbridge-control/wpbridge-control.php`, and the plugin validator shown below. Test both sites separately. Confirm that a key for one site cannot act on the other, an editor credential cannot use site control, and stale fingerprints or versions are rejected. Review the existing bridge logs and WordPress state after each write. The companion plugin does not provide a backup or rollback for a plugin upgrade.

```powershell
python C:/Users/you/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/wpbridge
```

MCP `upload_attached_media` adapts ChatGPT file inputs to WPBridge's existing attachment uploader. `downloadMedia` currently returns the existing GPT file-response URL as JSON; verify its behavior in the chosen MCP client before relying on a full document round trip. Template, navigation, global-style, plugin installation/removal, and user-management controls remain future work.
