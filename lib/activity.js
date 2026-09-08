import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function boundedValue(value, depth = 0) {
  if (depth > 4) return "[depth-limited]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length <= 1000 ? value : `${value.slice(0, 1000)}…`;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      out[String(key).slice(0, 191)] = boundedValue(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 1000);
}

export function sanitizeActivityPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const allowed = new Set([
    "time",
    "method",
    "path",
    "status",
    "outcome",
    "request_id",
    "action",
    "target",
    "recoverable",
    "recovery",
    "changed_fields",
    "wordpress_revision",
    "note",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.has(key) && value !== undefined) out[key] = boundedValue(value);
  }
  return out;
}

function summarize(entry) {
  return {
    id: entry.id,
    time: entry.time,
    method: entry.method || "",
    path: entry.path || "",
    status: entry.status ?? null,
    outcome: entry.outcome || "unknown",
    request_id: entry.request_id || "",
    action: entry.action || "",
    target: entry.target || null,
    recoverable: Boolean(entry.recoverable),
    changed_fields: Array.isArray(entry.changed_fields) ? entry.changed_fields : [],
    wordpress_revision: entry.wordpress_revision || null,
    note: entry.note || "",
  };
}

function createStoreCore({ retentionMs, maxRecords, persist }) {
  const records = new Map();
  const byRequestId = new Map();

  function rebuildRequestIndex() {
    byRequestId.clear();
    for (const entry of records.values()) {
      if (entry?.request_id) byRequestId.set(entry.request_id, entry.id);
    }
  }

  function prune(now = Date.now()) {
    for (const [id, entry] of records) {
      const timeMs = Date.parse(entry?.time || "");
      if (!Number.isFinite(timeMs) || now - timeMs > retentionMs) records.delete(id);
    }
    if (records.size > maxRecords) {
      const ordered = [...records.values()].sort(
        (a, b) => Date.parse(a?.time || 0) - Date.parse(b?.time || 0)
      );
      for (let i = 0; i < ordered.length - maxRecords; i += 1) records.delete(ordered[i].id);
    }
    rebuildRequestIndex();
  }

  function upsertByRequestId(requestId, patch) {
    prune();
    const safePatch = sanitizeActivityPatch({ ...patch, request_id: requestId });
    let id = requestId ? byRequestId.get(requestId) : null;
    let existing = id ? records.get(id) : null;
    if (!existing) {
      id = crypto.randomUUID();
      existing = {
        id,
        time: safePatch.time || new Date().toISOString(),
        request_id: requestId || "",
      };
    }
    const mergePatch = { ...safePatch };
    if (existing?.action && mergePatch.action) delete mergePatch.action;
    if (existing?.target && mergePatch.target) delete mergePatch.target;
    const next = { ...existing, ...mergePatch, id, request_id: requestId || existing.request_id || "" };
    records.set(id, next);
    if (next.request_id) byRequestId.set(next.request_id, id);
    prune();
    persist(records);
    return clone(next);
  }

  function append(patch) {
    prune();
    const safePatch = sanitizeActivityPatch(patch);
    const id = crypto.randomUUID();
    const entry = {
      id,
      time: safePatch.time || new Date().toISOString(),
      ...safePatch,
    };
    records.set(id, entry);
    if (entry.request_id) byRequestId.set(entry.request_id, id);
    prune();
    persist(records);
    return clone(entry);
  }

  return {
    upsertByRequestId,
    append,
    get(id) {
      prune();
      return clone(records.get(String(id || "")) || null);
    },
    list({ limit = 50, postType, objectId, outcome, recoverable } = {}) {
      prune();
      let values = [...records.values()].sort(
        (a, b) => Date.parse(b?.time || 0) - Date.parse(a?.time || 0)
      );
      if (postType) values = values.filter((entry) => entry?.target?.post_type === postType);
      if (objectId !== undefined && objectId !== null) {
        values = values.filter((entry) => Number(entry?.target?.object_id) === Number(objectId));
      }
      if (outcome) values = values.filter((entry) => entry?.outcome === outcome);
      if (recoverable !== undefined) values = values.filter((entry) => Boolean(entry?.recoverable) === Boolean(recoverable));
      return values.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))).map(summarize);
    },
    stats() {
      prune();
      return { records: records.size };
    },
    _load(entries) {
      records.clear();
      for (const entry of entries || []) {
        if (entry?.id) records.set(entry.id, entry);
      }
      prune();
    },
  };
}

export function createMemoryActivityStore({ retentionMs = 30 * 24 * 60 * 60 * 1000, maxRecords = 2000 } = {}) {
  return createStoreCore({ retentionMs, maxRecords, persist: () => {} });
}

export function createFileActivityStore({ filePath, retentionMs, maxRecords }) {
  const absolute = path.resolve(filePath);
  let loaded = false;
  let core;

  function persist(records) {
    if (!loaded) return;
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const tmp = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = JSON.stringify({ version: 1, records: [...records.values()] }, null, 2);
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, absolute);
    try { fs.chmodSync(absolute, 0o600); } catch {}
  }

  core = createStoreCore({ retentionMs, maxRecords, persist });

  function load() {
    if (loaded) return;
    loaded = true;
    if (!fs.existsSync(absolute)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
      core._load(Array.isArray(parsed?.records) ? parsed.records : []);
    } catch (error) {
      const err = new Error(`Could not read activity store at ${absolute}: ${error.message}`);
      err.code = "ACTIVITY_STORE_ERROR";
      throw err;
    }
  }

  return {
    upsertByRequestId(requestId, patch) { load(); return core.upsertByRequestId(requestId, patch); },
    append(patch) { load(); return core.append(patch); },
    get(id) { load(); return core.get(id); },
    list(filters) { load(); return core.list(filters); },
    stats() { load(); return { ...core.stats(), file: absolute }; },
  };
}

export function outcomeFromStatus(status) {
  if (status >= 200 && status < 400) return "succeeded";
  return "failed";
}

export function inferMutationActivity(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(m)) return null;
  if (/\/preview$/.test(p) || p === "/v1/editorial/audit") return null;

  const patterns = [
    [/^\/v1\/posts\/(\d+)$/, "edit_post", "post"],
    [/^\/v1\/posts\/(\d+)\/(publish|unpublish|schedule|submit-review)$/, "post_workflow", "post"],
    [/^\/v1\/posts\/(\d+)\/blocks$/, "edit_post_blocks", "post"],
    [/^\/v1\/posts\/(\d+)\/revisions\/(\d+)\/restore$/, "restore_post_revision", "post"],
    [/^\/v1\/pages\/(\d+)$/, "edit_page", "page"],
    [/^\/v1\/pages\/(\d+)\/(publish|unpublish|schedule|submit-review)$/, "page_workflow", "page"],
    [/^\/v1\/pages\/(\d+)\/blocks$/, "edit_page_blocks", "page"],
    [/^\/v1\/pages\/(\d+)\/revisions\/(\d+)\/restore$/, "restore_page_revision", "page"],
    [/^\/v1\/posts\/(\d+)\/seo$/, "edit_post_seo", "post"],
    [/^\/v1\/pages\/(\d+)\/seo$/, "edit_page_seo", "page"],
    [/^\/v1\/custom-fields\/([a-z0-9_-]+)\/(\d+)$/, "edit_custom_fields", null],
    [/^\/v1\/comments\/(\d+)\/(approve|unapprove|reply)$/, "comment_action", "comment"],
    [/^\/v1\/media\/(\d+)\/transform$/, "transform_media", "media"],
    [/^\/v1\/media\/(\d+)$/, "edit_media", "media"],
    [/^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)$/, "edit_custom_item", null],
  ];
  for (const [re, action, type] of patterns) {
    const match = p.match(re);
    if (!match) continue;
    if (action === "edit_custom_item" || action === "edit_custom_fields") {
      return { action, target: { kind: "content", post_type: match[1], object_id: Number(match[2]) } };
    }
    return {
      action,
      target: { kind: type === "comment" || type === "media" ? type : "content", post_type: type, object_id: Number(match[1]) },
    };
  }
  if (m === "POST" && p === "/v1/posts") return { action: "create_post", target: { kind: "content", post_type: "post" } };
  if (m === "POST" && p === "/v1/pages") return { action: "create_page", target: { kind: "content", post_type: "page" } };
  if (m === "POST" && p === "/v1/media") return { action: "upload_media", target: { kind: "media" } };
  if (m === "POST" && p === "/v1/categories") return { action: "create_category", target: { kind: "taxonomy_term", taxonomy: "category" } };
  if (m === "POST" && p === "/v1/tags") return { action: "create_tag", target: { kind: "taxonomy_term", taxonomy: "post_tag" } };
  const customCreateMatch = p.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/items$/);
  if (m === "POST" && customCreateMatch) {
    return { action: "create_custom_item", target: { kind: "content", post_type: customCreateMatch[1] } };
  }
  const termCreateMatch = p.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/taxonomies\/([a-z0-9_-]+)\/terms$/);
  if (m === "POST" && termCreateMatch) {
    return {
      action: "create_custom_taxonomy_term",
      target: { kind: "taxonomy_term", post_type: termCreateMatch[1], taxonomy: termCreateMatch[2] },
    };
  }
  const taxonomyMatch = p.match(/^\/v1\/custom-types\/([a-z0-9_-]+)\/items\/(\d+)\/taxonomies\/([a-z0-9_-]+)\/(assign|remove)$/);
  if (taxonomyMatch) {
    return {
      action: `custom_taxonomy_${taxonomyMatch[4]}`,
      target: { kind: "content", post_type: taxonomyMatch[1], object_id: Number(taxonomyMatch[2]) },
    };
  }
  if (m === "POST" && p === "/v1/editorial/bulk-edit") return { action: "bulk_edit", target: { kind: "bulk" } };
  if (/^\/v1\/activity\/[0-9a-f-]+\/restore$/.test(p)) return { action: "restore_activity", target: { kind: "activity" } };
  return { action: `${m.toLowerCase()} ${p}`, target: null };
}
