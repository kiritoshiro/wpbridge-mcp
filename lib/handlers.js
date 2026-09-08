import crypto from "node:crypto";
import { translateGptRequest } from "./gpt-api.js";
import { URL } from "node:url";
import { assertCurrentEditVersion, assertLiveEditAllowed } from "./edit-safety.js";
import { buildEditPreview, previewPayloadSha256, verifyPreviewToken } from "./preview.js";
import { bridgeErrorResponse, json, readJson as readJsonBody } from "./http.js";
import { futureGmtForWordPress, integer, optionalIdArray, optionalString } from "./validation.js";
import { createMemoryIdempotencyStore, idempotencyKeyFrom, requestFingerprint } from "./idempotency.js";
import { mapWithConcurrencyUntil } from "./concurrency.js";
import { createMemoryActivityStore } from "./activity.js";
import {
  allowedImageTypes,
  assertImageBytes,
  downloadOpenAiImages,
  imageOptimizationRecommendation,
  normalizeOpenAiFileRefs,
  optimizeImageForWeb,
  safeUploadFilename,
} from "./image-files.js";

export function createRouteHandler({ cfg, wordpress, security, idempotency, activity, fetchImpl = globalThis.fetch }) {
  const { wpRequest, wpSeoHelperRequest, wpImageUpload } = wordpress;
  const { authorized, rateLimited } = security;
  const readJson = (req) => readJsonBody(req, cfg.maxBodyBytes);
  const idempotencyStore = idempotency || createMemoryIdempotencyStore();
  const idempotencyInflight = new Map();
  const activityEnabled = Boolean(activity);
  const activityStore = activity || createMemoryActivityStore();
  let configuredAuthorPromise = null;

  function authorReferenceMatches(user, reference) {
    const expected = String(reference || "").trim().toLowerCase();
    if (!expected) return false;
    return [user?.name, user?.nickname, user?.slug, user?.username]
      .filter((value) => typeof value === "string")
      .some((value) => value.trim().toLowerCase() === expected);
  }

  async function resolveConfiguredAuthor() {
    const configured = cfg.defaultAuthor;
    if (!configured) return null;
    if (configured.kind === "id") return { id: configured.value, source: "configured_id" };

    if (!configuredAuthorPromise) {
      configuredAuthorPromise = (async () => {
        const reference = configured.value;

        // The common case is intentionally cheap and permission-safe: a configured
        // display name/slug matching the authenticated bridge user resolves via /users/me.
        try {
          const me = await wpRequest("/wp-json/wp/v2/users/me?context=edit");
          if (me?.data?.id && authorReferenceMatches(me.data, reference)) {
            return {
              id: Number(me.data.id),
              name: me.data.name || "",
              slug: me.data.slug || "",
              source: "authenticated_user",
            };
          }
        } catch (err) {
          if (![401, 403, 404].includes(err?.status)) throw err;
        }

        let result;
        try {
          const query = new URLSearchParams({
            context: "view",
            search: reference,
            per_page: "50",
          });
          result = await wpRequest(`/wp-json/wp/v2/users?${query}`);
        } catch (err) {
          const wrapped = new Error(
            `DEFAULT_AUTHOR="${reference}" could not be resolved. Configure its numeric WordPress user ID instead, or ensure the bridge can read authors.`
          );
          wrapped.status = 503;
          wrapped.code = "default_author_unresolvable";
          throw wrapped;
        }

        const exact = (Array.isArray(result?.data) ? result.data : []).filter((user) =>
          authorReferenceMatches(user, reference)
        );
        if (exact.length !== 1 || !Number(exact[0]?.id)) {
          const wrapped = new Error(
            exact.length > 1
              ? `DEFAULT_AUTHOR="${reference}" matched more than one WordPress author. Configure the numeric user ID instead.`
              : `DEFAULT_AUTHOR="${reference}" did not exactly match a WordPress author display name, nickname, or slug. Configure the numeric user ID instead.`
          );
          wrapped.status = 503;
          wrapped.code = exact.length > 1 ? "default_author_ambiguous" : "default_author_not_found";
          throw wrapped;
        }
        return {
          id: Number(exact[0].id),
          name: exact[0].name || "",
          slug: exact[0].slug || "",
          source: "author_lookup",
        };
      })().catch((err) => {
        configuredAuthorPromise = null;
        throw err;
      });
    }
    return configuredAuthorPromise;
  }

  async function creationAuthor(body, { supportsAuthor = true, noun = "item" } = {}) {
    const requested =
      body.author_id !== undefined ? integer(body.author_id, "author_id") : undefined;
    if (!cfg.defaultAuthor) return requested;

    if (!supportsAuthor) {
      if (cfg.enforceDefaultAuthor) {
        const err = new Error(
          `The configured default author cannot be enforced because this ${noun} does not support author assignment.`
        );
        err.status = 409;
        err.code = "default_author_not_supported";
        throw err;
      }
      return requested;
    }

    const configured = await resolveConfiguredAuthor();
    if (cfg.enforceDefaultAuthor && requested !== undefined && requested !== configured.id) {
      const err = new Error(
        `This bridge enforces the configured default WordPress author (user ID ${configured.id}).`
      );
      err.status = 403;
      err.code = "default_author_enforced";
      throw err;
    }
    return cfg.enforceDefaultAuthor || requested === undefined ? configured.id : requested;
  }

  function replayIdempotencyRecord(res, record, replayed) {
    const body = record?.response_body && typeof record.response_body === "object"
      ? { ...record.response_body }
      : record?.response_body;
    return json(res, record.status, body, {
      "x-idempotency-state": record.state,
      "x-idempotency-replayed": replayed ? "true" : "false",
      ...(replayed && record.request_id
        ? { "x-idempotency-original-request-id": record.request_id }
        : {}),
    });
  }

  async function idempotentMutation(req, res, requestId, body, scope, run) {
    const key = idempotencyKeyFrom(req, body);
    if (!key) {
      return json(res, 400, {
        error: "idempotency_key_required",
        message:
          "Provide an Idempotency-Key header or idempotency_key body value for operations that can create duplicates.",
        request_id: requestId,
      });
    }
    const fingerprint = requestFingerprint(scope, body);

    // Prefer the live in-process promise so simultaneous identical requests coalesce.
    const inFlight = idempotencyInflight.get(key);
    if (inFlight) {
      if (inFlight.scope !== scope || inFlight.request_fingerprint !== fingerprint) {
        return json(res, 409, {
          error: "idempotency_key_in_flight",
          message: "This idempotency key is currently being used by a different request.",
          request_id: requestId,
        });
      }
      const record = await inFlight.promise;
      return replayIdempotencyRecord(res, record, true);
    }

    const existing = idempotencyStore.get(key);
    if (existing) {
      if (existing.scope !== scope || existing.request_fingerprint !== fingerprint) {
        return json(res, 409, {
          error: "idempotency_key_reused",
          message: "This idempotency key was already used for a different operation or payload.",
          request_id: requestId,
        });
      }
      return replayIdempotencyRecord(res, existing, true);
    }

    // Persist before the upstream write. If the process dies before the final outcome is
    // stored, a restart will replay this conservative unknown marker instead of duplicating
    // a write that may already have committed in WordPress.
    const startedRecord = {
      scope,
      request_fingerprint: fingerprint,
      state: "in_progress",
      status: 409,
      response_body: {
        error: "idempotency_operation_in_progress_or_interrupted",
        message:
          "This operation started but no final outcome is recorded yet. It may still be running or the bridge may have restarted after the write was sent; reconcile WordPress before using a new idempotency key.",
        outcome: "unknown",
        outcome_unknown: true,
        request_id: requestId,
      },
      request_id: requestId,
      created_at: new Date().toISOString(),
      created_at_ms: Date.now(),
    };
    idempotencyStore.put(key, startedRecord);

    const promise = (async () => {
      let status;
      let responseBody;
      let state;
      try {
        const result = await run();
        status = result.status;
        responseBody = result.body;
        state = result.state || (status >= 200 && status < 300 ? "succeeded" : "failed");
      } catch (err) {
        const response = bridgeErrorResponse(err, requestId);
        status = response.status;
        responseBody = response.body;
        state = err?.outcomeUnknown ? "unknown" : "failed";
      }
      const record = {
        scope,
        request_fingerprint: fingerprint,
        state,
        status,
        response_body: responseBody,
        request_id: requestId,
        created_at: startedRecord.created_at,
        created_at_ms: startedRecord.created_at_ms,
        completed_at: new Date().toISOString(),
      };
      idempotencyStore.put(key, record);
      return record;
    })();

    idempotencyInflight.set(key, { scope, request_fingerprint: fingerprint, promise });
    try {
      const record = await promise;
      return replayIdempotencyRecord(res, record, false);
    } finally {
      idempotencyInflight.delete(key);
    }
  }

  function enrichActivity(requestId, patch) {
    if (!activityEnabled) return null;
    try {
      return activityStore.upsertByRequestId(requestId, patch);
    } catch (err) {
      console.error(`Activity log error: ${err?.message || "failed to persist activity"}`);
      return null;
    }
  }

  function appendActivity(requestId, patch) {
    if (!activityEnabled) return null;
    try {
      return activityStore.append({ ...patch, request_id: requestId });
    } catch (err) {
      console.error(`Activity log error: ${err?.message || "failed to persist activity"}`);
      return null;
    }
  }

  function rawFieldValue(item, field) {
    const value = item?.[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, "raw")) return value.raw ?? "";
      if (Object.prototype.hasOwnProperty.call(value, "rendered")) return value.rendered ?? "";
    }
    return value;
  }

  function revisionAdminLink(revisionId) {
    return revisionId ? `${cfg.wpUrl}/wp-admin/revision.php?revision=${revisionId}` : null;
  }

  async function matchingCurrentRevision(restBase, id, current, fields) {
    if (!activityEnabled || !fields.length) return null;
    try {
      const result = await wpRequest(
        `/wp-json/wp/v2/${restBase}/${id}/revisions?context=edit&per_page=5&order=desc`
      );
      for (const revision of Array.isArray(result.data) ? result.data : []) {
        let matches = true;
        for (const field of fields) {
          if (String(rawFieldValue(revision, field) ?? "") !== String(rawFieldValue(current, field) ?? "")) {
            matches = false;
            break;
          }
        }
        if (matches && revision?.id) {
          return {
            id: Number(revision.id),
            admin_url: revisionAdminLink(Number(revision.id)),
          };
        }
      }
    } catch (err) {
      if (![401, 403, 404, 501].includes(err?.status)) {
        console.error(`Revision linkage warning: ${err?.message || "revision lookup failed"}`);
      }
    }
    return null;
  }

  function itemRecoverySnapshot({ postType, restBase, objectId, current, payload, beforeRevision }) {
    const revisionFields = ["title", "content", "excerpt"].filter((field) =>
      Object.prototype.hasOwnProperty.call(payload, field)
    );
    const metadataBefore = {};
    for (const field of Object.keys(payload)) {
      if (revisionFields.includes(field)) continue;
      if (["slug", "categories", "tags", "author", "featured_media", "parent", "menu_order", "template"].includes(field)) {
        metadataBefore[field] = rawFieldValue(current, field);
      }
    }
    const canRestoreRevisionFields = revisionFields.length === 0 || Boolean(beforeRevision?.id);
    const recoverableFields = [
      ...(beforeRevision?.id ? revisionFields : []),
      ...Object.keys(metadataBefore),
    ];
    return {
      kind: "wp_item",
      post_type: postType,
      rest_base: restBase,
      object_id: objectId,
      revision_fields: beforeRevision?.id ? revisionFields : [],
      unavailable_revision_fields: beforeRevision?.id ? [] : revisionFields,
      before_revision_id: beforeRevision?.id || null,
      metadata_before: metadataBefore,
      recoverable_fields: recoverableFields,
      complete: canRestoreRevisionFields,
    };
  }

  async function buildWpItemRestorePayload(entry, current) {
    const recovery = entry?.recovery;
    if (!recovery || recovery.kind !== "wp_item") return null;
    const payload = { ...(recovery.metadata_before || {}) };
    if (recovery.before_revision_id && Array.isArray(recovery.revision_fields) && recovery.revision_fields.length) {
      const revision = await wpRequest(
        `/wp-json/wp/v2/${recovery.rest_base}/${recovery.object_id}/revisions/${recovery.before_revision_id}?context=edit`
      );
      for (const field of recovery.revision_fields) {
        payload[field] = rawFieldValue(revision.data, field);
      }
    }
    return payload;
  }

  async function activityRestoreContext(entry) {
    const recovery = entry?.recovery;
    if (!recovery || !entry?.recoverable) {
      const err = new Error("This activity entry does not contain a recoverable before-state.");
      err.status = 409;
      err.code = "activity_not_recoverable";
      throw err;
    }

    if (recovery.kind === "wp_item") {
      const current = await wpRequest(
        `/wp-json/wp/v2/${recovery.rest_base}/${recovery.object_id}?context=edit`
      );
      const payload = await buildWpItemRestorePayload(entry, current.data);
      if (!payload || !Object.keys(payload).length) {
        const err = new Error("No recoverable fields remain for this activity entry.");
        err.status = 409;
        err.code = "activity_no_recoverable_fields";
        throw err;
      }
      return {
        current: current.data,
        payload,
        target: `activity:${entry.id}`,
        postType: recovery.post_type,
        objectId: recovery.object_id,
        restBase: recovery.rest_base,
        apply: () => wpRequest(`/wp-json/wp/v2/${recovery.rest_base}/${recovery.object_id}`, { method: "POST", body: payload }),
      };
    }

    if (recovery.kind === "seo") {
      const restBase = recovery.post_type === "page" ? "pages" : "posts";
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${recovery.object_id}?context=edit`);
      const seo = await wpSeoHelperRequest(recovery.helper_path);
      const fakeCurrent = {
        ...current.data,
        fields: seo.data?.fields || {},
        content: { raw: seo.data?.seo_sha256 || "" },
      };
      const payload = { fields: recovery.fields_before || {} };
      return {
        current: fakeCurrent,
        conflictCurrent: current.data,
        payload,
        target: `activity:${entry.id}`,
        postType: recovery.post_type, objectId: recovery.object_id, restBase,
        apply: () => wpSeoHelperRequest(recovery.helper_path, {
          method: "POST",
          body: { expected_seo_sha256: seo.data?.seo_sha256, fields: recovery.fields_before || {} },
        }),
      };
    }

    if (recovery.kind === "custom_fields") {
      const current = await wpRequest(`/wp-json/wp/v2/${recovery.rest_base}/${recovery.object_id}?context=edit`);
      const snapshot = customFieldSnapshot(current.data, recovery.post_type);
      const fakeCurrent = {
        ...current.data,
        fields: snapshot.fields,
        content: { raw: snapshot.custom_fields_sha256 },
      };
      const payload = { fields: recovery.fields_before || {} };
      return {
        current: fakeCurrent, conflictCurrent: current.data, payload, target: `activity:${entry.id}`,
        postType: recovery.post_type, objectId: recovery.object_id, restBase: recovery.rest_base,
        apply: () => wpRequest(`/wp-json/wp/v2/${recovery.rest_base}/${recovery.object_id}`, {
          method: "POST", body: { meta: recovery.fields_before || {} },
        }),
      };
    }

    if (recovery.kind === "custom_taxonomy") {
      const current = await wpRequest(`/wp-json/wp/v2/${recovery.type_rest_base}/${recovery.object_id}?context=edit`);
      const snapshot = customTaxonomyAssignmentSnapshot(
        current.data, recovery.post_type, recovery.taxonomy, recovery.taxonomy_rest_base
      );
      const fakeCurrent = {
        ...current.data,
        term_ids: snapshot.term_ids,
        content: { raw: snapshot.terms_sha256 },
      };
      const payload = { term_ids: recovery.term_ids_before || [] };
      return {
        current: fakeCurrent, conflictCurrent: current.data, payload, target: `activity:${entry.id}`,
        postType: recovery.post_type, objectId: recovery.object_id, restBase: recovery.type_rest_base,
        apply: () => wpRequest(`/wp-json/wp/v2/${recovery.type_rest_base}/${recovery.object_id}`, {
          method: "POST", body: { [recovery.taxonomy_rest_base]: recovery.term_ids_before || [] },
        }),
      };
    }

    const err = new Error("This activity recovery type is not supported.");
    err.status = 409;
    err.code = "activity_recovery_type_unsupported";
    throw err;
  }

  function categorySummary(category) {
    return {
      id: category.id,
      name: category.name ?? "",
      slug: category.slug ?? "",
      description: category.description ?? "",
      parent: category.parent ?? 0,
      count: category.count ?? 0,
      link: category.link ?? "",
    };
  }

  function tagSummary(tag) {
    return {
      id: tag.id,
      name: tag.name ?? "",
      slug: tag.slug ?? "",
      description: tag.description ?? "",
      count: tag.count ?? 0,
      link: tag.link ?? "",
    };
  }

  function authorSummary(user) {
    return {
      id: Number(user?.id || 0),
      name: user?.name ?? "",
      slug: user?.slug ?? "",
      link: user?.link ?? "",
    };
  }

  function commentSummary(comment) {
    return {
      id: comment.id,
      post: comment.post ?? 0,
      parent: comment.parent ?? 0,
      status: comment.status ?? "",
      type: comment.type ?? "comment",
      date: comment.date ?? null,
      date_gmt: comment.date_gmt ?? null,
      link: comment.link ?? "",
      author: comment.author ?? 0,
      author_name: comment.author_name ?? "",
      author_url: comment.author_url ?? "",
      content: {
        raw: comment.content?.raw ?? "",
        rendered: comment.content?.rendered ?? "",
      },
    };
  }

  function postTypeSummary(type, slugHint = "") {
    return {
      slug: type?.slug ?? slugHint,
      name: type?.name ?? "",
      description: type?.description ?? "",
      hierarchical: Boolean(type?.hierarchical),
      has_archive: type?.has_archive ?? false,
      rest_base: type?.rest_base ?? "",
      rest_namespace: type?.rest_namespace ?? "wp/v2",
      taxonomies: Array.isArray(type?.taxonomies) ? type.taxonomies : [],
      supports: type?.supports && typeof type.supports === "object" ? type.supports : {},
    };
  }

  function taxonomyDiscoverySummary(taxonomy, slugHint = "") {
    return {
      slug: taxonomy?.slug ?? slugHint,
      name: taxonomy?.name ?? "",
      description: taxonomy?.description ?? "",
      hierarchical: Boolean(taxonomy?.hierarchical),
      rest_base: taxonomy?.rest_base ?? "",
      rest_namespace: taxonomy?.rest_namespace ?? "wp/v2",
      types: Array.isArray(taxonomy?.types) ? taxonomy.types : [],
    };
  }

  function statusSummary(status, slugHint = "") {
    return {
      slug: status?.slug ?? slugHint,
      name: status?.name ?? "",
      public: Boolean(status?.public),
      private: Boolean(status?.private),
      protected: Boolean(status?.protected),
      queryable: Boolean(status?.queryable),
      show_in_list: Boolean(status?.show_in_list),
    };
  }

  function templateSummary(template) {
    return {
      id: template?.id ?? "",
      slug: template?.slug ?? "",
      theme: template?.theme ?? "",
      type: template?.type ?? "",
      source: template?.source ?? "",
      origin: template?.origin ?? "",
      title: template?.title?.rendered ?? template?.title?.raw ?? "",
      description: template?.description ?? "",
      status: template?.status ?? "",
      author: template?.author ?? 0,
      modified: template?.modified ?? null,
    };
  }

  function siteSettingsSummary(settings) {
    if (!settings || typeof settings !== "object") return null;
    return {
      title: settings.title ?? "",
      description: settings.description ?? "",
      url: settings.url ?? cfg.wpUrl,
      timezone: settings.timezone ?? "",
      date_format: settings.date_format ?? "",
      time_format: settings.time_format ?? "",
      start_of_week: settings.start_of_week ?? null,
      language: settings.language ?? "",
      posts_per_page: settings.posts_per_page ?? null,
      show_on_front: settings.show_on_front ?? "",
      page_on_front: settings.page_on_front ?? 0,
      page_for_posts: settings.page_for_posts ?? 0,
      default_category: settings.default_category ?? 0,
      default_post_format: settings.default_post_format ?? "",
      default_comment_status: settings.default_comment_status ?? "",
    };
  }

  function postSummary(post) {
    return {
      id: post.id,
      date: post.date,
      date_gmt: post.date_gmt ?? null,
      modified: post.modified,
      modified_gmt: post.modified_gmt ?? null,
      slug: post.slug,
      status: post.status,
      link: post.link,
      title: post.title?.rendered ?? post.title?.raw ?? "",
      excerpt: post.excerpt?.rendered ?? post.excerpt?.raw ?? "",
      categories: post.categories ?? [],
      tags: post.tags ?? [],
      author: post.author ?? 0,
      featured_media: post.featured_media ?? 0,
    };
  }

  function postDetails(post) {
    return {
      id: post.id,
      date: post.date,
      date_gmt: post.date_gmt ?? null,
      modified: post.modified,
      modified_gmt: post.modified_gmt ?? null,
      slug: post.slug,
      status: post.status,
      link: post.link,
      title: {
        raw: post.title?.raw ?? "",
        rendered: post.title?.rendered ?? "",
      },
      content: {
        raw: post.content?.raw ?? "",
        rendered: post.content?.rendered ?? "",
      },
      content_sha256: sha256Text(post.content?.raw ?? ""),
      excerpt: {
        raw: post.excerpt?.raw ?? "",
        rendered: post.excerpt?.rendered ?? "",
      },
      categories: post.categories ?? [],
      tags: post.tags ?? [],
      author: post.author ?? 0,
      featured_media: post.featured_media ?? 0,
    };
  }

  function pageSummary(page) {
    return {
      id: page.id,
      date: page.date,
      date_gmt: page.date_gmt ?? null,
      modified: page.modified,
      modified_gmt: page.modified_gmt ?? null,
      slug: page.slug,
      status: page.status,
      link: page.link,
      title: page.title?.rendered ?? page.title?.raw ?? "",
      parent: page.parent ?? 0,
      menu_order: page.menu_order ?? 0,
      template: page.template ?? "",
      author: page.author ?? 0,
      featured_media: page.featured_media ?? 0,
    };
  }

  function pageDetails(page) {
    return {
      id: page.id,
      date: page.date,
      date_gmt: page.date_gmt ?? null,
      modified: page.modified,
      modified_gmt: page.modified_gmt ?? null,
      slug: page.slug,
      status: page.status,
      link: page.link,
      title: {
        raw: page.title?.raw ?? "",
        rendered: page.title?.rendered ?? "",
      },
      content: {
        raw: page.content?.raw ?? "",
        rendered: page.content?.rendered ?? "",
      },
      content_sha256: sha256Text(page.content?.raw ?? ""),
      parent: page.parent ?? 0,
      menu_order: page.menu_order ?? 0,
      template: page.template ?? "",
      author: page.author ?? 0,
      featured_media: page.featured_media ?? 0,
    };
  }

  function rejectStatusChange(body, noun = "item") {
    if (!("status" in body)) return;
    const err = new Error(`Use the dedicated ${noun} publish/unpublish action for visibility changes.`);
    err.status = 400;
    err.code = "status_not_allowed_here";
    throw err;
  }

  function postEditPayload(body) {
    rejectStatusChange(body, "post");
    const payload = {};
    for (const [field, maxLen] of [
      ["title", 500],
      ["content", 1_000_000],
      ["excerpt", 20_000],
      ["slug", 250],
    ]) {
      const value = optionalString(body[field], field, maxLen);
      if (value !== undefined) payload[field] = value;
    }
    const categories = optionalIdArray(body.category_ids, "category_ids");
    const tags = optionalIdArray(body.tag_ids, "tag_ids");
    if (categories !== undefined) payload.categories = categories;
    if (tags !== undefined) payload.tags = tags;
    if (body.author_id !== undefined) payload.author = integer(body.author_id, "author_id");
    if (body.featured_media !== undefined) {
      payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
    }
    if (!Object.keys(payload).length) {
      const err = new Error("No editable post fields were supplied.");
      err.status = 400;
      err.code = "no_editable_fields_supplied";
      throw err;
    }
    return payload;
  }

  function pageEditPayload(body) {
    rejectStatusChange(body, "page");
    const payload = {};
    for (const [field, maxLen] of [
      ["title", 500],
      ["content", 1_000_000],
      ["slug", 250],
      ["template", 250],
    ]) {
      const value = optionalString(body[field], field, maxLen);
      if (value !== undefined) payload[field] = value;
    }
    if (body.parent !== undefined) payload.parent = integer(body.parent, "parent", { min: 0 });
    if (body.menu_order !== undefined) {
      payload.menu_order = integer(body.menu_order, "menu_order", { min: 0, max: 1_000_000 });
    }
    if (body.author_id !== undefined) payload.author = integer(body.author_id, "author_id");
    if (body.featured_media !== undefined) {
      payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
    }
    if (!Object.keys(payload).length) {
      const err = new Error("No editable page fields were supplied.");
      err.status = 400;
      err.code = "no_editable_fields_supplied";
      throw err;
    }
    return payload;
  }

  function maybeAssertPreviewInputVersion(body, current) {
    if (body.expected_modified_gmt !== undefined || body.expected_content_sha256 !== undefined) {
      assertCurrentEditVersion(body, current, sha256Text);
    }
  }

  function verifySuppliedPreview(body, target, current, payload) {
    const token = optionalString(body.preview_token, "preview_token", 4096);
    if (token === undefined) return;
    verifyPreviewToken(token, {
      secret: cfg.bridgeApiKey,
      target,
      currentModifiedGmt: current?.modified_gmt || null,
      currentContentSha256: sha256Text(current?.content?.raw ?? ""),
      payloadSha256: previewPayloadSha256(payload),
    });
  }

  function editPreview(target, current, payload) {
    return buildEditPreview({
      secret: cfg.bridgeApiKey,
      target,
      current,
      payload,
      allowLiveEdits: cfg.allowLiveEdits,
    });
  }


  function sha256Text(value) {
    return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
  }

  function textPreview(value, maxLen = 180) {
    return String(value ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
  }

  function parseGutenbergContent(content) {
    const source = String(content ?? "");
    const tokenRe = /<!--\s*(\/?)wp:([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)\b([\s\S]*?)-->/g;
    const units = [];
    const stack = [];
    let current = null;
    let cursor = 0;
    let match;

    const pushFreeform = (start, end) => {
      if (end <= start) return;
      const serialized = source.slice(start, end);
      if (!serialized.trim()) return;
      units.push({
        name: "core/freeform",
        freeform: true,
        attributes: null,
        start,
        end,
        serialized,
      });
    };

    while ((match = tokenRe.exec(source)) !== null) {
      const isClosing = match[1] === "/";
      const name = match[2];
      const tail = match[3] || "";
      const isSelfClosing = !isClosing && /\/\s*$/.test(tail);
      const tokenEnd = tokenRe.lastIndex;

      if (!isClosing) {
        if (stack.length === 0) {
          pushFreeform(cursor, match.index);
          let attributes = null;
          const rawAttrs = tail.replace(/\/\s*$/, "").trim();
          if (rawAttrs) {
            try {
              const parsed = JSON.parse(rawAttrs);
              attributes =
                parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
            } catch {
              attributes = null;
            }
          }
          current = { name, attributes, start: match.index };
          if (isSelfClosing) {
            const serialized = source.slice(match.index, tokenEnd);
            units.push({
              name,
              freeform: false,
              attributes,
              start: match.index,
              end: tokenEnd,
              serialized,
            });
            cursor = tokenEnd;
            current = null;
          } else {
            stack.push(name);
          }
        } else if (!isSelfClosing) {
          stack.push(name);
        }
        continue;
      }

      if (stack.length === 0) {
        const err = new Error(`Malformed Gutenberg markup: unexpected closing block ${name}.`);
        err.status = 422;
        err.code = "malformed_gutenberg";
        throw err;
      }
      const expected = stack[stack.length - 1];
      if (expected !== name) {
        const err = new Error(
          `Malformed Gutenberg markup: closing block ${name} does not match ${expected}.`
        );
        err.status = 422;
        err.code = "malformed_gutenberg";
        throw err;
      }
      stack.pop();
      if (stack.length === 0 && current) {
        const serialized = source.slice(current.start, tokenEnd);
        units.push({
          name: current.name,
          freeform: false,
          attributes: current.attributes,
          start: current.start,
          end: tokenEnd,
          serialized,
        });
        cursor = tokenEnd;
        current = null;
      }
    }

    if (stack.length) {
      const err = new Error(`Malformed Gutenberg markup: unclosed block ${stack[stack.length - 1]}.`);
      err.status = 422;
      err.code = "malformed_gutenberg";
      throw err;
    }
    pushFreeform(cursor, source.length);

    return units.map((unit, index) => ({
      ...unit,
      name:
        unit.freeform || unit.name.includes("/") ? unit.name : `core/${unit.name}`,
      index,
      sha256: sha256Text(unit.serialized),
      preview: textPreview(unit.serialized),
    }));
  }

  function blockList(content) {
    const source = String(content ?? "");
    const units = parseGutenbergContent(source);
    return {
      content_sha256: sha256Text(source),
      block_count: units.length,
      blocks: units.map(({ start, end, ...unit }) => unit),
    };
  }

  function validateSingleBlockMarkup(value) {
    const markup = optionalString(value, "block_markup", 250_000);
    if (markup === undefined || !markup.trim()) {
      const err = new Error("block_markup is required for this block operation.");
      err.status = 400;
      throw err;
    }
    const trimmed = markup.trim();
    const units = parseGutenbergContent(trimmed);
    if (
      units.length !== 1 ||
      units[0].freeform ||
      units[0].start !== 0 ||
      units[0].end !== trimmed.length
    ) {
      const err = new Error("block_markup must contain exactly one serialized Gutenberg block.");
      err.status = 400;
      err.code = "single_block_required";
      throw err;
    }
    return trimmed;
  }

  function mutateBlockContent(content, body) {
    const source = String(content ?? "");
    const expectedHash = optionalString(body.expected_content_sha256, "expected_content_sha256", 64);
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      const err = new Error("expected_content_sha256 must be a 64-character SHA-256 hex digest.");
      err.status = 400;
      throw err;
    }
    const actualHash = sha256Text(source);
    if (!safeEqual(expectedHash.toLowerCase(), actualHash)) {
      const err = new Error(
        "Content changed since it was read. Read the blocks again before applying the edit."
      );
      err.status = 409;
      err.code = "content_changed";
      throw err;
    }

    const operation = optionalString(body.operation, "operation", 30);
    const allowed = new Set(["insert_start", "insert_end", "insert_before", "insert_after", "replace", "remove"]);
    if (!operation || !allowed.has(operation)) {
      const err = new Error(`operation must be one of: ${[...allowed].join(", ")}.`);
      err.status = 400;
      throw err;
    }

    const units = parseGutenbergContent(source);
    let target = null;
    if (["insert_before", "insert_after", "replace", "remove"].includes(operation)) {
      const index = integer(body.block_index, "block_index", { min: 0, max: 100000 });
      target = units[index];
      if (!target) {
        const err = new Error(`block_index ${index} does not exist in the current content.`);
        err.status = 400;
        err.code = "block_index_not_found";
        throw err;
      }
    }

    if (operation === "remove") {
      if (body.confirm !== "REMOVE_BLOCK") {
        const err = new Error('Removing a block requires confirm="REMOVE_BLOCK".');
        err.status = 400;
        err.code = "explicit_confirmation_required";
        throw err;
      }
      return source.slice(0, target.start) + source.slice(target.end);
    }

    const markup = validateSingleBlockMarkup(body.block_markup);
    if (operation === "replace") {
      return source.slice(0, target.start) + markup + source.slice(target.end);
    }

    let position;
    if (operation === "insert_start") position = 0;
    else if (operation === "insert_end") position = source.length;
    else if (operation === "insert_before") position = target.start;
    else position = target.end;

    const before = source.slice(0, position);
    const after = source.slice(position);
    const leftSep = before && !/\s$/.test(before) ? "\n\n" : "";
    const rightSep = after && !/^\s/.test(after) ? "\n\n" : "";
    return before + leftSep + markup + rightSep + after;
  }

  function revisionSummary(revision) {
    const rawContent = revision.content?.raw ?? revision.content?.rendered ?? "";
    return {
      id: revision.id,
      parent: revision.parent,
      date: revision.date,
      date_gmt: revision.date_gmt,
      modified: revision.modified,
      modified_gmt: revision.modified_gmt,
      author: revision.author,
      slug: revision.slug,
      title: revision.title?.raw ?? revision.title?.rendered ?? "",
      content_sha256: sha256Text(rawContent),
      content_preview: textPreview(rawContent),
    };
  }

  function revisionDetails(revision) {
    return {
      ...revisionSummary(revision),
      title: {
        raw: revision.title?.raw ?? revision.title?.rendered ?? "",
        rendered: revision.title?.rendered ?? "",
      },
      content: {
        raw: revision.content?.raw ?? revision.content?.rendered ?? "",
        rendered: revision.content?.rendered ?? "",
      },
      excerpt: {
        raw: revision.excerpt?.raw ?? revision.excerpt?.rendered ?? "",
        rendered: revision.excerpt?.rendered ?? "",
      },
    };
  }

  function mediaSummary(media) {
    const details = media.media_details || {};
    return {
      id: media.id,
      date: media.date,
      modified: media.modified,
      slug: media.slug,
      status: media.status,
      link: media.link,
      title: media.title?.rendered ?? media.title?.raw ?? "",
      alt_text: media.alt_text ?? "",
      caption: media.caption?.rendered ?? media.caption?.raw ?? "",
      description: media.description?.rendered ?? media.description?.raw ?? "",
      mime_type: media.mime_type ?? "",
      media_type: media.media_type ?? "",
      source_url: media.source_url ?? "",
      attached_to: media.post ?? 0,
      width: details.width ?? null,
      height: details.height ?? null,
      filesize: details.filesize ?? null,
    };
  }

  function decodeImageBase64(value, mimeType) {
    if (typeof value !== "string" || !value.length) {
      const err = new Error("data_base64 must be a non-empty base64 string.");
      err.status = 400;
      throw err;
    }
    if (/^data:/i.test(value)) {
      const err = new Error("data_base64 must contain raw base64 only, not a data: URL.");
      err.status = 400;
      throw err;
    }
    const compact = value.replace(/\s+/g, "");
    if (
      !compact.length ||
      compact.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
    ) {
      const err = new Error("data_base64 is not valid base64.");
      err.status = 400;
      throw err;
    }
    const data = Buffer.from(compact, "base64");
    return assertImageBytes(data, mimeType, cfg.maxMediaBytes);
  }


  function seoHelperUnavailable(err) {
    return err?.status === 404 && ["rest_no_route", "wpbridge_seo_not_available"].includes(err?.code || "rest_no_route");
  }

  function seoWritePayload(body) {
    const expectedHash = optionalString(body.expected_seo_sha256, "expected_seo_sha256", 64);
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      const err = new Error("expected_seo_sha256 must be a 64-character SHA-256 hex digest.");
      err.status = 400;
      throw err;
    }

    const fields = {};
    for (const [field, maxLen] of [
      ["title", 1000],
      ["description", 3000],
      ["focus_keyword", 1000],
      ["canonical_url", 2048],
      ["og_title", 1000],
      ["og_description", 3000],
    ]) {
      const value = optionalString(body[field], field, maxLen);
      if (value !== undefined) fields[field] = value;
    }

    if ("canonical_url" in fields && fields.canonical_url.trim()) {
      let canonical;
      try {
        canonical = new URL(fields.canonical_url);
      } catch {
        const err = new Error("canonical_url must be an absolute HTTP(S) URL or an empty string to clear it.");
        err.status = 400;
        throw err;
      }
      if (!["http:", "https:"].includes(canonical.protocol)) {
        const err = new Error("canonical_url must use HTTP or HTTPS.");
        err.status = 400;
        throw err;
      }
    }

    if (!Object.keys(fields).length) {
      const err = new Error("At least one supported SEO field must be supplied.");
      err.status = 400;
      throw err;
    }

    return {
      expected_seo_sha256: expectedHash.toLowerCase(),
      fields,
    };
  }



  function makeQuery(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
    return q.toString();
  }


  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function customFieldFingerprint(meta, keys) {
    const normalized = {};
    for (const key of [...keys].sort()) {
      normalized[key] = Object.prototype.hasOwnProperty.call(meta || {}, key)
        ? meta[key]
        : { __wpbridge_missing__: true };
    }
    return sha256Text(stableJson(normalized));
  }

  function validateCustomFieldValue(value, fieldName, depth = 0) {
    if (depth > 5) {
      const err = new Error(`${fieldName} custom field value is nested too deeply.`);
      err.status = 400;
      throw err;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        const err = new Error(`${fieldName} custom field number must be finite.`);
        err.status = 400;
        throw err;
      }
      return value;
    }
    if (typeof value === "string") {
      if (value.length > 20_000) {
        const err = new Error(`${fieldName} custom field string exceeds 20000 characters.`);
        err.status = 400;
        throw err;
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 100) {
        const err = new Error(`${fieldName} custom field array exceeds 100 items.`);
        err.status = 400;
        throw err;
      }
      return value.map((entry) => validateCustomFieldValue(entry, fieldName, depth + 1));
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 100) {
        const err = new Error(`${fieldName} custom field object exceeds 100 keys.`);
        err.status = 400;
        throw err;
      }
      const out = {};
      for (const [key, entry] of entries) {
        if (key.length > 191) {
          const err = new Error(`${fieldName} custom field object contains an overlong key.`);
          err.status = 400;
          throw err;
        }
        out[key] = validateCustomFieldValue(entry, fieldName, depth + 1);
      }
      return out;
    }
    const err = new Error(`${fieldName} custom field value must be valid JSON data.`);
    err.status = 400;
    throw err;
  }

  function customItemSummary(item, typeSlug) {
    return {
      id: item?.id ?? 0,
      type: item?.type ?? typeSlug,
      date: item?.date ?? null,
      date_gmt: item?.date_gmt ?? null,
      modified: item?.modified ?? null,
      modified_gmt: item?.modified_gmt ?? null,
      slug: item?.slug ?? "",
      status: item?.status ?? "",
      link: item?.link ?? "",
      title: item?.title?.rendered ?? item?.title?.raw ?? "",
      excerpt: item?.excerpt?.rendered ?? item?.excerpt?.raw ?? "",
      author: item?.author ?? 0,
      featured_media: item?.featured_media ?? 0,
      parent: item?.parent ?? 0,
      menu_order: item?.menu_order ?? 0,
    };
  }

  function customItemDetails(item, typeSlug) {
    return {
      ...customItemSummary(item, typeSlug),
      title: {
        raw: item?.title?.raw ?? "",
        rendered: item?.title?.rendered ?? "",
      },
      content: {
        raw: item?.content?.raw ?? "",
        rendered: item?.content?.rendered ?? "",
      },
      content_sha256: sha256Text(item?.content?.raw ?? ""),
      excerpt: {
        raw: item?.excerpt?.raw ?? "",
        rendered: item?.excerpt?.rendered ?? "",
      },
    };
  }

  function customTypeBridgeSummary(type, slugHint = "") {
    const base = postTypeSummary(type, slugHint);
    return {
      ...base,
      configured: true,
      writable_via_bridge:
        (type?.rest_namespace ?? "wp/v2") === "wp/v2" &&
        /^[a-z0-9_-]+$/.test(type?.rest_base || type?.slug || slugHint),
      allowlisted_custom_fields: cfg.customFieldAllowlist.get(type?.slug ?? slugHint) || [],
      allowlisted_custom_taxonomies:
        cfg.customTaxonomyAllowlist.get(type?.slug ?? slugHint) || [],
    };
  }

  async function resolveCustomType(typeSlug, { timeoutMs } = {}) {
    if (!cfg.customPostTypes.includes(typeSlug)) {
      const err = new Error(`Custom post type "${typeSlug}" is not allowlisted in CUSTOM_POST_TYPES.`);
      err.status = 403;
      err.code = "custom_type_not_allowlisted";
      throw err;
    }

    let result;
    try {
      result = await wpRequest(`/wp-json/wp/v2/types/${typeSlug}?context=edit`, { timeoutMs });
    } catch (err) {
      if (err?.status === 404) {
        err.code = "custom_type_not_rest_enabled";
        err.message =
          `Custom post type "${typeSlug}" is allowlisted locally but is not exposed by the WordPress REST API.`;
      }
      throw err;
    }
    const type = result.data || {};
    const namespace = type.rest_namespace || "wp/v2";
    const restBase = type.rest_base || type.slug || typeSlug;
    if (namespace !== "wp/v2" || !/^[a-z0-9_-]+$/.test(restBase)) {
      const err = new Error(
        `Custom post type "${typeSlug}" must use the standard wp/v2 namespace and a simple REST base.`
      );
      err.status = 409;
      err.code = "custom_type_controller_not_supported";
      throw err;
    }
    return { type, restBase };
  }

  async function resolveEditableType(typeSlug) {
    if (typeSlug === "post") return { typeSlug, restBase: "posts", type: { slug: "post" } };
    if (typeSlug === "page") return { typeSlug, restBase: "pages", type: { slug: "page" } };
    const resolved = await resolveCustomType(typeSlug);
    return { typeSlug, ...resolved };
  }

  function boolQueryValue(value, name, defaultValue = false) {
    if (value === null || value === undefined || value === "") return defaultValue;
    const raw = String(value).toLowerCase();
    if (["1", "true", "yes"].includes(raw)) return true;
    if (["0", "false", "no"].includes(raw)) return false;
    const err = new Error(`${name} must be true or false.`);
    err.status = 400;
    throw err;
  }

  function editorialIssue(code, severity, message) {
    return { code, severity, message };
  }

  async function resolveEditorialType(typeSlug, { timeoutMs } = {}) {
    if (typeSlug === "post" || typeSlug === "page") {
      const restBase = typeSlug === "post" ? "posts" : "pages";
      let type = { slug: typeSlug, supports: {} };
      try {
        const result = await wpRequest(`/wp-json/wp/v2/types/${typeSlug}?context=edit`, { timeoutMs });
        if (result?.data && typeof result.data === "object") type = result.data;
      } catch (err) {
        if (err?.status !== 403 && err?.status !== 404) throw err;
      }
      return { typeSlug, restBase, type };
    }
    const resolved = await resolveCustomType(typeSlug, { timeoutMs });
    return { typeSlug, ...resolved };
  }

  async function editorialSeoCapabilitiesSafe(timeoutMs) {
    try {
      const result = await wpSeoHelperRequest("/wp-json/wpbridge/v1/seo/capabilities", { timeoutMs });
      return {
        available: Boolean(result.data?.available),
        helper_installed: Boolean(result.data?.helper_installed),
        provider: result.data?.provider || "none",
        writable_fields: Array.isArray(result.data?.writable_fields)
          ? result.data.writable_fields
          : [],
      };
    } catch (err) {
      if (seoHelperUnavailable(err)) {
        return {
          available: false,
          helper_installed: false,
          provider: "none",
          writable_fields: [],
        };
      }
      return {
        available: false,
        helper_installed: null,
        provider: "unknown",
        writable_fields: [],
        error: String(err?.message || "SEO capability check failed.").slice(0, 300),
      };
    }
  }

  async function editorialSeoForItem(typeSlug, id, capabilities, timeoutMs) {
    if (!["post", "page"].includes(typeSlug)) {
      return {
        checked: false,
        available: false,
        reason: "seo_helper_supports_core_posts_and_pages_only",
      };
    }
    if (!capabilities?.available) {
      return {
        checked: false,
        available: false,
        provider: capabilities?.provider || "none",
        helper_installed: capabilities?.helper_installed ?? null,
        ...(capabilities?.error ? { error: capabilities.error } : {}),
      };
    }
    try {
      const helperPath = `/wp-json/wpbridge/v1/seo/${typeSlug}/${id}`;
      const result = await wpSeoHelperRequest(helperPath, { timeoutMs });
      return {
        checked: true,
        available: Boolean(result.data?.available),
        provider: result.data?.provider || capabilities.provider || "unknown",
        fields: result.data?.fields && typeof result.data.fields === "object"
          ? result.data.fields
          : {},
        seo_sha256: result.data?.seo_sha256 || null,
      };
    } catch (err) {
      return {
        checked: false,
        available: false,
        provider: capabilities?.provider || "unknown",
        error: String(err?.message || "SEO metadata check failed.").slice(0, 300),
      };
    }
  }

  function editorialStatusForItem(item, typeSlug, type, { staleDays = 30, seo = null } = {}) {
    const supports =
      type?.supports && typeof type.supports === "object" ? type.supports : {};
    const title = item?.title?.raw ?? item?.title?.rendered ?? "";
    const content = item?.content?.raw ?? item?.content?.rendered ?? "";
    const excerpt = item?.excerpt?.raw ?? item?.excerpt?.rendered ?? "";
    const modified = item?.modified_gmt || item?.modified || null;
    const modifiedMs = item?.modified_gmt
      ? Date.parse(`${item.modified_gmt}Z`)
      : item?.modified
        ? Date.parse(item.modified)
        : NaN;
    const staleCutoff = Date.now() - staleDays * 86400000;
    const stale =
      ["draft", "pending"].includes(item?.status) &&
      Number.isFinite(modifiedMs) &&
      modifiedMs < staleCutoff;

    const checks = {
      title_present: Boolean(textPreview(title, 2)),
      content_present: Boolean(textPreview(content, 2)),
      featured_image_present:
        !supports.thumbnail || Number(item?.featured_media || 0) > 0,
      excerpt_present:
        !supports.excerpt || Boolean(textPreview(excerpt, 2)),
      categories_present:
        typeSlug !== "post" ||
        (Array.isArray(item?.categories) && item.categories.length > 0),
      tags_present:
        typeSlug !== "post" ||
        (Array.isArray(item?.tags) && item.tags.length > 0),
      slug_present: Boolean(String(item?.slug || "").trim()),
      stale_draft_or_pending: stale,
      seo_description_present:
        seo?.checked && seo?.available
          ? Boolean(String(seo?.fields?.description || "").trim())
          : null,
    };

    const issues = [];
    if (!checks.title_present) {
      issues.push(editorialIssue("missing_title", "error", "Title is empty."));
    }
    if (!checks.content_present) {
      issues.push(editorialIssue("missing_content", "error", "Content is empty."));
    }
    if (supports.thumbnail && !checks.featured_image_present) {
      issues.push(
        editorialIssue(
          "missing_featured_image",
          "warning",
          "The post type supports featured images but none is assigned."
        )
      );
    }
    if (supports.excerpt && !checks.excerpt_present) {
      issues.push(
        editorialIssue("missing_excerpt", "warning", "Excerpt is empty.")
      );
    }
    if (typeSlug === "post" && !checks.categories_present) {
      issues.push(
        editorialIssue("missing_category", "warning", "No category is assigned.")
      );
    }
    if (typeSlug === "post" && !checks.tags_present) {
      issues.push(editorialIssue("missing_tags", "info", "No tags are assigned."));
    }
    if (!checks.slug_present) {
      issues.push(editorialIssue("missing_slug", "warning", "Slug is empty."));
    }
    if (stale) {
      issues.push(
        editorialIssue(
          "stale_editorial_item",
          "info",
          `This ${item?.status || "editorial"} item has not been modified in at least ${staleDays} days.`
        )
      );
    }
    if (seo?.checked && seo?.available && !checks.seo_description_present) {
      issues.push(
        editorialIssue(
          "missing_seo_description",
          "warning",
          "The supported SEO provider has no explicit meta description for this item."
        )
      );
    }

    return {
      id: item?.id ?? 0,
      post_type: typeSlug,
      status: item?.status ?? "",
      link: item?.link ?? "",
      title: item?.title?.rendered ?? item?.title?.raw ?? "",
      slug: item?.slug ?? "",
      date: item?.date ?? null,
      date_gmt: item?.date_gmt ?? null,
      modified: item?.modified ?? null,
      modified_gmt: item?.modified_gmt ?? null,
      featured_media: item?.featured_media ?? 0,
      checks,
      issues,
      issue_count: issues.length,
      has_errors: issues.some((issue) => issue.severity === "error"),
      seo: seo || { checked: false, available: false },
    };
  }

  async function fetchEditorialItems(typeSlug, status, perPage, page, orderby, order, { timeoutMs } = {}) {
    const { type, restBase } = await resolveEditorialType(typeSlug, { timeoutMs });
    const query = makeQuery({
      context: "edit",
      status,
      per_page: perPage,
      page,
      orderby,
      order,
    });
    const result = await wpRequest(`/wp-json/wp/v2/${restBase}?${query}`, { timeoutMs });
    return {
      type,
      restBase,
      items: Array.isArray(result.data) ? result.data : [],
      total: Number(result.headers.get("x-wp-total") || 0),
      total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
    };
  }


  function taxonomyTermSummary(term, taxonomySlug) {
    return {
      id: term?.id ?? 0,
      taxonomy: term?.taxonomy ?? taxonomySlug,
      name: term?.name ?? "",
      slug: term?.slug ?? "",
      description: term?.description ?? "",
      parent: term?.parent ?? 0,
      count: term?.count ?? 0,
      link: term?.link ?? "",
    };
  }

  function taxonomyTermsFingerprint(termIds) {
    const ids = Array.isArray(termIds)
      ? [...new Set(termIds.map((id) => Number(id)).filter(Number.isInteger))].sort((a, b) => a - b)
      : [];
    return sha256Text(stableJson(ids));
  }

  async function resolveCustomTaxonomyForType(typeSlug, taxonomySlug) {
    const configured = cfg.customTaxonomyAllowlist.get(typeSlug) || [];
    if (!configured.includes(taxonomySlug)) {
      const err = new Error(
        `Custom taxonomy "${taxonomySlug}" is not allowlisted for "${typeSlug}" in CUSTOM_TAXONOMY_ALLOWLIST.`
      );
      err.status = 403;
      err.code = "custom_taxonomy_not_allowlisted";
      throw err;
    }

    const customType = await resolveCustomType(typeSlug);
    let result;
    try {
      result = await wpRequest(`/wp-json/wp/v2/taxonomies/${taxonomySlug}?context=edit`);
    } catch (err) {
      if (err?.status === 404) {
        err.code = "custom_taxonomy_not_rest_enabled";
        err.message =
          `Custom taxonomy "${taxonomySlug}" is allowlisted locally but is not exposed by the WordPress REST API.`;
      }
      throw err;
    }

    const taxonomy = result.data || {};
    const namespace = taxonomy.rest_namespace || "wp/v2";
    const restBase = taxonomy.rest_base || taxonomy.slug || taxonomySlug;
    if (namespace !== "wp/v2" || !/^[a-z0-9_-]+$/.test(restBase)) {
      const err = new Error(
        `Custom taxonomy "${taxonomySlug}" must use the standard wp/v2 namespace and a simple REST base.`
      );
      err.status = 409;
      err.code = "custom_taxonomy_controller_not_supported";
      throw err;
    }

    const associatedTypes = Array.isArray(taxonomy.types) ? taxonomy.types : [];
    if (!associatedTypes.includes(typeSlug)) {
      const err = new Error(
        `Custom taxonomy "${taxonomySlug}" is not associated with custom post type "${typeSlug}" in WordPress.`
      );
      err.status = 409;
      err.code = "custom_taxonomy_type_mismatch";
      throw err;
    }

    return {
      taxonomy,
      taxonomyRestBase: restBase,
      type: customType.type,
      typeRestBase: customType.restBase,
    };
  }

  function customTaxonomyAssignmentSnapshot(item, typeSlug, taxonomySlug, taxonomyRestBase) {
    const raw = item?.[taxonomyRestBase];
    const available = Array.isArray(raw);
    const termIds = available
      ? [...new Set(raw.map((id) => Number(id)).filter(Number.isInteger))].sort((a, b) => a - b)
      : [];

    return {
      post_type: typeSlug,
      object_id: item?.id ?? 0,
      taxonomy: taxonomySlug,
      rest_base: taxonomyRestBase,
      term_ids: termIds,
      terms_sha256: taxonomyTermsFingerprint(termIds),
      rest_field_available: available,
    };
  }

  function customFieldSnapshot(item, typeSlug) {
    const keys = cfg.customFieldAllowlist.get(typeSlug) || [];
    const meta = item?.meta && typeof item.meta === "object" && !Array.isArray(item.meta) ? item.meta : {};
    const fields = {};
    const unavailable = [];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(meta, key)) fields[key] = meta[key];
      else unavailable.push(key);
    }
    return {
      post_type: typeSlug,
      object_id: item?.id ?? 0,
      fields,
      unavailable_keys: unavailable,
      custom_fields_sha256: customFieldFingerprint(meta, keys),
      note:
        unavailable.length
          ? "Unavailable keys are allowlisted locally but are not exposed in this item's WordPress REST meta response."
          : "Only locally allowlisted WordPress REST-exposed meta keys are returned.",
    };
  }

  function customItemPayload(body, type, { creating = false } = {}) {
    if ("status" in body) {
      const err = new Error("Status changes require a dedicated publish/unpublish action.");
      err.status = 400;
      err.code = "status_not_allowed_here";
      throw err;
    }

    const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
    const payload = {};
    const supportChecks = [
      ["title", "title", 500],
      ["content", "editor", 1_000_000],
      ["excerpt", "excerpt", 20_000],
    ];
    for (const [field, supportName, maxLen] of supportChecks) {
      if (body[field] === undefined) continue;
      if (!supports[supportName]) {
        const err = new Error(`The custom post type does not declare support for "${supportName}".`);
        err.status = 400;
        err.code = "field_not_supported";
        throw err;
      }
      payload[field] = optionalString(body[field], field, maxLen);
    }

    const slug = optionalString(body.slug, "slug", 250);
    if (slug !== undefined) payload.slug = slug;

    if (body.author_id !== undefined) {
      if (!supports.author) {
        const err = new Error('The custom post type does not declare support for "author".');
        err.status = 400;
        err.code = "field_not_supported";
        throw err;
      }
      payload.author = integer(body.author_id, "author_id");
    }

    if (body.featured_media !== undefined) {
      if (!supports.thumbnail) {
        const err = new Error('The custom post type does not declare support for "thumbnail".');
        err.status = 400;
        err.code = "field_not_supported";
        throw err;
      }
      payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
    }

    if (body.parent !== undefined) {
      if (!type?.hierarchical) {
        const err = new Error("parent is only supported for hierarchical custom post types.");
        err.status = 400;
        err.code = "field_not_supported";
        throw err;
      }
      payload.parent = integer(body.parent, "parent", { min: 0 });
    }

    if (body.menu_order !== undefined) {
      if (!supports["page-attributes"]) {
        const err = new Error('The custom post type does not declare support for "page-attributes".');
        err.status = 400;
        err.code = "field_not_supported";
        throw err;
      }
      payload.menu_order = integer(body.menu_order, "menu_order", { min: 0, max: 1_000_000 });
    }

    if (!Object.keys(payload).length && !creating) {
      const err = new Error("No supported editable fields were supplied.");
      err.status = 400;
      err.code = "no_editable_fields_supplied";
      throw err;
    }
    if (creating) payload.status = "draft";
    return payload;
  }


  function normalizeBulkEditItem(raw, index) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      const err = new Error(`items[${index}] must be an object.`);
      err.status = 400;
      err.code = "invalid_bulk_item";
      throw err;
    }

    const postType = optionalString(raw.post_type, `items[${index}].post_type`, 20);
    if (!postType || !/^[a-z0-9_-]{1,20}$/.test(postType)) {
      const err = new Error(`items[${index}].post_type must be post, page, or an allowlisted custom post type.`);
      err.status = 400;
      err.code = "invalid_post_type";
      throw err;
    }
    if (!["post", "page"].includes(postType) && !cfg.customPostTypes.includes(postType)) {
      const err = new Error(`Custom post type "${postType}" is not allowlisted.`);
      err.status = 403;
      err.code = "custom_post_type_not_allowlisted";
      throw err;
    }

    const objectId = integer(raw.object_id, `items[${index}].object_id`);
    const expectedModifiedGmt = optionalString(
      raw.expected_modified_gmt,
      `items[${index}].expected_modified_gmt`,
      40
    );
    if (!expectedModifiedGmt) {
      const err = new Error(
        `items[${index}].expected_modified_gmt is required from the latest item read.`
      );
      err.status = 400;
      err.code = "expected_modified_gmt_required";
      throw err;
    }

    const changes = {};
    if (raw.author_id !== undefined) {
      changes.author = integer(raw.author_id, `items[${index}].author_id`);
    }
    if (raw.featured_media !== undefined) {
      changes.featured_media = integer(raw.featured_media, `items[${index}].featured_media`, {
        min: 0,
      });
    }
    if (raw.add_category_ids !== undefined) {
      if (postType !== "post") {
        const err = new Error("add_category_ids is supported only for core posts.");
        err.status = 400;
        err.code = "categories_not_supported";
        throw err;
      }
      changes.add_category_ids = optionalIdArray(
        raw.add_category_ids,
        `items[${index}].add_category_ids`
      );
    }
    if (raw.add_tag_ids !== undefined) {
      if (postType !== "post") {
        const err = new Error("add_tag_ids is supported only for core posts.");
        err.status = 400;
        err.code = "tags_not_supported";
        throw err;
      }
      changes.add_tag_ids = optionalIdArray(raw.add_tag_ids, `items[${index}].add_tag_ids`);
    }

    if (!Object.keys(changes).length) {
      const err = new Error(`items[${index}] has no supported changes.`);
      err.status = 400;
      err.code = "no_editable_fields_supplied";
      throw err;
    }

    return {
      post_type: postType,
      object_id: objectId,
      expected_modified_gmt: expectedModifiedGmt,
      changes,
    };
  }

  function bulkRetryPayload(item) {
    return {
      post_type: item.post_type,
      object_id: item.object_id,
      expected_modified_gmt: item.expected_modified_gmt,
      ...(item.changes.author !== undefined ? { author_id: item.changes.author } : {}),
      ...(item.changes.featured_media !== undefined
        ? { featured_media: item.changes.featured_media }
        : {}),
      ...(item.changes.add_category_ids !== undefined
        ? { add_category_ids: item.changes.add_category_ids }
        : {}),
      ...(item.changes.add_tag_ids !== undefined
        ? { add_tag_ids: item.changes.add_tag_ids }
        : {}),
    };
  }

  async function resolveBulkEditableItem(item) {
    if (item.post_type === "post") {
      const current = await wpRequest(`/wp-json/wp/v2/posts/${item.object_id}?context=edit`);
      return { current: current.data, restBase: "posts", supports: { author: true, thumbnail: true } };
    }
    if (item.post_type === "page") {
      const current = await wpRequest(`/wp-json/wp/v2/pages/${item.object_id}?context=edit`);
      return { current: current.data, restBase: "pages", supports: { author: true, thumbnail: true } };
    }

    const { type, restBase } = await resolveCustomType(item.post_type);
    const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${item.object_id}?context=edit`);
    const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
    return { current: current.data, restBase, supports };
  }

  async function validateBulkReferenceIds(prepared) {
    const authorIds = new Set();
    const mediaIds = new Set();
    const categoryIds = new Set();
    const tagIds = new Set();

    for (const entry of prepared) {
      if (entry.changes.author !== undefined) authorIds.add(entry.changes.author);
      if (entry.changes.featured_media > 0) mediaIds.add(entry.changes.featured_media);
      for (const id of entry.changes.add_category_ids || []) categoryIds.add(id);
      for (const id of entry.changes.add_tag_ids || []) tagIds.add(id);
    }

    for (const authorId of authorIds) {
      await wpRequest(`/wp-json/wp/v2/users/${authorId}?context=view`);
    }

    for (const mediaId of mediaIds) {
      const media = await wpRequest(`/wp-json/wp/v2/media/${mediaId}?context=edit`);
      if (!String(media.data?.mime_type || "").startsWith("image/")) {
        const err = new Error(`Media ${mediaId} is not an image attachment.`);
        err.status = 400;
        err.code = "featured_media_not_image";
        throw err;
      }
    }

    async function validateTerms(restBase, ids, label) {
      if (!ids.size) return;
      const values = [...ids];
      const q = new URLSearchParams();
      q.set("context", "view");
      q.set("per_page", String(Math.min(values.length, 100)));
      q.set("hide_empty", "false");
      for (const id of values) q.append("include[]", String(id));
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}?${q.toString()}`);
      const found = new Set(
        (Array.isArray(result.data) ? result.data : [])
          .map((term) => Number(term?.id))
          .filter(Number.isInteger)
      );
      const missing = values.filter((id) => !found.has(id));
      if (missing.length) {
        const err = new Error(`Unknown ${label} IDs: ${missing.join(", ")}.`);
        err.status = 400;
        err.code = `invalid_${label}_ids`;
        err.details = { missing_ids: missing };
        throw err;
      }
    }

    await validateTerms("categories", categoryIds, "category");
    await validateTerms("tags", tagIds, "tag");
  }

  async function optionalDiscoveryRequest(restPath, fallbackPath) {
    try {
      return { available: true, result: await wpRequest(restPath) };
    } catch (err) {
      if (fallbackPath && (err?.status === 401 || err?.status === 403)) {
        try {
          return { available: true, result: await wpRequest(fallbackPath), limited_context: true };
        } catch (fallbackErr) {
          err = fallbackErr;
        }
      }
      if ([401, 403, 404, 501].includes(err?.status)) {
        return {
          available: false,
          error: {
            status: err.status,
            code: err.code || "unavailable",
            message: String(err.message || "WordPress endpoint unavailable.").slice(0, 300),
          },
        };
      }
      throw err;
    }
  }

  async function route(req, res) {
    const requestId = crypto.randomUUID();
    res.setHeader("x-request-id", requestId);

    if (rateLimited(req)) {
      return json(res, 429, { error: "rate_limited", request_id: requestId });
    }

    if (String(req.url || "").startsWith("/gpt/")) {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized", request_id: requestId });
      req = await translateGptRequest(req, cfg.maxBodyBytes);
    }
    const url = new URL(req.url || "/", "http://localhost");

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "site-one-wordpress-chatgpt-bridge",
        version: "1.15.1",
        publish_enabled: cfg.allowPublish,
        live_edits_enabled: cfg.allowLiveEdits,
        edit_preview_enabled: true,
        media_upload_enabled: true,
        conversation_image_upload_enabled: true,
        conversation_image_optimization_enabled: true,
        gutenberg_block_editing_enabled: true,
        revision_restore_enabled: true,
        scheduling_enabled: cfg.allowPublish,
        pending_review_enabled: true,
        taxonomy_creation_enabled: true,
        comments_enabled: true,
        comment_visibility_changes_enabled: cfg.allowPublish,
        site_discovery_enabled: true,
        editorial_audit_enabled: true,
        author_discovery_enabled: true,
        default_author_configured: Boolean(cfg.defaultAuthor),
        default_author_enforced: Boolean(cfg.defaultAuthor && cfg.enforceDefaultAuthor),
        bulk_editorial_metadata_enabled: true,
        bulk_editorial_metadata_max_items: 20,
        idempotency_enabled: true,
        activity_history_enabled: true,
        activity_recovery_enabled: true,
        activity_retention_days: cfg.activityRetentionDays ?? 30,
        idempotency_retention_hours: cfg.idempotencyRetentionHours,
        audit_deadline_ms: cfg.auditDeadlineMs,
        audit_concurrency: cfg.auditConcurrency,
        seo_integration_enabled: true,
        seo_helper_required_for_writes: true,
        custom_post_types_enabled: cfg.customPostTypes.length > 0,
        custom_post_type_allowlist: cfg.customPostTypes,
        custom_post_type_scheduling_enabled: cfg.customPostTypes.length > 0 && cfg.allowPublish,
        custom_post_type_review_enabled: cfg.customPostTypes.length > 0,
        custom_post_type_gutenberg_enabled: cfg.customPostTypes.length > 0,
        custom_post_type_revisions_enabled: cfg.customPostTypes.length > 0,
        custom_fields_enabled: cfg.customFieldAllowlist.size > 0,
        custom_field_types: [...cfg.customFieldAllowlist.keys()],
        custom_taxonomies_enabled: cfg.customTaxonomyAllowlist.size > 0,
        custom_taxonomy_types: [...cfg.customTaxonomyAllowlist.keys()],
        max_media_bytes: cfg.maxMediaBytes,
        max_source_image_bytes: cfg.maxSourceImageBytes,
        image_optimize_threshold_bytes: cfg.imageOptimizeThresholdBytes,
        image_optimize_max_dimension: cfg.imageOptimizeMaxDimension,
        docx_zip_image_extraction_enabled: true,
        max_archive_entries: cfg.maxArchiveEntries,
        max_extracted_images: cfg.maxExtractedImages,
      });
    }

    if (!authorized(req)) {
      return json(res, 401, { error: "unauthorized", request_id: requestId });
    }

    // GET /v1/activity — privacy-filtered bridge write history.
    if (req.method === "GET" && url.pathname === "/v1/activity") {
      const limit = integer(url.searchParams.get("limit") || "50", "limit", { min: 1, max: 200 });
      const postType = (url.searchParams.get("post_type") || "").slice(0, 20) || undefined;
      const objectIdRaw = url.searchParams.get("object_id");
      const objectId = objectIdRaw ? integer(objectIdRaw, "object_id") : undefined;
      const outcome = (url.searchParams.get("outcome") || "").slice(0, 20) || undefined;
      const recoverableRaw = url.searchParams.get("recoverable");
      let recoverable;
      if (recoverableRaw !== null) {
        if (!["true", "false"].includes(recoverableRaw)) {
          return json(res, 400, { error: "invalid_recoverable_filter" });
        }
        recoverable = recoverableRaw === "true";
      }
      return json(res, 200, {
        entries: activityStore.list({ limit, postType, objectId, outcome, recoverable }),
        retention_days: cfg.activityRetentionDays ?? 30,
        note: "History excludes credentials, full post bodies, comment bodies, and uploaded media bytes. Recoverable content fields refer to WordPress revisions when available.",
      });
    }

    // GET /v1/activity/:activityId — inspect one bridge history entry.
    let activityMatch = url.pathname.match(/^\/v1\/activity\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && activityMatch) {
      const entry = activityStore.get(activityMatch[1]);
      if (!entry) return json(res, 404, { error: "activity_not_found" });
      return json(res, 200, entry);
    }

    // POST /v1/activity/:activityId/restore-preview — preview a recovery without writing.
    activityMatch = url.pathname.match(/^\/v1\/activity\/([0-9a-f-]{36})\/restore-preview$/i);
    if (req.method === "POST" && activityMatch) {
      const entry = activityStore.get(activityMatch[1]);
      if (!entry) return json(res, 404, { error: "activity_not_found" });
      const body = await readJson(req);
      const context = await activityRestoreContext(entry);
      const conflictCurrent = context.conflictCurrent || context.current;
      assertLiveEditAllowed(conflictCurrent, cfg.allowLiveEdits);
      maybeAssertPreviewInputVersion(body, conflictCurrent);
      const preview = editPreview(context.target, context.current, context.payload);
      const conflictVersion = {
        modified_gmt: conflictCurrent?.modified_gmt || null,
        content_sha256: sha256Text(conflictCurrent?.content?.raw ?? ""),
      };
      return json(res, 200, {
        activity_id: entry.id,
        source_request_id: entry.request_id || null,
        source_action: entry.action || "",
        restore_target: entry.target || null,
        ...preview,
        conflict_version: conflictVersion,
        note: "This preview is read-only. Apply it only with the returned preview_token and a value from conflict_version as expected_modified_gmt or expected_content_sha256.",
      });
    }

    // POST /v1/activity/:activityId/restore — apply only a fresh, previewed recovery.
    activityMatch = url.pathname.match(/^\/v1\/activity\/([0-9a-f-]{36})\/restore$/i);
    if (req.method === "POST" && activityMatch) {
      const entry = activityStore.get(activityMatch[1]);
      if (!entry) return json(res, 404, { error: "activity_not_found" });
      const body = await readJson(req);
      if (body.confirm !== "RESTORE_ACTIVITY") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "RESTORE_ACTIVITY".',
        });
      }
      const previewToken = optionalString(body.preview_token, "preview_token", 4096);
      if (!previewToken) {
        return json(res, 400, {
          error: "restore_preview_required",
          message: "Generate restore-preview first and supply its preview_token.",
        });
      }

      const context = await activityRestoreContext(entry);
      const conflictCurrent = context.conflictCurrent || context.current;
      assertLiveEditAllowed(conflictCurrent, cfg.allowLiveEdits);
      assertCurrentEditVersion(body, conflictCurrent, sha256Text);
      verifySuppliedPreview(body, context.target, context.current, context.payload);

      let reverseRecovery = null;
      let beforeRevision = null;
      if (entry.recovery?.kind === "wp_item") {
        const revisionFields = ["title", "content", "excerpt"].filter((field) =>
          Object.prototype.hasOwnProperty.call(context.payload, field)
        );
        beforeRevision = await matchingCurrentRevision(
          context.restBase, context.objectId, conflictCurrent, revisionFields
        );
        reverseRecovery = itemRecoverySnapshot({
          postType: context.postType, restBase: context.restBase, objectId: context.objectId,
          current: conflictCurrent, payload: context.payload, beforeRevision,
        });
      } else if (entry.recovery?.kind === "seo") {
        const currentFields = context.current?.fields || {};
        const keys = Object.keys(context.payload?.fields || {});
        reverseRecovery = {
          kind: "seo", post_type: context.postType, object_id: context.objectId,
          helper_path: entry.recovery.helper_path,
          fields_before: Object.fromEntries(keys.map((key) => [key, currentFields[key] ?? ""])),
        };
      } else if (entry.recovery?.kind === "custom_fields") {
        const currentFields = context.current?.fields || {};
        const keys = Object.keys(context.payload?.fields || {});
        reverseRecovery = {
          kind: "custom_fields", post_type: context.postType, rest_base: context.restBase,
          object_id: context.objectId,
          fields_before: Object.fromEntries(keys.map((key) => [key, currentFields[key]])),
        };
      } else if (entry.recovery?.kind === "custom_taxonomy") {
        reverseRecovery = {
          ...entry.recovery,
          term_ids_before: Array.isArray(context.current?.term_ids) ? context.current.term_ids : [],
        };
      }

      const result = await context.apply();
      enrichActivity(requestId, {
        action: "restore_activity",
        target: { kind: "content", post_type: context.postType, object_id: context.objectId },
        outcome: "succeeded", status: 200,
        recoverable: Boolean(reverseRecovery),
        recovery: reverseRecovery,
        changed_fields: Object.keys(context.payload || {}),
        wordpress_revision: beforeRevision ? { before: beforeRevision } : null,
        note: `Restored activity ${entry.id}; this restore itself is recorded so it can be reviewed and, when possible, reversed.`,
      });

      return json(res, 200, {
        restored_activity_id: entry.id,
        source_request_id: entry.request_id || null,
        target: entry.target || null,
        result: result.data ?? result,
      });
    }

    // GET /v1/posts
    if (req.method === "GET" && url.pathname === "/v1/posts") {
      const perPage = integer(url.searchParams.get("per_page") || "10", "per_page", { min: 1, max: 50 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const status = url.searchParams.get("status") || "publish";
      const allowedStatuses = new Set(["publish", "draft", "pending", "private", "future"]);
      if (!allowedStatuses.has(status)) {
        return json(res, 400, { error: "invalid_status", allowed: [...allowedStatuses] });
      }
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const author = url.searchParams.get("author_id");
      const authorId = author ? integer(author, "author_id") : undefined;
      const query = makeQuery({
        context: "edit",
        status,
        search,
        author: authorId,
        per_page: perPage,
        page,
        orderby: status === "future" ? "date" : "modified",
        order: status === "future" ? "asc" : "desc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/posts?${query}`);
      return json(res, 200, {
        posts: Array.isArray(result.data) ? result.data.map(postSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/posts/:id
    let match = url.pathname.match(/^\/v1\/posts\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "post_id");
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      return json(res, 200, postDetails(result.data));
    }

    // POST /v1/posts — always creates a draft.
    if (req.method === "POST" && url.pathname === "/v1/posts") {
      const body = await readJson(req);
      const title = optionalString(body.title, "title", 500);
      if (!title?.trim()) {
        return json(res, 400, { error: "title_required" });
      }
      const payload = {
        status: "draft",
        title,
      };
      const content = optionalString(body.content, "content", 1_000_000);
      const excerpt = optionalString(body.excerpt, "excerpt", 20_000);
      const slug = optionalString(body.slug, "slug", 250);
      const categories = optionalIdArray(body.category_ids, "category_ids");
      const tags = optionalIdArray(body.tag_ids, "tag_ids");
      if (content !== undefined) payload.content = content;
      if (excerpt !== undefined) payload.excerpt = excerpt;
      if (slug !== undefined) payload.slug = slug;
      if (categories !== undefined) payload.categories = categories;
      if (tags !== undefined) payload.tags = tags;
      const effectiveAuthor = await creationAuthor(body, { noun: "post" });
      if (effectiveAuthor !== undefined) payload.author = effectiveAuthor;
      if (body.featured_media !== undefined) {
        payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
      }

      return idempotentMutation(req, res, requestId, body, "create:post", async () => {
        const result = await wpRequest("/wp-json/wp/v2/posts", { method: "POST", body: payload });
        enrichActivity(requestId, {
          action: "create_post",
          target: { kind: "content", post_type: "post", object_id: Number(result.data?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: Object.keys(payload),
          note: "Creation is recorded for traceability; bridge activity recovery does not delete newly created content.",
        });
        return { status: 201, body: postDetails(result.data) };
      });
    }

    // POST /v1/posts/:id/preview — preview an ordinary post edit without writing.
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/preview$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      maybeAssertPreviewInputVersion(body, current.data);
      const payload = postEditPayload(body);
      return json(res, 200, editPreview(`post:${id}`, current.data, payload));
    }

    // PATCH /v1/posts/:id — cannot change status.
    match = url.pathname.match(/^\/v1\/posts\/(\d+)$/);
    if (req.method === "PATCH" && match) {
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      assertCurrentEditVersion(body, current.data, sha256Text);
      const payload = postEditPayload(body);
      verifySuppliedPreview(body, `post:${id}`, current.data, payload);
      const revisionFields = ["title", "content", "excerpt"].filter((field) =>
        Object.prototype.hasOwnProperty.call(payload, field)
      );
      const beforeRevision = await matchingCurrentRevision("posts", id, current.data, revisionFields);
      const recovery = itemRecoverySnapshot({
        postType: "post", restBase: "posts", objectId: id, current: current.data, payload, beforeRevision,
      });

      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: payload,
      });
      const afterRevision = await matchingCurrentRevision("posts", id, result.data, revisionFields);
      enrichActivity(requestId, {
        action: "edit_post",
        target: { kind: "content", post_type: "post", object_id: id },
        outcome: "succeeded",
        status: 200,
        recoverable: recovery.recoverable_fields.length > 0,
        recovery,
        changed_fields: Object.keys(payload),
        wordpress_revision: { before: beforeRevision, after: afterRevision },
        note: recovery.unavailable_revision_fields.length
          ? `WordPress had no matching pre-change revision for: ${recovery.unavailable_revision_fields.join(", ")}. Those fields are not locally copied into activity history.`
          : "Recovery uses WordPress revisions for content fields and bounded local before-values only for non-revision metadata.",
      });
      return json(res, 200, postDetails(result.data));
    }

    // POST /v1/posts/:id/publish
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/publish$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      if (body.confirm !== "PUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "PUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: { status: "publish" },
      });
      return json(res, 200, postDetails(result.data));
    }

    // POST /v1/posts/:id/schedule
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/schedule$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable scheduling.",
        });
      }
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      if (body.confirm !== "SCHEDULE") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "SCHEDULE".',
        });
      }
      const dateGmt = futureGmtForWordPress(body.scheduled_for_gmt);
      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      const allowed = new Set(["draft", "pending", "future"]);
      if (!allowed.has(current.data?.status)) {
        return json(res, 409, {
          error: "schedule_status_not_allowed",
          message:
            "Only draft, pending, or already-scheduled posts can be scheduled. " +
            "This endpoint will not take a currently live/private post offline.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: { status: "future", date_gmt: dateGmt },
      });
      return json(res, 200, postDetails(result.data));
    }

    // POST /v1/posts/:id/submit-review
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/submit-review$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "post_id");
      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      if (current.data?.status === "pending") {
        return json(res, 200, postDetails(current.data));
      }
      if (current.data?.status !== "draft") {
        return json(res, 409, {
          error: "review_status_not_allowed",
          message:
            "Only draft posts can be submitted for review. This endpoint cannot unpublish or unschedule content.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: { status: "pending" },
      });
      return json(res, 200, postDetails(result.data));
    }

    // POST /v1/posts/:id/unpublish
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/unpublish$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      if (body.confirm !== "UNPUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "UNPUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: { status: "draft" },
      });
      return json(res, 200, postDetails(result.data));
    }


    // GET /v1/pages
    if (req.method === "GET" && url.pathname === "/v1/pages") {
      const perPage = integer(url.searchParams.get("per_page") || "10", "per_page", { min: 1, max: 50 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const status = url.searchParams.get("status") || "publish";
      const allowedStatuses = new Set(["publish", "draft", "pending", "private", "future"]);
      if (!allowedStatuses.has(status)) {
        return json(res, 400, { error: "invalid_status", allowed: [...allowedStatuses] });
      }
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const author = url.searchParams.get("author_id");
      const authorId = author ? integer(author, "author_id") : undefined;
      const query = makeQuery({
        context: "edit",
        status,
        search,
        author: authorId,
        per_page: perPage,
        page,
        orderby: status === "future" ? "date" : "modified",
        order: status === "future" ? "asc" : "desc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/pages?${query}`);
      return json(res, 200, {
        pages: Array.isArray(result.data) ? result.data.map(pageSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/pages/:id
    match = url.pathname.match(/^\/v1\/pages\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "page_id");
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      return json(res, 200, pageDetails(result.data));
    }

    // POST /v1/pages — always creates a draft.
    if (req.method === "POST" && url.pathname === "/v1/pages") {
      const body = await readJson(req);
      const title = optionalString(body.title, "title", 500);
      if (!title?.trim()) {
        return json(res, 400, { error: "title_required" });
      }
      const payload = {
        status: "draft",
        title,
      };
      const content = optionalString(body.content, "content", 1_000_000);
      const slug = optionalString(body.slug, "slug", 250);
      const template = optionalString(body.template, "template", 250);
      if (content !== undefined) payload.content = content;
      if (slug !== undefined) payload.slug = slug;
      if (template !== undefined) payload.template = template;
      if (body.parent !== undefined) payload.parent = integer(body.parent, "parent", { min: 0 });
      if (body.menu_order !== undefined) {
        payload.menu_order = integer(body.menu_order, "menu_order", { min: 0, max: 1_000_000 });
      }
      const effectiveAuthor = await creationAuthor(body, { noun: "page" });
      if (effectiveAuthor !== undefined) payload.author = effectiveAuthor;
      if (body.featured_media !== undefined) {
        payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
      }

      return idempotentMutation(req, res, requestId, body, "create:page", async () => {
        const result = await wpRequest("/wp-json/wp/v2/pages", { method: "POST", body: payload });
        enrichActivity(requestId, {
          action: "create_page",
          target: { kind: "content", post_type: "page", object_id: Number(result.data?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: Object.keys(payload),
          note: "Creation is recorded for traceability; bridge activity recovery does not delete newly created content.",
        });
        return { status: 201, body: pageDetails(result.data) };
      });
    }

    // POST /v1/pages/:id/preview — preview an ordinary page edit without writing.
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/preview$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      maybeAssertPreviewInputVersion(body, current.data);
      const payload = pageEditPayload(body);
      return json(res, 200, editPreview(`page:${id}`, current.data, payload));
    }

    // PATCH /v1/pages/:id — cannot change status.
    match = url.pathname.match(/^\/v1\/pages\/(\d+)$/);
    if (req.method === "PATCH" && match) {
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      assertCurrentEditVersion(body, current.data, sha256Text);
      const payload = pageEditPayload(body);
      verifySuppliedPreview(body, `page:${id}`, current.data, payload);
      const revisionFields = ["title", "content"].filter((field) =>
        Object.prototype.hasOwnProperty.call(payload, field)
      );
      const beforeRevision = await matchingCurrentRevision("pages", id, current.data, revisionFields);
      const recovery = itemRecoverySnapshot({
        postType: "page", restBase: "pages", objectId: id, current: current.data, payload, beforeRevision,
      });

      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: payload,
      });
      const afterRevision = await matchingCurrentRevision("pages", id, result.data, revisionFields);
      enrichActivity(requestId, {
        action: "edit_page",
        target: { kind: "content", post_type: "page", object_id: id },
        outcome: "succeeded", status: 200,
        recoverable: recovery.recoverable_fields.length > 0,
        recovery, changed_fields: Object.keys(payload),
        wordpress_revision: { before: beforeRevision, after: afterRevision },
        note: recovery.unavailable_revision_fields.length
          ? `WordPress had no matching pre-change revision for: ${recovery.unavailable_revision_fields.join(", ")}. Those fields are not locally copied into activity history.`
          : "Recovery uses WordPress revisions for content fields and bounded local before-values only for non-revision metadata.",
      });
      return json(res, 200, pageDetails(result.data));
    }

    // POST /v1/pages/:id/publish
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/publish$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      if (body.confirm !== "PUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "PUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: { status: "publish" },
      });
      return json(res, 200, pageDetails(result.data));
    }

    // POST /v1/pages/:id/schedule
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/schedule$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable scheduling.",
        });
      }
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      if (body.confirm !== "SCHEDULE") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "SCHEDULE".',
        });
      }
      const dateGmt = futureGmtForWordPress(body.scheduled_for_gmt);
      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      const allowed = new Set(["draft", "pending", "future"]);
      if (!allowed.has(current.data?.status)) {
        return json(res, 409, {
          error: "schedule_status_not_allowed",
          message:
            "Only draft, pending, or already-scheduled pages can be scheduled. " +
            "This endpoint will not take a currently live/private page offline.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: { status: "future", date_gmt: dateGmt },
      });
      return json(res, 200, pageDetails(result.data));
    }

    // POST /v1/pages/:id/submit-review
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/submit-review$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "page_id");
      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      if (current.data?.status === "pending") {
        return json(res, 200, pageDetails(current.data));
      }
      if (current.data?.status !== "draft") {
        return json(res, 409, {
          error: "review_status_not_allowed",
          message:
            "Only draft pages can be submitted for review. This endpoint cannot unpublish or unschedule content.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: { status: "pending" },
      });
      return json(res, 200, pageDetails(result.data));
    }

    // POST /v1/pages/:id/unpublish
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/unpublish$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      if (body.confirm !== "UNPUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "UNPUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: { status: "draft" },
      });
      return json(res, 200, pageDetails(result.data));
    }


    // GET /v1/posts/:id/blocks — parse top-level Gutenberg blocks without changing content.
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/blocks$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "post_id");
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      const content = result.data?.content?.raw ?? "";
      return json(res, 200, {
        post_id: id,
        status: result.data?.status,
        modified: result.data?.modified,
        ...blockList(content),
      });
    }

    // PATCH /v1/posts/:id/blocks — targeted top-level Gutenberg edit with optimistic locking.
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/blocks$/);
    if (req.method === "PATCH" && match) {
      const id = integer(match[1], "post_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentContent = current.data?.content?.raw ?? "";
      const nextContent = mutateBlockContent(currentContent, body);
      const beforeRevision = await matchingCurrentRevision("posts", id, current.data, ["content"]);
      const recovery = itemRecoverySnapshot({
        postType: "post", restBase: "posts", objectId: id, current: current.data,
        payload: { content: nextContent }, beforeRevision,
      });
      const updated = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: { content: nextContent },
      });
      const afterRevision = await matchingCurrentRevision("posts", id, updated.data, ["content"]);
      enrichActivity(requestId, {
        action: "edit_post_blocks", target: { kind: "content", post_type: "post", object_id: id },
        outcome: "succeeded", status: 200, recoverable: recovery.recoverable_fields.length > 0,
        recovery, changed_fields: ["content"], wordpress_revision: { before: beforeRevision, after: afterRevision },
        note: beforeRevision ? "Block recovery uses the matching pre-change WordPress revision." : "No matching pre-change WordPress revision was available, so the full content is not copied into local history.",
      });
      const updatedContent = updated.data?.content?.raw ?? nextContent;
      return json(res, 200, {
        post: postDetails(updated.data),
        ...blockList(updatedContent),
      });
    }

    // GET /v1/posts/:id/revisions
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/revisions$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "post_id");
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", { min: 1, max: 100 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const query = makeQuery({
        context: "edit",
        per_page: perPage,
        page,
        orderby: "date",
        order: "desc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/posts/${id}/revisions?${query}`);
      return json(res, 200, {
        post_id: id,
        revisions: Array.isArray(result.data) ? result.data.map(revisionSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/posts/:id/revisions/:revisionId
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/revisions\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "post_id");
      const revisionId = integer(match[2], "revision_id");
      const result = await wpRequest(
        `/wp-json/wp/v2/posts/${id}/revisions/${revisionId}?context=edit`
      );
      return json(res, 200, revisionDetails(result.data));
    }

    // POST /v1/posts/:id/revisions/:revisionId/restore
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/revisions\/(\d+)\/restore$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "post_id");
      const revisionId = integer(match[2], "revision_id");
      const body = await readJson(req);
      if (body.confirm !== "RESTORE_REVISION") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "RESTORE_REVISION".',
        });
      }

      const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentContent = current.data?.content?.raw ?? "";
      const expectedHash = optionalString(
        body.expected_current_content_sha256,
        "expected_current_content_sha256",
        64
      );
      if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return json(res, 400, {
          error: "expected_hash_required",
          message: "expected_current_content_sha256 must be a 64-character SHA-256 hex digest.",
        });
      }
      if (!safeEqual(expectedHash.toLowerCase(), sha256Text(currentContent))) {
        return json(res, 409, {
          error: "content_changed",
          message: "Current content changed since it was read. Read the post again before restoring.",
        });
      }

      const revision = await wpRequest(
        `/wp-json/wp/v2/posts/${id}/revisions/${revisionId}?context=edit`
      );
      const payload = {
        title: revision.data?.title?.raw ?? revision.data?.title?.rendered ?? "",
        content: revision.data?.content?.raw ?? revision.data?.content?.rendered ?? "",
        excerpt: revision.data?.excerpt?.raw ?? revision.data?.excerpt?.rendered ?? "",
      };
      const updated = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
        method: "POST",
        body: payload,
      });
      return json(res, 200, {
        restored_revision_id: revisionId,
        status_unchanged: current.data?.status === updated.data?.status,
        post: postDetails(updated.data),
      });
    }

    // GET /v1/pages/:id/blocks — parse top-level Gutenberg blocks without changing content.
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/blocks$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "page_id");
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      const content = result.data?.content?.raw ?? "";
      return json(res, 200, {
        page_id: id,
        status: result.data?.status,
        modified: result.data?.modified,
        ...blockList(content),
      });
    }

    // PATCH /v1/pages/:id/blocks — targeted top-level Gutenberg edit with optimistic locking.
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/blocks$/);
    if (req.method === "PATCH" && match) {
      const id = integer(match[1], "page_id");
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentContent = current.data?.content?.raw ?? "";
      const nextContent = mutateBlockContent(currentContent, body);
      const beforeRevision = await matchingCurrentRevision("pages", id, current.data, ["content"]);
      const recovery = itemRecoverySnapshot({
        postType: "page", restBase: "pages", objectId: id, current: current.data,
        payload: { content: nextContent }, beforeRevision,
      });
      const updated = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: { content: nextContent },
      });
      const afterRevision = await matchingCurrentRevision("pages", id, updated.data, ["content"]);
      enrichActivity(requestId, {
        action: "edit_page_blocks", target: { kind: "content", post_type: "page", object_id: id },
        outcome: "succeeded", status: 200, recoverable: recovery.recoverable_fields.length > 0,
        recovery, changed_fields: ["content"], wordpress_revision: { before: beforeRevision, after: afterRevision },
        note: beforeRevision ? "Block recovery uses the matching pre-change WordPress revision." : "No matching pre-change WordPress revision was available, so the full content is not copied into local history.",
      });
      const updatedContent = updated.data?.content?.raw ?? nextContent;
      return json(res, 200, {
        page: pageDetails(updated.data),
        ...blockList(updatedContent),
      });
    }

    // GET /v1/pages/:id/revisions
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/revisions$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "page_id");
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", { min: 1, max: 100 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const query = makeQuery({
        context: "edit",
        per_page: perPage,
        page,
        orderby: "date",
        order: "desc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/pages/${id}/revisions?${query}`);
      return json(res, 200, {
        page_id: id,
        revisions: Array.isArray(result.data) ? result.data.map(revisionSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/pages/:id/revisions/:revisionId
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/revisions\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "page_id");
      const revisionId = integer(match[2], "revision_id");
      const result = await wpRequest(
        `/wp-json/wp/v2/pages/${id}/revisions/${revisionId}?context=edit`
      );
      return json(res, 200, revisionDetails(result.data));
    }

    // POST /v1/pages/:id/revisions/:revisionId/restore
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/revisions\/(\d+)\/restore$/);
    if (req.method === "POST" && match) {
      const id = integer(match[1], "page_id");
      const revisionId = integer(match[2], "revision_id");
      const body = await readJson(req);
      if (body.confirm !== "RESTORE_REVISION") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "RESTORE_REVISION".',
        });
      }

      const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentContent = current.data?.content?.raw ?? "";
      const expectedHash = optionalString(
        body.expected_current_content_sha256,
        "expected_current_content_sha256",
        64
      );
      if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return json(res, 400, {
          error: "expected_hash_required",
          message: "expected_current_content_sha256 must be a 64-character SHA-256 hex digest.",
        });
      }
      if (!safeEqual(expectedHash.toLowerCase(), sha256Text(currentContent))) {
        return json(res, 409, {
          error: "content_changed",
          message: "Current content changed since it was read. Read the page again before restoring.",
        });
      }

      const revision = await wpRequest(
        `/wp-json/wp/v2/pages/${id}/revisions/${revisionId}?context=edit`
      );
      const payload = {
        title: revision.data?.title?.raw ?? revision.data?.title?.rendered ?? "",
        content: revision.data?.content?.raw ?? revision.data?.content?.rendered ?? "",
      };
      const updated = await wpRequest(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: payload,
      });
      return json(res, 200, {
        restored_revision_id: revisionId,
        status_unchanged: current.data?.status === updated.data?.status,
        page: pageDetails(updated.data),
      });
    }

    // POST /v1/media/from-chatgpt — fetch only temporary OpenAI conversation files.
    if (req.method === "POST" && url.pathname === "/v1/media/from-chatgpt") {
      const body = await readJson(req);
      const allowedFields = new Set(["openaiFileIdRefs", "idempotency_key", "optimization_mode"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        return json(res, 400, { error: "unexpected_upload_field", request_id: requestId });
      }
      const mode = optionalString(body.optimization_mode, "optimization_mode", 20) || "ask";
      if (!["ask", "optimize", "original"].includes(mode)) {
        return json(res, 400, { error: "invalid_optimization_mode", allowed: ["ask", "optimize", "original"], request_id: requestId });
      }
      const normalizedRefs = normalizeOpenAiFileRefs(body.openaiFileIdRefs);
      const fingerprintBody = {
        idempotency_key: body.idempotency_key,
        optimization_mode: mode,
        openaiFileIdRefs: normalizedRefs.map((ref) => ({ id: ref.id, name: ref.filename, mime_type: ref.mimeType })),
      };
      return idempotentMutation(req, res, requestId, fingerprintBody, "upload:conversation-images", async () => {
        const files = await downloadOpenAiImages(body.openaiFileIdRefs, {
          fetchImpl,
          maxBytes: cfg.maxSourceImageBytes,
          maxTotalBytes: cfg.maxSourceImageBatchBytes,
          maxArchiveEntries: cfg.maxArchiveEntries,
          maxExtractedImages: cfg.maxExtractedImages,
        });
        const recommendationConfig = {
          thresholdBytes: cfg.imageOptimizeThresholdBytes,
          maxDimension: cfg.imageOptimizeMaxDimension,
        };
        const recommendations = files.map((file) => imageOptimizationRecommendation(file, recommendationConfig)).filter(Boolean);
        if (mode === "ask" && recommendations.length) {
          return {
            status: 409,
            state: "failed",
            body: {
              error: "image_optimization_recommended",
              message: "No images were uploaded. Ask the user before resizing and converting; after approval retry with optimization_mode=optimize and a fresh idempotency_key.",
              recommendations,
              request_id: requestId,
            },
          };
        }

        const prepared = [];
        for (const file of files) {
          const recommendation = imageOptimizationRecommendation(file, recommendationConfig);
          const next = mode === "optimize" && recommendation
            ? await optimizeImageForWeb(file, {
              maxDimension: cfg.imageOptimizeMaxDimension,
              quality: cfg.imageOptimizeQuality,
              maxOutputBytes: cfg.maxMediaBytes,
            })
            : file;
          assertImageBytes(next.data, next.mimeType, cfg.maxMediaBytes);
          prepared.push(next);
        }

        const uploaded = [];
        const failed = [];
        for (const file of prepared) {
          try {
            const media = await wpImageUpload(file.filename, file.mimeType, file.data);
            uploaded.push({
              file_id: file.id,
              source_filename: file.sourceFilename || null,
              archive_path: file.sourcePath || null,
              optimized: Boolean(file.optimized),
              original: file.original || null,
              media: mediaSummary(media),
            });
            appendActivity(requestId, {
              time: new Date().toISOString(), method: "POST", path: "/v1/media/from-chatgpt",
              action: "upload_media", target: { kind: "media", object_id: Number(media?.id) || null },
              status: 201, outcome: "succeeded", recoverable: false, changed_fields: ["image_bytes"],
              note: "Conversation image upload is recorded without the temporary URL or image bytes. Activity recovery does not delete uploaded media.",
            });
          } catch (error) {
            const failure = bridgeErrorResponse(error, requestId);
            failed.push({
              file_id: file.id,
              filename: file.filename,
              status: failure.status,
              outcome: error?.outcomeUnknown ? "unknown" : "failed",
              error: failure.body.error,
              message: failure.body.message,
            });
            appendActivity(requestId, {
              time: new Date().toISOString(), method: "POST", path: "/v1/media/from-chatgpt",
              action: "upload_media", target: { kind: "media" }, status: failure.status,
              outcome: error?.outcomeUnknown ? "unknown" : "failed", recoverable: false,
              changed_fields: [], note: "Conversation image upload failed; no temporary URL or image bytes were retained.",
            });
          }
        }
        const state = failed.some((item) => item.outcome === "unknown") ? "unknown" : failed.length ? "failed" : "succeeded";
        return {
          status: failed.length ? 207 : 201,
          state,
          body: {
            uploaded,
            failed,
            optimization_mode: mode,
            note: "Uploading adds images to the Media Library; insert returned source_url values into post content with a separate guarded content edit.",
          },
        };
      });
    }

    // GET /v1/media — image attachments only.
    if (req.method === "GET" && url.pathname === "/v1/media") {
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", { min: 1, max: 50 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const query = makeQuery({
        context: "edit",
        media_type: "image",
        search,
        per_page: perPage,
        page,
        orderby: "date",
        order: "desc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/media?${query}`);
      return json(res, 200, {
        media: Array.isArray(result.data) ? result.data.map(mediaSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/media/:id — image attachments only.
    match = url.pathname.match(/^\/v1\/media\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "media_id");
      const result = await wpRequest(`/wp-json/wp/v2/media/${id}?context=edit`);
      if (result.data?.media_type !== "image") {
        return json(res, 400, {
          error: "unsupported_media_type",
          message: "This bridge exposes image media only.",
        });
      }
      return json(res, 200, mediaSummary(result.data));
    }

    // POST /v1/media — image upload supplied as base64; never fetches external URLs.
    if (req.method === "POST" && url.pathname === "/v1/media") {
      const body = await readJson(req);
      const mimeType = optionalString(body.mime_type, "mime_type", 100);
      if (!mimeType || !allowedImageTypes.has(mimeType)) {
        return json(res, 400, {
          error: "unsupported_mime_type",
          allowed: [...allowedImageTypes.keys()],
        });
      }
      const filename = safeUploadFilename(body.filename, mimeType);
      const data = decodeImageBase64(body.data_base64, mimeType);

      const metadata = {};
      for (const [field, maxLen] of [
        ["title", 500],
        ["alt_text", 2000],
        ["caption", 20_000],
        ["description", 100_000],
      ]) {
        const value = optionalString(body[field], field, maxLen);
        if (value !== undefined) metadata[field] = value;
      }
      if (body.attached_to !== undefined) {
        metadata.post = integer(body.attached_to, "attached_to", { min: 0 });
      }

      return idempotentMutation(req, res, requestId, body, "upload:image", async () => {
        const uploaded = await wpImageUpload(filename, mimeType, data);
        let finalMedia = uploaded;
        if (Object.keys(metadata).length) {
          const updated = await wpRequest(`/wp-json/wp/v2/media/${uploaded.id}`, {
            method: "POST",
            body: metadata,
          });
          finalMedia = updated.data;
        }
        enrichActivity(requestId, {
          action: "upload_media",
          target: { kind: "media", object_id: Number(finalMedia?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: ["image_bytes", ...Object.keys(metadata)],
          note: "Image upload is recorded without storing uploaded bytes. Activity recovery does not delete uploaded media.",
        });
        return { status: 201, body: mediaSummary(finalMedia) };
      });
    }

    // PATCH /v1/media/:id — metadata only; image bytes are never replaced.
    match = url.pathname.match(/^\/v1\/media\/(\d+)$/);
    if (req.method === "PATCH" && match) {
      const id = integer(match[1], "media_id");
      const existing = await wpRequest(`/wp-json/wp/v2/media/${id}?context=edit`);
      if (existing.data?.media_type !== "image") {
        return json(res, 400, {
          error: "unsupported_media_type",
          message: "This bridge exposes image media only.",
        });
      }

      const body = await readJson(req);
      const payload = {};
      for (const [field, maxLen] of [
        ["title", 500],
        ["alt_text", 2000],
        ["caption", 20_000],
        ["description", 100_000],
      ]) {
        const value = optionalString(body[field], field, maxLen);
        if (value !== undefined) payload[field] = value;
      }
      if (body.attached_to !== undefined) {
        payload.post = integer(body.attached_to, "attached_to", { min: 0 });
      }
      if (!Object.keys(payload).length) {
        return json(res, 400, { error: "no_editable_fields_supplied" });
      }

      const result = await wpRequest(`/wp-json/wp/v2/media/${id}`, {
        method: "POST",
        body: payload,
      });
      return json(res, 200, mediaSummary(result.data));
    }


    // GET /v1/comments — moderation-oriented comment listing.
    if (req.method === "GET" && url.pathname === "/v1/comments") {
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", { min: 1, max: 100 });
      const page = integer(url.searchParams.get("page") || "1", "page", { min: 1, max: 10000 });
      const friendlyStatus = url.searchParams.get("status") || "hold";
      const statusMap = new Map([
        ["approved", "approve"],
        ["hold", "hold"],
        ["spam", "spam"],
      ]);
      if (!statusMap.has(friendlyStatus)) {
        return json(res, 400, {
          error: "invalid_comment_status",
          allowed: [...statusMap.keys()],
        });
      }
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const postIdRaw = url.searchParams.get("post_id");
      const query = makeQuery({
        context: "edit",
        status: statusMap.get(friendlyStatus),
        search,
        post: postIdRaw === null ? undefined : integer(postIdRaw, "post_id"),
        per_page: perPage,
        page,
        orderby: "date_gmt",
        order: "desc",
        type: "comment",
      });
      const result = await wpRequest(`/wp-json/wp/v2/comments?${query}`);
      return json(res, 200, {
        comments: Array.isArray(result.data) ? result.data.map(commentSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/comments/:id
    match = url.pathname.match(/^\/v1\/comments\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "comment_id");
      const result = await wpRequest(`/wp-json/wp/v2/comments/${id}?context=edit`);
      return json(res, 200, commentSummary(result.data));
    }

    // POST /v1/comments/:id/approve
    match = url.pathname.match(/^\/v1\/comments\/(\d+)\/approve$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "comment_visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable comment approval.",
        });
      }
      const id = integer(match[1], "comment_id");
      const body = await readJson(req);
      if (body.confirm !== "APPROVE_COMMENT") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "APPROVE_COMMENT".',
        });
      }
      const current = await wpRequest(`/wp-json/wp/v2/comments/${id}?context=edit`);
      if (current.data?.status === "approved") {
        return json(res, 200, commentSummary(current.data));
      }
      if (current.data?.status !== "hold") {
        return json(res, 409, {
          error: "comment_status_not_allowed",
          message: "Only held comments can be approved by this endpoint.",
          current_status: current.data?.status ?? null,
        });
      }
      const updated = await wpRequest(`/wp-json/wp/v2/comments/${id}`, {
        method: "POST",
        body: { status: "approved" },
      });
      return json(res, 200, commentSummary(updated.data));
    }

    // POST /v1/comments/:id/unapprove
    match = url.pathname.match(/^\/v1\/comments\/(\d+)\/unapprove$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "comment_visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable comment visibility changes.",
        });
      }
      const id = integer(match[1], "comment_id");
      const body = await readJson(req);
      if (body.confirm !== "HOLD_COMMENT") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "HOLD_COMMENT".',
        });
      }
      const current = await wpRequest(`/wp-json/wp/v2/comments/${id}?context=edit`);
      if (current.data?.status === "hold") {
        return json(res, 200, commentSummary(current.data));
      }
      if (current.data?.status !== "approved") {
        return json(res, 409, {
          error: "comment_status_not_allowed",
          message: "Only approved comments can be moved to hold by this endpoint.",
          current_status: current.data?.status ?? null,
        });
      }
      const updated = await wpRequest(`/wp-json/wp/v2/comments/${id}`, {
        method: "POST",
        body: { status: "hold" },
      });
      return json(res, 200, commentSummary(updated.data));
    }

    // POST /v1/comments/:id/reply — creates an approved child comment as the bridge user.
    match = url.pathname.match(/^\/v1\/comments\/(\d+)\/reply$/);
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "comment_visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable public comment replies.",
        });
      }
      const parentId = integer(match[1], "comment_id");
      const body = await readJson(req);
      if (body.confirm !== "REPLY_COMMENT") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "REPLY_COMMENT".',
        });
      }
      const content = optionalString(body.content, "content", 20_000);
      if (!content?.trim()) {
        return json(res, 400, { error: "comment_content_required" });
      }

      const parent = await wpRequest(`/wp-json/wp/v2/comments/${parentId}?context=edit`);
      if (parent.data?.status !== "approved") {
        return json(res, 409, {
          error: "reply_parent_not_approved",
          message: "This bridge only publishes replies to already-approved comments.",
          parent_status: parent.data?.status ?? null,
        });
      }
      const postId = integer(parent.data?.post, "parent_post_id");
      return idempotentMutation(req, res, requestId, body, `reply:comment:${parentId}`, async () => {
        const created = await wpRequest("/wp-json/wp/v2/comments", {
          method: "POST",
          body: {
            post: postId,
            parent: parentId,
            content: content.trim(),
            status: "approved",
          },
        });
        enrichActivity(requestId, {
          action: "reply_comment",
          target: { kind: "comment", object_id: Number(created.data?.id) || null, parent_object_id: parentId, post_id: postId },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: ["reply"],
          note: "Comment reply is recorded without storing the reply body. Activity recovery does not delete comments.",
        });
        return { status: 201, body: commentSummary(created.data) };
      });
    }



    // GET /v1/editorial/status/:postType/:id — reusable read-only editorial checks.
    match = url.pathname.match(/^\/v1\/editorial\/status\/([a-z0-9_-]+)\/(\d+)$/);
    if (req.method === "GET" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const staleDays = integer(url.searchParams.get("stale_days") || "30", "stale_days", {
        min: 1,
        max: 3650,
      });
      const includeSeo = boolQueryValue(
        url.searchParams.get("include_seo"),
        "include_seo",
        true
      );
      const { type, restBase } = await resolveEditorialType(typeSlug);
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      let seo = { checked: false, available: false };
      if (includeSeo && ["post", "page"].includes(typeSlug)) {
        const capabilities = await editorialSeoCapabilitiesSafe();
        seo = await editorialSeoForItem(typeSlug, id, capabilities);
      }
      return json(
        res,
        200,
        editorialStatusForItem(result.data, typeSlug, type, { staleDays, seo })
      );
    }

    // GET /v1/editorial/audit — read-only quality audit with bounded concurrency/deadline.
    if (req.method === "GET" && url.pathname === "/v1/editorial/audit") {
      const auditStartedAt = Date.now();
      const deadlineAt = auditStartedAt + cfg.auditDeadlineMs;
      const remainingAuditMs = () => Math.max(1, deadlineAt - Date.now());
      const typeSlug = (url.searchParams.get("post_type") || "post").trim();
      if (!/^[a-z0-9_-]{1,20}$/.test(typeSlug)) {
        return json(res, 400, { error: "invalid_post_type" });
      }
      const status = url.searchParams.get("status") || "draft";
      const allowedStatuses = new Set(["publish", "draft", "pending", "private", "future"]);
      if (!allowedStatuses.has(status)) {
        return json(res, 400, { error: "invalid_status", allowed: [...allowedStatuses] });
      }
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", {
        min: 1,
        max: 25,
      });
      const page = integer(url.searchParams.get("page") || "1", "page", {
        min: 1,
        max: 10000,
      });
      const staleDays = integer(url.searchParams.get("stale_days") || "30", "stale_days", {
        min: 1,
        max: 3650,
      });
      const includeSeo = boolQueryValue(
        url.searchParams.get("include_seo"),
        "include_seo",
        true
      );
      const onlyIssues = boolQueryValue(
        url.searchParams.get("only_with_issues"),
        "only_with_issues",
        true
      );

      const fetched = await fetchEditorialItems(
        typeSlug,
        status,
        perPage,
        page,
        status === "future" ? "date" : "modified",
        status === "future" ? "asc" : "desc",
        { timeoutMs: remainingAuditMs() }
      );

      let seoCapabilities = {
        available: false,
        helper_installed: null,
        provider: "not_checked",
      };
      if (includeSeo && ["post", "page"].includes(typeSlug) && Date.now() < deadlineAt) {
        seoCapabilities = await editorialSeoCapabilitiesSafe(remainingAuditMs());
      }

      const mapped = await mapWithConcurrencyUntil(
        fetched.items,
        { concurrency: cfg.auditConcurrency, deadlineAt },
        async (item, _index, remainingMs) => {
          let seo = { checked: false, available: false };
          if (includeSeo && ["post", "page"].includes(typeSlug)) {
            seo = await editorialSeoForItem(typeSlug, item.id, seoCapabilities, remainingMs);
          }
          return editorialStatusForItem(item, typeSlug, fetched.type, { staleDays, seo });
        }
      );
      const audited = mapped.results.filter(Boolean);
      const items = onlyIssues
        ? audited.filter((entry) => entry.issue_count > 0)
        : audited;

      const issueCounts = {};
      for (const entry of audited) {
        for (const issue of entry.issues) {
          issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
        }
      }

      return json(res, mapped.deadline_exceeded ? 206 : 200, {
        post_type: typeSlug,
        status,
        stale_days: staleDays,
        include_seo: includeSeo,
        only_with_issues: onlyIssues,
        complete: !mapped.deadline_exceeded,
        deadline_exceeded: mapped.deadline_exceeded,
        audit_deadline_ms: cfg.auditDeadlineMs,
        audit_concurrency: cfg.auditConcurrency,
        elapsed_ms: Date.now() - auditStartedAt,
        scanned_count: audited.length,
        skipped_due_deadline: mapped.skipped,
        returned_count: items.length,
        total_matching_wordpress_items: fetched.total,
        total_pages: fetched.total_pages,
        issue_counts: issueCounts,
        seo_capabilities: seoCapabilities,
        items,
        note: mapped.deadline_exceeded
          ? "The read-only audit reached its configured overall deadline and returned partial results. Request the next/smaller page or increase AUDIT_DEADLINE_MS within the documented limit."
          : "This is a read-only heuristic editorial audit. Missing fields can be intentional; review the item before changing it.",
      });
    }

    // GET /v1/editorial/queue — read-only stale-draft/review/schedule queue.
    if (req.method === "GET" && url.pathname === "/v1/editorial/queue") {
      const staleDays = integer(url.searchParams.get("stale_days") || "30", "stale_days", {
        min: 1,
        max: 3650,
      });
      const perType = integer(url.searchParams.get("per_type") || "10", "per_type", {
        min: 1,
        max: 20,
      });
      const includeCustom = boolQueryValue(
        url.searchParams.get("include_custom"),
        "include_custom",
        false
      );

      const customTypes = includeCustom ? cfg.customPostTypes.slice(0, 10) : [];
      const typeSlugs = ["post", "page", ...customTypes];
      const staleDrafts = [];
      const pendingReview = [];
      const scheduled = [];
      const unavailable = [];

      for (const typeSlug of typeSlugs) {
        try {
          const draftBatch = await fetchEditorialItems(
            typeSlug,
            "draft",
            perType,
            1,
            "modified",
            "asc"
          );
          for (const item of draftBatch.items) {
            const status = editorialStatusForItem(item, typeSlug, draftBatch.type, {
              staleDays,
              seo: { checked: false, available: false },
            });
            if (status.checks.stale_draft_or_pending) staleDrafts.push(status);
          }

          const pendingBatch = await fetchEditorialItems(
            typeSlug,
            "pending",
            perType,
            1,
            "modified",
            "asc"
          );
          for (const item of pendingBatch.items) {
            pendingReview.push(
              editorialStatusForItem(item, typeSlug, pendingBatch.type, {
                staleDays,
                seo: { checked: false, available: false },
              })
            );
          }

          const futureBatch = await fetchEditorialItems(
            typeSlug,
            "future",
            perType,
            1,
            "date",
            "asc"
          );
          for (const item of futureBatch.items) {
            scheduled.push(
              editorialStatusForItem(item, typeSlug, futureBatch.type, {
                staleDays,
                seo: { checked: false, available: false },
              })
            );
          }
        } catch (err) {
          unavailable.push({
            post_type: typeSlug,
            error: err?.code || "request_failed",
            message: String(err?.message || "Could not inspect this post type.").slice(0, 300),
          });
        }
      }

      staleDrafts.sort((a, b) =>
        String(a.modified_gmt || a.modified || "").localeCompare(
          String(b.modified_gmt || b.modified || "")
        )
      );
      pendingReview.sort((a, b) =>
        String(a.modified_gmt || a.modified || "").localeCompare(
          String(b.modified_gmt || b.modified || "")
        )
      );
      scheduled.sort((a, b) =>
        String(a.date_gmt || a.date || "").localeCompare(
          String(b.date_gmt || b.date || "")
        )
      );

      return json(res, 200, {
        stale_days: staleDays,
        per_type_limit: perType,
        included_post_types: typeSlugs,
        custom_types_truncated:
          includeCustom && cfg.customPostTypes.length > customTypes.length,
        stale_drafts: staleDrafts,
        pending_review: pendingReview,
        scheduled,
        unavailable,
        note:
          "Queue data is read-only and intentionally capped per post type. Use the normal read/write actions before changing any returned item.",
      });
    }


    // GET /v1/seo/capabilities — detect the optional WordPress SEO helper/provider.
    if (req.method === "GET" && url.pathname === "/v1/seo/capabilities") {
      try {
        const result = await wpSeoHelperRequest("/wp-json/wpbridge/v1/seo/capabilities");
        return json(res, 200, result.data);
      } catch (err) {
        if (seoHelperUnavailable(err)) {
          return json(res, 200, {
            available: false,
            helper_installed: false,
            provider: "none",
            writable_fields: [],
            message:
              "Install and activate wordpress/wpbridge-seo-helper in WordPress to enable safe SEO metadata access.",
          });
        }
        throw err;
      }
    }

    // GET/PATCH /v1/posts/:id/seo — fixed allowlisted SEO fields only.
    match = url.pathname.match(/^\/v1\/posts\/(\d+)\/seo$/);
    if (match && (req.method === "GET" || req.method === "PATCH")) {
      const id = integer(match[1], "post_id");
      const helperPath = `/wp-json/wpbridge/v1/seo/post/${id}`;
      try {
        if (req.method === "GET") {
          const result = await wpSeoHelperRequest(helperPath);
          return json(res, 200, result.data);
        }
        const body = await readJson(req);
        const current = await wpRequest(`/wp-json/wp/v2/posts/${id}?context=edit`);
        assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
        const payload = seoWritePayload(body);
        const beforeSeo = activityEnabled ? await wpSeoHelperRequest(helperPath) : null;
        const result = await wpSeoHelperRequest(helperPath, { method: "POST", body: payload });
        if (activityEnabled) {
          const fieldsBefore = {};
          for (const key of Object.keys(payload.fields)) fieldsBefore[key] = beforeSeo?.data?.fields?.[key] ?? "";
          enrichActivity(requestId, {
            action: "edit_post_seo",
            target: { kind: "content", post_type: "post", object_id: id },
            outcome: "succeeded", status: 200, recoverable: true,
            recovery: { kind: "seo", post_type: "post", object_id: id, helper_path: helperPath, fields_before: fieldsBefore },
            changed_fields: Object.keys(payload.fields).map((field) => `seo.${field}`),
            note: "Only the changed allowlisted SEO fields' bounded before-values are retained for recovery.",
          });
        }
        return json(res, 200, result.data);
      } catch (err) {
        if (seoHelperUnavailable(err)) {
          return json(res, 503, {
            error: "seo_helper_not_installed",
            message:
              "Install and activate wordpress/wpbridge-seo-helper in WordPress before using SEO metadata actions.",
          });
        }
        throw err;
      }
    }

    // GET/PATCH /v1/pages/:id/seo — fixed allowlisted SEO fields only.
    match = url.pathname.match(/^\/v1\/pages\/(\d+)\/seo$/);
    if (match && (req.method === "GET" || req.method === "PATCH")) {
      const id = integer(match[1], "page_id");
      const helperPath = `/wp-json/wpbridge/v1/seo/page/${id}`;
      try {
        if (req.method === "GET") {
          const result = await wpSeoHelperRequest(helperPath);
          return json(res, 200, result.data);
        }
        const body = await readJson(req);
        const current = await wpRequest(`/wp-json/wp/v2/pages/${id}?context=edit`);
        assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
        const payload = seoWritePayload(body);
        const beforeSeo = activityEnabled ? await wpSeoHelperRequest(helperPath) : null;
        const result = await wpSeoHelperRequest(helperPath, { method: "POST", body: payload });
        if (activityEnabled) {
          const fieldsBefore = {};
          for (const key of Object.keys(payload.fields)) fieldsBefore[key] = beforeSeo?.data?.fields?.[key] ?? "";
          enrichActivity(requestId, {
            action: "edit_page_seo",
            target: { kind: "content", post_type: "page", object_id: id },
            outcome: "succeeded", status: 200, recoverable: true,
            recovery: { kind: "seo", post_type: "page", object_id: id, helper_path: helperPath, fields_before: fieldsBefore },
            changed_fields: Object.keys(payload.fields).map((field) => `seo.${field}`),
            note: "Only the changed allowlisted SEO fields' bounded before-values are retained for recovery.",
          });
        }
        return json(res, 200, result.data);
      } catch (err) {
        if (seoHelperUnavailable(err)) {
          return json(res, 503, {
            error: "seo_helper_not_installed",
            message:
              "Install and activate wordpress/wpbridge-seo-helper in WordPress before using SEO metadata actions.",
          });
        }
        throw err;
      }
    }


    // GET /v1/custom-types — only locally allowlisted REST-enabled custom post types.
    if (req.method === "GET" && url.pathname === "/v1/custom-types") {
      const result = await wpRequest("/wp-json/wp/v2/types?context=edit");
      const data =
        result.data && typeof result.data === "object" && !Array.isArray(result.data)
          ? result.data
          : {};
      const items = [];
      const unavailable = [];
      for (const slug of cfg.customPostTypes) {
        const type = data[slug];
        if (!type) {
          unavailable.push({
            slug,
            reason: "not_visible_in_rest_types",
          });
          continue;
        }
        items.push(customTypeBridgeSummary(type, slug));
      }
      return json(res, 200, {
        configured: cfg.customPostTypes,
        custom_post_types: items,
        unavailable,
        note:
          "Only CUSTOM_POST_TYPES entries using the standard wp/v2 REST controller are writable through this bridge.",
      });
    }

    // GET/POST /v1/custom-types/:type/items — list or create a draft.
    match = url.pathname.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/items$/);
    if (match && (req.method === "GET" || req.method === "POST")) {
      const typeSlug = match[1];
      const { type, restBase } = await resolveCustomType(typeSlug);

      if (req.method === "GET") {
        const perPage = integer(url.searchParams.get("per_page") || "10", "per_page", {
          min: 1,
          max: 50,
        });
        const page = integer(url.searchParams.get("page") || "1", "page", {
          min: 1,
          max: 10000,
        });
        const status = url.searchParams.get("status") || "publish";
        const allowedStatuses = new Set(["publish", "draft", "pending", "private", "future"]);
        if (!allowedStatuses.has(status)) {
          return json(res, 400, { error: "invalid_status", allowed: [...allowedStatuses] });
        }
        const search = (url.searchParams.get("search") || "").slice(0, 200);
        const author = url.searchParams.get("author_id");
        const authorId = author ? integer(author, "author_id") : undefined;
        const query = makeQuery({
          context: "edit",
          status,
          search,
          author: authorId,
          per_page: perPage,
          page,
          orderby: status === "future" ? "date" : "modified",
          order: status === "future" ? "asc" : "desc",
        });
        const result = await wpRequest(`/wp-json/wp/v2/${restBase}?${query}`);
        return json(res, 200, {
          post_type: typeSlug,
          items: Array.isArray(result.data)
            ? result.data.map((item) => customItemSummary(item, typeSlug))
            : [],
          total: Number(result.headers.get("x-wp-total") || 0),
          total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
        });
      }

      const body = await readJson(req);
      const payload = customItemPayload(body, type, { creating: true });
      const effectiveAuthor = await creationAuthor(body, {
        supportsAuthor: Boolean(type?.supports?.author),
        noun: `custom post type "${typeSlug}"`,
      });
      if (effectiveAuthor !== undefined) payload.author = effectiveAuthor;
      return idempotentMutation(req, res, requestId, body, `create:custom:${typeSlug}`, async () => {
        const result = await wpRequest(`/wp-json/wp/v2/${restBase}`, {
          method: "POST",
          body: payload,
        });
        enrichActivity(requestId, {
          action: "create_custom_item",
          target: { kind: "content", post_type: typeSlug, object_id: Number(result.data?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: Object.keys(payload),
          note: "Creation is recorded for traceability; bridge activity recovery does not delete newly created content.",
        });
        return { status: 201, body: customItemDetails(result.data, typeSlug) };
      });
    }

    // POST /v1/custom-types/:type/items/:id/preview — preview an ordinary custom item edit without writing.
    match = url.pathname.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/preview$/);
    if (req.method === "POST" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { type, restBase } = await resolveCustomType(typeSlug);
      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      maybeAssertPreviewInputVersion(body, current.data);
      const payload = customItemPayload(body, type);
      return json(res, 200, editPreview(`custom:${typeSlug}:${id}`, current.data, payload));
    }

    // GET/PATCH /v1/custom-types/:type/items/:id.
    match = url.pathname.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)$/);
    if (match && (req.method === "GET" || req.method === "PATCH")) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { type, restBase } = await resolveCustomType(typeSlug);

      if (req.method === "GET") {
        const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
        return json(res, 200, customItemDetails(result.data, typeSlug));
      }

      const body = await readJson(req);
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      assertCurrentEditVersion(body, current.data, sha256Text);
      const payload = customItemPayload(body, type);
      verifySuppliedPreview(body, `custom:${typeSlug}:${id}`, current.data, payload);
      const revisionFields = ["title", "content", "excerpt"].filter((field) =>
        Object.prototype.hasOwnProperty.call(payload, field)
      );
      const beforeRevision = await matchingCurrentRevision(restBase, id, current.data, revisionFields);
      const recovery = itemRecoverySnapshot({
        postType: typeSlug, restBase, objectId: id, current: current.data, payload, beforeRevision,
      });
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: payload,
      });
      const afterRevision = await matchingCurrentRevision(restBase, id, result.data, revisionFields);
      enrichActivity(requestId, {
        action: "edit_custom_item",
        target: { kind: "content", post_type: typeSlug, object_id: id },
        outcome: "succeeded", status: 200,
        recoverable: recovery.recoverable_fields.length > 0,
        recovery, changed_fields: Object.keys(payload),
        wordpress_revision: { before: beforeRevision, after: afterRevision },
        note: recovery.unavailable_revision_fields.length
          ? `WordPress had no matching pre-change revision for: ${recovery.unavailable_revision_fields.join(", ")}. Those fields are not locally copied into activity history.`
          : "Recovery uses WordPress revisions for content fields and bounded local before-values only for non-revision metadata.",
      });
      return json(res, 200, customItemDetails(result.data, typeSlug));
    }

    // POST /v1/custom-types/:type/items/:id/publish.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/publish$/
    );
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { restBase } = await resolveCustomType(typeSlug);
      const body = await readJson(req);
      if (body.confirm !== "PUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "PUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { status: "publish" },
      });
      return json(res, 200, customItemDetails(result.data, typeSlug));
    }

    // POST /v1/custom-types/:type/items/:id/unpublish.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/unpublish$/
    );
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "visibility_changes_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable this action.",
        });
      }
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { restBase } = await resolveCustomType(typeSlug);
      const body = await readJson(req);
      if (body.confirm !== "UNPUBLISH") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "UNPUBLISH".',
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { status: "draft" },
      });
      return json(res, 200, customItemDetails(result.data, typeSlug));
    }


    // POST /v1/custom-types/:type/items/:id/schedule — consequential future publication.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/schedule$/
    );
    if (req.method === "POST" && match) {
      if (!cfg.allowPublish) {
        return json(res, 403, {
          error: "publishing_disabled",
          message: "Set ALLOW_PUBLISH=true in .env and restart the bridge to enable scheduling.",
        });
      }
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { restBase } = await resolveCustomType(typeSlug);
      const body = await readJson(req);
      if (body.confirm !== "SCHEDULE") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "SCHEDULE".',
        });
      }
      const dateGmt = futureGmtForWordPress(body.scheduled_for_gmt);
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      const allowed = new Set(["draft", "pending", "future"]);
      if (!allowed.has(current.data?.status)) {
        return json(res, 409, {
          error: "schedule_status_not_allowed",
          message:
            "Only draft, pending, or already-scheduled custom items can be scheduled. " +
            "This endpoint will not take a currently live/private item offline.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { status: "future", date_gmt: dateGmt },
      });
      return json(res, 200, customItemDetails(result.data, typeSlug));
    }

    // POST /v1/custom-types/:type/items/:id/submit-review — draft to pending only.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/submit-review$/
    );
    if (req.method === "POST" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { restBase } = await resolveCustomType(typeSlug);
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      if (current.data?.status === "pending") {
        return json(res, 200, customItemDetails(current.data, typeSlug));
      }
      if (current.data?.status !== "draft") {
        return json(res, 409, {
          error: "review_status_not_allowed",
          message:
            "Only draft custom items can be submitted for review. " +
            "This endpoint cannot unpublish or unschedule content.",
          current_status: current.data?.status ?? null,
        });
      }
      const result = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { status: "pending" },
      });
      return json(res, 200, customItemDetails(result.data, typeSlug));
    }

    // GET/PATCH /v1/custom-types/:type/items/:id/blocks — top-level Gutenberg editing.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/blocks$/
    );
    if (match && (req.method === "GET" || req.method === "PATCH")) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { type, restBase } = await resolveCustomType(typeSlug);
      const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
      if (!supports.editor) {
        return json(res, 409, {
          error: "gutenberg_not_supported",
          message: 'This custom post type does not declare support for the WordPress "editor" feature.',
        });
      }

      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      const currentContent = current.data?.content?.raw ?? "";
      if (req.method === "GET") {
        return json(res, 200, {
          post_type: typeSlug,
          object_id: id,
          status: current.data?.status,
          modified: current.data?.modified,
          ...blockList(currentContent),
        });
      }

      const body = await readJson(req);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const nextContent = mutateBlockContent(currentContent, body);
      const updated = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { content: nextContent },
      });
      const updatedContent = updated.data?.content?.raw ?? nextContent;
      return json(res, 200, {
        item: customItemDetails(updated.data, typeSlug),
        ...blockList(updatedContent),
      });
    }

    // GET /v1/custom-types/:type/items/:id/revisions
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/revisions$/
    );
    if (req.method === "GET" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { type, restBase } = await resolveCustomType(typeSlug);
      const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
      if (!supports.revisions) {
        return json(res, 409, {
          error: "revisions_not_supported",
          message: 'This custom post type does not declare support for the WordPress "revisions" feature.',
        });
      }
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", {
        min: 1,
        max: 100,
      });
      const page = integer(url.searchParams.get("page") || "1", "page", {
        min: 1,
        max: 10000,
      });
      const query = makeQuery({
        context: "edit",
        per_page: perPage,
        page,
        orderby: "date",
        order: "desc",
      });
      const result = await wpRequest(
        `/wp-json/wp/v2/${restBase}/${id}/revisions?${query}`
      );
      return json(res, 200, {
        post_type: typeSlug,
        object_id: id,
        revisions: Array.isArray(result.data) ? result.data.map(revisionSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
      });
    }

    // GET /v1/custom-types/:type/items/:id/revisions/:revisionId
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/revisions\/(\d+)$/
    );
    if (req.method === "GET" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const revisionId = integer(match[3], "revision_id");
      const { type, restBase } = await resolveCustomType(typeSlug);
      const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
      if (!supports.revisions) {
        return json(res, 409, {
          error: "revisions_not_supported",
          message: 'This custom post type does not declare support for the WordPress "revisions" feature.',
        });
      }
      const result = await wpRequest(
        `/wp-json/wp/v2/${restBase}/${id}/revisions/${revisionId}?context=edit`
      );
      return json(res, 200, {
        post_type: typeSlug,
        object_id: id,
        revision: revisionDetails(result.data),
      });
    }

    // POST /v1/custom-types/:type/items/:id/revisions/:revisionId/restore
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/revisions\/(\d+)\/restore$/
    );
    if (req.method === "POST" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const revisionId = integer(match[3], "revision_id");
      const { type, restBase } = await resolveCustomType(typeSlug);
      const supports = type?.supports && typeof type.supports === "object" ? type.supports : {};
      if (!supports.revisions) {
        return json(res, 409, {
          error: "revisions_not_supported",
          message: 'This custom post type does not declare support for the WordPress "revisions" feature.',
        });
      }

      const body = await readJson(req);
      if (body.confirm !== "RESTORE_REVISION") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "RESTORE_REVISION".',
        });
      }

      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentContent = current.data?.content?.raw ?? "";
      const expectedHash = optionalString(
        body.expected_current_content_sha256,
        "expected_current_content_sha256",
        64
      );
      if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return json(res, 400, {
          error: "expected_hash_required",
          message: "expected_current_content_sha256 must be a 64-character SHA-256 hex digest.",
        });
      }
      if (!safeEqual(expectedHash.toLowerCase(), sha256Text(currentContent))) {
        return json(res, 409, {
          error: "content_changed",
          message:
            "Current content changed since it was read. Read the custom item again before restoring.",
        });
      }

      const revision = await wpRequest(
        `/wp-json/wp/v2/${restBase}/${id}/revisions/${revisionId}?context=edit`
      );
      const payload = {};
      if (supports.title && revision.data?.title) {
        payload.title = revision.data.title.raw ?? revision.data.title.rendered ?? "";
      }
      if (supports.editor && revision.data?.content) {
        payload.content = revision.data.content.raw ?? revision.data.content.rendered ?? "";
      }
      if (supports.excerpt && revision.data?.excerpt) {
        payload.excerpt = revision.data.excerpt.raw ?? revision.data.excerpt.rendered ?? "";
      }
      if (!Object.keys(payload).length) {
        return json(res, 409, {
          error: "revision_has_no_supported_fields",
          message:
            "The selected revision contains no title/content/excerpt fields supported by this custom post type.",
        });
      }

      const updated = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: payload,
      });
      return json(res, 200, {
        post_type: typeSlug,
        object_id: id,
        restored_revision_id: revisionId,
        restored_fields: Object.keys(payload),
        status_unchanged: current.data?.status === updated.data?.status,
        item: customItemDetails(updated.data, typeSlug),
      });
    }


    // GET /v1/custom-types/:type/taxonomies — discover only locally allowlisted custom taxonomies.
    match = url.pathname.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/taxonomies$/);
    if (req.method === "GET" && match) {
      const typeSlug = match[1];
      await resolveCustomType(typeSlug);
      const configured = cfg.customTaxonomyAllowlist.get(typeSlug) || [];
      const taxonomies = [];

      for (const taxonomySlug of configured) {
        try {
          const resolved = await resolveCustomTaxonomyForType(typeSlug, taxonomySlug);
          taxonomies.push({
            ...taxonomyDiscoverySummary(resolved.taxonomy, taxonomySlug),
            configured: true,
            writable_via_bridge: true,
          });
        } catch (err) {
          if ([403, 404, 409].includes(err?.status)) {
            taxonomies.push({
              slug: taxonomySlug,
              configured: true,
              writable_via_bridge: false,
              error: {
                status: err.status,
                code: err.code || "unavailable",
                message: String(err.message || "Custom taxonomy unavailable.").slice(0, 300),
              },
            });
            continue;
          }
          throw err;
        }
      }

      return json(res, 200, {
        post_type: typeSlug,
        taxonomies,
        note:
          "Only taxonomies explicitly configured for this custom post type in CUSTOM_TAXONOMY_ALLOWLIST are returned.",
      });
    }

    // GET/POST /v1/custom-types/:type/taxonomies/:taxonomy/terms
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/taxonomies\/([a-z0-9_-]+)\/terms$/
    );
    if (match && (req.method === "GET" || req.method === "POST")) {
      const typeSlug = match[1];
      const taxonomySlug = match[2];
      const { taxonomy, taxonomyRestBase } = await resolveCustomTaxonomyForType(
        typeSlug,
        taxonomySlug
      );

      if (req.method === "GET") {
        const search = (url.searchParams.get("search") || "").slice(0, 200);
        const perPage = integer(url.searchParams.get("per_page") || "50", "per_page", {
          min: 1,
          max: 100,
        });
        const page = integer(url.searchParams.get("page") || "1", "page", {
          min: 1,
          max: 10000,
        });
        const parentRaw = url.searchParams.get("parent");
        let parent;
        if (parentRaw !== null && parentRaw !== "") {
          if (!taxonomy.hierarchical) {
            return json(res, 400, {
              error: "parent_not_supported",
              message: "parent filtering is only supported for hierarchical taxonomies.",
            });
          }
          parent = integer(parentRaw, "parent", { min: 0 });
        }

        const query = makeQuery({
          context: "edit",
          search,
          per_page: perPage,
          page,
          hide_empty: "false",
          parent,
          orderby: "name",
          order: "asc",
        });
        const result = await wpRequest(`/wp-json/wp/v2/${taxonomyRestBase}?${query}`);
        return json(res, 200, {
          post_type: typeSlug,
          taxonomy: taxonomySlug,
          hierarchical: Boolean(taxonomy.hierarchical),
          terms: Array.isArray(result.data)
            ? result.data.map((term) => taxonomyTermSummary(term, taxonomySlug))
            : [],
          total: Number(result.headers.get("x-wp-total") || 0),
          total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
        });
      }

      const body = await readJson(req);
      const name = optionalString(body.name, "name", 200);
      if (!name?.trim()) {
        return json(res, 400, { error: "name_required" });
      }

      const payload = { name: name.trim() };
      const description = optionalString(body.description, "description", 20_000);
      const slug = optionalString(body.slug, "slug", 200);
      if (description !== undefined) payload.description = description;
      if (slug !== undefined) payload.slug = slug;

      if (body.parent !== undefined) {
        if (!taxonomy.hierarchical) {
          return json(res, 400, {
            error: "parent_not_supported",
            message: "parent is only supported for hierarchical taxonomies.",
          });
        }
        payload.parent = integer(body.parent, "parent", { min: 0 });
      }

      return idempotentMutation(
        req,
        res,
        requestId,
        body,
        `create:custom-taxonomy-term:${typeSlug}:${taxonomySlug}`,
        async () => {
          const result = await wpRequest(`/wp-json/wp/v2/${taxonomyRestBase}`, {
            method: "POST",
            body: payload,
          });
          enrichActivity(requestId, {
            action: "create_custom_taxonomy_term",
            target: {
              kind: "taxonomy_term", post_type: typeSlug, taxonomy: taxonomySlug,
              object_id: Number(result.data?.id) || null,
            },
            outcome: "succeeded", status: 201, recoverable: false,
            changed_fields: Object.keys(payload),
            note: "Taxonomy-term creation is recorded for traceability; bridge activity recovery does not delete terms.",
          });
          return {
            status: 201,
            body: {
              post_type: typeSlug,
              taxonomy: taxonomySlug,
              term: taxonomyTermSummary(result.data, taxonomySlug),
            },
          };
        }
      );
    }

    // GET /v1/custom-types/:type/items/:id/taxonomies — current allowlisted term assignments.
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/taxonomies$/
    );
    if (req.method === "GET" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const { restBase: typeRestBase } = await resolveCustomType(typeSlug);
      const current = await wpRequest(`/wp-json/wp/v2/${typeRestBase}/${id}?context=edit`);
      const configured = cfg.customTaxonomyAllowlist.get(typeSlug) || [];
      const assignments = [];

      for (const taxonomySlug of configured) {
        try {
          const { taxonomy, taxonomyRestBase } =
            await resolveCustomTaxonomyForType(typeSlug, taxonomySlug);
          assignments.push({
            ...customTaxonomyAssignmentSnapshot(
              current.data,
              typeSlug,
              taxonomySlug,
              taxonomyRestBase
            ),
            hierarchical: Boolean(taxonomy.hierarchical),
          });
        } catch (err) {
          if ([403, 404, 409].includes(err?.status)) {
            assignments.push({
              post_type: typeSlug,
              object_id: id,
              taxonomy: taxonomySlug,
              rest_field_available: false,
              error: {
                status: err.status,
                code: err.code || "unavailable",
                message: String(err.message || "Custom taxonomy unavailable.").slice(0, 300),
              },
            });
            continue;
          }
          throw err;
        }
      }

      return json(res, 200, {
        post_type: typeSlug,
        object_id: id,
        assignments,
        note:
          "Use each taxonomy's terms_sha256 from this response before assigning or removing terms.",
      });
    }

    // POST /v1/custom-types/:type/items/:id/taxonomies/:taxonomy/(assign|remove)
    match = url.pathname.match(
      /^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/taxonomies\/([a-z0-9_-]+)\/(assign|remove)$/
    );
    if (req.method === "POST" && match) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const taxonomySlug = match[3];
      const operation = match[4];
      const { taxonomyRestBase, typeRestBase } =
        await resolveCustomTaxonomyForType(typeSlug, taxonomySlug);

      const body = await readJson(req);
      if (!Array.isArray(body.term_ids) || body.term_ids.length < 1 || body.term_ids.length > 100) {
        return json(res, 400, {
          error: "term_ids_required",
          message: "term_ids must be a non-empty array with at most 100 numeric term IDs.",
        });
      }
      const requestedIds = [
        ...new Set(body.term_ids.map((value) => integer(value, "term_ids"))),
      ].sort((a, b) => a - b);

      const expectedHash = optionalString(
        body.expected_terms_sha256,
        "expected_terms_sha256",
        64
      );
      if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return json(res, 400, {
          error: "invalid_terms_hash",
          message:
            "expected_terms_sha256 must be the 64-character fingerprint from the latest taxonomy-assignment read.",
        });
      }

      const current = await wpRequest(`/wp-json/wp/v2/${typeRestBase}/${id}?context=edit`);
      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const currentSnapshot = customTaxonomyAssignmentSnapshot(
        current.data,
        typeSlug,
        taxonomySlug,
        taxonomyRestBase
      );
      if (!currentSnapshot.rest_field_available) {
        return json(res, 409, {
          error: "custom_taxonomy_not_exposed_on_item",
          message:
            "The taxonomy is allowlisted and REST-enabled, but its term field is not exposed on this custom item's REST response.",
        });
      }
      if (!safeEqual(expectedHash.toLowerCase(), currentSnapshot.terms_sha256)) {
        return json(res, 409, {
          error: "taxonomy_terms_changed",
          message:
            "Taxonomy assignments changed since they were read. Read the custom item's taxonomies again before editing.",
        });
      }

      // Verify every requested ID belongs to this taxonomy before changing the item.
      const includeQuery = new URLSearchParams();
      includeQuery.set("context", "view");
      includeQuery.set("per_page", String(Math.min(requestedIds.length, 100)));
      includeQuery.set("hide_empty", "false");
      for (const termId of requestedIds) includeQuery.append("include[]", String(termId));
      const termCheck = await wpRequest(
        `/wp-json/wp/v2/${taxonomyRestBase}?${includeQuery.toString()}`
      );
      const foundIds = new Set(
        (Array.isArray(termCheck.data) ? termCheck.data : [])
          .map((term) => Number(term?.id))
          .filter(Number.isInteger)
      );
      const missingIds = requestedIds.filter((termId) => !foundIds.has(termId));
      if (missingIds.length) {
        return json(res, 400, {
          error: "invalid_term_ids",
          taxonomy: taxonomySlug,
          missing_term_ids: missingIds,
        });
      }

      const currentIds = currentSnapshot.term_ids;
      const nextIds =
        operation === "assign"
          ? [...new Set([...currentIds, ...requestedIds])].sort((a, b) => a - b)
          : currentIds.filter((termId) => !requestedIds.includes(termId));

      const updated = await wpRequest(`/wp-json/wp/v2/${typeRestBase}/${id}`, {
        method: "POST",
        body: { [taxonomyRestBase]: nextIds },
      });
      const updatedSnapshot = customTaxonomyAssignmentSnapshot(
        updated.data,
        typeSlug,
        taxonomySlug,
        taxonomyRestBase
      );
      enrichActivity(requestId, {
        action: `custom_taxonomy_${operation}`,
        target: { kind: "content", post_type: typeSlug, object_id: id },
        outcome: "succeeded", status: 200, recoverable: true,
        recovery: {
          kind: "custom_taxonomy", post_type: typeSlug, object_id: id, taxonomy: taxonomySlug,
          taxonomy_rest_base: taxonomyRestBase, type_rest_base: typeRestBase,
          term_ids_before: currentSnapshot.term_ids,
        },
        changed_fields: [`taxonomy.${taxonomySlug}`],
        note: "The previous allowlisted taxonomy term IDs are retained; term names/content are not copied into history.",
      });

      return json(res, 200, {
        operation,
        requested_term_ids: requestedIds,
        ...updatedSnapshot,
      });
    }

    // GET/PATCH /v1/custom-fields/:type/:id — fixed local meta-key allowlist only.
    match = url.pathname.match(/^\/v1\/custom-fields\/([a-z0-9_-]+)\/(\d+)$/);
    if (match && (req.method === "GET" || req.method === "PATCH")) {
      const typeSlug = match[1];
      const id = integer(match[2], "object_id");
      const allowlistedKeys = cfg.customFieldAllowlist.get(typeSlug);
      if (!allowlistedKeys?.length) {
        return json(res, 403, {
          error: "custom_fields_not_allowlisted",
          message:
            `No custom fields are allowlisted for "${typeSlug}" in CUSTOM_FIELD_ALLOWLIST.`,
        });
      }

      const { restBase } = await resolveEditableType(typeSlug);
      const current = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}?context=edit`);
      const currentSnapshot = customFieldSnapshot(current.data, typeSlug);

      if (req.method === "GET") {
        return json(res, 200, currentSnapshot);
      }

      assertLiveEditAllowed(current.data, cfg.allowLiveEdits);
      const body = await readJson(req);
      const expectedHash = optionalString(
        body.expected_custom_fields_sha256,
        "expected_custom_fields_sha256",
        64
      );
      if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return json(res, 400, {
          error: "invalid_custom_fields_hash",
          message:
            "expected_custom_fields_sha256 must be the 64-character fingerprint from the latest custom-field read.",
        });
      }
      if (!safeEqual(expectedHash.toLowerCase(), currentSnapshot.custom_fields_sha256)) {
        return json(res, 409, {
          error: "custom_fields_changed",
          message:
            "Custom fields changed since they were read. Read them again before applying the edit.",
        });
      }

      if (
        !body.fields ||
        typeof body.fields !== "object" ||
        Array.isArray(body.fields) ||
        !Object.keys(body.fields).length
      ) {
        return json(res, 400, {
          error: "fields_required",
          message: "fields must be a non-empty object of allowlisted custom-field values.",
        });
      }
      if (Object.keys(body.fields).length > 50) {
        return json(res, 400, { error: "too_many_custom_fields" });
      }

      const currentMeta =
        current.data?.meta &&
        typeof current.data.meta === "object" &&
        !Array.isArray(current.data.meta)
          ? current.data.meta
          : {};
      const allowedSet = new Set(allowlistedKeys);
      const payloadFields = {};
      for (const [key, value] of Object.entries(body.fields)) {
        if (!allowedSet.has(key)) {
          return json(res, 403, {
            error: "custom_field_not_allowlisted",
            field: key,
          });
        }
        if (!Object.prototype.hasOwnProperty.call(currentMeta, key)) {
          return json(res, 409, {
            error: "custom_field_not_rest_exposed",
            field: key,
            message:
              "The field is locally allowlisted but WordPress did not expose it in REST meta. Register it with show_in_rest and ensure the post type supports custom-fields.",
          });
        }
        payloadFields[key] = validateCustomFieldValue(value, key);
      }
      if (Buffer.byteLength(JSON.stringify(payloadFields), "utf8") > 100_000) {
        return json(res, 413, {
          error: "custom_fields_payload_too_large",
          message: "Custom field updates are limited to 100 KB of JSON.",
        });
      }

      const updated = await wpRequest(`/wp-json/wp/v2/${restBase}/${id}`, {
        method: "POST",
        body: { meta: payloadFields },
      });
      enrichActivity(requestId, {
        action: "edit_custom_fields",
        target: { kind: "content", post_type: typeSlug, object_id: id },
        outcome: "succeeded", status: 200, recoverable: true,
        recovery: {
          kind: "custom_fields", post_type: typeSlug, rest_base: restBase, object_id: id,
          fields_before: Object.fromEntries(
            Object.keys(payloadFields).map((key) => [key, currentMeta[key]])
          ),
        },
        changed_fields: Object.keys(payloadFields).map((field) => `meta.${field}`),
        note: "Only changed, locally allowlisted REST-exposed custom fields are retained, with bounded values.",
      });
      return json(res, 200, customFieldSnapshot(updated.data, typeSlug));
    }


    // GET /v1/authors — read-only author discovery with privacy-filtered output.
    if (req.method === "GET" && url.pathname === "/v1/authors") {
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const perPage = integer(url.searchParams.get("per_page") || "20", "per_page", {
        min: 1,
        max: 100,
      });
      const page = integer(url.searchParams.get("page") || "1", "page", {
        min: 1,
        max: 10000,
      });
      const query = makeQuery({
        context: "view",
        who: "authors",
        search,
        per_page: perPage,
        page,
        orderby: "name",
        order: "asc",
      });
      const result = await wpRequest(`/wp-json/wp/v2/users?${query}`);
      return json(res, 200, {
        authors: Array.isArray(result.data) ? result.data.map(authorSummary) : [],
        total: Number(result.headers.get("x-wp-total") || 0),
        total_pages: Number(result.headers.get("x-wp-totalpages") || 0),
        note: "Only public editorial identifiers are returned. Email, login names, roles, capabilities, and user meta are intentionally omitted.",
      });
    }

    // GET /v1/authors/:id — privacy-filtered single author lookup.
    match = url.pathname.match(/^\/v1\/authors\/(\d+)$/);
    if (req.method === "GET" && match) {
      const id = integer(match[1], "author_id");
      const result = await wpRequest(`/wp-json/wp/v2/users/${id}?context=view`);
      return json(res, 200, authorSummary(result.data));
    }

    // POST /v1/editorial/bulk-edit — capped, resumable metadata-only bulk edits.
    if (req.method === "POST" && url.pathname === "/v1/editorial/bulk-edit") {
      const body = await readJson(req);
      if (body.confirm !== "APPLY_BULK_EDIT") {
        return json(res, 400, {
          error: "explicit_confirmation_required",
          message: 'confirm must equal "APPLY_BULK_EDIT".',
        });
      }
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
        return json(res, 400, {
          error: "invalid_bulk_items",
          message: "items must contain between 1 and 20 editorial metadata edits.",
        });
      }

      const normalized = body.items.map((item, index) => ({
        ...normalizeBulkEditItem(item, index),
        _index: index,
      }));
      const seen = new Set();
      for (const item of normalized) {
        const key = `${item.post_type}:${item.object_id}`;
        if (seen.has(key)) {
          return json(res, 400, {
            error: "duplicate_bulk_item",
            message: `Each content item may appear only once in a bulk request (${key}).`,
          });
        }
        seen.add(key);
      }

      const results = new Array(normalized.length);
      const prepared = [];
      for (const item of normalized) {
        try {
          const resolved = await resolveBulkEditableItem(item);
          assertLiveEditAllowed(resolved.current, cfg.allowLiveEdits);
          const currentModified = String(resolved.current?.modified_gmt || "");
          if (!currentModified || currentModified !== item.expected_modified_gmt) {
            const err = new Error("This item changed since it was read. Read it again before retrying.");
            err.status = 409;
            err.code = "bulk_item_changed";
            err.current_modified_gmt = currentModified || null;
            throw err;
          }

          if (item.changes.author !== undefined && !resolved.supports.author) {
            const err = new Error("This post type does not support author assignment.");
            err.status = 400;
            err.code = "author_not_supported";
            throw err;
          }
          if (item.changes.featured_media !== undefined && !resolved.supports.thumbnail) {
            const err = new Error("This post type does not support featured images.");
            err.status = 400;
            err.code = "featured_media_not_supported";
            throw err;
          }

          const payload = {};
          if (item.changes.author !== undefined) payload.author = item.changes.author;
          if (item.changes.featured_media !== undefined) {
            payload.featured_media = item.changes.featured_media;
          }
          if (item.post_type === "post") {
            if (item.changes.add_category_ids) {
              payload.categories = [
                ...new Set([...(resolved.current?.categories || []), ...item.changes.add_category_ids]),
              ].sort((a, b) => a - b);
            }
            if (item.changes.add_tag_ids) {
              payload.tags = [
                ...new Set([...(resolved.current?.tags || []), ...item.changes.add_tag_ids]),
              ].sort((a, b) => a - b);
            }
          }

          const entry = { ...item, ...resolved, payload };
          // Validate references per item so one bad item does not block unrelated valid items.
          await validateBulkReferenceIds([entry]);
          prepared.push(entry);
        } catch (err) {
          results[item._index] = {
            ok: false,
            outcome: "failed",
            phase: "preflight",
            retryable: false,
            needs_refresh: err?.code === "bulk_item_changed",
            post_type: item.post_type,
            object_id: item.object_id,
            error: {
              status: Number.isInteger(err?.status) ? err.status : 400,
              code: err?.code || "bulk_preflight_failed",
              message: String(err?.message || "Bulk item preflight failed.").slice(0, 300),
              ...(err?.current_modified_gmt !== undefined
                ? { current_modified_gmt: err.current_modified_gmt }
                : {}),
            },
          };
          appendActivity(requestId, {
            action: "bulk_edit_item",
            target: { kind: "content", post_type: item.post_type, object_id: item.object_id },
            outcome: "failed", status: Number.isInteger(err?.status) ? err.status : 400,
            recoverable: false, changed_fields: Object.keys(item.changes || {}),
            note: `Bulk preflight failed: ${String(err?.code || "bulk_preflight_failed").slice(0, 100)}.`,
          });
        }
      }

      for (const item of prepared) {
        try {
          const result = await wpRequest(
            `/wp-json/wp/v2/${item.restBase}/${item.object_id}`,
            { method: "POST", body: item.payload }
          );
          const summary =
            item.post_type === "post"
              ? postSummary(result.data)
              : item.post_type === "page"
                ? pageSummary(result.data)
                : customItemSummary(result.data, item.post_type);
          results[item._index] = {
            ok: true,
            outcome: "succeeded",
            phase: "write",
            retryable: false,
            post_type: item.post_type,
            object_id: item.object_id,
            item: summary,
          };
          const recovery = itemRecoverySnapshot({
            postType: item.post_type, restBase: item.restBase, objectId: item.object_id,
            current: item.current, payload: item.payload, beforeRevision: null,
          });
          appendActivity(requestId, {
            action: "bulk_edit_item",
            target: { kind: "content", post_type: item.post_type, object_id: item.object_id },
            outcome: "succeeded", status: 200, recoverable: recovery.recoverable_fields.length > 0,
            recovery, changed_fields: Object.keys(item.payload),
            note: "Bulk metadata recovery stores only bounded before-values for the fields changed on this item.",
          });
        } catch (err) {
          const unknown = Boolean(err?.outcomeUnknown);
          results[item._index] = {
            ok: false,
            outcome: unknown ? "unknown" : "failed",
            phase: "write",
            retryable: !unknown,
            requires_reconciliation: unknown,
            post_type: item.post_type,
            object_id: item.object_id,
            error: {
              status: Number.isInteger(err?.status) ? err.status : 502,
              code: err?.code || "update_failed",
              message: String(err?.message || "WordPress update failed.").slice(0, 300),
            },
            ...(!unknown ? { retry_item: bulkRetryPayload(item) } : {}),
          };
          appendActivity(requestId, {
            action: "bulk_edit_item",
            target: { kind: "content", post_type: item.post_type, object_id: item.object_id },
            outcome: unknown ? "unknown" : "failed",
            status: Number.isInteger(err?.status) ? err.status : 502,
            recoverable: false, changed_fields: Object.keys(item.payload || {}),
            note: unknown
              ? "Bulk write outcome is unknown; reconcile WordPress before retrying."
              : `Bulk write failed: ${String(err?.code || "update_failed").slice(0, 100)}.`,
          });
        }
      }

      const finalResults = results.filter(Boolean);
      const succeeded = finalResults.filter((entry) => entry.outcome === "succeeded").length;
      const failed = finalResults.filter((entry) => entry.outcome === "failed").length;
      const unknown = finalResults.filter((entry) => entry.outcome === "unknown").length;
      const retryableItems = finalResults
        .filter((entry) => entry.retryable && entry.retry_item)
        .map((entry) => entry.retry_item);
      const needsAttention = finalResults
        .filter((entry) => !entry.ok && !entry.retryable)
        .map((entry) => ({
          post_type: entry.post_type,
          object_id: entry.object_id,
          outcome: entry.outcome,
          ...(entry.needs_refresh ? { needs_refresh: true } : {}),
          ...(entry.requires_reconciliation ? { requires_reconciliation: true } : {}),
          error: entry.error,
        }));

      return json(res, failed || unknown ? 207 : 200, {
        requested: normalized.length,
        succeeded,
        failed,
        unknown,
        unfinished: failed + unknown,
        retryable_count: retryableItems.length,
        results: finalResults,
        retryable_items: retryableItems,
        needs_attention: needsAttention,
        note:
          unknown > 0
            ? "At least one write has an unknown outcome because connectivity was lost or timed out after the write may have reached WordPress. Do not blindly retry unknown items; reconcile them in WordPress first. retryable_items contains only definitively unfinished writes safe to submit as a new bulk request."
            : failed > 0
              ? "Some items were not applied. Successful writes are not rolled back. retryable_items contains only write-phase failures that can be retried without resending successful items; preflight failures must be corrected or refreshed first."
              : "All requested metadata-only bulk edits were applied.",
      });
    }

    // GET /v1/site/discovery — read-only editorial capability discovery.
    if (req.method === "GET" && url.pathname === "/v1/site/discovery") {
      const [settingsResult, typesResult, taxonomiesResult, statusesResult, templatesResult] =
        await Promise.all([
          optionalDiscoveryRequest(
            "/wp-json/wp/v2/settings?context=edit",
            "/wp-json/wp/v2/settings?context=view"
          ),
          optionalDiscoveryRequest(
            "/wp-json/wp/v2/types?context=edit",
            "/wp-json/wp/v2/types?context=view"
          ),
          optionalDiscoveryRequest(
            "/wp-json/wp/v2/taxonomies?context=edit",
            "/wp-json/wp/v2/taxonomies?context=view"
          ),
          optionalDiscoveryRequest(
            "/wp-json/wp/v2/statuses?context=edit",
            "/wp-json/wp/v2/statuses?context=view"
          ),
          optionalDiscoveryRequest(
            `/wp-json/wp/v2/templates?${makeQuery({ context: "view", per_page: 100 })}`
          ),
        ]);

      const mapObject = (entry, mapper) => {
        if (!entry.available) return { available: false, error: entry.error };
        const data = entry.result?.data;
        return {
          available: true,
          limited_context: Boolean(entry.limited_context),
          items:
            data && typeof data === "object" && !Array.isArray(data)
              ? Object.entries(data).map(([key, value]) => mapper(value, key))
              : [],
        };
      };

      const settings = settingsResult.available
        ? {
            available: true,
            limited_context: Boolean(settingsResult.limited_context),
            value: siteSettingsSummary(settingsResult.result?.data),
          }
        : { available: false, error: settingsResult.error };

      const templates = templatesResult.available
        ? {
            available: true,
            items: Array.isArray(templatesResult.result?.data)
              ? templatesResult.result.data.map(templateSummary)
              : [],
          }
        : { available: false, error: templatesResult.error };

      return json(res, 200, {
        site_url: cfg.wpUrl,
        settings,
        post_types: mapObject(typesResult, postTypeSummary),
        taxonomies: mapObject(taxonomiesResult, taxonomyDiscoverySummary),
        statuses: mapObject(statusesResult, statusSummary),
        templates,
        note:
          "Discovery is read-only. Unavailable sections usually indicate WordPress role, theme, or endpoint limitations.",
      });
    }

    // GET /v1/categories
    if (req.method === "GET" && url.pathname === "/v1/categories") {
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const perPage = integer(url.searchParams.get("per_page") || "50", "per_page", { min: 1, max: 100 });
      const query = makeQuery({ context: "edit", search, per_page: perPage, hide_empty: "false" });
      const result = await wpRequest(`/wp-json/wp/v2/categories?${query}`);
      return json(res, 200, {
        categories: (result.data || []).map(categorySummary),
      });
    }

    // POST /v1/categories
    if (req.method === "POST" && url.pathname === "/v1/categories") {
      const body = await readJson(req);
      const name = optionalString(body.name, "name", 200);
      if (!name?.trim()) {
        return json(res, 400, { error: "name_required" });
      }
      const payload = { name: name.trim() };
      const description = optionalString(body.description, "description", 20_000);
      const slug = optionalString(body.slug, "slug", 200);
      if (description !== undefined) payload.description = description;
      if (slug !== undefined) payload.slug = slug;
      if (body.parent !== undefined) {
        payload.parent = integer(body.parent, "parent", { min: 0 });
      }
      return idempotentMutation(req, res, requestId, body, "create:category", async () => {
        const result = await wpRequest("/wp-json/wp/v2/categories", {
          method: "POST",
          body: payload,
        });
        enrichActivity(requestId, {
          action: "create_category",
          target: { kind: "taxonomy_term", taxonomy: "category", object_id: Number(result.data?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: Object.keys(payload),
          note: "Category creation is recorded for traceability; bridge activity recovery does not delete terms.",
        });
        return { status: 201, body: categorySummary(result.data) };
      });
    }

    // GET /v1/tags
    if (req.method === "GET" && url.pathname === "/v1/tags") {
      const search = (url.searchParams.get("search") || "").slice(0, 200);
      const perPage = integer(url.searchParams.get("per_page") || "50", "per_page", { min: 1, max: 100 });
      const query = makeQuery({ context: "edit", search, per_page: perPage, hide_empty: "false" });
      const result = await wpRequest(`/wp-json/wp/v2/tags?${query}`);
      return json(res, 200, {
        tags: (result.data || []).map(tagSummary),
      });
    }

    // POST /v1/tags
    if (req.method === "POST" && url.pathname === "/v1/tags") {
      const body = await readJson(req);
      const name = optionalString(body.name, "name", 200);
      if (!name?.trim()) {
        return json(res, 400, { error: "name_required" });
      }
      const payload = { name: name.trim() };
      const description = optionalString(body.description, "description", 20_000);
      const slug = optionalString(body.slug, "slug", 200);
      if (description !== undefined) payload.description = description;
      if (slug !== undefined) payload.slug = slug;
      return idempotentMutation(req, res, requestId, body, "create:tag", async () => {
        const result = await wpRequest("/wp-json/wp/v2/tags", {
          method: "POST",
          body: payload,
        });
        enrichActivity(requestId, {
          action: "create_tag",
          target: { kind: "taxonomy_term", taxonomy: "post_tag", object_id: Number(result.data?.id) || null },
          outcome: "succeeded", status: 201, recoverable: false,
          changed_fields: Object.keys(payload),
          note: "Tag creation is recorded for traceability; bridge activity recovery does not delete terms.",
        });
        return { status: 201, body: tagSummary(result.data) };
      });
    }

    return json(res, 404, { error: "not_found", request_id: requestId });
  }

  return route;
}
