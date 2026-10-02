# WPBridge MCP setup

This repository has three cooperating parts: the per-site WPBridge service, the multi-site MCP gateway in `mcp/`, and the Codex plugin in `plugins/wpbridge/`. The optional `wordpress/wpbridge-control/` companion adds a limited set of site-maintenance actions. Enrolling a site is explicit: a site does not become available just because the plugin is installed. The older Custom GPT bridge can keep running while you test this repository separately.

## 1. Prepare one site

Install Node.js 20 or newer, clone this repository, and run `npm ci` in the checkout. For the existing editorial actions, create a dedicated WordPress user with an Application Password. Copy the root `.env.example` to `.env` and set that site's `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`, and a unique `BRIDGE_API_KEY`. Start the bridge with `npm start` and check its loopback `/health` endpoint. Use a separate checkout/process, port, WordPress account, and keys for each site. Do not copy credentials from another site or from an older bridge automatically.

For optional site control, install `wordpress/wpbridge-control/` as a WordPress plugin on that site. Use a separate account with the required capabilities and add `SITE_CONTROL_API_KEY`, `WP_CONTROL_USERNAME`, and `WP_CONTROL_APP_PASSWORD` to **that site's bridge** `.env`. The companion needs `manage_options` for settings, `activate_plugins` to list plugins, and `update_plugins` to update one plugin. It can change only title, tagline, timezone, and posts per page; it cannot install/remove plugins, edit themes or menus, manage users, or make backups. Take a restorable backup before plugin updates.

## 2. Enroll the site in the MCP gateway

Copy `mcp/sites.example.json` to `mcp/sites.local.json` and `mcp/.env.example` to `mcp/.env`. Both destination files are Git ignored. Give each site a stable `id`, a loopback `bridge_url`, a `bridge_key_env` name, and only the permission classes you want. Put the matching **editorial** `BRIDGE_API_KEY` value in that named variable in `mcp/.env`. For `site_read`, `site_settings`, or `plugin_updates`, also set `control_key_env` and its matching site-control key. The gateway rejects non-loopback bridge URLs and missing keys.

Permission classes are `read`, `editorial`, `publish`, `site_read`, `site_settings`, and `plugin_updates`. An optional `allowed_actions` list narrows actions further. The per-site bridge's `ALLOW_PUBLISH` and `ALLOW_LIVE_EDITS` switches remain in force. To disconnect a site, remove its registry entry and restart MCP; rotate its keys if they may have been exposed. Generate distinct keys with `npm run generate-key`; keep all keys out of Git and chat.

## 3. Connect Codex locally

The Codex plugin launches MCP over stdio. From this checkout, run:

```powershell
npm ci
npm run mcp:configure-local
codex plugin marketplace add .
codex plugin add wpbridge@personal
```

`mcp:configure-local` writes **only the absolute checkout path**, not credentials, to `~/.wpbridge-mcp/local.json` (on Windows, under your user profile). The installed plugin reads this stable per-user file, so it works after Codex copies the plugin into its cache. If you move the checkout, run the configuration command again. A new Codex task loads the installed plugin. If this marketplace was already added, skip `marketplace add`; after changing plugin code, reinstall the plugin and start a new task. This repository marketplace is named `personal`; check the name in `.agents/plugins/marketplace.json` before installing.

To test the gateway without installing the Codex plugin, run `npm run mcp` for stdio. For a local HTTP MCP client, set a random 32-character-or-longer `WPBRIDGE_MCP_TOKEN` in `mcp/.env`, then run `npm run mcp:http`; it listens only on `http://127.0.0.1:8790/mcp` by default. The local token is not a ChatGPT OAuth substitute.

In the client, call `list_sites`, then try `wpbridge_contentRead` with a returned `site_id` and `action: listPosts`. Check that an action absent from `allowed_actions` is refused. Before enabling writes, test a draft and its preview/version checks on one site at a time. Installing the plugin by itself does not start the per-site bridge processes.

## 4. Prepare remote ChatGPT access

Remote access needs two services that this repository does not create: a stable HTTPS address for `/mcp`, and an OAuth 2.1 identity provider. Until both exist, use the local path above and leave OAuth variables unset. Do not point a public tunnel at the old bridge or expose the MCP loopback port directly.

Put a TLS reverse proxy or named HTTPS tunnel in front of the **new** loopback MCP HTTP process. Route only `/mcp` and `/.well-known/oauth-protected-resource` to it. Configure an established identity provider with authorization-code + PKCE S256, authorization-server metadata, a JWKS endpoint, and a client registration method supported by ChatGPT. Its access token must contain the MCP resource as its audience and the `wpbridge:access` scope. Use the exact subject of the owner account that may operate these sites. Set these values in the new checkout's `mcp/.env`:

```dotenv
WPBRIDGE_MCP_OAUTH_ISSUER=https://issuer.example/
WPBRIDGE_MCP_OAUTH_AUDIENCE=https://mcp.example.com/mcp
WPBRIDGE_MCP_OAUTH_SUBJECT=<exact owner subject claim>
WPBRIDGE_MCP_OAUTH_JWKS_URL=https://issuer.example/jwks.json
WPBRIDGE_MCP_PUBLIC_URL=https://mcp.example.com/mcp
```

When OAuth is configured, MCP checks the token signature, issuer, audience, expiration, exact owner subject, and scope for every request. It publishes protected-resource metadata at `/.well-known/oauth-protected-resource` and challenges unauthenticated requests. Verify that an unauthenticated POST to `/mcp` returns 401 and a `WWW-Authenticate` header, and that the metadata resource and issuer match the configured HTTPS URLs. Then register the HTTPS `/mcp` URL in ChatGPT developer mode, complete OAuth, and test `list_sites` and a read action before enabling any write class. Follow the [current OpenAI authentication guide](https://developers.openai.com/plugins/build/auth) for the provider's client registration and callback requirements and the [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for ChatGPT testing. Keep the plugin private until the end-to-end connection is verified.

## 5. Validate and operate

Set `PUBLIC_BASE_URL` to an HTTPS bridge origin and run `npm run ci`. Also run `php -l wordpress/wpbridge-control/wpbridge-control.php` and validate the plugin with `python "$env:USERPROFILE/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/wpbridge`. The automated suite exercises the installed-style stdio launcher, authenticated HTTP transport, gateway routing, and signed OAuth token checks. It does not prove a live WordPress or ChatGPT connection; test each enrolled site separately, including cross-site key isolation and stale preview/version rejection.

`upload_attached_media` adapts ChatGPT file inputs to WPBridge's attachment uploader. `downloadMedia` currently returns a file-response URL as JSON; verify it in your MCP client before relying on a full document round trip. Template, navigation, global-style, plugin installation/removal, and user-management controls remain future work.
