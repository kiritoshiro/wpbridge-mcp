# SiteOne WordPress ↔ ChatGPT bridge

For Custom GPT Actions, generate and import **openapi.gpt.yaml**: it exposes all
86 grouped editorial capabilities through 12 grouped operations plus one direct
conversation-image uploader. See [GPT API setup](GPT-API.md).
The full REST schema is retained for direct API clients.

A deliberately restricted local API bridge for controlling WordPress editorial
content through a **private Custom GPT Action**.

## Included in v1.15.1

### Posts
- Read/search published posts and drafts
- Filter lists directly by category/tag inclusion or exclusion, taxonomy relation, sticky state, author, exact IDs, publication/modification time, and explicit ordering
- Read full editable post content and a SHA-256 content fingerprint
- Create drafts
- Preview proposed title/content/excerpt/slug/category/tag/author/featured-media changes without writing
- Edit title/content/excerpt/slug/categories/tags/featured media only with a current `modified_gmt` or `content_sha256`
- Optional, separately gated publish/unpublish/schedule actions

### Pages
- Read/search published pages and drafts
- Filter lists by parent, author, exact IDs, publication/modification time, and explicit ordering
- Read full editable page content and a SHA-256 content fingerprint
- Create draft pages
- Preview proposed title/content/slug/parent/menu-order/template/author/featured-media changes without writing
- Edit title/content/slug/parent/menu order/template/featured media only with a current `modified_gmt` or `content_sha256`
- Optional, separately gated publish/unpublish/schedule actions

### ALPS featured-image presentation
- Reads expose the normalized `featured_image` summary and, when the optional
  helper plugin is installed, ALPS `large_banner` and `hide_featured_image`
  fields with an `alps_sha256` optimistic-lock fingerprint.
- Post/page edits accept the stable `featured_image_id` alias and fixed ALPS
  fields only; ALPS writes require the current `expected_alps_sha256`.
- Install `wordpress/wpbridge-alps-helper` on an ALPS site to map the public
  values to the theme's `_featured_image_hero_layout` and `_hide_featured_image`
  keys. The helper never exposes arbitrary post meta.

### Prepared bulk editorial operations
- `prepareBulkOperation` requires an explicit category/tag/ID/status/author/date,
  featured-image, or ALPS filter and creates a frozen, read-only plan.
- Featured-image strategies include an existing image, first Gutenberg/content
  image, first attached media, explicit media ID, or a bounded per-post mapping;
  missing images can be skipped without blocking unrelated ALPS changes.
- `executeBulkOperation` applies bounded chunks with version/ALPS conflict checks,
  per-item isolation, idempotent retries, and activity audit records. A completed
  operation can be rolled back with the same conflict guards.
- Plans and results persist in `.data/bulk-operations.json` with configurable
  retention, record/item caps, chunk size, and large-job threshold.

### Gutenberg block editing
- List top-level Gutenberg blocks for posts and pages
- Represent classic/non-block HTML as `core/freeform`
- Insert a serialized block at the start/end or before/after another block
- Replace one top-level block without rewriting unrelated content
- Explicitly remove one top-level content unit with `confirm=REMOVE_BLOCK`
- Require `expected_content_sha256` on every targeted block write, so a stale
  AI edit is rejected if WordPress content changed after it was read
- Reject structurally malformed Gutenberg block comments instead of guessing

Block operations intentionally work at the **top level**. Nested InnerBlocks stay
inside their parent block and are preserved as part of that parent's serialized
markup. To modify a nested block, replace the containing top-level block or use
the full-content edit endpoint.

### Revisions / rollback
- List post revisions
- Read a specific post revision
- Restore post title/content/excerpt from an explicitly selected revision
- List page revisions
- Read a specific page revision
- Restore page title/content from an explicitly selected revision
- Revision restore requires both `confirm=RESTORE_REVISION` and the current
  content hash to protect against accidental/stale rollback
- Restoring does **not** change publication status

WordPress must have revisions available for the content item. The bridge does
not expose revision deletion.

### Activity history and guarded recovery
- Persist privacy-filtered records for bridge write attempts with action, affected item, time, outcome, HTTP status, and request ID; successful create/upload/reply/term operations attach the returned WordPress object ID when available
- List recent activity with filters for post type, object ID, outcome, and recoverability
- Inspect one activity entry without exposing credentials, full post bodies, comment bodies, or uploaded image bytes
- Link content edits to matching WordPress revisions before/after the change when revisions are available
- Store only bounded before-values for non-revision metadata such as slug, taxonomy IDs, author, featured media, page attributes, allowlisted SEO fields, allowlisted custom fields, and allowlisted custom-taxonomy assignments
- Record per-item bulk metadata outcomes so successful items can be reviewed/recovered independently
- Recover through `restoreActivityPreview` first; the preview is read-only and returns a version-bound token
- Apply with `restoreActivity` only when `confirm=RESTORE_ACTIVITY`, the preview token, and a fresh current version are all supplied
- A changed item or changed metadata state invalidates the preview before the restore write
- Recovery writes are themselves recorded, making a restore reviewable and, when sufficient before-state exists, reversible
- History defaults to `.data/activity.json`, 30 days, and 2000 records (`ACTIVITY_STORE_PATH`, `ACTIVITY_RETENTION_DAYS`, `ACTIVITY_MAX_RECORDS`)

### Image media
- List/search image attachments in the Media Library
- Filter lists by attached post/page, author, MIME type, exact IDs, publication/modification time, and explicit ordering
- Read image metadata
- Upload up to 10 images attached to a ChatGPT conversation through temporary OpenAI file references
- Extract JPEG, PNG, WebP, and GIF images embedded in attached DOCX files or stored in ZIP archives
- Bound archive entry count, extracted image count, individual size, and total expanded size
- Recommend no-write resize/WebP optimization for large images and apply it only after approval
- Download only OpenAI's `oaiusercontent.com` host family with strict MIME, signature, source-size, and batch-size validation
- Upload JPEG, PNG, WebP, and GIF images from caller-supplied base64 data
- Require an idempotency key for uploads so exact retries cannot create duplicate attachments
- Edit title, alt text, caption, description, and attachment parent
- Create a rotated, horizontally/vertically flipped, and/or percentage-cropped derivative from existing media
- Preserve the original attachment and return the new media ID/URL for a guarded gallery, block, content, or featured-image update
- Use returned media IDs as featured images on posts/pages
- No arbitrary remote-URL fetching

Collection responses request only the bounded summary fields used by WPBridge. This reduces WordPress response size while full-item read actions remain available when editable content is needed. Allowlisted custom-item lists also support author, exact-ID, date, and ordering filters.

### Editorial audits / workflow queue
- Inspect one post/page/allowlisted custom item with `getEditorialStatus`
- Run a paged read-only quality audit with `auditEditorialContent`
- Flag heuristic gaps such as empty title/content, supported featured image/excerpt,
  missing core post categories/tags, stale draft/pending age, and missing explicit
  SEO meta description when the safe SEO helper is available
- Show consolidated stale-draft, pending-review, and scheduled queues with
  `getEditorialQueue`
- Core posts/pages are included in queue inspection; custom post types are
  opt-in per request and remain constrained by `CUSTOM_POST_TYPES`
- Audit results are advisory only. Missing fields may be intentional; the audit
  endpoints never mutate WordPress content
- Audit SEO checks use bounded concurrency (`AUDIT_CONCURRENCY`, default 4) and an overall deadline (`AUDIT_DEADLINE_MS`, default 15000); slow audits return HTTP 206 with partial results rather than running indefinitely

### Scheduling / editorial workflow
- Schedule draft, pending, or already-scheduled posts/pages for future publication
- Scheduling requires `ALLOW_PUBLISH=true` and `confirm=SCHEDULE`
- Schedule input is explicit UTC: `YYYY-MM-DDTHH:MM:SSZ`
- Scheduling refuses to take an already-published/private item offline
- Submit draft posts/pages to WordPress `pending` review state
- Review submission only permits draft → pending; it cannot unpublish/unschedule
- Listing with `status=future` orders upcoming items by publication date ascending
- Existing unpublish action can explicitly cancel a schedule by returning `future` → `draft`

### Taxonomy
- List/search categories and tags
- Create categories with optional description, slug, and parent
- Create tags with optional description and slug
- Existing post edit/create operations assign terms using resolved numeric IDs
- No taxonomy delete/rename endpoints

### Comments
- List moderation comments by `hold`, `approved`, or `spam` status
- Read an individual comment
- Approve a held comment with explicit confirmation
- Move an approved comment back to moderation hold with explicit confirmation
- Publish a reply to an already-approved comment as the bridge WordPress user
- Comment visibility changes and replies require `ALLOW_PUBLISH=true`
- Commenter email, IP address, and user-agent fields are intentionally omitted
- No comment delete, trash, spam, or unspam mutation endpoints

### Read-only site discovery
- Inspect sanitized site/editorial settings when the WordPress role permits access
- Discover registered REST post types and their supported features/taxonomies
- Discover registered taxonomies and associated post types
- Discover post statuses
- Discover block-theme templates when WordPress/theme permissions expose them
- Permission-limited sections are reported as unavailable; the bridge does not bypass them
- No site-setting mutation

### Allowlisted custom post types
- Configure writable custom post-type slugs with `CUSTOM_POST_TYPES`
- The bridge resolves each slug through WordPress `/wp/v2/types` before use
- Only types exposed through the standard `wp/v2` post controller are accepted
- List/search custom items by publication status
- Read full custom items
- Create custom items as drafts only
- Preview supported common-field edits without writing
- Edit only common fields the post type declares as supported
- Submit draft custom items for editorial review
- Schedule/reschedule draft, pending, or already-scheduled custom items with `confirm=SCHEDULE`
- Publish/unpublish through dedicated, explicitly confirmed actions gated by `ALLOW_PUBLISH`
- List/read/restore revisions when the post type declares WordPress `revisions` support
- List/edit top-level Gutenberg blocks when the post type declares WordPress `editor` support
- Custom block edits use `content_sha256`; revision restores require a fresh current-content hash
- No generic REST path, unsupported custom controller, or deletion
- Core `post`, `page`, and `attachment` cannot be added to `CUSTOM_POST_TYPES`

### Allowlisted custom fields
- Configure keys per post type with `CUSTOM_FIELD_ALLOWLIST`
- Supports core posts/pages plus types already present in `CUSTOM_POST_TYPES`
- Reads only keys present in the local allowlist
- Writes only allowlisted keys that WordPress actually exposes in the REST `meta` object
- Requires a fresh `custom_fields_sha256` fingerprint before every write
- Rejects stale writes, unallowlisted keys, and locally configured keys that are not REST-exposed
- No arbitrary `post_meta` endpoint and no automatic meta registration
- WordPress must register each field with `show_in_rest=true`; custom post types must also support `custom-fields`

Example `.env` configuration:

```text
DEFAULT_AUTHOR=SiteOne.lt
ENFORCE_DEFAULT_AUTHOR=true
CUSTOM_POST_TYPES=sermon,resource
CUSTOM_FIELD_ALLOWLIST=post:subtitle;page:hero_text;sermon:speaker,sermon_date
CUSTOM_TAXONOMY_ALLOWLIST=sermon:series,speaker;resource:resource_topic
```

### Allowlisted custom taxonomies
- Configure custom taxonomies **per custom post type** with `CUSTOM_TAXONOMY_ALLOWLIST`
- Only post types already present in `CUSTOM_POST_TYPES` may be referenced
- WordPress must already register the taxonomy with `show_in_rest=true`
- The taxonomy must be associated with the requested custom post type
- Only the standard `wp/v2` namespace and a simple REST base are accepted
- Discover configured taxonomies and whether each is usable through the bridge
- Search/list terms and create new terms
- Hierarchical taxonomies support `parent` on listing/creation
- Read current term assignments on a custom item
- Assign selected numeric term IDs without replacing unrelated existing terms
- Remove selected numeric term IDs without touching other terms
- Assignment changes require a fresh per-taxonomy `terms_sha256` fingerprint
- Requested term IDs are validated against the target taxonomy before the item is changed
- No term delete, rename, arbitrary taxonomy access, or taxonomy registration

Example:

```text
CUSTOM_TAXONOMY_ALLOWLIST=sermon:series,speaker;resource:resource_topic
```

This does not grant access by itself. `sermon` and `resource` must also be present
in `CUSTOM_POST_TYPES`, and WordPress remains the final authority for the
authenticated user's taxonomy capabilities.

### SEO metadata (optional WordPress helper)
- Detect whether the bundled `WPBridge SEO Helper` is installed
- Detect supported active provider: **Yoast SEO** or **Rank Math SEO**
- Read/update a fixed SEO field allowlist for posts and pages:
  - SEO title
  - Meta description
  - Focus keyword
  - Canonical URL
  - Open Graph title
  - Open Graph description
- Every SEO write requires the latest `seo_sha256` fingerprint returned by the
  matching SEO read, so stale edits are rejected
- Empty strings clear individual SEO overrides
- The helper checks the authenticated WordPress user's normal `edit_post`
  capability for the target object
- If both Yoast and Rank Math appear active, SEO writes are refused
- No arbitrary post-meta keys, global SEO settings, redirects, schemas, robots
  directives, plugin administration, or raw plugin REST proxy are exposed

SEO writes require installing the bundled WordPress plugin in
`wordpress/wpbridge-seo-helper/`. The bridge itself never installs or activates
plugins.

### Authors and capped bulk editorial metadata
- Search/list authors with privacy-filtered output: ID, display name, slug, and author link only
- Read one author without exposing email, login/username, roles, capabilities, or user meta
- Assign an author when creating/editing posts/pages; allowlisted custom post types require declared WordPress `author` support
- Optionally set `DEFAULT_AUTHOR` for every newly created post/page and author-enabled custom item. It accepts a numeric WordPress user ID (recommended) or an exact display name, nickname, or slug.
- Set `ENFORCE_DEFAULT_AUTHOR=true` to prevent callers from substituting another `author_id` during creation. Existing-item edits keep their explicit author-edit behavior.
- The WordPress byline still comes from the selected user's **Display name publicly as** profile setting; changing only the nickname does not change the public author label.
- Filter post/page/custom-item lists by `author_id`
- Apply up to 20 metadata-only edits with `bulkEditEditorialMetadata`
- Every bulk item requires the latest `modified_gmt` from a fresh read
- Bulk edits require explicit `confirm=APPLY_BULK_EDIT`
- Supported bulk changes: author, featured image, and additive categories/tags for core posts
- Bulk edits never change title/content/status and never publish/unpublish/schedule
- Each bulk item gets its own preflight/write outcome: `succeeded`, definite `failed`, or `unknown`
- A bad/stale item no longer prevents unrelated valid items from being attempted; successful writes are never rolled back
- `retryable_items` contains only definite write-phase failures, so a retry request can omit already-successful items
- Preflight failures must be corrected/refreshed first; unknown outcomes must be reconciled in WordPress before retrying because the write may already have happened


### Persistent idempotency and retry safety

- Duplicate-prone operations require an `idempotency_key` (or equivalent `Idempotency-Key` header): post/page/custom draft creation, image upload, category/tag/custom-taxonomy term creation, and comment replies.
- Reusing the same key with the exact same request replays the stored outcome instead of calling WordPress again. Reusing a key for a different payload/operation returns HTTP `409 idempotency_key_reused`.
- Outcomes persist across bridge restarts in `IDEMPOTENCY_STORE_PATH` (default `.data/idempotency.json`). Before sending the WordPress mutation, the bridge first persists an `in_progress` marker; if the process dies mid-write, a restart treats that key as an unknown outcome rather than sending it again. Plaintext idempotency keys are not written to disk; the store uses key hashes and restrictive filesystem permissions.
- Store retention defaults to 168 hours and 500 records (`IDEMPOTENCY_RETENTION_HOURS`, `IDEMPOTENCY_MAX_RECORDS`). Oldest/expired records are pruned automatically.
- If connectivity is lost or a timeout occurs after a write may have been sent, the bridge returns an `outcome=unknown` error (for example `wordpress_write_timeout_outcome_unknown`) and persists it. Reusing the same key replays that unknown outcome without blindly sending the write a second time. Reconcile the WordPress state before choosing a new key.

## Deliberately NOT included

- Delete posts, pages, or media
- Delete revisions
- User-account or role mutation (privacy-filtered author discovery/assignment is supported)
- Plugins
- Themes
- Site settings mutation
- Custom taxonomy access outside `CUSTOM_TAXONOMY_ALLOWLIST`
- Custom taxonomy term deletion or rename
- Arbitrary post meta or global SEO-plugin settings
- Arbitrary WordPress REST proxy
- Arbitrary URL fetching
- Shell/PHP execution


## Configuration and live-edit safety

- Numeric settings (`PORT`, `MAX_BODY_BYTES`, `MAX_MEDIA_BYTES`, `RATE_LIMIT_PER_MINUTE`, `IDEMPOTENCY_RETENTION_HOURS`, `IDEMPOTENCY_MAX_RECORDS`, `AUDIT_DEADLINE_MS`, `AUDIT_CONCURRENCY`, `ACTIVITY_RETENTION_DAYS`, `ACTIVITY_MAX_RECORDS`, and `BULK_OPERATION_*`) are validated strictly at startup; malformed or out-of-range values stop the bridge instead of being silently clamped.
- `HOST` defaults to `127.0.0.1`. Binding to a non-loopback address requires the explicit `ALLOW_EXTERNAL_ACCESS=true` opt-in.
- `WP_URL` preserves an installation subdirectory, so `https://example.org/wordpress` targets `https://example.org/wordpress/wp-json/...` rather than the domain root.
- Forwarded client-IP headers are ignored unless the direct peer IP is listed in `TRUSTED_PROXY_IPS`. This affects rate-limit attribution only, never authentication.
- `ALLOW_LIVE_EDITS` is separate from `ALLOW_PUBLISH`. When false, edits to already-published post/page/custom-item content, Gutenberg blocks, SEO, taxonomy assignments, custom fields, revision restores, and bulk editorial metadata are rejected.
- Ordinary post/page/custom-item PATCH operations require either `expected_modified_gmt` or `expected_content_sha256` from a fresh full-item read. A mismatch returns HTTP `409 edit_conflict` with the current version/fingerprint.

### Version-bound edit previews

- `previewPostEdit`, `previewPageEdit`, and `previewCustomItemEdit` are read-only operations for ordinary full-field edits. They fetch the current item and do **not** send a WordPress mutation request.
- Preview responses list only fields that would actually change. Array fields such as categories/tags show added and removed values. Content replacements include bounded additions/removals plus before/after SHA-256 fingerprints. Very large diffs are intentionally truncated in the response rather than returning unbounded content.
- A preview of an already-published item sets `affects_published_content=true`. When `ALLOW_LIVE_EDITS=false`, the preview remains available for review but reports `apply_allowed=false` and a blocking warning.
- Every preview returns the exact `modified_gmt` and `content_sha256` used plus a signed `preview_token` valid for one hour. The token contains only identifiers/hashes/version claims, not the proposed content itself.
- Supplying `preview_token` to the matching ordinary PATCH binds the write to that exact item, WordPress version, and normalized proposed payload. A changed item returns `409 preview_stale`; a changed proposed payload returns `409 preview_payload_mismatch`. Invalid/expired tokens are also rejected before WordPress is written.
- `preview_token` is optional at the raw API level for backward compatibility, but the bundled GPT instructions tell the assistant to preview ordinary post/page/custom-item edits first and carry the returned token into the write. Existing optimistic-lock version/fingerprint requirements still apply.

### Activity-history privacy and recovery model

`ACTIVITY_STORE_PATH` is a separate local store from idempotency outcomes. It is written with restrictive local file permissions and automatically pruned by age/count. The store intentionally rejects arbitrary fields: credentials, bridge/API secrets, full content bodies, comment bodies, and uploaded image bytes are not accepted into activity records. Strings/arrays/objects that are retained as metadata before-values are bounded.

For title/content/excerpt recovery, the bridge first tries to identify a WordPress revision that exactly matches the pre-change state of the revision-covered fields. It stores the revision ID/admin link, not a copy of that content. If no matching revision is available, those content fields are marked unavailable for history recovery rather than copied into the local log. Non-revision metadata stores only the fields actually changed.

`restoreActivityPreview` re-reads the current WordPress item/metadata and constructs the proposed restore without writing. It returns both a signed `preview_token` and `conflict_version`, which is derived from the real current WordPress item even when the recovery itself targets SEO/taxonomy/custom-field state. `restoreActivity` then requires the returned token plus `conflict_version.modified_gmt` (preferred) or `conflict_version.content_sha256`. The token is separately bound to the exact metadata/content restore state and payload, so stale or altered restores fail before the write. Published-item recovery still obeys `ALLOW_LIVE_EDITS`.

### Conditional-write limitation

The bridge re-reads WordPress immediately before ordinary writes and verifies the supplied version/fingerprint. WordPress core REST updates do not provide a general compare-and-swap precondition that preserves normal revisions/hooks, so a very small check-to-save race still exists. A database-level conditional write could close that gap, but it would bypass or complicate normal WordPress update behavior; v1.15.1 therefore keeps the safer REST/revision path and documents the remaining race for a future WordPress-side helper design.

## Architecture and verification

v1.12.0+ separates the bridge runtime into independently testable modules:

- `lib/config.js` — `.env` loading, startup validation, URL/proxy rules
- `lib/auth.js` — bridge API-key authentication and rate-limit attribution
- `lib/validation.js` — reusable request-value validation
- `lib/edit-safety.js` — live-edit and optimistic-lock checks
- `lib/preview.js` — signed preview tokens and bounded field/content diffs
- `lib/idempotency.js` — persisted duplicate-prevention outcomes and request fingerprints
- `lib/activity.js` — privacy-filtered activity history, persistence, retention, and mutation classification
- `lib/bulk-operations.js` — bounded frozen-plan storage and resumable bulk state
- `wordpress/wpbridge-alps-helper` — optional fixed-key ALPS REST adapter
- `lib/concurrency.js` — bounded deadline-aware work scheduling for audits
- `lib/wordpress.js` — constrained WordPress/SEO/media HTTP client
- `lib/handlers.js` — implemented bridge endpoint handlers
- `lib/http.js` — JSON request/response and safe error serialization
- `server.js` — startup/bootstrap only

Run `npm run check` for syntax validation, `npm test` for the automated suite,
and `npm run check:openapi` after rendering the schema. The OpenAPI check compares
the documented method/path set with all annotated implemented handlers and currently
verifies all 87 operations. CI performs syntax checks, tests, schema rendering, and
the implementation/schema comparison on pushes and pull requests.

WordPress transport failures are normalized. Read-only network failures return `502 wordpress_unreachable` and read-only upstream deadlines return `504 wordpress_timeout`. For mutating requests, a network loss or timeout after the request may have been sent is reported separately as an **unknown write outcome** (`wordpress_write_network_outcome_unknown` / `wordpress_write_timeout_outcome_unknown`) so callers do not mistake it for a definite failure and retry blindly. Raw network exception details are not returned to callers.

## Gutenberg safety model

`listPostBlocks` / `listPageBlocks` / `listCustomItemBlocks` return a `content_sha256` fingerprint.
Supply that exact value to the matching edit operation. The bridge fetches the
content again immediately before writing and returns HTTP `409 content_changed`
if the fingerprint no longer matches.

This is an optimistic lock: it prevents an edit planned against an older copy
from silently overwriting a newer WordPress edit. If the item is already published,
`ALLOW_LIVE_EDITS=true` is also required.

`block_markup` must contain exactly one serialized Gutenberg block, for example:

```html
<!-- wp:paragraph -->
<p>Updated text.</p>
<!-- /wp:paragraph -->
```

For removal, `block_markup` is omitted and the exact confirmation string
`REMOVE_BLOCK` is required.

## Revision restore safety

A restore is a content write. The caller must first read the current post/page/custom item
and the intended revision. Restore requires:

- `confirm=RESTORE_REVISION`
- `expected_current_content_sha256=<hash from the current item>`

If the item is already published, the restore is rejected unless `ALLOW_LIVE_EDITS=true`.
Because restore keeps the current status, an allowed restore can immediately change public
content; explicit user intent for the specific revision is still required.

## Media upload safety

Custom GPT conversation attachments use the dedicated `uploadConversationImages`
action. ChatGPT supplies temporary OpenAI file references; the bridge downloads
only OpenAI's `oaiusercontent.com` host family, validates and decodes each image, and then
uploads it to WordPress. The action also accepts DOCX and ZIP attachments. DOCX
processing reads supported images only from `word/media/*`; ZIP processing finds
supported images anywhere in the archive. Archives are processed in memory with
entry-count and expanded-size limits and are never extracted to disk. The original
`/v1/media` base64 endpoint remains available for direct API clients.

`transformMedia` first uses WordPress's native media editor to create a new derivative. If
WordPress cannot open its local image file, the bridge can fall back to downloading only
the same-origin source URL returned by authenticated WordPress, transforming the bounded
JPEG/PNG/WebP bytes with Sharp, and uploading the result as a new attachment. It never
uses a caller-supplied URL, follows a redirect, or fetches a different origin. The operation
supports 90/180/270-degree clockwise rotation, horizontal/vertical flips, and a bounded
percentage crop. A fresh `modified_gmt`, `confirm=CREATE_TRANSFORMED_MEDIA`, and an
idempotency key are required. The source attachment is never overwritten or deleted;
use the returned ID/URL in a separate version-guarded post, page, Gutenberg block,
gallery, custom-content, or featured-image edit.

Pass the original conversation attachment to the action. A `sandbox:/mnt/data/...`
reference created by Code Interpreter exists only inside ChatGPT's sandbox and is
not downloadable by WPBridge; the bridge returns a specific error for this case.

Supported types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif`

For a large image, the default `optimization_mode=ask` returns a recommendation
without uploading anything. After the user approves, retrying with
`optimization_mode=optimize` resizes within the configured maximum dimension and
converts JPEG, PNG, or WebP to WebP. Automatic GIF conversion is intentionally
disabled to avoid discarding animation. The final decoded image limit is 8 MB
(`MAX_MEDIA_BYTES=8000000`).

The bridge never downloads an arbitrary user-supplied URL. Uploads also require
an idempotency key so a retry after an ambiguous connection failure cannot silently
create a second attachment.

## SEO safety model

WordPress core does not provide one universal writable SEO API. v1.5.0 therefore
uses the bundled `WPBridge SEO Helper` plugin as a narrow adapter for supported
SEO providers.

The helper exposes only six named fields and only for `post` / `page` objects
the authenticated WordPress user can already edit. It maps those names to the
active provider internally; callers cannot choose or supply arbitrary meta keys.

`getPostSeo` / `getPageSeo` return `seo_sha256`. Supply that exact fingerprint
as `expected_seo_sha256` to the corresponding update action. If SEO metadata was
changed by another editor/plugin after the read, the helper returns a conflict
instead of overwriting it.

To install the helper, copy `wordpress/wpbridge-seo-helper/` into
`wp-content/plugins/` (or ZIP that folder and upload it through WordPress), then
activate **WPBridge SEO Helper**. Plugin activation is intentionally not exposed
through the bridge.

## Custom post type, custom field, and custom taxonomy safety

Custom-content functionality is disabled unless you explicitly configure it.
`CUSTOM_POST_TYPES` is a comma-separated list of custom post-type slugs. The
bridge checks each requested slug against that local list and then resolves the
registered WordPress type before constructing a REST path. Only the standard
`wp/v2` namespace and a simple REST base are accepted.

`CUSTOM_FIELD_ALLOWLIST` uses:

```text
post_type:key1,key2;other_type:key3,key4
```

The bridge does not make hidden metadata REST-accessible. WordPress must already
expose each allowlisted key through the target item's `meta` field. Every write
requires the latest `custom_fields_sha256` returned by the matching read, and
only supplied allowlisted keys are changed.

`CUSTOM_TAXONOMY_ALLOWLIST` uses the same per-type grouping style:

```text
post_type:taxonomy1,taxonomy2;other_type:taxonomy3
```

Every referenced post type must already be in `CUSTOM_POST_TYPES`. The bridge
then verifies the taxonomy through WordPress's taxonomy REST discovery endpoint,
requires the standard `wp/v2` namespace, verifies that the taxonomy is associated
with that post type, and derives its REST field/base from WordPress rather than
guessing.

`getCustomItemTaxonomies` returns a separate `terms_sha256` for each configured
taxonomy. Supply the matching hash to `assignCustomTaxonomyTerms` or
`removeCustomTaxonomyTerms`. The bridge re-reads the item immediately before
writing and rejects stale taxonomy edits with HTTP 409.

## Publishing and scheduling safety

Creation endpoints always create drafts. Post/page publishing, unpublishing,
scheduling, comment approval/unapproval, and public comment replies are separate
visibility-changing operations and remain disabled unless `ALLOW_PUBLISH=true`.
`ALLOW_LIVE_EDITS` is a separate gate: publishing permission does not automatically
authorize editing content or metadata that is already live.

Scheduling additionally requires `confirm=SCHEDULE`, accepts only a UTC
`scheduled_for_gmt` timestamp in the form `YYYY-MM-DDTHH:MM:SSZ`, and rejects
times less than 60 seconds in the future. The bridge only schedules items
currently in `draft`, `pending`, or `future` state; it refuses to convert a live
`publish`/`private` item into a future item because that would take content
offline until the scheduled time.

Submitting for review is not public publication. The review endpoints only
permit `draft` → `pending` (or return an already-pending item unchanged).

Comment approval requires `confirm=APPROVE_COMMENT`; moving an approved comment
back to moderation requires `confirm=HOLD_COMMENT`; publishing a reply requires
`confirm=REPLY_COMMENT`. The reply endpoint only publishes a child reply when
the selected parent comment is already approved. Comment delete/trash/spam
mutation is intentionally not exposed.

The site discovery endpoint is read-only. It filters WordPress settings to a
small editorially useful set and omits sensitive fields such as administrator
email. Post types, taxonomies, statuses, and templates are returned only when
the authenticated WordPress role/theme exposes them.

## Files

- `server.js` — small startup/bootstrap entry point
- `lib/` — configuration, authentication, validation, WordPress client, HTTP helpers, and endpoint handlers
- `.env.example` — configuration template
- `openapi.template.yaml` — Custom GPT Action schema template
- `scripts/render-openapi.mjs` — inserts your stable public tunnel URL
- `scripts/check-openapi.mjs` — verifies documented operations match implemented handler annotations
- `scripts/check-syntax.mjs` — validates all JavaScript source/test files
- `GPT-INSTRUCTIONS.txt` — instructions to paste into the Custom GPT
- `SETUP-WINDOWS.md` — Windows setup
- `CHANGELOG.md` — release history
- `wordpress/wpbridge-seo-helper/` — optional restricted WordPress helper for SEO metadata

Start with `SETUP-WINDOWS.md`.

## Authentication

The bridge accepts `Authorization: Bearer <BRIDGE_API_KEY>` (recommended for
GPT Actions) and the legacy `X-Bridge-Key: <BRIDGE_API_KEY>` header for manual
tests.
