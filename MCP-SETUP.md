# WPBridge MCP setup

This repository has three cooperating parts: the per-site WPBridge service, the multi-site MCP gateway in `mcp/`, and the plugin in `plugins/wpbridge/`, which installs in both Codex and Claude Code. The optional `wordpress/wpbridge-control/` companion adds a limited set of site-maintenance actions. Enrolling a site is explicit: a site does not become available just because the plugin is installed. The older Custom GPT bridge can keep running while you test this repository separately.

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

### Claude Code

The same plugin directory and skill install in Claude Code. Its `.claude-plugin/plugin.json` defines the MCP server with `${CLAUDE_PLUGIN_ROOT}/launcher.mjs`, because Claude Code documents `${CLAUDE_PLUGIN_ROOT}` for plugin server paths but not a plugin-relative `cwd`. That inline server replaces the same-named entry in the Codex `.mcp.json`, which keeps its relative launcher and `cwd`. Both read the same per-user checkout file. From this checkout, run:

```powershell
npm ci
npm run mcp:configure-local
claude plugin marketplace add .
claude plugin install wpbridge@wpbridge-mcp
```

Inside a session, `/plugin marketplace add <path to this checkout>` and `/plugin install wpbridge@wpbridge-mcp` do the same. A marketplace added from a local path loads the plugin in place, so `/reload-plugins` or a new session picks up edits. Enroll sites as in section 2, then start a new session, check `/mcp` for `plugin:wpbridge:wpbridge`, and call `list_sites`. If the server fails to start, run `node plugins/wpbridge/launcher.mjs` in a terminal to see the launcher's message. Check a plugin edit with `claude plugin validate plugins/wpbridge` and `claude plugin validate .`.

### Local media uploads (stdio only)

Codex and Claude Code cannot pass ChatGPT file URLs, so stdio sessions do not offer `upload_attached_media`. To upload a local image, audio file, or PDF, set `WPBRIDGE_MCP_UPLOAD_DIR` in `mcp/.env` to an absolute local folder that holds only files you intend to upload. The stdio server then offers `upload_local_media`, which takes a path relative to that folder (for example `photos/header.png`; absolute paths are refused) and an idempotency key and sends the bytes through the existing `uploadMedia` action, so the site needs the `editorial` permission and, if it uses `allowed_actions`, `uploadMedia`. The gateway refuses paths outside the folder, including absolute paths, `..`, symlink and junction escapes (checked on the exact-case canonical path), UNC and device paths, hard-linked files, FIFOs and other non-regular files, and files over 30 MB, before it reads them; the bridge still checks type, signature, and its own `MAX_MEDIA_BYTES`. Uploads run one at a time per server process; a second call waits for the first to finish. The tool is never offered over HTTP.

The upload folder must not be writable by untrusted users or processes. The gateway re-checks the file's identity and location after opening it, but path-based checks cannot fully close a race against someone who can swap files or folders while an upload is opened, and Windows has no no-follow open. Use a folder only you can write to, and do not point it at a shared, synced, or downloads folder.

To test the gateway without installing the Codex plugin, run `npm run mcp` for stdio. For a local HTTP MCP client, set a random 32-character-or-longer `WPBRIDGE_MCP_TOKEN` in `mcp/.env`, then run `npm run mcp:http`; it listens only on `http://127.0.0.1:8790/mcp` by default. The local token is not a ChatGPT OAuth substitute.

In the client, call `list_sites`, then try `wpbridge_contentRead` with a returned `site_id` and `action: listPosts`. Check that an action absent from `allowed_actions` is refused. Before enabling writes, test a draft and its preview/version checks on one site at a time. Installing the plugin by itself does not start the per-site bridge processes.

## 4. Prepare remote access (HTTPS + OAuth)

Remote access needs two services that this repository does not create: a stable HTTPS address for `/mcp`, and an OAuth 2.1 identity provider. Until both exist, use the local path above and leave OAuth variables unset. Do not point a public tunnel at the old bridge or expose the MCP loopback port directly.

The MCP HTTP process always binds to loopback. Put a TLS reverse proxy or named HTTPS tunnel (for example a Cloudflare named tunnel forwarding `https://mcp.example.com` to `http://127.0.0.1:8790`) in front of the **new** MCP HTTP process. Route only `/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` to it. Configure an established identity provider with authorization-code + PKCE S256, authorization-server metadata, a JWKS endpoint, and a client registration method supported by your clients. Its access token must contain the MCP resource as its audience and, unless you turn it off, the `wpbridge:access` scope. Use the exact subject of the owner account that may operate these sites. Set these values in the new checkout's `mcp/.env`:

```dotenv
WPBRIDGE_MCP_OAUTH_ISSUER=https://TENANT.eu.auth0.com/
WPBRIDGE_MCP_OAUTH_AUDIENCE=https://mcp.example.com/mcp
WPBRIDGE_MCP_OAUTH_SUBJECT=<exact owner subject claim>
WPBRIDGE_MCP_OAUTH_JWKS_URL=https://TENANT.eu.auth0.com/.well-known/jwks.json
WPBRIDGE_MCP_PUBLIC_URL=https://mcp.example.com/mcp
```

The issuer must equal the provider's metadata `issuer` and the token `iss` character for character, including any trailing slash. Optional settings:

| Variable | Default | Effect |
|---|---|---|
| `WPBRIDGE_MCP_OAUTH_SCOPE` | `wpbridge:access` | Required scope, advertised in metadata, challenges and tool `securitySchemes`. Set it to an empty value for providers without custom scopes; security then rests on issuer, audience, owner subject and expiry. |
| `WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM` | `scope` | `scp` reads the scope from an `scp` claim (string or array). |
| `WPBRIDGE_MCP_OAUTH_ALGORITHMS` | `RS256` | Comma-separated accepted JWS algorithms. Only asymmetric algorithms are allowed; `none` and `HS*` are refused at startup. |
| `WPBRIDGE_MCP_RATE_LIMIT_BURST` | `30` | Requests a client may send at once before throttling. |
| `WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND` | `5` | Sustained requests per second per client. |

Every request passes these checks in order, and only a request that passes all of them reaches token verification:

1. **Path:** only `/mcp` and the two metadata paths; anything else is 404.
2. **Host:** the host of `WPBRIDGE_MCP_PUBLIC_URL`, or `127.0.0.1`, `localhost` or `[::1]` with the configured port; anything else is 403. In local-token mode (no OAuth) only loopback hosts are accepted, and requests carrying proxy headers (`Cf-Connecting-IP`, `Cf-Ray`, `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`) are refused, so a tunnel can never expose the static token. The proxy must therefore pass the public Host through unchanged.
3. **Origin:** a request without `Origin` (server-side clients) is allowed; a present `Origin` must be the public URL's origin or a loopback origin on the configured port, otherwise 403.
4. **Method:** `/mcp` accepts only POST and the metadata paths only GET; others get 405 before any authentication.
5. **Throttle:** an in-process token bucket per client returns 429 with `Retry-After`. The client is `Cf-Connecting-IP` when the TCP peer is loopback (the tunnel), otherwise the peer address; IPv6 clients share a bucket per /64. Memory is capped at 10,000 clients.
6. **Token:** signature against the JWKS with the pinned algorithms, exact issuer and audience, a required `exp` (30 seconds of clock tolerance), the exact owner `sub`, and the scope. An invalid, expired or missing token gets 401; a valid token for another subject or without the scope gets 403 with `error="insufficient_scope"`.

Failed authentication and Host, Origin or throttle rejections are written to stderr as one JSON line with a reason code (for example `ERR_JWT_CLAIM_VALIDATION_FAILED:aud`, `scope_missing` or `sub_mismatch`), the `Cf-Ray`, the client key and, from an unverified decode, the token's `kid`, `iss` and `aud` only. Tokens, the `Authorization` header, `sub` and other claims are never logged. Identical lines are logged at most once a minute with a repeat count.

**Do not put a Cloudflare Access application on the MCP hostname.** Access answers non-browser clients with a redirect to its login page, so MCP clients never see WPBridge's 401 and metadata, and discovery fails. As an extra layer, use Cloudflare WAF rules on the hostname instead: a rate-limiting rule on `/mcp`, a custom rule blocking methods other than GET and POST, and a rule blocking paths other than `/mcp` and the two metadata paths. If the tunnel uses a locally managed `config.yml`, restrict ingress to the same paths and end with `service: http_status:404`.

Start with `npm run mcp:http`. Verify that an unauthenticated POST to `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="wpbridge:access"`, that both metadata paths return the configured `resource` and a single issuer, and that a foreign `Host` or `Origin` returns 403 and GET `/mcp` returns 405. Then register the HTTPS `/mcp` URL in your client, complete OAuth, and test `list_sites` and a read action before enabling any write class. For ChatGPT, follow the [current OpenAI authentication guide](https://developers.openai.com/plugins/build/auth) for the provider's client registration and callback requirements and the [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for testing. `upload_attached_media` works only with ChatGPT file attachments; other clients cannot supply its files. Keep the plugin private until the end-to-end connection is verified.

## 5. Validate and operate

Set `PUBLIC_BASE_URL` to an HTTPS bridge origin and run `npm run ci`. Also run `php -l wordpress/wpbridge-control/wpbridge-control.php` and validate the plugin with `python "$env:USERPROFILE/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/wpbridge`. The automated suite exercises the installed-style stdio launcher, authenticated HTTP transport, the pre-auth HTTP checks, gateway routing, and signed OAuth token checks. It does not prove a live WordPress or ChatGPT connection; test each enrolled site separately, including cross-site key isolation and stale preview/version rejection.

Over HTTP, `upload_attached_media` adapts ChatGPT file inputs to WPBridge's attachment uploader; stdio clients use `upload_local_media` instead. `downloadMedia` currently returns a file-response URL as JSON; verify it in your MCP client before relying on a full document round trip. Template, navigation, global-style, plugin installation/removal, and user-management controls remain future work.
