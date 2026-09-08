import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assertCurrentEditVersion, assertLiveEditAllowed } from "../lib/edit-safety.js";

const hash = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const current = {
  status: "draft",
  modified_gmt: "2026-09-08T05:00:00",
  content: { raw: "current body" },
};

test("published items are protected when live edits are disabled", () => {
  assert.throws(
    () => assertLiveEditAllowed({ ...current, status: "publish" }, false),
    (err) => err.status === 403 && err.code === "live_edits_disabled"
  );
});

test("drafts are editable and published items require explicit live-edit opt-in", () => {
  assert.doesNotThrow(() => assertLiveEditAllowed(current, false));
  assert.doesNotThrow(() => assertLiveEditAllowed({ ...current, status: "publish" }, true));
});

test("ordinary edits require a current version or content fingerprint", () => {
  assert.throws(
    () => assertCurrentEditVersion({}, current, hash),
    (err) => err.status === 400 && err.code === "edit_version_required"
  );
});

test("matching modified_gmt permits an edit", () => {
  assert.doesNotThrow(() =>
    assertCurrentEditVersion({ expected_modified_gmt: current.modified_gmt }, current, hash)
  );
});

test("matching content fingerprint permits an edit", () => {
  assert.doesNotThrow(() =>
    assertCurrentEditVersion({ expected_content_sha256: hash(current.content.raw) }, current, hash)
  );
});

test("stale version returns a conflict with current values", () => {
  assert.throws(
    () =>
      assertCurrentEditVersion(
        { expected_modified_gmt: "2026-09-08T04:59:59" },
        current,
        hash
      ),
    (err) =>
      err.status === 409 &&
      err.code === "edit_conflict" &&
      err.current_modified_gmt === current.modified_gmt &&
      err.current_content_sha256 === hash(current.content.raw)
  );
});

test("if both version and hash are supplied, both must still be current", () => {
  assert.throws(
    () =>
      assertCurrentEditVersion(
        {
          expected_modified_gmt: current.modified_gmt,
          expected_content_sha256: hash("stale body"),
        },
        current,
        hash
      ),
    (err) => err.status === 409 && err.code === "edit_conflict"
  );
});
