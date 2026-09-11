import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";

export function configError(message) {
  const err = new Error(message);
  err.code = "CONFIG_ERROR";
  return err;
}

export function loadEnvFile(file = ".env", env = process.env, cwd = process.cwd()) {
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) return false;
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
    if (!(key in env)) env[key] = value;
  }
  return true;
}

export function parseIntegerSetting(env, name, defaultValue, { min, max } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? String(defaultValue) : String(raw).trim();
  if (!/^-?\d+$/.test(value)) {
    throw configError(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw configError(`${name} must be a safe integer.`);
  }
  if (min !== undefined && parsed < min) {
    throw configError(`${name} must be at least ${min}.`);
  }
  if (max !== undefined && parsed > max) {
    throw configError(`${name} must be at most ${max}.`);
  }
  return parsed;
}


export function parseDefaultAuthor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw configError("DEFAULT_AUTHOR numeric IDs must be positive safe integers.");
    }
    return { kind: "id", value: id, raw };
  }
  if (raw.length > 191 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw configError("DEFAULT_AUTHOR name/slug must be 1-191 printable characters.");
  }
  return { kind: "name", value: raw, raw };
}

export function parseBooleanSetting(env, name, defaultValue = false) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return Boolean(defaultValue);
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw configError(`${name} must be either true or false.`);
}

export function normalizeWpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw configError("WP_URL is required.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw configError("WP_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") throw configError("WP_URL must use HTTPS.");
  if (url.username || url.password) throw configError("WP_URL must not contain credentials.");
  if (url.search || url.hash) throw configError("WP_URL must not contain a query string or fragment.");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "");
}

export function buildWpRestUrl(wpUrl, restPath) {
  if (!String(restPath).startsWith("/wp-json/")) {
    throw new Error("Internal safety check failed: disallowed WordPress REST path.");
  }
  const site = new URL(wpUrl);
  const basePath = site.pathname === "/" ? "" : site.pathname.replace(/\/+$/, "");
  const target = new URL(`${basePath}${restPath}`, site.origin);
  const requiredPrefix = `${basePath}/wp-json/`;
  if (target.origin !== site.origin || !target.pathname.startsWith(requiredPrefix)) {
    throw new Error("Internal safety check failed: WordPress REST target escaped the configured site path.");
  }
  return target;
}

export function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return ["127.0.0.1", "::1", "localhost"].includes(normalized);
}

export function assertListenerAllowed(host, allowExternalAccess) {
  if (!isLoopbackHost(host) && !allowExternalAccess) {
    throw configError(
      `HOST=${host} is not loopback. Set ALLOW_EXTERNAL_ACCESS=true explicitly to bind outside localhost.`
    );
  }
}

function normalizeIp(value) {
  let ip = String(value || "").trim();
  if (ip.startsWith("[")) ip = ip.replace(/^\[|\]$/g, "");
  if (ip.toLowerCase().startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (net.isIP(mapped) === 4) ip = mapped;
  }
  return ip;
}

export function parseTrustedProxyIps(value) {
  const out = new Set();
  for (const raw of String(value || "").split(",")) {
    const ip = normalizeIp(raw);
    if (!ip) continue;
    if (!net.isIP(ip)) {
      throw configError(`TRUSTED_PROXY_IPS contains invalid IP address "${raw.trim()}".`);
    }
    out.add(ip);
  }
  return out;
}

function forwardedCandidate(headers) {
  const cf = String(headers?.["cf-connecting-ip"] || "").trim();
  if (cf && net.isIP(normalizeIp(cf))) return normalizeIp(cf);
  const xff = String(headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
  if (xff && net.isIP(normalizeIp(xff))) return normalizeIp(xff);
  return "";
}

export function clientIp(req, trustedProxyIps) {
  const remote = normalizeIp(req?.socket?.remoteAddress || "");
  if (remote && trustedProxyIps?.has(remote)) {
    const forwarded = forwardedCandidate(req.headers || {});
    if (forwarded) return forwarded;
  }
  return remote || "unknown";
}

export function parseSlugList(value, name) {
  const out = [];
  const seen = new Set();
  for (const raw of String(value || "").split(",")) {
    const slug = raw.trim();
    if (!slug) continue;
    if (!/^[a-z0-9_-]{1,20}$/.test(slug)) {
      throw configError(`${name} contains invalid post type slug "${slug}".`);
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

export function parseCustomFieldAllowlist(value) {
  const result = new Map();
  const rawValue = String(value || "").trim();
  if (!rawValue) return result;

  for (const groupRaw of rawValue.split(";")) {
    const group = groupRaw.trim();
    if (!group) continue;
    const colon = group.indexOf(":");
    if (colon < 1) {
      throw configError('CUSTOM_FIELD_ALLOWLIST must use "post_type:key1,key2;page:key3" format.');
    }
    const type = group.slice(0, colon).trim();
    if (!/^[a-z0-9_-]{1,20}$/.test(type)) {
      throw configError(`CUSTOM_FIELD_ALLOWLIST contains invalid post type slug "${type}".`);
    }
    const keys = [];
    const seen = new Set();
    for (const rawKey of group.slice(colon + 1).split(",")) {
      const key = rawKey.trim();
      if (!key) continue;
      if (!/^[A-Za-z0-9_.:-]{1,191}$/.test(key)) {
        throw configError(`CUSTOM_FIELD_ALLOWLIST contains invalid meta key "${key}".`);
      }
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    if (!keys.length) {
      throw configError(`CUSTOM_FIELD_ALLOWLIST entry for "${type}" has no meta keys.`);
    }
    const existing = result.get(type) || [];
    result.set(type, [...new Set([...existing, ...keys])]);
  }
  return result;
}

export function parseCustomTaxonomyAllowlist(value) {
  const result = new Map();
  const rawValue = String(value || "").trim();
  if (!rawValue) return result;

  for (const groupRaw of rawValue.split(";")) {
    const group = groupRaw.trim();
    if (!group) continue;
    const colon = group.indexOf(":");
    if (colon < 1) {
      throw configError(
        'CUSTOM_TAXONOMY_ALLOWLIST must use "post_type:taxonomy1,taxonomy2;other_type:taxonomy3" format.'
      );
    }
    const type = group.slice(0, colon).trim();
    if (!/^[a-z0-9_-]{1,20}$/.test(type)) {
      throw configError(`CUSTOM_TAXONOMY_ALLOWLIST contains invalid post type slug "${type}".`);
    }

    const taxonomies = [];
    const seen = new Set();
    for (const rawTaxonomy of group.slice(colon + 1).split(",")) {
      const taxonomy = rawTaxonomy.trim();
      if (!taxonomy) continue;
      if (!/^[a-z0-9_-]{1,32}$/.test(taxonomy)) {
        throw configError(`CUSTOM_TAXONOMY_ALLOWLIST contains invalid taxonomy slug "${taxonomy}".`);
      }
      if (!seen.has(taxonomy)) {
        seen.add(taxonomy);
        taxonomies.push(taxonomy);
      }
    }
    if (!taxonomies.length) {
      throw configError(`CUSTOM_TAXONOMY_ALLOWLIST entry for "${type}" has no taxonomy slugs.`);
    }
    const existing = result.get(type) || [];
    result.set(type, [...new Set([...existing, ...taxonomies])]);
  }
  return result;
}

export function loadConfig(env = process.env) {
  const cfg = {
    host: (env.HOST || "127.0.0.1").trim(),
    port: parseIntegerSetting(env, "PORT", 8787, { min: 1, max: 65535 }),
    wpUrl: normalizeWpUrl(env.WP_URL || ""),
    wpUsername: env.WP_USERNAME || "",
    wpAppPassword: (env.WP_APP_PASSWORD || "").replace(/\s+/g, ""),
    bridgeApiKey: env.BRIDGE_API_KEY || "",
    allowPublish: parseBooleanSetting(env, "ALLOW_PUBLISH", false),
    allowLiveEdits: parseBooleanSetting(env, "ALLOW_LIVE_EDITS", false),
    defaultAuthor: parseDefaultAuthor(env.DEFAULT_AUTHOR || ""),
    enforceDefaultAuthor: parseBooleanSetting(env, "ENFORCE_DEFAULT_AUTHOR", false),
    allowExternalAccess: parseBooleanSetting(env, "ALLOW_EXTERNAL_ACCESS", false),
    maxBodyBytes: parseIntegerSetting(env, "MAX_BODY_BYTES", 12_000_000, {
      min: 1024,
      max: 20_000_000,
    }),
    // Keep large WordPress content reads below common Custom GPT/Actions
    // response limits. Callers can request subsequent windows with the
    // content_offset/content_limit query parameters.
    maxContentResponseChars: parseIntegerSetting(env, "MAX_CONTENT_RESPONSE_CHARS", 24_000, {
      min: 4_000,
      max: 200_000,
    }),
    maxMediaBytes: parseIntegerSetting(env, "MAX_MEDIA_BYTES", 8_000_000, {
      min: 1024,
      max: 10_000_000,
    }),
    maxSourceImageBytes: parseIntegerSetting(env, "MAX_SOURCE_IMAGE_BYTES", 20_000_000, {
      min: 1024,
      max: 50_000_000,
    }),
    maxSourceImageBatchBytes: parseIntegerSetting(env, "MAX_SOURCE_IMAGE_BATCH_BYTES", 50_000_000, {
      min: 1024,
      max: 100_000_000,
    }),
    imageOptimizeThresholdBytes: parseIntegerSetting(env, "IMAGE_OPTIMIZE_THRESHOLD_BYTES", 1_500_000, {
      min: 10_000,
      max: 50_000_000,
    }),
    imageOptimizeMaxDimension: parseIntegerSetting(env, "IMAGE_OPTIMIZE_MAX_DIMENSION", 1920, {
      min: 320,
      max: 8192,
    }),
    imageOptimizeQuality: parseIntegerSetting(env, "IMAGE_OPTIMIZE_QUALITY", 82, {
      min: 40,
      max: 95,
    }),
    maxArchiveEntries: parseIntegerSetting(env, "MAX_ARCHIVE_ENTRIES", 1000, {
      min: 10,
      max: 10_000,
    }),
    maxExtractedImages: parseIntegerSetting(env, "MAX_EXTRACTED_IMAGES", 50, {
      min: 1,
      max: 200,
    }),
    customPostTypes: parseSlugList(env.CUSTOM_POST_TYPES || "", "CUSTOM_POST_TYPES"),
    customFieldAllowlist: parseCustomFieldAllowlist(env.CUSTOM_FIELD_ALLOWLIST || ""),
    customTaxonomyAllowlist: parseCustomTaxonomyAllowlist(env.CUSTOM_TAXONOMY_ALLOWLIST || ""),
    rateLimitPerMinute: parseIntegerSetting(env, "RATE_LIMIT_PER_MINUTE", 120, {
      min: 10,
      max: 1000,
    }),
    idempotencyStorePath: String(env.IDEMPOTENCY_STORE_PATH || ".data/idempotency.json").trim(),
    idempotencyRetentionHours: parseIntegerSetting(env, "IDEMPOTENCY_RETENTION_HOURS", 168, {
      min: 1,
      max: 8760,
    }),
    idempotencyMaxRecords: parseIntegerSetting(env, "IDEMPOTENCY_MAX_RECORDS", 500, {
      min: 10,
      max: 10000,
    }),
    auditDeadlineMs: parseIntegerSetting(env, "AUDIT_DEADLINE_MS", 15000, {
      min: 1000,
      max: 120000,
    }),
    auditConcurrency: parseIntegerSetting(env, "AUDIT_CONCURRENCY", 4, {
      min: 1,
      max: 10,
    }),
    activityStorePath: String(env.ACTIVITY_STORE_PATH || ".data/activity.json").trim(),
    activityRetentionDays: parseIntegerSetting(env, "ACTIVITY_RETENTION_DAYS", 30, {
      min: 1,
      max: 3650,
    }),
    activityMaxRecords: parseIntegerSetting(env, "ACTIVITY_MAX_RECORDS", 2000, {
      min: 10,
      max: 50000,
    }),
    bulkOperationStorePath: String(env.BULK_OPERATION_STORE_PATH || ".data/bulk-operations.json").trim(),
    bulkOperationRetentionHours: parseIntegerSetting(env, "BULK_OPERATION_RETENTION_HOURS", 168, {
      min: 1,
      max: 8760,
    }),
    bulkOperationMaxRecords: parseIntegerSetting(env, "BULK_OPERATION_MAX_RECORDS", 100, {
      min: 10,
      max: 500,
    }),
    bulkOperationMaxItems: parseIntegerSetting(env, "BULK_OPERATION_MAX_ITEMS", 2000, {
      min: 100,
      max: 10000,
    }),
    bulkOperationLargeThreshold: parseIntegerSetting(env, "BULK_OPERATION_LARGE_THRESHOLD", 100, {
      min: 20,
      max: 1000,
    }),
    bulkOperationChunkSize: parseIntegerSetting(env, "BULK_OPERATION_CHUNK_SIZE", 25, {
      min: 1,
      max: 50,
    }),
    trustedProxyIps: parseTrustedProxyIps(env.TRUSTED_PROXY_IPS || ""),
  };

  assertListenerAllowed(cfg.host, cfg.allowExternalAccess);
  if (!cfg.wpUsername) throw configError("WP_USERNAME is required.");
  if (!cfg.wpAppPassword) throw configError("WP_APP_PASSWORD is required.");
  if (!cfg.bridgeApiKey || cfg.bridgeApiKey.length < 32) {
    throw configError("BRIDGE_API_KEY is required and must be at least 32 characters.");
  }
  if (cfg.enforceDefaultAuthor && !cfg.defaultAuthor) {
    throw configError("ENFORCE_DEFAULT_AUTHOR=true requires DEFAULT_AUTHOR to be configured.");
  }
  if (cfg.maxMediaBytes > cfg.maxBodyBytes) {
    throw configError("MAX_MEDIA_BYTES must not exceed MAX_BODY_BYTES.");
  }
  if (cfg.maxSourceImageBytes < cfg.maxMediaBytes) {
    throw configError("MAX_SOURCE_IMAGE_BYTES must be at least MAX_MEDIA_BYTES.");
  }
  if (cfg.maxSourceImageBatchBytes < cfg.maxSourceImageBytes) {
    throw configError("MAX_SOURCE_IMAGE_BATCH_BYTES must be at least MAX_SOURCE_IMAGE_BYTES.");
  }
  if (cfg.imageOptimizeThresholdBytes > cfg.maxSourceImageBytes) {
    throw configError("IMAGE_OPTIMIZE_THRESHOLD_BYTES must not exceed MAX_SOURCE_IMAGE_BYTES.");
  }
  if (!cfg.idempotencyStorePath) {
    throw configError("IDEMPOTENCY_STORE_PATH must not be empty.");
  }
  if (!cfg.activityStorePath) {
    throw configError("ACTIVITY_STORE_PATH must not be empty.");
  }
  if (!cfg.bulkOperationStorePath) {
    throw configError("BULK_OPERATION_STORE_PATH must not be empty.");
  }

  const reservedCoreTypes = new Set(["post", "page", "attachment"]);
  for (const type of cfg.customPostTypes) {
    if (reservedCoreTypes.has(type)) {
      throw configError(`CUSTOM_POST_TYPES must not include core type "${type}".`);
    }
  }
  for (const type of cfg.customFieldAllowlist.keys()) {
    if (!["post", "page"].includes(type) && !cfg.customPostTypes.includes(type)) {
      throw configError(
        `CUSTOM_FIELD_ALLOWLIST references "${type}", which is not post/page or present in CUSTOM_POST_TYPES.`
      );
    }
  }
  for (const [type, taxonomies] of cfg.customTaxonomyAllowlist) {
    if (!cfg.customPostTypes.includes(type)) {
      throw configError(
        `CUSTOM_TAXONOMY_ALLOWLIST references "${type}", which is not present in CUSTOM_POST_TYPES.`
      );
    }
    for (const taxonomy of taxonomies) {
      if (taxonomy === "category" || taxonomy === "post_tag") {
        throw configError(
          `CUSTOM_TAXONOMY_ALLOWLIST must not include core taxonomy "${taxonomy}". Use the dedicated category/tag actions for core posts.`
        );
      }
    }
  }
  return cfg;
}
