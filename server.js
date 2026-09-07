/**
 * SiteOne WordPress ↔ ChatGPT bridge
 * Zero runtime dependencies; requires Node.js 20+.
 *
 * Security model:
 * - Binds to 127.0.0.1 only.
 * - WordPress credentials stay local in .env.
 * - ChatGPT receives only BRIDGE_API_KEY.
 * - Only explicitly implemented WordPress REST operations are reachable.
 * - No delete, users, plugins, themes, raw REST proxy, or arbitrary URLs.
 * - Publishing/unpublishing is disabled unless ALLOW_PUBLISH=true.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

function loadEnvFile(file = ".env") {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const rawLine of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const cfg = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || "8787"),
  wpUrl: (process.env.WP_URL || "").replace(/\/+$/, ""),
  wpUsername: process.env.WP_USERNAME || "",
  wpAppPassword: (process.env.WP_APP_PASSWORD || "").replace(/\s+/g, ""),
  bridgeApiKey: process.env.BRIDGE_API_KEY || "",
  allowPublish: /^true$/i.test(process.env.ALLOW_PUBLISH || "false"),
  maxBodyBytes: Math.min(
    Math.max(Number(process.env.MAX_BODY_BYTES || "1500000"), 1024),
    5_000_000
  ),
  rateLimitPerMinute: Math.min(
    Math.max(Number(process.env.RATE_LIMIT_PER_MINUTE || "120"), 10),
    1000
  ),
};

function failStartup(message) {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

if (!cfg.wpUrl) failStartup("WP_URL is required.");
if (!cfg.wpUsername) failStartup("WP_USERNAME is required.");
if (!cfg.wpAppPassword) failStartup("WP_APP_PASSWORD is required.");
if (!cfg.bridgeApiKey || cfg.bridgeApiKey.length < 32) {
  failStartup("BRIDGE_API_KEY is required and must be at least 32 characters.");
}
let wpOrigin;
try {
  const u = new URL(cfg.wpUrl);
  if (u.protocol !== "https:") failStartup("WP_URL must use HTTPS.");
  wpOrigin = u.origin;
} catch {
  failStartup("WP_URL must be a valid HTTPS URL.");
}

const basicAuth =
  "Basic " +
  Buffer.from(`${cfg.wpUsername}:${cfg.wpAppPassword}`, "utf8").toString("base64");

const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60_000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.started < cutoff) rateBuckets.delete(key);
  }
}, 60_000).unref();

function clientId(req) {
  // Cloudflare sets CF-Connecting-IP. This value is only used for coarse
  // rate-limiting; it is not an authentication factor.
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
}

function rateLimited(req) {
  const key = clientId(req);
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.started >= 60_000) {
    bucket = { started: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > cfg.rateLimitPerMinute;
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) {
    // Keep a timingSafeEqual call on equal-length buffers to reduce
    // accidental timing differences between code paths.
    const pad = crypto.randomBytes(Math.max(aa.length, 1));
    crypto.timingSafeEqual(pad, pad);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  // Prefer standard Bearer auth for GPT Actions, but keep the original
  // X-Bridge-Key header for backwards-compatible manual/local tests.
  const auth = String(req.headers["authorization"] || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const custom = String(req.headers["x-bridge-key"] || "").trim();

  return (
    (bearer && safeEqual(bearer, cfg.bridgeApiKey)) ||
    (custom && safeEqual(custom, cfg.bridgeApiKey))
  );
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cfg.maxBodyBytes) {
      const err = new Error("Request body too large.");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const err = new Error("JSON body must be an object.");
      err.status = 400;
      throw err;
    }
    return value;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error("Invalid JSON body.");
    err.status = 400;
    throw err;
  }
}

function integer(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    const err = new Error(`${name} must be an integer between ${min} and ${max}.`);
    err.status = 400;
    throw err;
  }
  return n;
}

function optionalIdArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    const err = new Error(`${name} must be an array with at most 100 numeric IDs.`);
    err.status = 400;
    throw err;
  }
  return value.map((v) => integer(v, name));
}

function optionalString(value, name, maxLen) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLen) {
    const err = new Error(`${name} must be a string no longer than ${maxLen} characters.`);
    err.status = 400;
    throw err;
  }
  return value;
}

function postSummary(post) {
  return {
    id: post.id,
    date: post.date,
    modified: post.modified,
    slug: post.slug,
    status: post.status,
    link: post.link,
    title: post.title?.rendered ?? post.title?.raw ?? "",
    excerpt: post.excerpt?.rendered ?? post.excerpt?.raw ?? "",
    categories: post.categories ?? [],
    tags: post.tags ?? [],
    featured_media: post.featured_media ?? 0,
  };
}

function postDetails(post) {
  return {
    id: post.id,
    date: post.date,
    modified: post.modified,
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
    excerpt: {
      raw: post.excerpt?.raw ?? "",
      rendered: post.excerpt?.rendered ?? "",
    },
    categories: post.categories ?? [],
    tags: post.tags ?? [],
    featured_media: post.featured_media ?? 0,
  };
}

async function wpRequest(restPath, { method = "GET", body } = {}) {
  if (!restPath.startsWith("/wp-json/wp/v2/")) {
    throw new Error("Internal safety check failed: disallowed WordPress REST path.");
  }
  const target = new URL(restPath, wpOrigin);
  if (target.origin !== wpOrigin) {
    throw new Error("Internal safety check failed: WordPress origin mismatch.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(target, {
      method,
      headers: {
        authorization: basicAuth,
        accept: "application/json",
        ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
        "user-agent": "SiteOne-ChatGPT-WordPress-Bridge/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: "WordPress returned a non-JSON response." };
    }

    if (!response.ok) {
      const err = new Error(
        typeof data?.message === "string"
          ? data.message.replace(/<[^>]*>/g, "")
          : `WordPress request failed with HTTP ${response.status}.`
      );
      err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
      err.code = data?.code;
      throw err;
    }
    return { data, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}

function makeQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

async function route(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader("x-request-id", requestId);

  if (rateLimited(req)) {
    return json(res, 429, { error: "rate_limited", request_id: requestId });
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "site-one-wordpress-chatgpt-bridge",
      version: "1.0.0",
      publish_enabled: cfg.allowPublish,
    });
  }

  if (!authorized(req)) {
    return json(res, 401, { error: "unauthorized", request_id: requestId });
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
    const query = makeQuery({
      context: "edit",
      status,
      search,
      per_page: perPage,
      page,
      orderby: "modified",
      order: "desc",
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

    const result = await wpRequest("/wp-json/wp/v2/posts", { method: "POST", body: payload });
    return json(res, 201, postDetails(result.data));
  }

  // PATCH /v1/posts/:id — cannot change status.
  match = url.pathname.match(/^\/v1\/posts\/(\d+)$/);
  if (req.method === "PATCH" && match) {
    const id = integer(match[1], "post_id");
    const body = await readJson(req);
    if ("status" in body) {
      return json(res, 400, {
        error: "status_not_allowed_here",
        message: "Use the dedicated publish/unpublish action for visibility changes.",
      });
    }
    const payload = {};
    const mappings = [
      ["title", 500],
      ["content", 1_000_000],
      ["excerpt", 20_000],
      ["slug", 250],
    ];
    for (const [field, maxLen] of mappings) {
      const value = optionalString(body[field], field, maxLen);
      if (value !== undefined) payload[field] = value;
    }
    const categories = optionalIdArray(body.category_ids, "category_ids");
    const tags = optionalIdArray(body.tag_ids, "tag_ids");
    if (categories !== undefined) payload.categories = categories;
    if (tags !== undefined) payload.tags = tags;
    if (body.featured_media !== undefined) {
      payload.featured_media = integer(body.featured_media, "featured_media", { min: 0 });
    }
    if (!Object.keys(payload).length) {
      return json(res, 400, { error: "no_editable_fields_supplied" });
    }

    const result = await wpRequest(`/wp-json/wp/v2/posts/${id}`, {
      method: "POST",
      body: payload,
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

  // GET /v1/categories
  if (req.method === "GET" && url.pathname === "/v1/categories") {
    const search = (url.searchParams.get("search") || "").slice(0, 200);
    const perPage = integer(url.searchParams.get("per_page") || "50", "per_page", { min: 1, max: 100 });
    const query = makeQuery({ context: "edit", search, per_page: perPage, hide_empty: "false" });
    const result = await wpRequest(`/wp-json/wp/v2/categories?${query}`);
    return json(res, 200, {
      categories: (result.data || []).map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        parent: c.parent,
        count: c.count,
      })),
    });
  }

  // GET /v1/tags
  if (req.method === "GET" && url.pathname === "/v1/tags") {
    const search = (url.searchParams.get("search") || "").slice(0, 200);
    const perPage = integer(url.searchParams.get("per_page") || "50", "per_page", { min: 1, max: 100 });
    const query = makeQuery({ context: "edit", search, per_page: perPage, hide_empty: "false" });
    const result = await wpRequest(`/wp-json/wp/v2/tags?${query}`);
    return json(res, 200, {
      tags: (result.data || []).map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        count: t.count,
      })),
    });
  }

  return json(res, 404, { error: "not_found", request_id: requestId });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    await route(req, res);
  } catch (err) {
    const status =
      Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
        ? err.status
        : err?.name === "AbortError"
          ? 504
          : 500;
    const safeMessage =
      status >= 500 && !err?.code
        ? "Bridge or upstream request failed."
        : String(err?.message || "Request failed.").slice(0, 500);
    json(res, status, {
      error: err?.code || "request_failed",
      message: safeMessage,
    });
  } finally {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        method: req.method,
        path: String(req.url || "").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - started,
      })
    );
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`WordPress bridge listening on http://${cfg.host}:${cfg.port}`);
  console.log(`Target WordPress site: ${cfg.wpUrl}`);
  console.log(`Publishing enabled: ${cfg.allowPublish}`);
});
