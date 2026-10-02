import fs from "node:fs";
import { groups, operations } from "../lib/gpt-api.js";

const readOnlyActions = new Set([
  "previewPostEdit", "previewPageEdit", "previewCustomItemEdit",
  "previewCalendarEventEdit", "restoreActivityPreview",
]);
const publicationActions = new Set([
  "publishPost", "schedulePost", "unpublishPost", "submitPostForReview",
  "publishPage", "schedulePage", "unpublishPage", "submitPageForReview",
  "publishCustomItem", "scheduleCustomItem", "unpublishCustomItem", "submitCustomItemForReview",
  "publishCalendarEvent", "scheduleCalendarEvent", "unpublishCalendarEvent",
  "approveComment", "unapproveComment", "replyToComment",
]);
const controlActions = {
  getSite: { path: "/v1/site-control/site", method: "GET", permission: "site_read" },
  listPlugins: { path: "/v1/site-control/plugins", method: "GET", permission: "site_read" },
  updateSiteSettings: { path: "/v1/site-control/site", method: "POST", permission: "site_settings" },
  updatePlugin: { path: "/v1/site-control/plugins/update", method: "POST", permission: "plugin_updates" },
};

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_mcp_request" });
}

function checkedSite(site, env) {
  if (!site || typeof site !== "object" || Array.isArray(site)) throw invalid("Invalid site entry.");
  const { id, bridge_url: bridgeUrl, bridge_key_env: keyEnv, control_key_env: controlKeyEnv, permissions } = site;
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(id || "")) throw invalid("Invalid site ID.");
  let url;
  try { url = new URL(bridgeUrl); } catch { throw invalid(`Invalid bridge URL for ${id}.`); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw invalid(`Bridge URL for ${id} must be a loopback HTTP origin.`);
  }
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(keyEnv || "")) throw invalid(`Invalid bridge key variable for ${id}.`);
  if (!env[keyEnv] || String(env[keyEnv]).length < 32) throw invalid(`Missing bridge key for ${id}: ${keyEnv}.`);
  if (!Array.isArray(permissions) || permissions.some((value) =>
    !["read", "editorial", "publish", "site_read", "site_settings", "plugin_updates"].includes(value))) {
    throw invalid(`Invalid permissions for ${id}.`);
  }
  const controlEnabled = permissions.some((value) => ["site_read", "site_settings", "plugin_updates"].includes(value));
  if (controlEnabled && (!/^[A-Z][A-Z0-9_]{2,79}$/.test(controlKeyEnv || "") ||
      !env[controlKeyEnv] || String(env[controlKeyEnv]).length < 32)) {
    throw invalid(`Missing separate site-control key for ${id}.`);
  }
  if (controlEnabled && (controlKeyEnv === keyEnv || env[controlKeyEnv] === env[keyEnv])) {
    throw invalid(`Editorial and site-control keys must differ for ${id}.`);
  }
  if (site.allowed_actions !== undefined &&
      (!Array.isArray(site.allowed_actions) || site.allowed_actions.some((value) =>
        (!operations.has(value) || value === "uploadConversationImages") && !Object.hasOwn(controlActions, value) && value !== "uploadAttachedMedia"))) {
    throw invalid(`Invalid allowed_actions for ${id}.`);
  }
  return Object.freeze({
    id, bridgeUrl: url.origin, key: String(env[keyEnv]),
    controlKey: controlEnabled ? String(env[controlKeyEnv]) : "",
    permissions: new Set(permissions),
    allowedActions: site.allowed_actions ? new Set(site.allowed_actions) : null,
  });
}

export function loadSites(filePath, env = process.env) {
  const input = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(input.sites) || !input.sites.length) throw invalid("Configure at least one site.");
  const sites = input.sites.map((site) => checkedSite(site, env));
  if (new Set(sites.map((site) => site.id)).size !== sites.length) throw invalid("Duplicate site ID.");
  const keys = sites.flatMap((site) => [site.key, ...(site.controlKey ? [site.controlKey] : [])]);
  if (new Set(keys).size !== keys.length) throw invalid("Each site and access class needs a distinct key.");
  return sites;
}

export function permissionFor(action) {
  if (action === "uploadAttachedMedia") return "editorial";
  if (Object.hasOwn(controlActions, action)) return controlActions[action].permission;
  const operation = operations.get(action);
  if (!operation) throw invalid("Unknown action.");
  if (publicationActions.has(action)) return "publish";
  if (operation.method === "GET" || readOnlyActions.has(action)) return "read";
  return "editorial";
}

function assertObject(value, name) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw invalid(`${name} must be an object.`);
  }
}

export function createGateway(sites, { fetchImpl = globalThis.fetch, timeoutMs = 90_000 } = {}) {
  const siteMap = new Map(sites.map((site) => [site.id, site]));
  if (siteMap.size !== sites.length) throw invalid("Duplicate site ID.");
  function listSites() {
    return sites.map((site) => ({ id: site.id, permissions: [...site.permissions] }));
  }
  async function invoke({ site_id: siteId, action, path, query, body }) {
    const site = siteMap.get(siteId);
    if (!site) throw invalid("Unknown or unavailable site ID.");
    if (typeof action !== "string") throw invalid("Action is required.");
    assertObject(path, "path"); assertObject(query, "query"); assertObject(body, "body");
    if (site.allowedActions && !site.allowedActions.has(action)) throw invalid("Action is disabled for this site.");
    const permission = permissionFor(action);
    if (!site.permissions.has(permission)) throw invalid("Action is disabled for this site.");
    const control = controlActions[action];
    let endpoint, payload;
    if (action === "uploadAttachedMedia") {
      if (path || query || !body || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > 10 ||
          typeof body.idempotency_key !== "string" || !body.idempotency_key) throw invalid("Invalid attached-media request.");
      endpoint = "/gpt/uploadConversationImages";
      payload = {
        openaiFileIdRefs: body.files.map((file) => ({
          id: file.file_id, name: file.file_name, mime_type: file.mime_type, download_link: file.download_url,
        })),
        idempotency_key: body.idempotency_key,
        ...(body.optimization_mode ? { optimization_mode: body.optimization_mode } : {}),
      };
    } else if (control) {
      if (path || query || (control.method === "GET" && body)) throw invalid("Unexpected parameters for site control action.");
      endpoint = control.path;
      payload = control.method === "POST" ? body : undefined;
    } else {
      const group = Object.entries(groups).find(([, ids]) => ids.includes(action))?.[0];
      if (!group) throw invalid("Unknown action.");
      endpoint = `/gpt/${group}`;
      payload = { action, ...(path ? { path } : {}), ...(query ? { query } : {}), ...(body ? { body } : {}) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${site.bridgeUrl}${endpoint}`, {
        method: control?.method || "POST",
        headers: { authorization: `Bearer ${control ? site.controlKey : site.key}`, accept: "application/json", "content-type": "application/json" },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) throw new Error("Bridge returned a non-JSON response.");
      const result = await response.json();
      return { site_id: siteId, action, ok: response.ok, status: response.status, result };
    } finally {
      clearTimeout(timer);
    }
  }
  return { listSites, invoke };
}

export const siteControlActions = Object.freeze(Object.keys(controlActions));
