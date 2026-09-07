# Windows setup — SiteOne WordPress ↔ ChatGPT bridge

This setup keeps the WordPress Application Password on your PC. ChatGPT only
receives a separate `BRIDGE_API_KEY`.

## 1) Create a dedicated WordPress account

In `https://site-one.example/wp-admin/`:

1. Go to **Users → Add New**.
2. Create a dedicated user, suggested username: `chatgpt-bridge`.
3. Give it the **Editor** role if you want the chat tool to edit/publish posts
   created by other authors. Do **not** make it Administrator.
4. Sign in as that user, or edit its profile as an administrator.
5. In **Application Passwords**, create one named
   `ChatGPT WordPress Bridge`.
6. Copy the generated Application Password. WordPress only shows it once.

An Editor is intentionally used as a second security boundary. Even if the
Application Password is compromised, it does not grant plugin/theme/user
administration.

## 2) Install Node.js

Install Node.js 20 or newer. Then open PowerShell in this extracted folder:

```powershell
node --version
npm run check
```

The bridge itself has **zero npm runtime dependencies**, so there is no
`npm install` step.

## 3) Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill these values:

```text
WP_URL=https://site-one.example
WP_USERNAME=chatgpt-bridge
WP_APP_PASSWORD=the WordPress application password
```

Generate a separate bridge secret:

```powershell
npm run generate-key
```

Copy the generated 64-character value into:

```text
BRIDGE_API_KEY=...
```

Leave this initially:

```text
ALLOW_PUBLISH=false
```

This lets you test reading, draft creation, and editing without allowing the
bridge to make anything public.

## 4) Start locally

```powershell
npm start
```

You should see:

```text
WordPress bridge listening on http://127.0.0.1:8787
```

In a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Then test authenticated WordPress access. Replace the secret below with your
BRIDGE_API_KEY:

```powershell
$headers = @{ "X-Bridge-Key" = "YOUR_BRIDGE_API_KEY" }
Invoke-RestMethod "http://127.0.0.1:8787/v1/posts?status=publish&per_page=3" -Headers $headers
```

If that returns posts, the local bridge and WordPress Application Password work.

## 5) Put it behind a stable Cloudflare Tunnel

Use a **named/persistent tunnel**, not a Quick Tunnel, because a Quick Tunnel's
hostname changes when restarted.

A convenient hostname is:

```text
wpbridge.site-one.example
```

In Cloudflare:

1. Open **Networking → Tunnels**.
2. Create a tunnel (for example `site-one-wp-bridge`).
3. Follow Cloudflare's Windows connector command to install/run `cloudflared`.
4. Inside the tunnel, add a **Published application** route:
   - Hostname: `wpbridge.site-one.example`
   - Service URL: `http://localhost:8787`
5. Save it.

No inbound router port needs to be opened. The local bridge remains bound to
`127.0.0.1`; `cloudflared` makes the outbound tunnel.

Test:

```powershell
Invoke-RestMethod https://wpbridge.site-one.example/health
```

Then authenticated access:

```powershell
$headers = @{ "X-Bridge-Key" = "YOUR_BRIDGE_API_KEY" }
Invoke-RestMethod "https://wpbridge.site-one.example/v1/posts?status=publish&per_page=3" -Headers $headers
```

## 6) Generate the GPT Action OpenAPI schema

Confirm `.env` contains:

```text
PUBLIC_BASE_URL=https://wpbridge.site-one.example
```

Then:

```powershell
npm run render-openapi
```

This creates:

```text
openapi.generated.yaml
```

## 7) Create your private GPT

On ChatGPT web:

1. Open **Explore GPTs → Create**.
2. Suggested name: **SiteOne WordPress**.
3. Paste the contents of `GPT-INSTRUCTIONS.txt` into the GPT's Instructions.
4. Open **Actions → Create new action**.
5. Configure authentication:
   - Authentication type: **API key**
   - API key style: **Bearer**
   - Secret/value: the same `BRIDGE_API_KEY` from your `.env`

   Enter only the raw key in the secret field. Do **not** type `Bearer ` yourself;
   ChatGPT adds the `Authorization: Bearer ...` header.
6. Paste the entire contents of `openapi.generated.yaml` as the action schema.
7. Test `bridgeHealth`, then `listPosts` in Preview.
8. Save the GPT and keep its sharing/access setting **Invite-only/private**.
   On a personal account, invite-only means only you.

Do not put the WordPress Application Password in the GPT. The GPT receives only
the bridge key.

## 8) Test safely

With `ALLOW_PUBLISH=false`, try these in your new GPT:

- `Show me the 5 most recently modified published posts.`
- `Search published posts for "Trejybė".`
- `Show my five newest drafts.`
- `Create a draft titled "Bridge test" with the content "<p>Testas.</p>".`
- `Read that draft back.`
- `Change its title to "Bridge test 2".`

There is intentionally **no delete endpoint**, so the test draft cannot be
deleted from ChatGPT. Delete it manually in WordPress when finished.

## 9) Enable publishing only after testing

Edit `.env`:

```text
ALLOW_PUBLISH=true
```

Stop the bridge with `Ctrl+C` and start it again:

```powershell
npm start
```

Now the GPT can use its dedicated `publishPost` and `unpublishPost` actions.

The server additionally requires the exact confirmation strings `PUBLISH` or
`UNPUBLISH`, and the GPT instructions prohibit inferring publication permission.

## Everyday use

Open your private **SiteOne WordPress** GPT and write naturally, e.g.:

- `Find the latest post about the Trinity conference and show me its text.`
- `Change only the registration paragraph to this: ...`
- `Create this announcement as a draft in the Naujienos category: ...`
- `Set post 12345's featured media to media ID 6789.`
- `Publish post 12345.`

The computer must be on and both the bridge and Cloudflare Tunnel must be
running. If the computer is off, the GPT Action will not be able to reach it.

## If you suspect a secret leaked

1. WordPress: revoke the `ChatGPT WordPress Bridge` Application Password.
2. Generate a new `BRIDGE_API_KEY`.
3. Update `.env`.
4. Update the GPT Action API-key secret.
5. Restart the bridge.

Because the two secrets are separate, exposing the GPT bridge secret does not
directly expose the WordPress Application Password.
