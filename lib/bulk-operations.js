import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bounded(value, depth = 0) {
  if (depth > 6) return "[depth-limited]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length <= 2000 ? value : `${value.slice(0, 2000)}…`;
  if (Array.isArray(value)) return value.slice(0, 2500).map((item) => bounded(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [String(key).slice(0, 191), bounded(item, depth + 1)]));
  }
  return String(value).slice(0, 2000);
}

function createCore({ retentionMs, maxRecords, persist }) {
  const records = new Map();

  function prune(now = Date.now()) {
    for (const [id, operation] of records) {
      const timestamp = Date.parse(operation?.updated_at || operation?.created_at || "");
      if (!Number.isFinite(timestamp) || now - timestamp > retentionMs) records.delete(id);
    }
    if (records.size > maxRecords) {
      const ordered = [...records.values()].sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
      for (const operation of ordered.slice(0, records.size - maxRecords)) records.delete(operation.id);
    }
  }

  function save(operation) {
    prune();
    const safe = bounded(operation);
    records.set(safe.id, safe);
    persist(records);
    return clone(safe);
  }

  return {
    create(operation) {
      const now = new Date().toISOString();
      return save({ ...operation, id: operation.id || `bulk_${crypto.randomUUID()}`, created_at: operation.created_at || now, updated_at: now });
    },
    get(id) {
      prune();
      return clone(records.get(String(id || "")) || null);
    },
    update(id, patch) {
      prune();
      const current = records.get(String(id || ""));
      if (!current) return null;
      return save({ ...current, ...patch, updated_at: new Date().toISOString() });
    },
    list() {
      prune();
      return [...records.values()].sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)).map(clone);
    },
    stats() { prune(); return { records: records.size }; },
    _load(entries) {
      records.clear();
      for (const entry of entries || []) if (entry?.id) records.set(entry.id, entry);
      prune();
    },
  };
}

export function createMemoryBulkOperationStore({ retentionMs = 7 * 24 * 60 * 60 * 1000, maxRecords = 100 } = {}) {
  return createCore({ retentionMs, maxRecords, persist: () => {} });
}

export function createFileBulkOperationStore({ filePath, retentionMs, maxRecords }) {
  const absolute = path.resolve(filePath);
  let loaded = false;
  let core;
  function persist(records) {
    if (!loaded) return;
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: [...records.values()] }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, absolute);
    try { fs.chmodSync(absolute, 0o600); } catch {}
  }
  core = createCore({ retentionMs, maxRecords, persist });
  function load() {
    if (loaded) return;
    loaded = true;
    if (!fs.existsSync(absolute)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
      core._load(Array.isArray(parsed?.records) ? parsed.records : []);
    } catch (error) {
      const err = new Error(`Could not read bulk operation store at ${absolute}: ${error.message}`);
      err.code = "BULK_OPERATION_STORE_ERROR";
      throw err;
    }
  }
  return {
    create(value) { load(); return core.create(value); },
    get(id) { load(); return core.get(id); },
    update(id, patch) { load(); return core.update(id, patch); },
    list() { load(); return core.list(); },
    stats() { load(); return { ...core.stats(), file: absolute }; },
  };
}
