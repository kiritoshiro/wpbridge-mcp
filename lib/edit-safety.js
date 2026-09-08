export function assertLiveEditAllowed(current, allowLiveEdits) {
  if (current?.status === "publish" && !allowLiveEdits) {
    const err = new Error(
      "This item is currently published. Set ALLOW_LIVE_EDITS=true and restart the bridge before editing live content or metadata."
    );
    err.status = 403;
    err.code = "live_edits_disabled";
    err.current_status = current?.status || null;
    throw err;
  }
}

export function assertCurrentEditVersion(body, current, contentSha256) {
  const expectedModified =
    typeof body?.expected_modified_gmt === "string" ? body.expected_modified_gmt.trim() : "";
  const expectedHash =
    typeof body?.expected_content_sha256 === "string"
      ? body.expected_content_sha256.trim().toLowerCase()
      : "";

  if (!expectedModified && !expectedHash) {
    const err = new Error(
      "A current edit version is required. Supply expected_modified_gmt or expected_content_sha256 from the latest item read."
    );
    err.status = 400;
    err.code = "edit_version_required";
    throw err;
  }
  if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) {
    const err = new Error("expected_content_sha256 must be a 64-character SHA-256 hex digest.");
    err.status = 400;
    err.code = "invalid_content_hash";
    throw err;
  }

  const currentModified = String(current?.modified_gmt || "");
  const currentHash = contentSha256(String(current?.content?.raw ?? ""));
  const modifiedMatches = !expectedModified || (currentModified && expectedModified === currentModified);
  const hashMatches = !expectedHash || expectedHash === currentHash;
  if (!modifiedMatches || !hashMatches) {
    const err = new Error(
      "Content changed since it was read. Read the item again and retry with the new version or fingerprint."
    );
    err.status = 409;
    err.code = "edit_conflict";
    err.expected_modified_gmt = expectedModified || null;
    err.current_modified_gmt = currentModified || null;
    err.expected_content_sha256 = expectedHash || null;
    err.current_content_sha256 = currentHash;
    throw err;
  }

  return {
    current_modified_gmt: currentModified || null,
    current_content_sha256: currentHash,
  };
}
