import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

export function requestFingerprint(scope, body) {
  const cleanBody = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  delete cleanBody.idempotency_key;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize({ scope, body: cleanBody })), "utf8")
    .digest("hex");
}

export function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    const err = new Error(
      "idempotency_key must be 8-200 characters using letters, numbers, dot, underscore, colon, or hyphen."
    );
    err.status = 400;
    err.code = "invalid_idempotency_key";
    throw err;
  }
  return key;
}

export function idempotencyKeyFrom(req, body = {}) {
  const header = Array.isArray(req?.headers?.["idempotency-key"])
    ? req.headers["idempotency-key"][0]
    : req?.headers?.["idempotency-key"];
  const headerKey = normalizeIdempotencyKey(header);
  const bodyKey = normalizeIdempotencyKey(body?.idempotency_key);
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    const err = new Error("Idempotency-Key header and idempotency_key body value must match.");
    err.status = 400;
    err.code = "idempotency_key_mismatch";
    throw err;
  }
  return headerKey || bodyKey;
}

function keyDigest(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createMemoryIdempotencyStore({ retentionMs = 7 * 24 * 60 * 60 * 1000, maxRecords = 500 } = {}) {
  const records = new Map();

  function prune(now = Date.now()) {
    for (const [digest, record] of records) {
      if (!record?.created_at_ms || now - record.created_at_ms > retentionMs) records.delete(digest);
    }
    if (records.size > maxRecords) {
      const ordered = [...records.entries()].sort(
        (a, b) => (a[1]?.created_at_ms || 0) - (b[1]?.created_at_ms || 0)
      );
      for (let i = 0; i < ordered.length - maxRecords; i += 1) records.delete(ordered[i][0]);
    }
  }

  return {
    get(key) {
      prune();
      return clone(records.get(keyDigest(key)) || null);
    },
    put(key, record) {
      prune();
      records.set(keyDigest(key), clone(record));
      prune();
      return clone(record);
    },
    stats() {
      prune();
      return { records: records.size };
    },
  };
}

export function createFileIdempotencyStore({ filePath, retentionMs, maxRecords }) {
  const absolute = path.resolve(filePath);
  const recordsByDigest = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!fs.existsSync(absolute)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
      for (const entry of Array.isArray(parsed?.records) ? parsed.records : []) {
        if (typeof entry?.digest === "string" && entry?.record) {
          recordsByDigest.set(entry.digest, entry.record);
        }
      }
    } catch (error) {
      const err = new Error(`Could not read idempotency store at ${absolute}: ${error.message}`);
      err.code = "IDEMPOTENCY_STORE_ERROR";
      throw err;
    }
  }

  function prune(now = Date.now()) {
    for (const [digest, record] of recordsByDigest) {
      if (!record?.created_at_ms || now - record.created_at_ms > retentionMs) {
        recordsByDigest.delete(digest);
      }
    }
    if (recordsByDigest.size > maxRecords) {
      const ordered = [...recordsByDigest.entries()].sort(
        (a, b) => (a[1]?.created_at_ms || 0) - (b[1]?.created_at_ms || 0)
      );
      for (let i = 0; i < ordered.length - maxRecords; i += 1) recordsByDigest.delete(ordered[i][0]);
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    prune();
    const tmp = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = JSON.stringify(
      { version: 1, records: [...recordsByDigest].map(([digest, record]) => ({ digest, record })) },
      null,
      2
    );
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, absolute);
    try { fs.chmodSync(absolute, 0o600); } catch {}
  }

  return {
    get(key) {
      load();
      prune();
      return clone(recordsByDigest.get(keyDigest(key)) || null);
    },
    put(key, record) {
      load();
      recordsByDigest.set(keyDigest(key), clone(record));
      persist();
      return clone(record);
    },
    stats() {
      load();
      prune();
      return { records: recordsByDigest.size, file: absolute };
    },
  };
}
