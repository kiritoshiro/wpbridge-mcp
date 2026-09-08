import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouteHandler } from "../lib/handlers.js";
import { writeBridgeError } from "../lib/http.js";
import { isAuthorized } from "../lib/auth.js";
import { createMemoryActivityStore } from "../lib/activity.js";

const apiKey = "r".repeat(40);

function cfg() {
  return {
    wpUrl: "https://example.test/wordpress",
    allowPublish: false,
    allowLiveEdits: false,
    maxBodyBytes: 1_000_000,
    maxMediaBytes: 100_000,
    bridgeApiKey: apiKey,
    customPostTypes: [],
    customFieldAllowlist: new Map(),
    customTaxonomyAllowlist: new Map(),
    idempotencyRetentionHours: 168,
    auditDeadlineMs: 15000,
    auditConcurrency: 4,
    activityRetentionDays: 30,
  };
}

async function withBridge(wordpress, activity, fn) {
  const security = { authorized: (req) => isAuthorized(req, apiKey), rateLimited: () => false };
  const route = createRouteHandler({ cfg: cfg(), wordpress, security, activity });
  const server = http.createServer(async (req, res) => {
    try { await route(req, res); }
    catch (err) { writeBridgeError(res, err, String(res.getHeader("x-request-id") || "") || undefined); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function authHeaders() {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

test("metadata edit history can be previewed and safely restored", async () => {
  let current = {
    id: 21,
    status: "draft",
    modified_gmt: "2026-09-08T06:00:00",
    content: { raw: "body" },
    title: { raw: "Title" },
    featured_media: 5,
    categories: [],
    tags: [],
  };
  let writes = 0;
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/posts/21?context=edit") {
        return { data: current, headers: new Headers() };
      }
      if (restPath === "/wp-json/wp/v2/posts/21" && options.method === "POST") {
        writes += 1;
        current = {
          ...current,
          ...options.body,
          modified_gmt: writes === 1 ? "2026-09-08T06:01:00" : "2026-09-08T06:02:00",
        };
        return { data: current, headers: new Headers() };
      }
      throw new Error(`Unexpected WordPress call: ${restPath}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };
  const activity = createMemoryActivityStore();

  await withBridge(wordpress, activity, async (base) => {
    const edit = await fetch(`${base}/v1/posts/21`, {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ featured_media: 9, expected_modified_gmt: "2026-09-08T06:00:00" }),
    });
    assert.equal(edit.status, 200);
    assert.equal(current.featured_media, 9);

    const historyResponse = await fetch(`${base}/v1/activity?recoverable=true`, { headers: authHeaders() });
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.entries.length, 1);
    const entry = history.entries[0];
    assert.equal(entry.action, "edit_post");
    assert.equal(entry.recoverable, true);

    const previewResponse = await fetch(`${base}/v1/activity/${entry.id}/restore-preview`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ expected_modified_gmt: "2026-09-08T06:01:00" }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.has_changes, true);
    assert.equal(preview.changes[0].field, "featured_media");
    assert.equal(preview.changes[0].before, 9);
    assert.equal(preview.changes[0].after, 5);
    assert.equal(preview.conflict_version.modified_gmt, "2026-09-08T06:01:00");
    assert.match(preview.conflict_version.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(writes, 1, "preview must not write");

    const missingPreview = await fetch(`${base}/v1/activity/${entry.id}/restore`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ confirm: "RESTORE_ACTIVITY", expected_modified_gmt: "2026-09-08T06:01:00" }),
    });
    assert.equal(missingPreview.status, 400);
    assert.equal((await missingPreview.json()).error, "restore_preview_required");
    assert.equal(writes, 1);

    const restore = await fetch(`${base}/v1/activity/${entry.id}/restore`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        confirm: "RESTORE_ACTIVITY",
        expected_modified_gmt: "2026-09-08T06:01:00",
        preview_token: preview.preview_token,
      }),
    });
    assert.equal(restore.status, 200);
    assert.equal(current.featured_media, 5);
    assert.equal(writes, 2);

    const staleReplay = await fetch(`${base}/v1/activity/${entry.id}/restore`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        confirm: "RESTORE_ACTIVITY",
        expected_modified_gmt: "2026-09-08T06:01:00",
        preview_token: preview.preview_token,
      }),
    });
    assert.equal(staleReplay.status, 409);
    assert.equal((await staleReplay.json()).error, "edit_conflict");
    assert.equal(writes, 2);
  });
});

test("content edit history links matching WordPress revisions instead of storing the body", async () => {
  let current = {
    id: 31,
    status: "draft",
    modified_gmt: "2026-09-08T07:00:00",
    title: { raw: "Before" },
    content: { raw: "private body" },
    excerpt: { raw: "" },
    categories: [], tags: [], featured_media: 0,
  };
  const activity = createMemoryActivityStore();
  const wordpress = {
    wpRequest: async (restPath, options = {}) => {
      if (restPath === "/wp-json/wp/v2/posts/31?context=edit") {
        return { data: current, headers: new Headers() };
      }
      if (restPath.startsWith("/wp-json/wp/v2/posts/31/revisions?")) {
        const before = current.title.raw === "Before";
        return {
          data: [{
            id: before ? 301 : 302,
            title: { raw: current.title.raw },
            content: { raw: current.content.raw },
            excerpt: { raw: current.excerpt.raw },
          }],
          headers: new Headers(),
        };
      }
      if (restPath === "/wp-json/wp/v2/posts/31" && options.method === "POST") {
        current = {
          ...current,
          title: { raw: options.body.title ?? current.title.raw },
          modified_gmt: "2026-09-08T07:01:00",
        };
        return { data: current, headers: new Headers() };
      }
      throw new Error(`Unexpected WordPress call: ${restPath}`);
    },
    wpSeoHelperRequest: async () => { throw new Error("unused"); },
    wpImageUpload: async () => { throw new Error("unused"); },
  };

  await withBridge(wordpress, activity, async (base) => {
    const edit = await fetch(`${base}/v1/posts/31`, {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ title: "After", expected_modified_gmt: "2026-09-08T07:00:00" }),
    });
    assert.equal(edit.status, 200);
    const [summary] = activity.list({ recoverable: true });
    const full = activity.get(summary.id);
    assert.equal(full.wordpress_revision.before.id, 301);
    assert.equal(full.wordpress_revision.after.id, 302);
    assert.equal(full.recovery.before_revision_id, 301);
    assert.deepEqual(full.recovery.revision_fields, ["title"]);
    const serialized = JSON.stringify(full);
    assert.equal(serialized.includes("private body"), false);
    assert.equal(serialized.includes('"Before"'), false);
  });
});
