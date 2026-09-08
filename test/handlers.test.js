import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouteHandler } from "../lib/handlers.js";
import { writeBridgeError } from "../lib/http.js";
import { isAuthorized } from "../lib/auth.js";
import { createMemoryIdempotencyStore, requestFingerprint } from "../lib/idempotency.js";
import { createMemoryActivityStore } from "../lib/activity.js";

const apiKey = "b".repeat(40);

function baseConfig(overrides = {}) {
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
    ...overrides,
  };
}

async function withBridge({ cfg = baseConfig(), wordpress, idempotency, activity }, fn) {
  const security = {
    authorized: (req) => isAuthorized(req, apiKey),
    rateLimited: () => false,
  };
  const route = createRouteHandler({ cfg, wordpress, security, idempotency, activity });
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

function unusedWordPress() {
  const fail = async () => {
    throw new Error("WordPress should not have been called");
  };
  return { wpRequest: fail, wpSeoHelperRequest: fail, wpImageUpload: fail };
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
    assert.equal((await health.json()).version, "1.15.1");

    const posts = await fetch(`${base}/v1/posts`);
    assert.equal(posts.status, 401);
    assert.equal((await posts.json()).error, "unauthorized");
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
