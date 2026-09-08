import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFileIdempotencyStore,
  normalizeIdempotencyKey,
  requestFingerprint,
} from "../lib/idempotency.js";

test("request fingerprints are stable across object key order and ignore idempotency_key", () => {
  const a = requestFingerprint("create:post", {
    title: "A",
    content: "B",
    idempotency_key: "request-12345678",
  });
  const b = requestFingerprint("create:post", { content: "B", title: "A" });
  assert.equal(a, b);
  assert.notEqual(a, requestFingerprint("create:post", { title: "Different", content: "B" }));
});

test("idempotency keys are strictly validated", () => {
  assert.equal(normalizeIdempotencyKey("req_12345678"), "req_12345678");
  assert.throws(() => normalizeIdempotencyKey("short"), /8-200/);
  assert.throws(() => normalizeIdempotencyKey("invalid key with spaces"), /8-200/);
});

test("file idempotency store survives reload without persisting plaintext keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-idempotency-"));
  const filePath = path.join(dir, "idempotency.json");
  const key = "opaque-request-key-123456";
  const record = {
    scope: "create:post",
    request_fingerprint: "abc",
    state: "succeeded",
    status: 201,
    response_body: { id: 55 },
    request_id: "r1",
    created_at_ms: Date.now(),
  };

  const first = createFileIdempotencyStore({
    filePath,
    retentionMs: 60_000,
    maxRecords: 10,
  });
  first.put(key, record);
  assert.deepEqual(first.get(key).response_body, { id: 55 });

  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.equal(onDisk.includes(key), false);

  const second = createFileIdempotencyStore({
    filePath,
    retentionMs: 60_000,
    maxRecords: 10,
  });
  assert.deepEqual(second.get(key), record);
  fs.rmSync(dir, { recursive: true, force: true });
});
