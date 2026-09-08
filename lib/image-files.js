import path from "node:path";
import sharp from "sharp";

export const allowedImageTypes = new Map([
  ["image/jpeg", { extensions: new Set([".jpg", ".jpeg"]), canonical: ".jpg" }],
  ["image/png", { extensions: new Set([".png"]), canonical: ".png" }],
  ["image/webp", { extensions: new Set([".webp"]), canonical: ".webp" }],
  ["image/gif", { extensions: new Set([".gif"]), canonical: ".gif" }],
]);

function imageError(message, status = 400, code = "invalid_image") {
  return Object.assign(new Error(message), { status, code });
}

export function safeUploadFilename(value, mimeType) {
  const info = allowedImageTypes.get(mimeType);
  if (!info) throw imageError(`mime_type must be one of: ${[...allowedImageTypes.keys()].join(", ")}.`, 400, "unsupported_mime_type");
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw imageError("filename must be a non-empty string no longer than 240 characters.");
  }
  const base = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  const ext = path.extname(base).toLowerCase();
  if (ext && !info.extensions.has(ext)) throw imageError(`filename extension ${ext} does not match ${mimeType}.`);
  let stem = ext ? base.slice(0, -ext.length) : base;
  stem = stem.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
  if (!stem) stem = "image";
  return `${stem}${ext || info.canonical}`;
}

export function assertImageBytes(data, mimeType, maxBytes = Infinity) {
  if (!Buffer.isBuffer(data) || !data.length) throw imageError("Uploaded image is empty.");
  if (data.length > maxBytes) throw imageError(`Uploaded image exceeds the configured byte limit (${maxBytes}).`, 413, "image_too_large");
  let signatureOk = false;
  if (mimeType === "image/jpeg") signatureOk = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  else if (mimeType === "image/png") signatureOk = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  else if (mimeType === "image/gif") signatureOk = ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  else if (mimeType === "image/webp") signatureOk = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signatureOk) throw imageError(`Image bytes do not match declared MIME type ${mimeType}.`, 400, "image_signature_mismatch");
  return data;
}

function normalizeOpenAiFileUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw imageError("OpenAI file download_link must be a valid HTTPS URL.", 400, "invalid_openai_file_url"); }
  if (url.protocol !== "https:" || url.hostname !== "files.oaiusercontent.com" || url.username || url.password) {
    throw imageError("Only temporary files.oaiusercontent.com download links are accepted.", 400, "untrusted_openai_file_url");
  }
  return url.toString();
}

export function normalizeOpenAiFileRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw imageError("openaiFileIdRefs must contain 1-10 conversation image files.", 400, "invalid_openai_file_refs");
  }
  return value.map((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw imageError("Each openaiFileIdRefs item must be the runtime file-reference object supplied by ChatGPT.", 400, "invalid_openai_file_ref");
    }
    const id = String(ref.id || "").trim();
    const mimeType = String(ref.mime_type || "").trim().toLowerCase();
    if (!/^file-[A-Za-z0-9_-]{6,190}$/.test(id)) throw imageError("Invalid OpenAI file id.", 400, "invalid_openai_file_id");
    if (!allowedImageTypes.has(mimeType)) throw imageError(`Unsupported conversation file MIME type ${mimeType || "(missing)"}.`, 400, "unsupported_mime_type");
    const filename = safeUploadFilename(ref.name, mimeType);
    return { id, name: String(ref.name), filename, mimeType, downloadLink: normalizeOpenAiFileUrl(ref.download_link) };
  });
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw imageError(`Conversation image exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "source_image_too_large");
  if (!response.body) throw imageError("OpenAI file response had no body.", 502, "openai_file_download_failed");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw imageError(`Conversation image exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "source_image_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function downloadOpenAiImages(refs, { fetchImpl = globalThis.fetch, maxBytes, maxTotalBytes, timeoutMs = 15_000 }) {
  const normalized = normalizeOpenAiFileRefs(refs);
  const files = [];
  let totalBytes = 0;
  for (const ref of normalized) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let data;
    try {
      const response = await fetchImpl(ref.downloadLink, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "image/*" } });
      if (!response.ok) throw imageError(`OpenAI conversation image download failed with HTTP ${response.status}.`, 502, "openai_file_download_failed");
      const responseType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (responseType && responseType !== ref.mimeType) throw imageError(`Downloaded MIME type ${responseType} does not match ${ref.mimeType}.`, 400, "image_mime_mismatch");
      data = await readBoundedResponse(response, maxBytes);
    } catch (error) {
      if (error?.name === "AbortError") throw imageError("OpenAI conversation image download timed out.", 504, "openai_file_download_timeout");
      if (error?.status) throw error;
      throw imageError("Could not download the temporary OpenAI conversation image.", 502, "openai_file_download_failed");
    } finally { clearTimeout(timer); }
    totalBytes += data.length;
    if (totalBytes > maxTotalBytes) throw imageError(`Conversation image batch exceeds MAX_SOURCE_IMAGE_BATCH_BYTES (${maxTotalBytes}).`, 413, "source_image_batch_too_large");
    assertImageBytes(data, ref.mimeType, maxBytes);
    let metadata;
    try { metadata = await sharp(data, { failOn: "error", limitInputPixels: 100_000_000 }).metadata(); }
    catch { throw imageError("Conversation file is not a readable supported image.", 400, "invalid_image_data"); }
    files.push({ ...ref, data, bytes: data.length, width: metadata.width || null, height: metadata.height || null });
  }
  return files;
}

export function imageOptimizationRecommendation(file, { thresholdBytes, maxDimension }) {
  const reasons = [];
  if (file.bytes > thresholdBytes) reasons.push(`file is larger than ${thresholdBytes} bytes`);
  if ((file.width || 0) > maxDimension || (file.height || 0) > maxDimension) reasons.push(`dimensions exceed ${maxDimension}px`);
  if (!reasons.length) return null;
  return {
    file_id: file.id,
    filename: file.filename,
    mime_type: file.mimeType,
    bytes: file.bytes,
    width: file.width,
    height: file.height,
    reasons,
    suggested_format: file.mimeType === "image/gif" ? file.mimeType : "image/webp",
    suggested_max_dimension: maxDimension,
    automatic_optimization_available: file.mimeType !== "image/gif",
  };
}

export async function optimizeImageForWeb(file, { maxDimension, quality, maxOutputBytes }) {
  if (file.mimeType === "image/gif") throw imageError("Automatic conversion is disabled for GIF files to avoid losing animation.", 409, "gif_optimization_unsupported");
  let result;
  try {
    result = await sharp(file.data, { failOn: "error", limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch { throw imageError("Image resizing or WebP conversion failed.", 400, "image_optimization_failed"); }
  assertImageBytes(result.data, "image/webp", maxOutputBytes);
  const stem = path.basename(file.filename, path.extname(file.filename));
  return {
    ...file,
    filename: safeUploadFilename(`${stem}.webp`, "image/webp"),
    mimeType: "image/webp",
    data: result.data,
    bytes: result.data.length,
    width: result.info.width || null,
    height: result.info.height || null,
    optimized: true,
    original: { filename: file.filename, mime_type: file.mimeType, bytes: file.bytes, width: file.width, height: file.height },
  };
}
