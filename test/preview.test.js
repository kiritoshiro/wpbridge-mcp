import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditPreview,
  contentDiff,
  previewPayloadSha256,
  verifyPreviewToken,
} from "../lib/preview.js";

const secret = "s".repeat(40);

function current(overrides = {}) {
  return {
    id: 7,
    status: "draft",
    modified_gmt: "2026-09-08T06:00:00",
    link: "https://example.test/post",
    title: { raw: "Old title" },
    content: { raw: "first\nsecond\nthird" },
    categories: [1, 2],
    ...overrides,
  };
}

test("content preview reports line additions and removals", () => {
  const diff = contentDiff("one\ntwo\nthree", "one\nchanged\nthree\nfour");
  assert.equal(diff.changed, true);
  assert.equal(diff.mode, "lines");
  assert.equal(diff.addition_count, 2);
  assert.equal(diff.removal_count, 1);
  assert.equal(diff.additions[0].text, "changed");
  assert.equal(diff.removals[0].text, "two");
});

test("preview highlights published content and binds token to version and payload", () => {
  const now = Date.UTC(2026, 8, 8, 6, 0, 0);
  const item = current({ status: "publish" });
  const payload = { title: "New title", categories: [2, 3] };
  const preview = buildEditPreview({
    secret,
    target: "post:7",
    current: item,
    payload,
    allowLiveEdits: false,
    now,
  });

  assert.equal(preview.affects_published_content, true);
  assert.equal(preview.apply_allowed, false);
  assert.deepEqual(preview.changes.find((change) => change.field === "categories").added, [3]);
  assert.deepEqual(preview.changes.find((change) => change.field === "categories").removed, [1]);
  assert.ok(preview.warnings.some((warning) => warning.code === "published_content_change"));

  const claims = verifyPreviewToken(preview.preview_token, {
    secret,
    target: "post:7",
    currentModifiedGmt: item.modified_gmt,
    currentContentSha256: preview.version.content_sha256,
    payloadSha256: previewPayloadSha256(payload),
    now,
  });
  assert.equal(claims.target, "post:7");
});

test("preview token rejects changed payload and changed content version", () => {
  const now = Date.UTC(2026, 8, 8, 6, 0, 0);
  const item = current();
  const payload = { title: "New title" };
  const preview = buildEditPreview({
    secret,
    target: "post:7",
    current: item,
    payload,
    allowLiveEdits: true,
    now,
  });

  assert.throws(
    () =>
      verifyPreviewToken(preview.preview_token, {
        secret,
        target: "post:7",
        currentModifiedGmt: item.modified_gmt,
        currentContentSha256: preview.version.content_sha256,
        payloadSha256: previewPayloadSha256({ title: "Different" }),
        now,
      }),
    (err) => err.code === "preview_payload_mismatch" && err.status === 409
  );

  assert.throws(
    () =>
      verifyPreviewToken(preview.preview_token, {
        secret,
        target: "post:7",
        currentModifiedGmt: "2026-09-08T06:01:00",
        currentContentSha256: preview.version.content_sha256,
        payloadSha256: previewPayloadSha256(payload),
        now,
      }),
    (err) => err.code === "preview_stale" && err.status === 409
  );
});
