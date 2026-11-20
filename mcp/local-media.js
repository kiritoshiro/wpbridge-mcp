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
const isWindows = process.platform === "win32";

function refused(message) {
  return Object.assign(new Error(message), { code: "local_media_refused" });
}

function comparable(value) {
  return isWindows ? value.toLowerCase() : value;
}

function inside(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

// Resolves a caller-supplied file path to a regular file inside uploadDir and
// reads it with the size limit enforced before the bytes are loaded.
export function readLocalMedia(uploadDir, requested, { maxBytes = MAX_LOCAL_MEDIA_BYTES } = {}) {
  if (typeof requested !== "string" || !requested.trim() || requested.length > 1024 || /[\u0000-\u001f]/.test(requested)) {
    throw refused("file must be a non-empty path no longer than 1024 characters.");
  }
  if (uncOrDevice(requested)) throw refused("UNC and device paths are not accepted.");
  if (requested.split(/[\\/]+/).includes("..")) throw refused("Paths containing .. are not accepted.");
  const candidate = path.resolve(uploadDir, requested);
  if (!inside(uploadDir, candidate)) throw refused("The file must be inside the configured upload directory.");
  const segments = path.relative(uploadDir, candidate).split(path.sep);
  if (segments.some((segment) => segment.includes(":") || reservedDeviceName.test(segment.trim()))) {
    throw refused("Alternate data streams and device names are not accepted.");
  }
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { throw refused("The file does not exist in the upload directory."); }
  // Rejects symlink and junction escapes: the canonical target must stay inside.
  if (uncOrDevice(real) || !inside(uploadDir, real)) throw refused("The file resolves outside the configured upload directory.");
  const extension = path.extname(real).toLowerCase();
  const mimeType = mimeByExtension.get(extension);
  if (!mimeType) throw refused(`Unsupported file extension. Allowed: ${[...mimeByExtension.keys()].join(", ")}.`);

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(real, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(real, { bigint: true });
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw refused("The file changed while it was being opened.");
    if (!opened.isFile()) throw refused("Only regular files can be uploaded.");
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
