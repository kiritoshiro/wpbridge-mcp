import fs from "node:fs";
import path from "node:path";
import { allowedMediaTypes } from "../lib/image-files.js";

// Hard ceiling of the bridge's MAX_MEDIA_BYTES setting. Each bridge may be
// configured lower and still validates type, signature and size itself.
export const MAX_LOCAL_MEDIA_BYTES = 30_000_000;
export const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;

const mimeByExtension = new Map();
for (const [mimeType, info] of allowedMediaTypes) {
  for (const extension of info.extensions) if (!mimeByExtension.has(extension)) mimeByExtension.set(extension, mimeType);
}
const reservedDeviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

function refused(message) {
  return Object.assign(new Error(message), { code: "local_media_refused" });
}

// Exact-case containment of one canonical path in another. path.relative is not
// used because on Windows it compares case-insensitively, which would let a
// case-sensitive sibling (C:\vault\upload next to C:\vault\Upload) pass.
// Both arguments must already be canonical (realpathSync.native output).
export function containedIn(root, candidate, sep = path.sep) {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return typeof candidate === "string" && candidate.length > prefix.length && candidate.startsWith(prefix);
}

function uncOrDevice(value) {
  // \\server\share, //server/share, \\?\..., \\.\..., and NT object paths.
  return /^[\\/]{2}/.test(value) || /^\\\?\?\\/.test(value);
}

// Validates WPBRIDGE_MCP_UPLOAD_DIR once at startup. Returns the canonical
// directory, or null when local uploads are not configured.
export function resolveUploadDir(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.includes("\0") || uncOrDevice(value) || !path.isAbsolute(value)) {
    throw refused("WPBRIDGE_MCP_UPLOAD_DIR must be an absolute local directory path.");
  }
  let real;
  try { real = fs.realpathSync.native(value); } catch { throw refused("WPBRIDGE_MCP_UPLOAD_DIR does not exist."); }
  if (uncOrDevice(real) || !fs.statSync(real).isDirectory()) throw refused("WPBRIDGE_MCP_UPLOAD_DIR must be a local directory.");
  if (path.dirname(real) === real) throw refused("WPBRIDGE_MCP_UPLOAD_DIR must not be a filesystem root.");
  return real;
}

function sameObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// Opens without blocking on FIFOs and other special files where the platform
// allows it (O_NONBLOCK does not change reads from regular files), and without
// following a final symlink where O_NOFOLLOW exists. Windows has neither flag, so
// the identity checks after opening are what guard it there.
const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// Resolves a path relative to uploadDir (the canonical directory returned by
// resolveUploadDir) to a regular file inside it and reads it with the size limit
// enforced before the bytes are loaded. The checks assume the upload directory
// is not writable by untrusted users or processes: path-based checks cannot fully
// close a race against someone who can swap entries while the file is opened.
export function readLocalMedia(uploadDir, requested, { maxBytes = MAX_LOCAL_MEDIA_BYTES } = {}) {
  if (typeof requested !== "string" || !requested.trim() || requested.length > 1024 || /[\u0000-\u001f]/.test(requested)) {
    throw refused("file must be a non-empty path no longer than 1024 characters.");
  }
  if (uncOrDevice(requested)) throw refused("UNC and device paths are not accepted.");
  if (path.win32.isAbsolute(requested) || path.posix.isAbsolute(requested)) {
    throw refused("file must be a path relative to the configured upload directory, not an absolute path.");
  }
  // Rejects drive-relative paths (C:photo.png) and alternate data streams.
  if (requested.includes(":")) throw refused("Alternate data streams, drive letters and device names are not accepted.");
  const segments = requested.split(/[\\/]+/);
  if (segments.includes("..")) throw refused("Paths containing .. are not accepted.");
  if (segments.some((segment) => reservedDeviceName.test(segment.trim()))) {
    throw refused("Alternate data streams, drive letters and device names are not accepted.");
  }
  // Lexical pre-check: an early refusal only. Access is decided on real paths below.
  const candidate = path.resolve(uploadDir, requested);
  if (!containedIn(uploadDir, candidate)) throw refused("The file must be inside the configured upload directory.");

  let real;
  try { real = fs.realpathSync.native(candidate); } catch { throw refused("The file does not exist in the upload directory."); }
  // Rejects symlink and junction escapes: the canonical target must stay inside,
  // compared with exact case.
  if (uncOrDevice(real) || !containedIn(uploadDir, real)) throw refused("The file resolves outside the configured upload directory.");
  const extension = path.extname(real).toLowerCase();
  const mimeType = mimeByExtension.get(extension);
  if (!mimeType) throw refused(`Unsupported file extension. Allowed: ${[...mimeByExtension.keys()].join(", ")}.`);

  let fd;
  try {
    fd = fs.openSync(real, openFlags);
  } catch (error) {
    if (error?.code === "ELOOP") throw refused("The file changed while it was being opened.");
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw refused("Only regular files can be uploaded.");
    // A hard link shares its identity with a file that may live outside.
    if (opened.nlink !== 1n) throw refused("Files with hard links are not accepted.");
    // Re-validate after opening: the path must still be a non-link entry whose
    // canonical path is unchanged, inside, and the same object as the handle.
    let after;
    let again;
    try {
      after = fs.lstatSync(real, { bigint: true });
      again = fs.realpathSync.native(candidate);
    } catch {
      throw refused("The file changed while it was being opened.");
    }
    if (after.isSymbolicLink() || again !== real || !containedIn(uploadDir, again) || !sameObject(after, opened)) {
      throw refused("The file changed while it was being opened.");
    }
    if (opened.size > BigInt(maxBytes)) throw refused(`The file exceeds the ${maxBytes}-byte media limit.`);
    if (opened.size === 0n) throw refused("The file is empty.");
    const size = Number(opened.size);
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (!read) break;
      total += read;
    }
    if (total !== size) throw refused("The file changed while it was being read.");
    return { filename: path.basename(real), mimeType, data: buffer.subarray(0, size) };
  } finally {
    fs.closeSync(fd);
  }
}
