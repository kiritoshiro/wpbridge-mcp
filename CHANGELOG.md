# Changelog

## Unreleased

- Extend conversation and base64 media uploads to validated audio and PDF files,
  while retaining image optimization and DOCX/ZIP image extraction.
- Use the installed ALPS helper's canonical fingerprint for reads and writes,
  preventing false `alps_edit_conflict` results when REST meta encodings differ.
- Document the reliable large-category workflow: list newest posts in pages of
  50 and process explicit post-ID batches newest-to-oldest.
- Bound large post/page/custom-content reads and Gutenberg block indexes to
  paginated windows while preserving the full content hash required for safe edits.
- Fix category-only query serialization so empty `tags` parameters are omitted; add a safe fallback for fixed, REST-exposed ALPS meta when the helper write route is unavailable.
- Make combined featured-image plus ALPS edits roll back a completed featured-image write when ALPS cannot be applied, and report rollback/partial-update state explicitly.
- Register the ALPS helper write route explicitly for `POST` compatibility with older WordPress REST servers.
- Add an optional ALPS helper adapter for normalized featured-image layout/hide fields, expose featured-image summaries and `featured_image_id` aliases, and add frozen, filtered, chunked bulk plans with conflict-guarded execution and rollback.
- Keep the grouped GPT schema at 13 operations while adding typed bulk prepare/execute/status/rollback actions and concise ALPS/bulk guidance under the 8,000-character instruction limit.
- Add typed, bounded category/tag, parent, attachment, author, exact-ID, date, MIME, sticky, taxonomy-relation, and ordering filters to existing post/page/media/custom-item list actions; request summary fields only for smaller responses.
- Fall back to bounded, same-origin Sharp processing when WordPress recognizes an attachment but its native image editor cannot open the local JPEG, PNG, or WebP file; upload a MIME-extension-correct new derivative and preserve the original.
- Add idempotent, version-checked image rotation, flip, and percentage crop through WordPress's native media editor; transforms create a new attachment and preserve the original.
- Fix the missing constant-time comparison import used by Gutenberg block, revision, taxonomy, and custom-field concurrency guards, and add a real paragraph-block edit regression test.
- Accept regional OpenAI Actions download hosts under the controlled `*.oaiusercontent.com` domain while continuing to reject other and suffix-spoofed domains.
- Diagnose non-downloadable ChatGPT sandbox references clearly, accept subdomains of the documented temporary file host, and direct the GPT to pass original DOCX/ZIP attachments instead of Code Interpreter outputs.
- Accept OpenAI attachment IDs as bounded opaque strings instead of assuming a `file-` prefix that the Actions runtime does not guarantee.
- Extract supported images from attached DOCX and ZIP files through the conversation-image action, with strict archive entry, expanded-size, image-count, signature, and decode limits.
- Add native Custom GPT conversation-image uploads through `openaiFileIdRefs`, restricted temporary OpenAI downloads, bounded batches, pre-upload optimization recommendations, and approval-driven resize/WebP conversion.
- Make the grouped GPT schema importer-compatible by declaring every request body and nested object with explicit properties and emitting an explicit `components.schemas` object.
- Condense Custom GPT instructions below the editor's 8,000-character limit and enforce the limit in CI while retaining grouped-tool, edit-preview, publication, retry, recovery, and safety guidance.
- Add 12 authenticated GPT groups covering all 81 original actions with typed action-specific envelopes and a fixed dispatch allowlist.
- Generate openapi.gpt.yaml for the 30-operation editor limit; keep the full REST API intact. Preserve original handler guards, idempotency and activity targets.
- Add grouped coverage, rejection, auth, publishing, stale-edit and cross-interface retry tests, and CI validation of the generated schema.
- Fix duplicate custom-edit response keys discovered by strict YAML parsing.

## 1.15.1

- Preserve unknown write outcomes when response bodies disconnect, time out, or contain invalid JSON; add regression tests for core, SEO, and media requests.
- Run CI on Windows and Linux with Node 20, 22, and 24, plus PHP helper syntax validation. Schema rendering accepts PUBLIC_BASE_URL from the environment without requiring a local .env file.

- Added optional `DEFAULT_AUTHOR` for newly created posts, pages, and author-enabled allowlisted custom post types. It accepts a numeric WordPress user ID or an exact display name, nickname, or slug.
- Added `ENFORCE_DEFAULT_AUTHOR`; when enabled, creation requests cannot substitute a different `author_id`.
- Added current-user author resolution through `/wp-json/wp/v2/users/me` before broader privacy-filtered author lookup, allowing the existing `chatgpt-bridge` account to be referenced as `SiteOne.lt` without changing its login username.
- Added public health capability flags for configured/enforced default-author policy without exposing the configured author reference.
- Documented WordPress's distinction between nickname and **Display name publicly as**: the public byline is determined by the selected user's WordPress display name.
- Added configuration and endpoint tests for default-author parsing, enforcement, post/page/custom-item creation, and author lookup behavior.
- Updated README, Windows setup, `.env.example`, GPT instructions, OpenAPI descriptions, package/health metadata, and release schema for v1.15.1.

## 1.15.0

- Added persistent privacy-filtered bridge activity history with action, affected item, timestamp, HTTP/outcome state, and request ID. Successful create/upload/reply/term operations enrich the record with the returned WordPress object ID when available.
- Added `ACTIVITY_STORE_PATH`, `ACTIVITY_RETENTION_DAYS`, and `ACTIVITY_MAX_RECORDS`; the local store uses restrictive permissions plus bounded retention/count pruning.
- Activity records reject arbitrary fields and do not retain credentials, WordPress Application Passwords, bridge/API secrets, full post bodies, comment bodies, or uploaded media bytes. Bounded before-values are retained only for changed metadata needed for recovery.
- Link ordinary content edits and Gutenberg edits to matching WordPress revisions before/after the change when available. Revision-covered title/content/excerpt values are not duplicated into the local activity store.
- Added recoverable history for ordinary post/page/custom-item edits, block edits, allowlisted SEO metadata, allowlisted custom fields, allowlisted custom-taxonomy assignments, and successful metadata-only bulk items. Bulk failures/unknown outcomes are logged per affected item.
- Added `listActivity` and `getActivity` for privacy-filtered history inspection.
- Added read-only `restoreActivityPreview` and guarded `restoreActivity`. Recovery requires explicit `confirm=RESTORE_ACTIVITY`, the real current WordPress `conflict_version` returned by the preview, and the exact signed preview token. Changed/stale current state is rejected before WordPress is written.
- Recovery remains subject to `ALLOW_LIVE_EDITS`; restore writes are themselves recorded so they can be reviewed and, where sufficient before-state exists, reversed.
- Expanded automated coverage from 42 to 49 tests, including activity-store persistence/privacy filtering, created-object traceability, revision linkage without body storage, read-only restore previews, mandatory preview tokens, strict activity configuration, and stale-restore conflicts.
- Expanded OpenAPI and GPT instructions for activity history/recovery and updated README, Windows setup, `.env.example`, package/health metadata, and release schema for v1.15.0.

## 1.14.0

- Added persistent idempotency protection for duplicate-prone operations: post/page/custom draft creation, image uploads, category/tag/custom-taxonomy term creation, and public comment replies.
- Accept `idempotency_key` in affected request bodies (or the `Idempotency-Key` header), reject same-key/different-payload reuse with HTTP 409, and coalesce identical concurrent same-key requests.
- Persist outcomes across bridge restarts in a bounded local store. Plaintext idempotency keys are not written to disk; stored records use key hashes, request fingerprints, restrictive file permissions, TTL pruning, and a configurable record cap.
- Distinguish read-only transport failures from mutating requests whose outcome is unknown. Write timeouts/network loss now return `wordpress_write_timeout_outcome_unknown` / `wordpress_write_network_outcome_unknown` with `outcome=unknown` when the write may already have reached WordPress.
- Same-key retries replay persisted success, definite failure, or unknown outcomes instead of issuing a duplicate WordPress write.
- Refactored bulk editorial metadata processing to return per-item `succeeded`, `failed`, or `unknown` outcomes. One bad preflight item no longer blocks unrelated valid items.
- Added `retryable_items` containing only definite write-phase failures; successful items are omitted, stale/preflight failures require correction/refresh, and unknown outcomes require WordPress reconciliation before retry.
- Added overall deadline and bounded concurrency controls for editorial audits (`AUDIT_DEADLINE_MS`, `AUDIT_CONCURRENCY`). Slow audits return HTTP 206 with partial results and `skipped_due_deadline`.
- Added `IDEMPOTENCY_STORE_PATH`, `IDEMPOTENCY_RETENTION_HOURS`, and `IDEMPOTENCY_MAX_RECORDS` startup settings with strict validation.
- Expanded automated coverage from 30 to 42 tests, including persistence across store reloads, key/payload mismatch handling, unknown-outcome replay, resumable bulk results, and audit deadline/concurrency behavior.
- Updated README, GPT instructions, Windows setup, `.env.example`, OpenAPI schema, package/health metadata, and bridge user-agent for v1.14.0.

## 1.13.0

- Added read-only `previewPostEdit`, `previewPageEdit`, and `previewCustomItemEdit` operations for ordinary full-field edits.
- Preview responses show normalized field changes, array additions/removals, and bounded content additions/removals with before/after SHA-256 fingerprints.
- Published-item previews are explicitly flagged with `affects_published_content`; previews remain read-only even when `ALLOW_LIVE_EDITS=false`, while reporting that application is blocked.
- Added signed one-hour `preview_token` values bound to the target item, `modified_gmt`, content fingerprint, and normalized proposed write payload. Preview tokens contain hashes/claims rather than the proposed content.
- Ordinary post/page/custom-item PATCH endpoints accept an optional `preview_token`; stale item versions, changed proposed payloads, expired tokens, invalid signatures, and target mismatches are rejected before a WordPress write.
- Refactored post/page edit-payload parsing so preview and apply use the same normalization/validation path.
- Expanded automated coverage from 24 to 30 tests, including read-only preview behavior, live-content warnings, content additions/removals, exact-payload binding, and stale-preview rejection.
- Expanded OpenAPI implementation/schema parity from 74 to 77 operations and updated README, GPT instructions, Windows setup, package metadata, health metadata, and generated schema for v1.13.0.

## 1.12.0

- Refactored the bridge so `server.js` is a small bootstrap layer and configuration, authentication/rate limiting, request validation, WordPress transport, HTTP helpers, and endpoint handlers live in separate importable modules.
- Preserved the existing 74-operation public API while making endpoint handlers injectable for isolated HTTP tests.
- Added authentication tests for Bearer and legacy `X-Bridge-Key` behavior and explicit rejection of missing/malformed credentials.
- Added endpoint-level tests for authentication gates, publishing permission, stale-edit conflicts, and rejected media uploads.
- Added WordPress transport tests for subdirectory URLs, raw image upload headers/bytes, sanitized upstream errors, network failures, and timeouts.
- Normalize WordPress network failures to `502 wordpress_unreachable` and upstream deadlines to `504 wordpress_timeout` without exposing low-level connection details.
- Added repository-wide JavaScript syntax validation and an OpenAPI implementation check covering all 74 documented method/path operations.
- Updated GitHub Actions to run syntax checks, the full test suite, OpenAPI rendering, and implementation/schema comparison.
- Updated README, Windows setup, OpenAPI version, package metadata, health version, and bridge user-agent.

## 1.11.0

- Strictly validate numeric startup settings (`PORT`, `MAX_BODY_BYTES`, `MAX_MEDIA_BYTES`, and `RATE_LIMIT_PER_MINUTE`) and reject malformed/out-of-range values instead of silently clamping them.
- Preserve WordPress subdirectory paths in every core, SEO-helper, and media REST request.
- Keep the listener on loopback by default; non-loopback `HOST` values now require `ALLOW_EXTERNAL_ACCESS=true`.
- Ignore `CF-Connecting-IP` / `X-Forwarded-For` unless the direct peer is explicitly allowlisted in `TRUSTED_PROXY_IPS`.
- Add `ALLOW_LIVE_EDITS`, independent from `ALLOW_PUBLISH`, and enforce it for published content/blocks, revision restores, SEO, custom taxonomy assignments, custom fields, allowlisted custom-item edits, and bulk editorial metadata.
- Require ordinary post/page/custom-item edits to include a fresh `expected_modified_gmt` or `expected_content_sha256`; stale values return HTTP 409 with the current version/fingerprint.
- Document the remaining narrow check-to-save race in WordPress core REST updates and defer database-level conditional writes because they would complicate normal WordPress revisions/hooks.
- Add Node built-in tests for configuration, proxy trust, live-edit permission, and stale-edit behavior, plus GitHub CI for syntax/tests/OpenAPI rendering.
- Update `.env.example`, README, Windows setup, GPT instructions, OpenAPI schema, health metadata, package version, and bridge user-agent.

## 1.10.0
- Added privacy-filtered WordPress author discovery with `listAuthors` and `getAuthor`.
- Author responses expose only numeric ID, display name, slug, and author link; email, login/username, roles, capabilities, and user meta are never returned by the bridge.
- Added `author_id` support to core post/page draft creation and editing, plus allowlisted custom post types that declare WordPress `author` support.
- Added optional `author_id` filters to post, page, and allowlisted custom-item listing.
- Added `bulkEditEditorialMetadata` for explicitly confirmed metadata-only edits across at most 20 unique items.
- Bulk edits support author assignment and featured-image assignment for supported post types, plus additive category/tag assignment for core posts.
- Bulk edits require `confirm=APPLY_BULK_EDIT` and the latest `modified_gmt` value for every item; stale preflight rejects the entire batch before writes begin.
- Bulk preflight validates referenced authors, image media, categories, and tags before mutation. If WordPress rejects an individual write after preflight, the response reports partial success and does not pretend to roll back earlier successful writes.
- Bulk editing cannot alter title/content/status, publish/unpublish/schedule, remove taxonomy terms, or write arbitrary metadata.
- Expanded the GPT Action schema from 71 to 74 operations.
- Updated OpenAPI, GPT instructions, README, setup notes, package metadata, health metadata, and bridge user-agent.

## 1.9.0
- Added a read-only editorial audit/workflow layer.
- Added `getEditorialStatus` for reusable single-item readiness checks across posts, pages, and allowlisted custom post types.
- Added `auditEditorialContent` for paged heuristic quality checks by post type and status.
- Audit checks cover empty title/content, supported featured image/excerpt, core post category/tag assignments, missing slug, stale draft/pending age, and missing explicit SEO meta description when the safe SEO helper is available.
- Added `getEditorialQueue` for stale drafts, pending-review items, and upcoming scheduled content; allowlisted custom post types are optional and capped for responsiveness.
- Editorial audit/queue endpoints are read-only and do not grant any additional mutation authority.
- Expanded the GPT Action schema from 68 to 71 operations.
- Updated OpenAPI, GPT instructions, README, package metadata, health metadata, and bridge user-agent.

## 1.8.0
- Added per-custom-post-type taxonomy allowlisting through `CUSTOM_TAXONOMY_ALLOWLIST`.
- Added custom-taxonomy discovery for allowlisted custom post types.
- Added search/list and create-term actions for REST-enabled allowlisted custom taxonomies.
- Added hierarchical custom-taxonomy parent filtering and parent assignment on term creation.
- Added custom-item taxonomy assignment reads with per-taxonomy `terms_sha256` fingerprints.
- Added safe additive term assignment and selective term removal while preserving unrelated assignments.
- Custom taxonomy writes reject stale fingerprints and validate requested term IDs against the target taxonomy before updating the custom item.
- The bridge verifies each taxonomy is associated with the requested custom post type and uses the standard `wp/v2` namespace and a simple REST base.
- Core `category`/`post_tag`, taxonomy registration, term deletion/rename, arbitrary taxonomy access, and raw REST proxying remain unavailable.
- Expanded the GPT Action schema from 62 to 68 operations.
- Updated OpenAPI, GPT instructions, README, Windows setup, `.env.example`, health metadata, package version, and bridge user-agent.

## 1.7.0
- Added editorial-workflow parity for allowlisted custom post types.
- Added `submitCustomItemForReview` for draft-to-pending transitions only.
- Added custom-item scheduling/rescheduling with `confirm=SCHEDULE` and `ALLOW_PUBLISH=true`.
- Scheduling accepts only draft, pending, or already-future custom items so it cannot take live/private content offline.
- Added top-level Gutenberg block listing/editing for custom post types that declare WordPress `editor` support.
- Custom block edits use the existing `content_sha256` optimistic lock and explicit `REMOVE_BLOCK` confirmation.
- Added custom-item revision list/read/restore for post types that declare WordPress `revisions` support.
- Custom revision restore requires `confirm=RESTORE_REVISION` plus the fresh current-content hash and preserves publication status.
- Revision restore only applies supported title/content/excerpt fields; custom meta/taxonomies are not restored by the bridge.
- Kept custom taxonomy mutation, delete operations, custom REST controllers, and raw REST proxying out of this release.
- Expanded the GPT Action schema from 55 to 62 operations.
- Updated OpenAPI, GPT instructions, README, Windows setup, health metadata, package version, and bridge user-agent.

## 1.6.0
- Added locally allowlisted custom post type support through `CUSTOM_POST_TYPES`.
- Added custom post type discovery/list/read/draft-create/edit/publish/unpublish actions.
- Custom post type operations resolve WordPress type metadata first and accept only the standard `wp/v2` namespace.
- Custom item editing checks declared post-type supports before sending common fields.
- Added locally allowlisted custom field reads/writes through `CUSTOM_FIELD_ALLOWLIST`.
- Custom fields must already be exposed by WordPress REST meta; the bridge does not register or expose hidden metadata.
- Added optimistic custom-field locking with `custom_fields_sha256` / `expected_custom_fields_sha256`.
- Custom-field writes reject stale fingerprints, unallowlisted keys, non-REST-exposed keys, excessive nesting, and oversized JSON.
- Core `post`, `page`, and `attachment` cannot be configured as generic custom post types.
- Kept custom-type deletion, scheduling, revisions, block editing, generic taxonomy mutation, arbitrary meta, custom REST controllers, and raw REST proxying out of this focused release.
- Expanded the GPT Action schema from 46 to 55 operations.
- Updated OpenAPI, GPT instructions, README, setup documentation, health metadata, package version, and bridge user-agent.

## 1.5.0
- Added optional bundled `WPBridge SEO Helper` WordPress plugin.
- Added `getSeoCapabilities` to detect helper/provider availability.
- Added allowlisted SEO reads/writes for posts and pages.
- Supported SEO providers: Yoast SEO and Rank Math SEO.
- Supported fields: SEO title, meta description, focus keyword, canonical URL,
  Open Graph title, and Open Graph description.
- Added optimistic SEO locking with `seo_sha256` / `expected_seo_sha256`.
- SEO writes refuse provider conflicts and never expose arbitrary post meta.
- Added canonical URL validation and field-length validation.
- Expanded the GPT Action schema from 41 to 46 operations.
- Updated OpenAPI, GPT instructions, README, setup documentation, health metadata,
  package version, and bridge user-agent.

## 1.4.0

- Added moderation-oriented comment listing with `approved`, `hold`, and read-only `spam` filters.
- Added individual comment reads while intentionally omitting commenter email, IP address, and user-agent data.
- Added held-comment approval guarded by `ALLOW_PUBLISH=true` and `confirm=APPROVE_COMMENT`.
- Added approved-comment return-to-hold guarded by `ALLOW_PUBLISH=true` and `confirm=HOLD_COMMENT`.
- Added public replies to already-approved comments guarded by `ALLOW_PUBLISH=true` and `confirm=REPLY_COMMENT`.
- Kept comment delete, trash, spam, and unspam mutation out of the bridge.
- Added read-only site/editorial discovery for sanitized settings, registered post types, taxonomies, statuses, and templates.
- Discovery reports permission/theme-limited sections as unavailable instead of bypassing WordPress permissions.
- Expanded the GPT Action schema from 35 to 41 operations.
- Kept SEO/custom fields and custom-post-type mutation for later focused releases.
- Updated health response, OpenAPI schema, GPT instructions, README, setup notes, package metadata, and safety documentation.

## 1.3.0

- Added post and page scheduling with explicit `confirm=SCHEDULE`.
- Scheduling requires `ALLOW_PUBLISH=true` and accepts only an explicit UTC `scheduled_for_gmt` timestamp.
- Scheduling is limited to `draft`, `pending`, and `future` items so it cannot take a currently published/private item offline.
- Added draft-to-pending review submission for posts and pages; the endpoints cannot unpublish or unschedule content.
- Scheduled (`future`) list queries now return nearest publication dates first.
- Added `date_gmt` and `modified_gmt` to post/page detail and summary responses.
- Added category creation with optional description, slug, and parent.
- Added tag creation with optional description and slug.
- Expanded the GPT Action schema from 29 to 35 operations.
- Kept delete operations, generic REST proxying, comments, SEO/meta, custom post types, users, plugins, themes, and site settings out of this focused batch.
- Updated health response, OpenAPI schema, GPT instructions, README, and Windows setup notes.

## 1.2.0

- Added top-level Gutenberg block listing for posts and pages.
- Added targeted block insert-before/after/start/end and replacement operations.
- Added explicit block removal guarded by `confirm=REMOVE_BLOCK`.
- Added SHA-256 optimistic locking for block edits to reject stale writes with HTTP 409.
- Added `content_sha256` to full post/page detail responses.
- Added post and page revision listing and revision detail reads.
- Added explicit revision restore with `confirm=RESTORE_REVISION` plus current-content hash verification.
- Revision restore preserves publication status and does not expose revision deletion.
- Added malformed Gutenberg structure detection instead of guessing at block boundaries.
- Kept v1.1 media/page/post APIs backward compatible and retained all existing safety restrictions.
- Updated health response, OpenAPI schema, GPT instructions, README, and Windows setup notes.

## 1.1.0

- Added WordPress page listing, reading, draft creation, editing, publishing, and unpublishing.
- Added image Media Library listing/search and metadata reading.
- Added base64 image uploads for JPEG, PNG, WebP, and GIF with MIME/signature validation.
- Added image metadata editing for title, alt text, caption, description, and attachment parent.
- Added featured-media support when creating posts and creating/editing pages.
- Added `MAX_MEDIA_BYTES`; raised the default JSON body limit to accommodate base64 image uploads.
- Kept arbitrary URL fetching, deletion, raw REST proxying, plugin/theme/user management, and shell execution disabled.
- Updated health response, OpenAPI schema, GPT instructions, README, and setup notes.

## 1.0.2

- Added standard Bearer authentication for GPT Actions.
- Kept `X-Bridge-Key` support for backwards compatibility/manual testing.
- Updated OpenAPI security scheme to HTTP Bearer.

## 1.0.1

- Fixed the `createDraft` OpenAPI request schema for ChatGPT Actions.
- Replaced the `allOf` composition with a single explicit object schema so the action is no longer skipped by the schema validator.
- Inlined the `updatePost` request object too, avoiding request-body `$ref` parsing differences in GPT Actions.
