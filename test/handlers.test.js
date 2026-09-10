import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouteHandler } from "../lib/handlers.js";
import { writeBridgeError } from "../lib/http.js";
import { isAuthorized } from "../lib/auth.js";
import { createMemoryIdempotencyStore, requestFingerprint } from "../lib/idempotency.js";
import { createMemoryActivityStore } from "../lib/activity.js";
import sharp from "sharp";
import yazl from "yazl";

const apiKey = "b".repeat(40);

function baseConfig(overrides = {}) {
  return {
    wpUrl: "https://example.test/wordpress",
    allowPublish: false,
    allowLiveEdits: false,
    maxBodyBytes: 1_000_000,
    maxMediaBytes: 100_000,
    maxSourceImageBytes: 500_000,
    maxSourceImageBatchBytes: 1_000_000,
    imageOptimizeThresholdBytes: 50_000,
    imageOptimizeMaxDimension: 600,
    imageOptimizeQuality: 82,
    bridgeApiKey: apiKey,
    customPostTypes: [],
    customFieldAllowlist: new Map(),
    customTaxonomyAllowlist: new Map(),
    idempotencyRetentionHours: 168,
    auditDeadlineMs: 15000,
    auditConcurrency: 4,
    ...overrides,
  };
}

async function withBridge({ cfg = baseConfig(), wordpress, idempotency, activity, fetchImpl }, fn) {
  const security = {
    authorized: (req) => isAuthorized(req, apiKey),
    rateLimited: () => false,
  };
  const route = createRouteHandler({ cfg, wordpress, security, idempotency, activity, fetchImpl });
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      writeBridgeError(res, err, String(res.getHeader("x-request-id") || "") || undefined);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeZip(entries) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  return result;
}

function unusedWordPress() {
  const fail = async () => {
    throw new Error("WordPress should not have been called");
  };
  return { wpRequest: fail, wpSeoHelperRequest: fail, wpImageUpload: fail, wpImageDownload: fail };
}

test("grouped API preserves auth, publish guards, and idempotency requirements", async () => {
  await withBridge({ wordpress: unusedWordPress() }, async (base) => {
    const call = (group, input, auth = true) => fetch(`${base}/gpt/${group}`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(input),
    });
    assert.equal((await call("contentRead", { action: "bridgeHealth" }, false)).status, 401);
    const health = await call("contentRead", { action: "bridgeHealth" });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal((await call("contentVisibility", { action: "publishPost", path: { post_id: 1 }, body: { confirm: "PUBLISH" } })).status, 403);
    const create = await call("contentCreate", { action: "createDraft", body: { title: "Draft" } });
    assert.equal(create.status, 400);
    assert.equal((await create.json()).error, "idempotency_key_required");
  });
});

test("grouped creation replays across direct REST calls and grouped stale edits cannot write", async () => {
  let writes = 0;
  const current = { id: 7, status: "draft", modified_gmt: "2026-09-08T06:30:00", title: { raw: "Draft" }, content: { raw: "Body" }, categories: [], tags: [] };
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (_path, options = {}) => {
      if (options.method === "POST") writes += 1;
      return { data: current, headers: new Headers() };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const body = { title: "Draft", idempotency_key: "grouped-create-001" };
    const created = await fetch(`${base}/gpt/contentCreate`, { method: "POST", headers, body: JSON.stringify({ action: "createDraft", body }) });
    assert.equal(created.status, 201);
    const replay = await fetch(`${base}/v1/posts`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    const stale = await fetch(`${base}/gpt/contentEdit`, { method: "POST", headers, body: JSON.stringify({ action: "updatePost", path: { post_id: 7 }, body: { title: "Changed", expected_modified_gmt: "2020-01-01T00:00:00" } }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "edit_conflict");
    assert.equal(writes, 1);
  });
});

test("health is public but editorial endpoints require bridge authentication", async () => {
  await withBridge({ wordpress: unusedWordPress() }, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.version, "1.15.1");
    assert.equal(healthBody.media_transform_enabled, true);
    assert.deepEqual(healthBody.media_transform_operations, ["rotate", "flip", "crop"]);

    const posts = await fetch(`${base}/v1/posts`);
    assert.equal(posts.status, 401);
    assert.equal((await posts.json()).error, "unauthorized");
  });
});

test("ALPS helper fields are exposed on reads and protected by an ALPS fingerprint on edits", async () => {
  const beforeHash = "c".repeat(64);
  const current = {
    id: 42, status: "draft", modified_gmt: "2026-09-08T08:30:00Z", featured_media: 77,
    title: { raw: "ALPS post", rendered: "ALPS post" }, content: { raw: "Body", rendered: "Body" },
    excerpt: { raw: "", rendered: "" }, categories: [], tags: [],
  };
  let helperWrites = 0;
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      if (path === "/wp-json/wp/v2/posts/42?context=edit") return { data: current, headers: new Headers() };
      if (path === "/wp-json/wp/v2/posts/42" && options.method === "POST") return { data: current, headers: new Headers() };
      throw new Error(`unexpected path ${path}`);
    },
    wpAlpsHelperRequest: async (_path, options = {}) => {
      if (!options.body) return { data: { fields: { large_banner: "none", hide_featured_image: false }, alps_sha256: beforeHash }, headers: new Headers() };
      helperWrites += 1;
      return { data: { fields: { large_banner: options.body.large_banner, hide_featured_image: options.body.hide_featured_image }, alps_sha256: "d".repeat(64) }, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const read = await fetch(`${base}/v1/posts/42`, { headers });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.deepEqual(readBody.featured_image, { id: 77, url: null });
    assert.deepEqual(readBody.alps, { large_banner: "none", hide_featured_image: false, alps_sha256: beforeHash });
    const edit = await fetch(`${base}/v1/posts/42`, { method: "PATCH", headers, body: JSON.stringify({
      expected_modified_gmt: current.modified_gmt, expected_alps_sha256: beforeHash,
      alps: { large_banner: "hero_50_50", hide_featured_image: true },
    }) });
    const editBody = await edit.json();
    assert.equal(edit.status, 200);
    assert.equal(helperWrites, 1);
    assert.equal(editBody.alps.large_banner, "hero_50_50");
    assert.equal(editBody.alps.hide_featured_image, true);
  });
});

test("combined post edits fall back to fixed REST-exposed ALPS meta when the helper route is unavailable", async () => {
  const current = {
    id: 42,
    status: "draft",
    modified_gmt: "2026-09-08T08:30:00Z",
    featured_media: 0,
    title: { raw: "ALPS post", rendered: "ALPS post" },
    content: { raw: "Body", rendered: "Body" },
    excerpt: { raw: "", rendered: "" },
    categories: [],
    tags: [],
    meta: { _featured_image_hero_layout: "false", _hide_featured_image: "" },
    alps_sha256: "c".repeat(64),
  };
  const writes = [];
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      if (path === "/wp-json/wp/v2/posts/42?context=edit") return { data: current, headers: new Headers() };
      if (path === "/wp-json/wp/v2/posts/42" && options.method === "POST") {
        writes.push(options.body);
        if (options.body.featured_media !== undefined) current.featured_media = options.body.featured_media;
        if (options.body.meta) current.meta = { ...current.meta, ...options.body.meta };
        return { data: current, headers: new Headers() };
      }
      throw new Error(`unexpected path ${path}`);
    },
    wpAlpsHelperRequest: async () => {
      const err = new Error("The REST route was not found.");
      err.status = 404;
      err.code = "rest_no_route";
      throw err;
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ cfg: baseConfig({ allowLiveEdits: true }), wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts/42`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        expected_modified_gmt: current.modified_gmt,
        expected_alps_sha256: current.alps_sha256,
        featured_image_id: 16136,
        alps: { large_banner: "none", hide_featured_image: true },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(writes, [
      { featured_media: 16136 },
      { meta: { _featured_image_hero_layout: "false", _hide_featured_image: "true" } },
    ]);
    const body = await response.json();
    assert.equal(body.featured_image_id, 16136);
    assert.equal(body.alps.hide_featured_image, true);
  });
});

test("combined post edits roll back a featured-image write when ALPS cannot be applied", async () => {
  const current = {
    id: 42,
    status: "draft",
    modified_gmt: "2026-09-08T08:30:00Z",
    featured_media: 0,
    title: { raw: "ALPS post", rendered: "ALPS post" },
    content: { raw: "Body", rendered: "Body" },
    excerpt: { raw: "", rendered: "" },
    categories: [],
    tags: [],
  };
  const writes = [];
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      if (path === "/wp-json/wp/v2/posts/42?context=edit") return { data: current, headers: new Headers() };
      if (path === "/wp-json/wp/v2/posts/42" && options.method === "POST") {
        writes.push(options.body);
        if (options.body.featured_media !== undefined) current.featured_media = options.body.featured_media;
        return { data: current, headers: new Headers() };
      }
      throw new Error(`unexpected path ${path}`);
    },
    wpAlpsHelperRequest: async (_path, options = {}) => {
      if (!options.body) return { data: { fields: { large_banner: "none", hide_featured_image: false }, alps_sha256: "c".repeat(64) }, headers: new Headers() };
      const err = new Error("The REST route was not found.");
      err.status = 404;
      err.code = "rest_no_route";
      throw err;
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ cfg: baseConfig({ allowLiveEdits: true }), wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts/42`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        expected_modified_gmt: current.modified_gmt,
        expected_alps_sha256: "c".repeat(64),
        featured_image_id: 16136,
        alps: { large_banner: "none", hide_featured_image: true },
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "alps_helper_write_unavailable");
    assert.equal(body.rollback_outcome, "succeeded");
    assert.equal(body.partial_update, undefined);
    assert.deepEqual(writes, [{ featured_media: 16136 }, { featured_media: 0 }]);
    assert.equal(current.featured_media, 0);
  });
});

test("post lists forward precise taxonomy, author, date, ID, and ordering filters", async () => {
  const calls = [];
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (path) => {
      calls.push(path);
      return { data: [], headers: new Headers({ "x-wp-total": "0", "x-wp-totalpages": "0" }) };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const url = new URL(`${base}/v1/posts`);
    for (const [name, value] of Object.entries({
      category_ids: "12,15",
      tag_exclude_ids: "4",
      taxonomy_relation: "AND",
      sticky: "false",
      author_id: "7",
      include_ids: "44,45",
      published_after: "2026-01-01T00:00:00Z",
      modified_before: "2026-09-01T12:00:00+03:00",
      orderby: "include",
      order: "asc",
      per_page: "5",
      page: "2",
    })) url.searchParams.set(name, value);
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(response.status, 200);
    const forwarded = new URL(calls[0], "https://example.test");
    assert.equal(forwarded.pathname, "/wp-json/wp/v2/posts");
    assert.equal(forwarded.searchParams.get("categories"), "12,15");
    assert.equal(forwarded.searchParams.get("tags_exclude"), "4");
    assert.equal(forwarded.searchParams.get("tax_relation"), "AND");
    assert.equal(forwarded.searchParams.get("sticky"), "false");
    assert.equal(forwarded.searchParams.get("author"), "7");
    assert.equal(forwarded.searchParams.get("include"), "44,45");
    assert.equal(forwarded.searchParams.get("after"), "2026-01-01T00:00:00Z");
    assert.equal(forwarded.searchParams.get("modified_before"), "2026-09-01T12:00:00+03:00");
    assert.equal(forwarded.searchParams.get("orderby"), "include");
    assert.equal(forwarded.searchParams.get("order"), "asc");
    assert.match(forwarded.searchParams.get("_fields"), /categories/);
    assert.doesNotMatch(forwarded.searchParams.get("_fields"), /content/);

    const invalid = await fetch(`${base}/v1/posts?category_ids=12,not-an-id`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 1);
  });
});

test("post list resolves an exact category name or slug before filtering", async () => {
  const calls = [];
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (path) => {
      calls.push(path);
      if (path.startsWith("/wp-json/wp/v2/categories?")) return { data: [{ id: 17, name: "Dvasiniai skaitiniai", slug: "dvasiniai-skaitiniai" }], headers: new Headers() };
      return { data: [], headers: new Headers({ "x-wp-total": "0", "x-wp-totalpages": "0" }) };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts?category=${encodeURIComponent("Dvasiniai skaitiniai")}`, { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(response.status, 200);
    const postsQuery = new URL(calls.at(-1), "https://example.test");
    assert.equal(postsQuery.pathname, "/wp-json/wp/v2/posts");
    assert.equal(postsQuery.searchParams.get("categories"), "17");
  });
});

test("category-only prepared bulk scope omits an empty tags parameter", async () => {
  const calls = [];
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (path) => {
      calls.push(path);
      if (!path.startsWith("/wp-json/wp/v2/posts?")) throw new Error(`unexpected path ${path}`);
      const query = new URL(path, "https://example.test").searchParams;
      assert.equal(query.get("categories"), "419140");
      assert.equal(query.has("tags"), false);
      return { data: [], headers: new Headers({ "x-wp-totalpages": "0" }) };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/editorial/bulk/prepare`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "bulk-category-only-001",
        scope: { category_ids: [419140], status: "publish" },
        operations: { alps: { large_banner: "none", hide_featured_image: true } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });
});

test("page and media lists forward resource-specific filters and requested ordering", async () => {
  const calls = [];
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (path) => {
      calls.push(path);
      return { data: [], headers: new Headers() };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}` };
    assert.equal((await fetch(`${base}/v1/pages?parent_ids=0,42&orderby=menu_order&order=asc`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/v1/media?attached_to=17033&mime_type=image%2Fjpeg&modified_after=2026-01-01T00%3A00%3A00Z&orderby=modified&order=asc`, { headers })).status, 200);

    const pages = new URL(calls[0], "https://example.test");
    assert.equal(pages.searchParams.get("parent"), "0,42");
    assert.equal(pages.searchParams.get("orderby"), "menu_order");
    assert.equal(pages.searchParams.get("order"), "asc");

    const media = new URL(calls[1], "https://example.test");
    assert.equal(media.searchParams.get("parent"), "17033");
    assert.equal(media.searchParams.get("mime_type"), "image/jpeg");
    assert.equal(media.searchParams.get("modified_after"), "2026-01-01T00:00:00Z");
    assert.equal(media.searchParams.get("orderby"), "modified");
    assert.equal(media.searchParams.get("order"), "asc");
  });
});



test("successful creations record the affected WordPress object without storing content", async () => {
  const activity = createMemoryActivityStore();
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      assert.equal(restPath, "/wp-json/wp/v2/posts");
      assert.equal(options.method, "POST");
      return {
        data: {
          id: 88, status: "draft", modified_gmt: "2026-09-08T08:00:00",
          title: { raw: "Created title", rendered: "Created title" },
          content: { raw: "Private content", rendered: "Private content" },
          excerpt: { raw: "", rendered: "" }, categories: [], tags: [],
        },
        headers: new Headers(),
      };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ wordpress, activity }, async (base) => {
    const response = await fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Created title", content: "Private content", idempotency_key: "create-post-88" }),
    });
    assert.equal(response.status, 201);
    const [entry] = activity.list();
    assert.equal(entry.action, "create_post");
    assert.equal(entry.target.object_id, 88);
    assert.equal(entry.recoverable, false);
    assert.equal(JSON.stringify(activity.get(entry.id)).includes("Private content"), false);
  });
});

test("publishing remains blocked independently of authentication when ALLOW_PUBLISH is false", async () => {
  await withBridge({ wordpress: unusedWordPress() }, async (base) => {
    const response = await fetch(`${base}/v1/posts/9/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "PUBLISH" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "publishing_disabled");
  });
});

test("stale post edits return 409 before any WordPress write", async () => {
  let calls = 0;
  const current = {
    id: 7,
    status: "draft",
    modified_gmt: "2026-09-08T05:00:00",
    content: { raw: "current content" },
  };
  const wordpress = {
    wpRequest: async (_path, options = {}) => {
      calls += 1;
      assert.equal(options.method || "GET", "GET");
      return { data: current, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts/7`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Changed",
        expected_modified_gmt: "2026-09-08T04:59:59",
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 409);
    assert.equal(data.error, "edit_conflict");
    assert.equal(data.current_modified_gmt, current.modified_gmt);
    assert.equal(calls, 1);
  });
});

test("media endpoint rejects unsupported uploads before calling WordPress", async () => {
  await withBridge({ wordpress: unusedWordPress() }, async (base) => {
    const response = await fetch(`${base}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "payload.svg",
        mime_type: "image/svg+xml",
        data_base64: Buffer.from("<svg/>").toString("base64"),
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "unsupported_mime_type");
  });
});

test("media transform creates a rotated derivative and replays without duplicating it", async () => {
  const activity = createMemoryActivityStore();
  let reads = 0;
  let edits = 0;
  const source = {
    id: 44,
    media_type: "image",
    mime_type: "image/jpeg",
    modified_gmt: "2026-09-08T10:00:00",
    source_url: "https://example.test/wp-content/uploads/photo.jpg",
    title: { raw: "Photo" },
    media_details: { width: 1200, height: 800 },
  };
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/media/44?context=edit") {
        reads += 1;
        assert.equal(options.method, undefined);
        return { data: source, headers: new Headers() };
      }
      assert.equal(restPath, "/wp-json/wp/v2/media/44/edit");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.body, { src: source.source_url, rotation: 90 });
      edits += 1;
      return {
        data: {
          ...source,
          id: 45,
          modified_gmt: "2026-09-08T10:01:00",
          source_url: "https://example.test/wp-content/uploads/photo-edited.jpg",
          media_details: { width: 800, height: 1200 },
        },
        headers: new Headers(),
      };
    },
  };
  const envelope = {
    action: "transformMedia",
    path: { media_id: 44 },
    body: {
      expected_modified_gmt: source.modified_gmt,
      // ChatGPT has emitted this typo despite the canonical OpenAPI field
      // being rotation_degrees. The bridge normalizes it defensively.
      notation_degrees: 90,
      confirm: "CREATE_TRANSFORMED_MEDIA",
      idempotency_key: "rotate-media-44-90",
    },
  };

  await withBridge({ wordpress, activity }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const first = await fetch(`${base}/gpt/media`, { method: "POST", headers, body: JSON.stringify(envelope) });
    const result = await first.json();
    assert.equal(first.status, 201);
    assert.equal(result.source_media_id, 44);
    assert.equal(result.original_unchanged, true);
    assert.equal(result.transformed_media.id, 45);
    assert.deepEqual(result.applied, [{ type: "rotate", angle: 90 }]);

    const replay = await fetch(`${base}/gpt/media`, { method: "POST", headers, body: JSON.stringify(envelope) });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    assert.equal(reads, 1);
    assert.equal(edits, 1);

    const [entry] = activity.list();
    assert.equal(entry.action, "transform_media");
    assert.equal(entry.target.object_id, 45);
    assert.equal(entry.target.source_object_id, 44);
  });
});

test("media transform falls back to bounded bridge processing when WordPress cannot open its local image", async () => {
  const sourceData = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#336699" },
  }).jpeg().toBuffer();
  let nativeEdits = 0;
  let downloads = 0;
  let uploads = 0;
  const source = {
    id: 91,
    media_type: "image",
    mime_type: "image/jpeg",
    modified_gmt: "2026-09-09T08:00:00",
    source_url: "https://example.test/wp-content/uploads/source.jpg",
  };
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/media/91?context=edit") return { data: source, headers: new Headers() };
      assert.equal(restPath, "/wp-json/wp/v2/media/91/edit");
      assert.equal(options.method, "POST");
      nativeEdits += 1;
      throw Object.assign(new Error("Unable to edit this image."), {
        status: 500,
        code: "rest_unknown_image_file_type",
        outcome: "failed",
      });
    },
    wpImageDownload: async (sourceUrl, maxBytes) => {
      downloads += 1;
      assert.equal(sourceUrl, source.source_url);
      assert.equal(maxBytes, 500_000);
      return sourceData;
    },
    wpImageUpload: async (filename, mimeType, data) => {
      uploads += 1;
      assert.equal(filename, "media-91-transformed.jpg");
      assert.equal(mimeType, "image/jpeg");
      const metadata = await sharp(data).metadata();
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 120);
      return {
        id: 92,
        media_type: "image",
        mime_type: mimeType,
        source_url: "https://example.test/wp-content/uploads/media-91-transformed.jpg",
        media_details: { width: metadata.width, height: metadata.height, filesize: data.length },
      };
    },
  };

  await withBridge({ wordpress }, async (base) => {
    const response = await fetch(`${base}/gpt/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        action: "transformMedia",
        path: { media_id: 91 },
        body: {
          expected_modified_gmt: source.modified_gmt,
          rotation_degrees: 90,
          confirm: "CREATE_TRANSFORMED_MEDIA",
          idempotency_key: ["fallback", "transform", "91"].join("-"),
        },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.transform_engine, "wpbridge_sharp_fallback");
    assert.equal(result.original_unchanged, true);
    assert.equal(result.transformed_media.id, 92);
    assert.equal(nativeEdits, 1);
    assert.equal(downloads, 1);
    assert.equal(uploads, 1);
  });
});

test("media transform validates crop bounds and stale media before writing", async () => {
  let edits = 0;
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (restPath, options = {}) => {
      if (options.method === "POST") {
        assert.equal(restPath, "/wp-json/wp/v2/media/7/edit");
        assert.deepEqual(options.body, {
          src: "https://example.test/image.jpg",
          modifiers: [
            { type: "flip", args: { flip: { horizontal: true, vertical: false } } },
            { type: "crop", args: { left: 10, top: 20, width: 70, height: 60 } },
          ],
        });
        edits += 1;
        return {
          data: { id: 8, media_type: "image", modified_gmt: "2026-09-08T11:01:00", source_url: "https://example.test/image-edited.jpg" },
          headers: new Headers(),
        };
      }
      assert.equal(restPath, "/wp-json/wp/v2/media/7?context=edit");
      return {
        data: { id: 7, media_type: "image", modified_gmt: "2026-09-08T11:00:00", source_url: "https://example.test/image.jpg" },
        headers: new Headers(),
      };
    },
  };
  await withBridge({ wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const invalidCrop = await fetch(`${base}/v1/media/7/transform`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expected_modified_gmt: "2026-09-08T11:00:00",
        crop: { left: 60, top: 0, width: 50, height: 100 },
        confirm: "CREATE_TRANSFORMED_MEDIA",
        idempotency_key: "bad-crop",
      }),
    });
    assert.equal(invalidCrop.status, 400);
    assert.equal((await invalidCrop.json()).error, "invalid_image_transform");

    const stale = await fetch(`${base}/v1/media/7/transform`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expected_modified_gmt: "2026-09-08T10:59:00",
        flip_horizontal: true,
        confirm: "CREATE_TRANSFORMED_MEDIA",
        idempotency_key: "stale-transform-7",
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "media_changed");

    const valid = await fetch(`${base}/v1/media/7/transform`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expected_modified_gmt: "2026-09-08T11:00:00",
        flip_horizontal: true,
        crop: { left: 10, top: 20, width: 70, height: 60 },
        confirm: "CREATE_TRANSFORMED_MEDIA",
        idempotency_key: "flip-crop-transform-7",
      }),
    });
    assert.equal(valid.status, 201);
    assert.equal((await valid.json()).transformed_media.id, 8);
    assert.equal(edits, 1);
  });
});

test("GPT conversation images require optimization approval, then resize to WebP and replay safely", async () => {
  const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#cc8844" } }).jpeg({ quality: 90 }).toBuffer();
  let downloads = 0;
  let uploads = 0;
  let captured;
  const fetchImpl = async (url, options) => {
    downloads += 1;
    assert.equal(new URL(url).hostname, "sdmntprdenmarkeast.oaiusercontent.com");
    assert.equal(options.redirect, "error");
    return new Response(source, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(source.length) } });
  };
  const wordpress = {
    ...unusedWordPress(),
    wpImageUpload: async (filename, mimeType, data) => {
      uploads += 1;
      captured = { filename, mimeType, data };
      const metadata = await sharp(data).metadata();
      return { id: 55, media_type: "image", mime_type: mimeType, source_url: "https://example.test/image.webp", media_details: { width: metadata.width, height: metadata.height, filesize: data.length } };
    },
  };
  const file = { name: "Large Photo.jpg", id: "file_image123", mime_type: "image/jpeg", download_link: "https://sdmntprdenmarkeast.oaiusercontent.com/file_image123?sig=first" };
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  await withBridge({ wordpress, fetchImpl }, async (base) => {
    const suggested = await fetch(`${base}/gpt/uploadConversationImages`, {
      method: "POST", headers,
      body: JSON.stringify({ openaiFileIdRefs: [file], idempotency_key: "conversation-image-ask-1", optimization_mode: "ask" }),
    });
    const suggestion = await suggested.json();
    assert.equal(suggested.status, 409);
    assert.equal(suggestion.error, "image_optimization_recommended");
    assert.equal(suggestion.recommendations[0].suggested_format, "image/webp");
    assert.equal(uploads, 0);

    const optimizedBody = { openaiFileIdRefs: [file], idempotency_key: "conversation-image-optimize-1", optimization_mode: "optimize" };
    const optimized = await fetch(`${base}/gpt/uploadConversationImages`, { method: "POST", headers, body: JSON.stringify(optimizedBody) });
    const result = await optimized.json();
    assert.equal(optimized.status, 201);
    assert.equal(result.uploaded[0].optimized, true);
    assert.equal(captured.mimeType, "image/webp");
    assert.match(captured.filename, /\.webp$/);
    const output = await sharp(captured.data).metadata();
    assert.ok(output.width <= 600 && output.height <= 600);
    assert.equal(uploads, 1);

    const replayBody = { ...optimizedBody, openaiFileIdRefs: [{ ...file, download_link: "https://sdmntprdenmarkeast.oaiusercontent.com/file_image123?sig=renewed" }] };
    const replay = await fetch(`${base}/gpt/uploadConversationImages`, { method: "POST", headers, body: JSON.stringify(replayBody) });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    assert.equal(downloads, 2);
    assert.equal(uploads, 1);
  });
});

test("GPT conversation image upload rejects arbitrary and suffix-spoofed download hosts before fetching", async () => {
  let downloads = 0;
  await withBridge({ wordpress: unusedWordPress(), fetchImpl: async () => { downloads += 1; } }, async (base) => {
    for (const [index, download_link] of [
      "https://example.com/private.jpg",
      "https://sdmntprcentralus.oaiusercontent.com.evil.example/private.jpg",
    ].entries()) {
      const response = await fetch(`${base}/gpt/uploadConversationImages`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          openaiFileIdRefs: [{ name: "image.jpg", id: `file-image${index}`, mime_type: "image/jpeg", download_link }],
          idempotency_key: `conversation-image-evil-${index}`,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "untrusted_openai_file_url");
    }
    assert.equal(downloads, 0);
  });
});

test("GPT conversation upload explains that sandbox files must be replaced by original attachments", async () => {
  let downloads = 0;
  await withBridge({ wordpress: unusedWordPress(), fetchImpl: async () => { downloads += 1; } }, async (base) => {
    const response = await fetch(`${base}/gpt/uploadConversationImages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        openaiFileIdRefs: [{ name: "photo.jpg", id: "sandbox-image-1", mime_type: "image/jpeg", download_link: "sandbox:/mnt/data/photo.jpg" }],
        idempotency_key: "conversation-image-sandbox-1",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "non_downloadable_sandbox_file");
    assert.match(body.message, /original attached image, DOCX, or ZIP/i);
    assert.equal(downloads, 0);
  });
});

test("GPT conversation upload rejects empty, control-character, and oversized opaque file ids", async () => {
  let downloads = 0;
  await withBridge({ wordpress: unusedWordPress(), fetchImpl: async () => { downloads += 1; } }, async (base) => {
    for (const id of ["", "bad\nid", "x".repeat(513)]) {
      const response = await fetch(`${base}/gpt/uploadConversationImages`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          openaiFileIdRefs: [{ name: "image.jpg", id, mime_type: "image/jpeg", download_link: "https://files.oaiusercontent.com/image?sig=1" }],
          idempotency_key: `invalid-file-id-${id.length || 0}`,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_openai_file_id");
    }
    assert.equal(downloads, 0);
  });
});

test("GPT conversation upload extracts images from DOCX and ZIP attachments", async () => {
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#aa5522ff" } }).png().toBuffer();
  const docx = await makeZip([
    ["[Content_Types].xml", Buffer.from("<Types/>")],
    ["word/document.xml", Buffer.from("<w:document/>")],
    ["word/media/photo.jpg", jpeg],
    ["outside.png", png],
  ]);
  const zip = await makeZip([
    ["photos/image.png", png],
    ["notes.txt", Buffer.from("not an image")],
  ]);
  const uploaded = [];
  const wordpress = {
    ...unusedWordPress(),
    wpImageUpload: async (filename, mimeType, data) => {
      uploaded.push({ filename, mimeType, data });
      return { id: 70 + uploaded.length, media_type: "image", mime_type: mimeType, source_url: `https://example.test/${filename}` };
    },
  };
  const fetchImpl = async (url) => {
    const isDocx = String(url).includes("docx123");
    const data = isDocx ? docx : zip;
    const type = isDocx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/zip";
    return new Response(data, { status: 200, headers: { "content-type": type, "content-length": String(data.length) } });
  };
  const refs = [
    { name: "article.docx", id: "file_docx123", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", download_link: "https://sdmntprcentralus.oaiusercontent.com/file_docx123?sig=1" },
    { name: "photos.zip", id: "file_zip1234", mime_type: "application/zip", download_link: "https://sdmntprcentralus.oaiusercontent.com/file_zip1234?sig=2" },
  ];

  await withBridge({ wordpress, fetchImpl }, async (base) => {
    const response = await fetch(`${base}/gpt/uploadConversationImages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ openaiFileIdRefs: refs, idempotency_key: "docx-zip-images-1", optimization_mode: "ask" }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.uploaded.length, 2);
    assert.deepEqual(body.uploaded.map((item) => item.archive_path), ["word/media/photo.jpg", "photos/image.png"]);
    assert.deepEqual(uploaded.map((item) => item.mimeType), ["image/jpeg", "image/png"]);
    assert.match(uploaded[0].filename, /^article-photo\.jpg$/);
    assert.match(uploaded[1].filename, /^photos-image\.png$/);
  });
});

test("GPT conversation ZIP extraction rejects oversized expanded images before upload", async () => {
  const zip = await makeZip([["photos/bomb.png", Buffer.alloc(500_001)]]);
  let uploads = 0;
  const wordpress = { ...unusedWordPress(), wpImageUpload: async () => { uploads += 1; } };
  await withBridge({
    wordpress,
    fetchImpl: async () => new Response(zip, { status: 200, headers: { "content-type": "application/zip", "content-length": String(zip.length) } }),
  }, async (base) => {
    const response = await fetch(`${base}/gpt/uploadConversationImages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        openaiFileIdRefs: [{ name: "images.zip", id: "file_zipbomb1", mime_type: "application/zip", download_link: "https://files.oaiusercontent.com/file_zipbomb1?sig=1" }],
        idempotency_key: "zip-bomb-images-1",
      }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "archive_image_too_large");
    assert.equal(uploads, 0);
  });
});

test("Gutenberg paragraph replacement uses the current content hash and preserves other content", async () => {
  const original = '<!-- wp:paragraph --><p>Old text</p><!-- /wp:paragraph --><!-- wp:separator /-->';
  const replacement = '<!-- wp:paragraph --><p>New text</p><!-- /wp:paragraph -->';
  let currentContent = original;
  let writes = 0;
  const wordpress = {
    ...unusedWordPress(),
    wpRequest: async (restPath, options = {}) => {
      if (options.method === "POST") {
        assert.equal(restPath, "/wp-json/wp/v2/posts/77");
        writes += 1;
        currentContent = options.body.content;
      } else {
        assert.equal(restPath, "/wp-json/wp/v2/posts/77?context=edit");
      }
      return {
        data: {
          id: 77,
          status: "draft",
          modified_gmt: "2026-09-08T12:00:00",
          title: { raw: "Draft" },
          content: { raw: currentContent },
          excerpt: { raw: "" },
          categories: [],
          tags: [],
        },
        headers: new Headers(),
      };
    },
  };

  await withBridge({ wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const listed = await fetch(`${base}/v1/posts/77/blocks`, { headers });
    const blocks = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(blocks.block_count, 2);

    const edited = await fetch(`${base}/v1/posts/77/blocks`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        operation: "replace",
        block_index: 0,
        block_markup: replacement,
        expected_content_sha256: blocks.content_sha256,
      }),
    });
    const result = await edited.json();
    assert.equal(edited.status, 200);
    assert.equal(writes, 1);
    assert.equal(currentContent, `${replacement}<!-- wp:separator /-->`);
    assert.equal(result.block_count, 2);
  });
});


test("post preview is read-only and highlights live content", async () => {
  let writes = 0;
  const current = {
    id: 11,
    status: "publish",
    modified_gmt: "2026-09-08T06:10:00",
    link: "https://example.test/wordpress/post-11",
    title: { raw: "Old" },
    content: { raw: "alpha\nbeta" },
    categories: [1],
    tags: [],
  };
  const wordpress = {
    wpRequest: async (_path, options = {}) => {
      if ((options.method || "GET") !== "GET") writes += 1;
      return { data: current, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts/11/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "New",
        content: "alpha\nchanged",
        expected_modified_gmt: current.modified_gmt,
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.affects_published_content, true);
    assert.equal(data.apply_allowed, false);
    assert.equal(data.content_diff.changed, true);
    assert.equal(data.content_diff.addition_count, 1);
    assert.equal(data.content_diff.removal_count, 1);
    assert.equal(typeof data.preview_token, "string");
    assert.equal(writes, 0);
  });
});

test("valid post preview token is accepted only for the exact previewed edit", async () => {
  let writes = 0;
  const current = {
    id: 12,
    status: "draft",
    modified_gmt: "2026-09-08T06:20:00",
    title: { raw: "Old" },
    content: { raw: "body" },
    categories: [],
    tags: [],
  };
  const wordpress = {
    wpRequest: async (_path, options = {}) => {
      if ((options.method || "GET") === "POST") {
        writes += 1;
        return {
          data: { ...current, title: { raw: options.body.title, rendered: options.body.title } },
          headers: new Headers(),
        };
      }
      return { data: current, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ wordpress }, async (base) => {
    const previewResponse = await fetch(`${base}/v1/posts/12/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "New", expected_modified_gmt: current.modified_gmt }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);

    const mismatch = await fetch(`${base}/v1/posts/12`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Different",
        expected_modified_gmt: current.modified_gmt,
        preview_token: preview.preview_token,
      }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error, "preview_payload_mismatch");
    assert.equal(writes, 0);

    const apply = await fetch(`${base}/v1/posts/12`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "New",
        expected_modified_gmt: current.modified_gmt,
        preview_token: preview.preview_token,
      }),
    });
    assert.equal(apply.status, 200);
    assert.equal(writes, 1);
  });
});

test("preview token is rejected when the item version changed even if caller supplies the new version", async () => {
  let current = {
    id: 13,
    status: "draft",
    modified_gmt: "2026-09-08T06:30:00",
    title: { raw: "Old" },
    content: { raw: "body" },
    categories: [],
    tags: [],
  };
  let writes = 0;
  const wordpress = {
    wpRequest: async (_path, options = {}) => {
      if ((options.method || "GET") === "POST") writes += 1;
      return { data: current, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ wordpress }, async (base) => {
    const previewResponse = await fetch(`${base}/v1/posts/13/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);

    current = { ...current, modified_gmt: "2026-09-08T06:31:00" };
    const apply = await fetch(`${base}/v1/posts/13`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "New",
        expected_modified_gmt: current.modified_gmt,
        preview_token: preview.preview_token,
      }),
    });
    assert.equal(apply.status, 409);
    assert.equal((await apply.json()).error, "preview_stale");
    assert.equal(writes, 0);
  });
});

test("draft creation requires idempotency and replays the same result without a second WordPress write", async () => {
  let writes = 0;
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      assert.equal(path, "/wp-json/wp/v2/posts");
      assert.equal(options.method, "POST");
      writes += 1;
      return {
        data: {
          id: 77,
          status: "draft",
          modified_gmt: "2026-09-08T07:00:00",
          title: { raw: options.body.title, rendered: options.body.title },
          content: { raw: options.body.content || "", rendered: options.body.content || "" },
          excerpt: { raw: "", rendered: "" },
          categories: [],
          tags: [],
        },
        headers: new Headers(),
      };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ wordpress }, async (base) => {
    const missing = await fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Draft" }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "idempotency_key_required");
    assert.equal(writes, 0);

    const request = () => fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "create-post-request-0001",
      },
      body: JSON.stringify({ title: "Draft", content: "Body" }),
    });
    const first = await request();
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("x-idempotency-replayed"), "false");
    assert.equal((await first.json()).id, 77);

    const replay = await request();
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    assert.equal((await replay.json()).id, 77);
    assert.equal(writes, 1);
  });
});

test("reusing an idempotency key for a different creation payload returns 409", async () => {
  let writes = 0;
  const wordpress = {
    wpRequest: async (_path, options = {}) => {
      writes += 1;
      return {
        data: {
          id: 78,
          status: "draft",
          modified_gmt: "2026-09-08T07:00:00",
          title: { raw: options.body.title, rendered: options.body.title },
          content: { raw: "", rendered: "" },
          excerpt: { raw: "", rendered: "" },
          categories: [],
          tags: [],
        },
        headers: new Headers(),
      };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ wordpress }, async (base) => {
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "create-post-request-0002",
    };
    assert.equal((await fetch(`${base}/v1/posts`, {
      method: "POST", headers, body: JSON.stringify({ title: "One" }),
    })).status, 201);
    const second = await fetch(`${base}/v1/posts`, {
      method: "POST", headers, body: JSON.stringify({ title: "Two" }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "idempotency_key_reused");
    assert.equal(writes, 1);
  });
});

test("unknown write outcome is persisted and same-key retry does not perform a second write", async () => {
  let writes = 0;
  const wordpress = {
    wpRequest: async () => {
      writes += 1;
      const err = new Error("write timed out after send");
      err.status = 504;
      err.code = "wordpress_write_timeout_outcome_unknown";
      err.outcomeUnknown = true;
      throw err;
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ wordpress }, async (base) => {
    const request = () => fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "unknown-post-request-001",
      },
      body: JSON.stringify({ title: "Maybe created" }),
    });
    const first = await request();
    const firstBody = await first.json();
    assert.equal(first.status, 504);
    assert.equal(firstBody.outcome, "unknown");
    assert.equal(first.headers.get("x-idempotency-state"), "unknown");

    const replay = await request();
    assert.equal(replay.status, 504);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    assert.equal((await replay.json()).outcome_unknown, true);
    assert.equal(writes, 1);
  });
});

test("bulk edit returns retryable items only for definite write failures", async () => {
  const current = (id) => ({
    id,
    status: "draft",
    modified_gmt: "2026-09-08T07:10:00",
    categories: [],
    tags: [],
    title: { raw: `Post ${id}`, rendered: `Post ${id}` },
  });
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      const match = path.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)\?context=edit$/);
      if (match) return { data: current(Number(match[1])), headers: new Headers() };
      const write = path.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
      if (write && options.method === "POST") {
        const id = Number(write[1]);
        if (id === 2) {
          const err = new Error("temporary rejection");
          err.status = 503;
          err.code = "wordpress_busy";
          err.outcome = "failed";
          throw err;
        }
        return { data: { ...current(id), author: options.body.author }, headers: new Headers() };
      }
      if (path.startsWith("/wp-json/wp/v2/users/")) {
        return { data: { id: 9 }, headers: new Headers() };
      }
      throw new Error(`unexpected path ${path}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ cfg: baseConfig({ allowLiveEdits: true }), wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/editorial/bulk-edit`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        confirm: "APPLY_BULK_EDIT",
        items: [1, 2].map((id) => ({
          post_type: "post",
          object_id: id,
          expected_modified_gmt: "2026-09-08T07:10:00",
          author_id: 9,
        })),
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 207);
    assert.equal(data.succeeded, 1);
    assert.equal(data.failed, 1);
    assert.equal(data.unknown, 0);
    assert.equal(data.retryable_count, 1);
    assert.deepEqual(data.retryable_items.map((item) => item.object_id), [2]);
    assert.equal(data.results[0].outcome, "succeeded");
    assert.equal(data.results[1].outcome, "failed");
  });
});

test("prepared bulk plans apply filtered featured images and ALPS in chunks, then roll back safely", async () => {
  const hashBefore = "a".repeat(64);
  const hashAfter = "b".repeat(64);
  const states = new Map([
    [1, { featured_media: 0, alps: { large_banner: "none", hide_featured_image: false }, hash: hashBefore }],
    [2, { featured_media: 22, alps: { large_banner: "none", hide_featured_image: false }, hash: hashBefore }],
  ]);
  const items = [1, 2].map((id) => ({
    id, status: "draft", modified_gmt: "2026-09-08T08:00:00Z", featured_media: states.get(id).featured_media,
    title: { raw: `Bulk ${id}`, rendered: `Bulk ${id}` },
    content: id === 1 ? { raw: '<!-- wp:image {"id":11} --><img src="image.jpg" /><!-- /wp:image -->' } : { raw: "<p>No image</p>" },
  }));
  const writes = [];
  const wordpress = {
    wpRequest: async (path, options = {}) => {
      if (path.startsWith("/wp-json/wp/v2/posts?")) return { data: items, headers: new Headers({ "x-wp-totalpages": "1" }) };
      const media = path.match(/^\/wp-json\/wp\/v2\/media\/(\d+)\?context=view$/);
      if (media) return { data: { id: Number(media[1]), media_type: "image", mime_type: "image/jpeg", source_url: "https://example.test/image.jpg" }, headers: new Headers() };
      const current = path.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)\?context=edit$/);
      if (current) {
        const id = Number(current[1]);
        return { data: { ...items[id - 1], featured_media: states.get(id).featured_media }, headers: new Headers() };
      }
      const update = path.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
      if (update && options.method === "POST") {
        const id = Number(update[1]);
        if (options.body.featured_media !== undefined) states.get(id).featured_media = options.body.featured_media;
        writes.push({ id, body: options.body });
        return { data: { ...items[id - 1], featured_media: states.get(id).featured_media }, headers: new Headers() };
      }
      throw new Error(`unexpected path ${path}`);
    },
    wpAlpsHelperRequest: async (path, options = {}) => {
      const match = path.match(/^\/wp-json\/wpbridge\/v1\/alps\/post\/(\d+)$/);
      assert.ok(match);
      const state = states.get(Number(match[1]));
      if (!options.body) return { data: { fields: state.alps, alps_sha256: state.hash }, headers: new Headers() };
      state.alps = { large_banner: options.body.large_banner ?? state.alps.large_banner, hide_featured_image: options.body.hide_featured_image ?? state.alps.hide_featured_image };
      state.hash = state.alps.large_banner === "none" ? hashBefore : hashAfter;
      return { data: { fields: state.alps, alps_sha256: state.hash }, headers: new Headers() };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({ cfg: baseConfig({ allowLiveEdits: true, bulkOperationChunkSize: 1 }), wordpress }, async (base) => {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const prepare = await fetch(`${base}/v1/editorial/bulk/prepare`, { method: "POST", headers, body: JSON.stringify({
      idempotency_key: "bulk-plan-001", scope: { post_ids: [1, 2], status: "draft" },
      operations: { featured_image: { strategy: "first_content_image", only_if_missing: true }, alps: { large_banner: "hero_50_50", hide_featured_image: true } },
    }) });
    assert.equal(prepare.status, 200);
    const plan = await prepare.json();
    assert.equal(plan.state, "prepared");
    assert.equal(plan.summary.ready, 2);
    assert.equal(plan.summary.featured_image_changes, 1);
    assert.equal(plan.summary.alps_changes, 2);
    assert.equal(writes.length, 0);

    const execute = async (key) => fetch(`${base}/v1/editorial/bulk/${plan.operation_id}/execute`, { method: "POST", headers, body: JSON.stringify({ confirm: "APPLY_BULK_OPERATION", idempotency_key: key, chunk_size: 1 }) });
    assert.equal((await execute("bulk-exec-001")).status, 206);
    assert.equal((await execute("bulk-exec-002")).status, 200);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { id: 1, body: { featured_media: 11 } });
    const status = await fetch(`${base}/v1/editorial/bulk/${plan.operation_id}`, { headers });
    const completed = await status.json();
    assert.equal(completed.state, "completed");
    assert.equal(completed.counts.changed, 2);

    const rollback = await fetch(`${base}/v1/editorial/bulk/${plan.operation_id}/rollback`, { method: "POST", headers, body: JSON.stringify({ confirm: "ROLLBACK_BULK_OPERATION", idempotency_key: "bulk-rollback-001", chunk_size: 2 }) });
    assert.equal(rollback.status, 200);
    const rolled = await rollback.json();
    assert.equal(rolled.state, "rolled_back");
    assert.equal(rolled.results.filter((result) => result.rollback_outcome === "rolled_back").length, 2);
    assert.equal(states.get(1).featured_media, 0);
    assert.equal(states.get(1).alps.large_banner, "none");
  });
});

test("editorial audit obeys configured deadline and concurrency and can return partial results", async () => {
  let activeSeo = 0;
  let maxActiveSeo = 0;
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    status: "draft",
    modified_gmt: "2026-09-08T07:20:00",
    title: { raw: `Post ${index + 1}` },
    content: { raw: "Body" },
    excerpt: { raw: "" },
    categories: [],
    tags: [],
    slug: `post-${index + 1}`,
  }));
  const wordpress = {
    wpRequest: async (path) => {
      if (path.startsWith("/wp-json/wp/v2/types/post")) {
        return { data: { slug: "post", supports: { title: true, editor: true } }, headers: new Headers() };
      }
      if (path.startsWith("/wp-json/wp/v2/posts?")) {
        return { data: items, headers: new Headers({ "x-wp-total": "6", "x-wp-totalpages": "1" }) };
      }
      throw new Error(`unexpected path ${path}`);
    },
    wpSeoHelperRequest: async (path) => {
      if (path.endsWith("/capabilities")) {
        return { data: { available: true, helper_installed: true, provider: "test" }, headers: new Headers() };
      }
      activeSeo += 1;
      maxActiveSeo = Math.max(maxActiveSeo, activeSeo);
      await new Promise((resolve) => setTimeout(resolve, 18));
      activeSeo -= 1;
      return { data: { available: true, provider: "test", fields: {} }, headers: new Headers() };
    },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge({
    cfg: baseConfig({ auditDeadlineMs: 28, auditConcurrency: 2 }),
    wordpress,
  }, async (base) => {
    const response = await fetch(`${base}/v1/editorial/audit?post_type=post&status=draft&per_page=6&only_with_issues=false`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = await response.json();
    assert.equal(response.status, 206);
    assert.equal(data.deadline_exceeded, true);
    assert.ok(data.scanned_count < 6);
    assert.ok(data.skipped_due_deadline > 0);
    assert.ok(maxActiveSeo <= 2);
  });
});

test("persisted in-progress idempotency marker prevents a duplicate write after restart", async () => {
  const key = "restart-safe-create-0001";
  const body = { title: "Possibly already created" };
  const store = createMemoryIdempotencyStore();
  store.put(key, {
    scope: "create:post",
    request_fingerprint: requestFingerprint("create:post", body),
    state: "in_progress",
    status: 409,
    response_body: {
      error: "idempotency_operation_in_progress_or_interrupted",
      outcome: "unknown",
      outcome_unknown: true,
    },
    request_id: "old-request",
    created_at_ms: Date.now(),
  });
  let writes = 0;
  const wordpress = {
    wpRequest: async () => { writes += 1; throw new Error("must not write"); },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  await withBridge({ wordpress, idempotency: store }, async (base) => {
    const response = await fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 409);
    assert.equal(data.outcome, "unknown");
    assert.equal(response.headers.get("x-idempotency-replayed"), "true");
    assert.equal(writes, 0);
  });
});


test("configured default author name resolves to the authenticated WordPress user for new posts", async () => {
  const calls = [];
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      calls.push({ restPath, options });
      if (restPath === "/wp-json/wp/v2/users/me?context=edit") {
        return {
          data: { id: 37, name: "ChatGPT", nickname: "SiteOne.lt", slug: "chatgpt-bridge", username: "chatgpt-bridge" },
          headers: new Headers(),
        };
      }
      if (restPath === "/wp-json/wp/v2/posts") {
        assert.equal(options.method, "POST");
        assert.equal(options.body.author, 37);
        return {
          data: {
            id: 101, status: "draft", modified_gmt: "2026-09-08T08:00:00",
            title: { raw: "Author test", rendered: "Author test" },
            content: { raw: "", rendered: "" }, excerpt: { raw: "", rendered: "" },
            categories: [], tags: [], author: 37,
          },
          headers: new Headers(),
        };
      }
      throw new Error(`Unexpected WordPress request: ${restPath}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  const cfg = baseConfig({
    defaultAuthor: { kind: "name", value: "SiteOne.lt", raw: "SiteOne.lt" },
    enforceDefaultAuthor: true,
  });
  await withBridge({ cfg, wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Author test", idempotency_key: "author-default-post" }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).author, 37);
    assert.equal(calls.filter((call) => call.restPath.includes("users/me")).length, 1);
  });
});

test("enforced default author rejects a different per-request author", async () => {
  let writes = 0;
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/users/me?context=edit") {
        return { data: { id: 37, name: "SiteOne.lt", slug: "chatgpt-bridge" }, headers: new Headers() };
      }
      if (options.method === "POST") writes += 1;
      throw new Error(`Unexpected WordPress request: ${restPath}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  const cfg = baseConfig({
    defaultAuthor: { kind: "name", value: "SiteOne.lt", raw: "SiteOne.lt" },
    enforceDefaultAuthor: true,
  });
  await withBridge({ cfg, wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/posts`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Author test", author_id: 99, idempotency_key: "author-enforced-post" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "default_author_enforced");
    assert.equal(writes, 0);
  });
});

test("numeric default author applies to new pages without an author lookup", async () => {
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      assert.equal(restPath, "/wp-json/wp/v2/pages");
      assert.equal(options.method, "POST");
      assert.equal(options.body.author, 55);
      return {
        data: {
          id: 202, status: "draft", modified_gmt: "2026-09-08T08:00:00",
          title: { raw: "Page author", rendered: "Page author" },
          content: { raw: "", rendered: "" }, author: 55,
        },
        headers: new Headers(),
      };
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  const cfg = baseConfig({
    defaultAuthor: { kind: "id", value: 55, raw: "55" },
    enforceDefaultAuthor: true,
  });
  await withBridge({ cfg, wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/pages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Page author", idempotency_key: "author-default-page" }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).author, 55);
  });
});

test("numeric default author applies to author-enabled custom post type creation", async () => {
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/types/sermon?context=edit") {
        return {
          data: {
            slug: "sermon",
            rest_namespace: "wp/v2",
            rest_base: "sermons",
            supports: { title: true, author: true },
            hierarchical: false,
          },
          headers: new Headers(),
        };
      }
      if (restPath === "/wp-json/wp/v2/sermons") {
        assert.equal(options.method, "POST");
        assert.equal(options.body.author, 55);
        assert.equal(options.body.title, "Custom author");
        return {
          data: {
            id: 303, type: "sermon", status: "draft", modified_gmt: "2026-09-08T08:00:00",
            title: { raw: "Custom author", rendered: "Custom author" },
            content: { raw: "", rendered: "" }, excerpt: { raw: "", rendered: "" }, author: 55,
          },
          headers: new Headers(),
        };
      }
      throw new Error(`Unexpected WordPress request: ${restPath}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  const cfg = baseConfig({
    customPostTypes: ["sermon"],
    defaultAuthor: { kind: "id", value: 55, raw: "55" },
    enforceDefaultAuthor: true,
  });
  await withBridge({ cfg, wordpress }, async (base) => {
    const response = await fetch(`${base}/v1/custom-types/sermon/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Custom author", idempotency_key: "author-default-custom" }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).author, 55);
  });
});
