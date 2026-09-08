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

## 2) Install the optional SEO helper (for SEO actions)

If you want ChatGPT to read/update SEO metadata, install the bundled WordPress
plugin before starting the bridge:

1. Open the extracted bridge folder and locate
   `wordpress\wpbridge-seo-helper\`.
2. ZIP that **folder itself** so the ZIP contains
   `wpbridge-seo-helper/wpbridge-seo-helper.php`.
3. In WordPress go to **Plugins → Add Plugin → Upload Plugin**.
4. Upload the ZIP and activate **WPBridge SEO Helper**.
5. Keep Yoast SEO **or** Rank Math SEO active. If both are active, the helper
   intentionally refuses SEO writes.

The helper does not require Administrator privileges at runtime. It checks the
normal WordPress `edit_post` capability for each target and exposes only six
fixed SEO fields. It does not expose arbitrary post meta.

If you do not need SEO actions, you can skip this step; the rest of the bridge
continues to work normally.

## 3) Install Node.js

Install Node.js 20 or newer. Then open PowerShell in this extracted folder:

```powershell
node --version
npm install
npm run check
```

`npm install` installs the YAML parser and the image-processing dependency used
for approved resize/WebP conversion of large conversation attachments.

## 4) Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill these values:

```text
WP_URL=https://site-one.example
# For a subdirectory install, use the full site URL, e.g. https://example.org/wordpress
WP_USERNAME=chatgpt-bridge
WP_APP_PASSWORD=the WordPress application password

# Keep the login username above unchanged. These settings control the author assigned to NEW content.
# Numeric WordPress user ID is most deterministic; exact display name/nickname/slug also works.
DEFAULT_AUTHOR=SiteOne.lt
ENFORCE_DEFAULT_AUTHOR=true
```

Generate a separate bridge secret:

```powershell
npm run generate-key
```

Copy the generated 64-character value into:

```text
BRIDGE_API_KEY=...
```

For your `chatgpt-bridge` WordPress account, also set **Display name publicly as** to `SiteOne.lt` if you want the visible post byline to read `SiteOne.lt`. WordPress stores the author as a user ID; the bridge does not rewrite user-profile display names. `DEFAULT_AUTHOR=SiteOne.lt` can resolve the authenticated user's exact display name, nickname, or slug, but the public label still uses WordPress's display-name setting.

Leave publishing disabled initially and keep the default media limits:

```text
ALLOW_PUBLISH=false
ALLOW_LIVE_EDITS=false
ALLOW_EXTERNAL_ACCESS=false
TRUSTED_PROXY_IPS=
MAX_BODY_BYTES=12000000
MAX_MEDIA_BYTES=8000000
MAX_SOURCE_IMAGE_BYTES=20000000
MAX_SOURCE_IMAGE_BATCH_BYTES=50000000
IMAGE_OPTIMIZE_THRESHOLD_BYTES=1500000
IMAGE_OPTIMIZE_MAX_DIMENSION=1920
IMAGE_OPTIMIZE_QUALITY=82
MAX_ARCHIVE_ENTRIES=1000
MAX_EXTRACTED_IMAGES=50
```

Custom post types, custom fields, and custom taxonomies are disabled by default. To enable only
specific custom content, add explicit allowlists. For example:

```text
CUSTOM_POST_TYPES=sermon,resource
CUSTOM_FIELD_ALLOWLIST=post:subtitle;page:hero_text;sermon:speaker,sermon_date
CUSTOM_TAXONOMY_ALLOWLIST=sermon:series,speaker;resource:resource_topic
```

`CUSTOM_POST_TYPES` must contain only custom post-type slugs that WordPress
already exposes through the standard REST API (`show_in_rest=true`). Do not add
`post`, `page`, or `attachment`.

`CUSTOM_FIELD_ALLOWLIST` does not expose hidden metadata. Each listed meta key
must already be registered by WordPress/plugin code with `show_in_rest=true`.
For a custom post type, WordPress also requires that type to support
`custom-fields`.

`CUSTOM_TAXONOMY_ALLOWLIST` uses `post_type:taxonomy1,taxonomy2` groups. Every
referenced post type must already be in `CUSTOM_POST_TYPES`, and each taxonomy
must already be associated with that type and registered with
`show_in_rest=true` using the standard `wp/v2` taxonomy controller. Leave these
settings blank until you know the exact slugs you want ChatGPT to access.

This lets you test reading, draft creation, page editing, Gutenberg block
editing, revision inspection/restore, Media Library uploads, draft-to-pending
review workflow, category/tag creation, comment reading, read-only site discovery, allowlisted SEO metadata edits (when the optional helper is installed), and explicitly configured custom content—including custom-item Gutenberg/revision reads, draft-to-pending review, and allowlisted custom-taxonomy term management—without enabling the dedicated visibility-changing actions. `MAX_BODY_BYTES` is larger than
`MAX_MEDIA_BYTES` because base64 expands image data.

## 5) Start locally

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

## 6) Put it behind a stable Cloudflare Tunnel

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

## 7) Generate the GPT Action OpenAPI schema

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

For v1.12+, validate the complete local release before copying the schema into ChatGPT:

```powershell
npm run check
npm test
npm run check:openapi
```

`npm run check:openapi` compares the OpenAPI method/path set with the endpoint handlers
and fails if an implemented action is undocumented or a documented action is missing.

## 8) Create your private GPT

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
6. Paste the entire contents of `openapi.gpt.yaml` as the action schema. This generated schema exposes the existing capabilities through 12 grouped operations plus the direct `uploadConversationImages` action—13 operations total, below the editor's 30-operation limit. Restart the updated bridge before importing it. `openapi.generated.yaml` remains the full REST reference and is not the GPT import file.
7. Test `bridgeHealth`, `listPosts`, `listPages`, `listPostBlocks`,
   `listPageRevisions`, `listMedia`, `listComments`, `getSeoCapabilities`, and `getSiteDiscovery` in Preview.
8. Save the GPT and keep its sharing/access setting **Invite-only/private**.
   On a personal account, invite-only means only you.

Do not put the WordPress Application Password in the GPT. The GPT receives only
the bridge key.

## 9) Test safely

With `ALLOW_PUBLISH=false`, try these in your new GPT:

- `Show me the 5 most recently modified published posts.`
- `Show me the 5 most recently modified pages.`
- `Search published posts for "Trejybė".`
- `Show my five newest drafts.`
- `Create a draft titled "Bridge test" with the content "<p>Testas.</p>".`
- `Create a draft page titled "Bridge page test".`
- `Read that draft back and change its title.`
- `Show me the newest images in the Media Library.`
- `List the top-level Gutenberg blocks in the Bridge test draft.`
- `Show me the revisions of the Bridge page test page.`
- `Create a category named "Bridge test category" if it does not already exist.`
- `Create a tag named "bridge-test" if it does not already exist.`
- `Submit the Bridge test draft for review.`
- `Show comments waiting for moderation.`
- `Show the site's registered post types and taxonomies.`
- `Check whether SEO metadata editing is available.`
- `Read the SEO metadata for the Bridge test draft.`

For an ordinary post/page edit, first read the full item and send either its exact
`modified_gmt` as `expected_modified_gmt` or its `content_sha256` as
`expected_content_sha256`. A stale value returns `409 edit_conflict`.

For a targeted block edit, first list the blocks and use the returned
`content_sha256` with `editPostBlock` or `editPageBlock`. Every targeted block
write uses optimistic locking: if WordPress changed after the read, the bridge
returns `409 content_changed` and the content must be read again.

Block removal additionally requires the exact confirmation value
`REMOVE_BLOCK`. Revision restore requires `RESTORE_REVISION` plus the current
content hash. Restoring a revision does not change status. Published-item edits, including
revision restore, are blocked while `ALLOW_LIVE_EDITS=false`.

For images, DOCX documents, or ZIP archives attached directly to a GPT conversation,
use `uploadConversationImages`. Images embedded in a DOCX under `word/media/*` and
supported images stored in a ZIP are extracted automatically without writing archive
contents to disk. Archive entry, image-count, individual-size, and total-size limits
protect the bridge from malformed or expanding archives.
ChatGPT supplies temporary OpenAI file references, so it does not need to place base64
inside the action call. The bridge accepts only OpenAI's temporary file host and never
fetches caller-chosen URLs. It supports up to 10 source attachments per call.

Use `optimization_mode=ask` first. Web-sized images upload unchanged. If an image is
larger than the configured byte or dimension threshold, the bridge uploads nothing and
returns `image_optimization_recommended`; ask the user before retrying with
`optimization_mode=optimize` and a fresh idempotency key. Approved JPEG/PNG/WebP images
are resized within the configured maximum dimension and converted to WebP. GIFs are not
automatically optimized because conversion could remove animation.

The older `uploadMedia` action remains available for callers that already have genuine
raw base64 bytes. The default final image size limit is 8 MB. After upload, use the returned media ID to set
`featured_media` on a post/page, or use the returned `source_url` when
intentionally inserting the image into content.

There is intentionally **no delete endpoint**, so test drafts, pages, or media
cannot be deleted through the bridge. Remove them manually in WordPress when
finished.

## 10) Enable publishing and live edits separately

Edit `.env`:

```text
ALLOW_PUBLISH=true
```

This enables visibility-changing actions only. To permit edits to content or metadata
that is already published, separately set:

```text
ALLOW_LIVE_EDITS=true
```

Stop the bridge with `Ctrl+C` and start it again:

```powershell
npm start
```

Now the GPT can use its dedicated post/page/custom-item publish, unpublish, scheduling,
comment approval/unapproval, and public comment-reply actions.

The server additionally requires the exact confirmation strings `PUBLISH`,
`UNPUBLISH`, `SCHEDULE`, `APPROVE_COMMENT`, `HOLD_COMMENT`, or `REPLY_COMMENT`
for the corresponding consequential action. Scheduling accepts only an explicit UTC timestamp in
`YYYY-MM-DDTHH:MM:SSZ` form and refuses to take a currently published/private
item offline. The GPT instructions prohibit inferring publication or scheduling
permission.


## Reliable retries and idempotency in v1.14+

Creation/upload/reply operations now require a stable idempotency key. Generate one unique key for each logical operation (a UUID is suitable), and **reuse that same key only when retrying the exact same request**. The OpenAPI schema exposes `idempotency_key` in the JSON body for the affected GPT actions; the bridge also accepts the standard `Idempotency-Key` HTTP header.

The persisted outcome store defaults to:

```env
IDEMPOTENCY_STORE_PATH=.data/idempotency.json
IDEMPOTENCY_RETENTION_HOURS=168
IDEMPOTENCY_MAX_RECORDS=500
```

Activity/edit history uses a separate privacy-filtered store:

```env
ACTIVITY_STORE_PATH=.data/activity.json
ACTIVITY_RETENTION_DAYS=30
ACTIVITY_MAX_RECORDS=2000
```

Keep this local file private and persistent if you want recovery records to survive restarts. It does not contain bridge credentials, WordPress Application Passwords, full post bodies, comment bodies, or uploaded image bytes. Content recovery points to WordPress revisions when a matching pre-change revision exists; bounded before-values are kept only for changed metadata that revisions do not cover.

Keep the store on persistent local disk if you want retry protection to survive a bridge restart. The bridge writes an in-progress marker before each protected WordPress mutation, so a crash/restart during the request is conservatively treated as an unknown outcome instead of automatically resending it. The store writes key hashes rather than plaintext idempotency keys and uses restrictive local file permissions. Do not share one store between unrelated bridge instances unless they intentionally represent the same WordPress target and API.

If a mutating WordPress request times out or loses connectivity after it may have been sent, the bridge returns an `outcome=unknown` error. Reusing the same idempotency key will replay that unknown outcome without issuing the write again. Check WordPress to determine whether the item/upload/reply exists before deciding whether a new logical operation with a new key is appropriate.

Read-only editorial audits also have bounded execution controls:

```env
AUDIT_DEADLINE_MS=15000
AUDIT_CONCURRENCY=4
```

If the audit reaches the deadline it returns HTTP 206 with partial results and `skipped_due_deadline`; request a smaller/next page or adjust the configured deadline rather than assuming omitted items were checked.

## Activity history and guarded recovery in v1.15+

Use `listActivity` to review recent bridge writes and `getActivity` for one entry. A recoverable entry must first be passed to `restoreActivityPreview`; this only reads WordPress and shows what would be restored. Applying recovery then requires `restoreActivity` with `confirm=RESTORE_ACTIVITY`, the preview token, and a fresh current version/fingerprint.

A restore never bypasses the normal live-edit gate. If the target is published and `ALLOW_LIVE_EDITS=false`, recovery is blocked. If WordPress or the relevant metadata changes after the preview, the restore is rejected and must be previewed again. The restore itself is added to activity history so it can be reviewed and, when enough before-state exists, reversed.

Suggested safe test on a draft:

1. Read a draft and note its `modified_gmt`.
2. Change only a harmless metadata field such as featured image/slug.
3. Call `listActivity?recoverable=true` and locate that request.
4. Call `restoreActivityPreview` for the entry and review the proposed field reversal.
5. Apply `restoreActivity` only with the returned token and the current version.

## Edit previews in v1.13+

No new `.env` setting is required for edit previews. The bridge signs preview tokens
with the existing `BRIDGE_API_KEY`; do not copy preview tokens between sites or items.
The GPT Action now has read-only preview operations for ordinary post/page/custom-item
edits. A preview shows the proposed changes and current version first, then the matching
edit can carry that preview token so a stale or altered proposal is rejected before
WordPress is written. Preview tokens expire after one hour.

## Everyday use

Open your private **SiteOne WordPress** GPT and write naturally, e.g.:

- `Find the latest post about the Trinity conference and show me its text.`
- `Change only the registration paragraph to this: ...` (the GPT previews the diff before applying)
- `Create this announcement as a draft in the Naujienos category: ...`
- `Show me the About page and change only its second paragraph.`
- `Show the newest images in the Media Library.`
- `Set post 12345's featured media to media ID 6789.`
- `Set page 2468's featured media to media ID 6789.`
- `Show the Gutenberg blocks in post 12345 and replace only the third paragraph.`
- `Show the latest revisions of page 2468.`
- `Show drafts pending review.`
- `Schedule draft post 12345 for 2026-09-10 09:00 Vilnius time.`
- `Show the next scheduled posts.`
- `Create a new child category under an existing category after resolving its ID.`
- `Show comments waiting for moderation.`
- `Approve comment 4321.`
- `Reply to comment 4321 with: Thank you for your feedback.`
- `Show the site's editorial capabilities and available templates.`
- `Show the SEO title and meta description for post 12345.`
- `Change only post 12345's SEO meta description to: ...`
- `Restore page 2468 to revision 13579.`
- `Show the Gutenberg blocks in sermon 345 and replace only the second paragraph.`
- `Show revisions for sermon 345 and restore revision 456.`
- `Submit sermon 345 for review.`
- `Schedule sermon 345 for 2026-09-12 18:00 Vilnius time.`
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


### Optional v1.9 editorial audits

No additional WordPress plugin or `.env` permission is required for the v1.9
read-only editorial audit endpoints. They use the same WordPress credentials and
existing custom-post-type allowlist. SEO-description checks are included only
when the optional WPBridge SEO Helper is already installed and available.



## Author discovery and bulk editorial metadata

v1.11+ adds optional safety variables (`ALLOW_LIVE_EDITS`, `ALLOW_EXTERNAL_ACCESS`, and `TRUSTED_PROXY_IPS`). Defaults remain local-only and live-edit-disabled. The bridge uses the authenticated
WordPress account's normal REST permissions for author lookup and content editing.

Author output is privacy-filtered. Bulk editorial metadata edits are capped at 20
items, require `confirm=APPLY_BULK_EDIT`, and require each item's latest
`modified_gmt` value. Re-read items before preparing a bulk change.
