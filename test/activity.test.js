import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFileActivityStore,
  createMemoryActivityStore,
  inferMutationActivity,
} from "../lib/activity.js";

test("activity store keeps only allowlisted privacy-filtered fields", () => {
  const store = createMemoryActivityStore();
  const entry = store.upsertByRequestId("req-1", {
    action: "edit_post",
    target: { kind: "content", post_type: "post", object_id: 7 },
    outcome: "succeeded",
    status: 200,
    recovery: { kind: "wp_item", metadata_before: { slug: "x".repeat(5000) } },
    credentials: { password: "must-not-be-stored" },
    content: "must-not-be-stored",
  });
  const saved = store.get(entry.id);
  assert.equal(saved.credentials, undefined);
  assert.equal(saved.content, undefined);
  assert.ok(saved.recovery.metadata_before.slug.length <= 1001);
  assert.equal(saved.target.object_id, 7);
});

test("file activity store persists entries without changing their ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-activity-"));
  const file = path.join(dir, "activity.json");
  const first = createFileActivityStore({ filePath: file, retentionMs: 86400000, maxRecords: 50 });
  const created = first.upsertByRequestId("req-persist", {
    action: "edit_page",
    target: { kind: "content", post_type: "page", object_id: 3 },
    outcome: "succeeded",
    status: 200,
  });
  const second = createFileActivityStore({ filePath: file, retentionMs: 86400000, maxRecords: 50 });
  const loaded = second.get(created.id);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.request_id, "req-persist");
  assert.equal(loaded.target.object_id, 3);
});

test("mutation inference excludes previews and identifies content writes", () => {
  assert.equal(inferMutationActivity("POST", "/v1/posts/7/preview"), null);
  assert.deepEqual(inferMutationActivity("PATCH", "/v1/posts/7"), {
    action: "edit_post",
    target: { kind: "content", post_type: "post", object_id: 7 },
  });
  assert.deepEqual(inferMutationActivity("POST", "/v1/categories"), {
    action: "create_category",
    target: { kind: "taxonomy_term", taxonomy: "category" },
  });
  assert.deepEqual(inferMutationActivity("POST", "/v1/custom-types/event/taxonomies/venue/terms"), {
    action: "create_custom_taxonomy_term",
    target: { kind: "taxonomy_term", post_type: "event", taxonomy: "venue" },
  });
});
