import crypto from "node:crypto";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 3600;
const MAX_TOKEN_LENGTH = 4096;

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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function hmac(secret, payload) {
  return crypto
    .createHmac("sha256", `wpbridge-preview-v1:${secret}`)
    .update(payload, "utf8")
    .digest("base64url");
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function previewError(code, message, status = 409) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function previewPayloadSha256(payload) {
  return sha256(stableJson(payload));
}

export function createPreviewToken({
  secret,
  target,
  currentModifiedGmt,
  currentContentSha256,
  payloadSha256,
  now = Date.now(),
}) {
  if (!secret) throw new Error("Preview signing secret is required.");
  const claims = {
    v: TOKEN_VERSION,
    target,
    modified_gmt: currentModifiedGmt || null,
    content_sha256: currentContentSha256,
    payload_sha256: payloadSha256,
    iat: Math.floor(now / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${encoded}.${hmac(secret, encoded)}`;
}

export function verifyPreviewToken(
  token,
  {
    secret,
    target,
    currentModifiedGmt,
    currentContentSha256,
    payloadSha256,
    now = Date.now(),
  }
) {
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    throw previewError("invalid_preview_token", "preview_token is invalid.", 400);
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw previewError("invalid_preview_token", "preview_token is invalid.", 400);
  }
  const [encoded, signature] = parts;
  const expectedSignature = hmac(secret, encoded);
  if (!safeEqualText(signature, expectedSignature)) {
    throw previewError("invalid_preview_token", "preview_token signature is invalid.", 400);
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw previewError("invalid_preview_token", "preview_token payload is invalid.", 400);
  }
  if (!claims || claims.v !== TOKEN_VERSION || typeof claims.iat !== "number") {
    throw previewError("invalid_preview_token", "preview_token payload is invalid.", 400);
  }

  const ageSeconds = Math.floor(now / 1000) - claims.iat;
  if (ageSeconds < -60 || ageSeconds > TOKEN_TTL_SECONDS) {
    throw previewError(
      "preview_expired",
      "The edit preview has expired. Generate a new preview before applying it."
    );
  }
  if (claims.target !== target) {
    throw previewError(
      "preview_target_mismatch",
      "The preview token was generated for a different content item."
    );
  }
  if (
    claims.modified_gmt !== (currentModifiedGmt || null) ||
    claims.content_sha256 !== currentContentSha256
  ) {
    throw previewError(
      "preview_stale",
      "The content changed after this preview was generated. Generate a new preview before applying it."
    );
  }
  if (claims.payload_sha256 !== payloadSha256) {
    throw previewError(
      "preview_payload_mismatch",
      "The proposed edit differs from the edit that was previewed. Generate a new preview for these changes."
    );
  }
  return claims;
}

function currentFieldValue(current, field) {
  const value = current?.[field];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, "raw")) return value.raw ?? "";
    if (Object.prototype.hasOwnProperty.call(value, "rendered")) return value.rendered ?? "";
  }
  return value;
}

function equalValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function compactValue(value, maxChars = 2000) {
  if (typeof value !== "string") return { value, truncated: false };
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function arrayDelta(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const beforeSet = new Set(before.map((value) => stableJson(value)));
  const afterSet = new Set(after.map((value) => stableJson(value)));
  return {
    added: after.filter((value) => !beforeSet.has(stableJson(value))),
    removed: before.filter((value) => !afterSet.has(stableJson(value))),
  };
}

function changeKind(before, after) {
  const beforeEmpty = before === undefined || before === null || before === "";
  const afterEmpty = after === undefined || after === null || after === "";
  if (beforeEmpty && !afterEmpty) return "add";
  if (!beforeEmpty && afterEmpty) return "remove";
  return "replace";
}

function truncateFragment(text, maxChars = 700) {
  const value = String(text ?? "");
  return {
    text: value.length <= maxChars ? value : value.slice(0, maxChars),
    truncated: value.length > maxChars,
  };
}

function lineContentDiff(before, after) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  if (beforeLines.length > 400 || afterLines.length > 400 || before.length + after.length > 200000) {
    return null;
  }

  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        beforeLines[i] === afterLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const additions = [];
  const removals = [];
  let totalAdditions = 0;
  let totalRemovals = 0;
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (j < afterLines.length && (i === beforeLines.length || table[i][j + 1] >= table[i + 1][j])) {
      totalAdditions += 1;
      if (additions.length < 80) {
        additions.push({ line: j + 1, ...truncateFragment(afterLines[j]) });
      }
      j += 1;
    } else if (i < beforeLines.length) {
      totalRemovals += 1;
      if (removals.length < 80) {
        removals.push({ line: i + 1, ...truncateFragment(beforeLines[i]) });
      }
      i += 1;
    }
  }
  return {
    mode: "lines",
    additions,
    removals,
    addition_count: totalAdditions,
    removal_count: totalRemovals,
    truncated: totalAdditions > additions.length || totalRemovals > removals.length,
  };
}

function windowContentDiff(before, after) {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  return {
    mode: "change_window",
    additions: added
      ? [{ offset: prefix, ...truncateFragment(added, 2000) }]
      : [],
    removals: removed
      ? [{ offset: prefix, ...truncateFragment(removed, 2000) }]
      : [],
    addition_count: added.length,
    removal_count: removed.length,
    count_unit: "characters",
    truncated: added.length > 2000 || removed.length > 2000,
  };
}

export function contentDiff(beforeValue, afterValue) {
  const before = String(beforeValue ?? "");
  const after = String(afterValue ?? "");
  if (before === after) {
    return {
      changed: false,
      before_sha256: sha256(before),
      after_sha256: sha256(after),
      additions: [],
      removals: [],
      addition_count: 0,
      removal_count: 0,
      truncated: false,
    };
  }
  const details = lineContentDiff(before, after) || windowContentDiff(before, after);
  return {
    changed: true,
    before_sha256: sha256(before),
    after_sha256: sha256(after),
    ...details,
  };
}

export function editableFieldDiff(current, payload) {
  const changes = [];
  let content = null;
  for (const [field, after] of Object.entries(payload)) {
    const before = currentFieldValue(current, field);
    if (equalValue(before, after)) continue;
    if (field === "content") {
      content = contentDiff(before, after);
      changes.push({
        field,
        change: changeKind(before, after),
        before_sha256: content.before_sha256,
        after_sha256: content.after_sha256,
        before_length: String(before ?? "").length,
        after_length: String(after ?? "").length,
      });
      continue;
    }

    const beforeCompact = compactValue(before);
    const afterCompact = compactValue(after);
    const delta = arrayDelta(before, after);
    changes.push({
      field,
      change: changeKind(before, after),
      before: beforeCompact.value,
      after: afterCompact.value,
      truncated: beforeCompact.truncated || afterCompact.truncated,
      ...(delta ? delta : {}),
    });
  }
  return { changes, content_diff: content };
}

export function buildEditPreview({
  secret,
  target,
  current,
  payload,
  allowLiveEdits,
  now = Date.now(),
}) {
  const currentContent = current?.content?.raw ?? "";
  const currentContentSha256 = sha256(currentContent);
  const payloadSha256 = previewPayloadSha256(payload);
  const { changes, content_diff } = editableFieldDiff(current, payload);
  const published = current?.status === "publish";
  const warnings = [];
  if (published && changes.length) {
    warnings.push({
      code: "published_content_change",
      severity: "warning",
      message: "These changes affect content that is currently published on the live site.",
    });
  }
  if (published && !allowLiveEdits) {
    warnings.push({
      code: "live_edits_disabled",
      severity: "error",
      message: "Applying this preview is blocked until ALLOW_LIVE_EDITS=true.",
    });
  }

  return {
    target,
    status: current?.status ?? "",
    link: current?.link ?? "",
    has_changes: changes.length > 0,
    affects_published_content: published && changes.length > 0,
    apply_allowed: !published || Boolean(allowLiveEdits),
    version: {
      modified_gmt: current?.modified_gmt || null,
      content_sha256: currentContentSha256,
    },
    changes,
    content_diff,
    warnings,
    preview_token: createPreviewToken({
      secret,
      target,
      currentModifiedGmt: current?.modified_gmt || null,
      currentContentSha256,
      payloadSha256,
      now,
    }),
    preview_expires_in_seconds: TOKEN_TTL_SECONDS,
  };
}
