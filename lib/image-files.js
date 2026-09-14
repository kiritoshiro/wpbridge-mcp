import path from "node:path";
import sharp from "sharp";
import yauzl from "yauzl";

export const allowedImageTypes = new Map([
  ["image/jpeg", { extensions: new Set([".jpg", ".jpeg"]), canonical: ".jpg" }],
  ["image/png", { extensions: new Set([".png"]), canonical: ".png" }],
  ["image/webp", { extensions: new Set([".webp"]), canonical: ".webp" }],
  ["image/gif", { extensions: new Set([".gif"]), canonical: ".gif" }],
]);

// Keep the non-image allowlist deliberately narrow. WordPress can accept many
// uploadable MIME types, but the bridge should only forward formats that it can
// validate by signature and that are useful to the editorial workflow.
export const allowedAudioTypes = new Map([
  ["audio/mpeg", { extensions: new Set([".mp3"]), canonical: ".mp3" }],
  ["audio/wav", { extensions: new Set([".wav"]), canonical: ".wav" }],
  ["audio/x-wav", { extensions: new Set([".wav"]), canonical: ".wav" }],
  ["audio/ogg", { extensions: new Set([".ogg"]), canonical: ".ogg" }],
  ["audio/opus", { extensions: new Set([".opus"]), canonical: ".opus" }],
  ["audio/mp4", { extensions: new Set([".m4a", ".mp4"]), canonical: ".m4a" }],
  ["audio/x-m4a", { extensions: new Set([".m4a"]), canonical: ".m4a" }],
  ["audio/flac", { extensions: new Set([".flac"]), canonical: ".flac" }],
  ["audio/aac", { extensions: new Set([".aac"]), canonical: ".aac" }],
  ["audio/webm", { extensions: new Set([".webm"]), canonical: ".webm" }],
]);

export const allowedDocumentTypes = new Map([
  ["application/pdf", { extensions: new Set([".pdf"]), canonical: ".pdf" }],
]);

export const allowedMediaTypes = new Map([
  ...allowedImageTypes,
  ...allowedAudioTypes,
  ...allowedDocumentTypes,
]);

const imageTypeByExtension = new Map(
  [...allowedImageTypes].flatMap(([mimeType, info]) => [...info.extensions].map((extension) => [extension, mimeType]))
);
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const zipMimeTypes = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);

function imageError(message, status = 400, code = "invalid_image") {
  return Object.assign(new Error(message), { status, code });
}

export function safeMediaFilename(value, mimeType) {
  const info = allowedMediaTypes.get(mimeType);
  if (!info) throw imageError(`mime_type must be one of: ${[...allowedMediaTypes.keys()].join(", ")}.`, 400, "unsupported_mime_type");
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw imageError("filename must be a non-empty string no longer than 240 characters.");
  }
  const base = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  const ext = path.extname(base).toLowerCase();
  if (ext && !info.extensions.has(ext)) throw imageError(`filename extension ${ext} does not match ${mimeType}.`);
  let stem = ext ? base.slice(0, -ext.length) : base;
  stem = stem.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
  if (!stem) stem = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "file";
  return `${stem}${ext || info.canonical}`;
}

// Backwards-compatible name used by the image transform and direct image API.
export function safeUploadFilename(value, mimeType) {
  if (!allowedImageTypes.has(mimeType)) {
    throw imageError(`mime_type must be one of: ${[...allowedImageTypes.keys()].join(", ")}.`, 400, "unsupported_mime_type");
  }
  return safeMediaFilename(value, mimeType);
}

function assertBytes(data, maxBytes, emptyMessage, tooLargeCode, tooLargeLabel) {
  if (!Buffer.isBuffer(data) || !data.length) throw imageError(emptyMessage);
  if (data.length > maxBytes) throw imageError(`${tooLargeLabel} exceeds the configured byte limit (${maxBytes}).`, 413, tooLargeCode);
  return data;
}

export function assertImageBytes(data, mimeType, maxBytes = Infinity) {
  assertBytes(data, maxBytes, "Uploaded image is empty.", "image_too_large", "Uploaded image");
  let signatureOk = false;
  if (mimeType === "image/jpeg") signatureOk = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  else if (mimeType === "image/png") signatureOk = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  else if (mimeType === "image/gif") signatureOk = ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  else if (mimeType === "image/webp") signatureOk = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signatureOk) throw imageError(`Image bytes do not match declared MIME type ${mimeType}.`, 400, "image_signature_mismatch");
  return data;
}

export function assertPdfBytes(data, maxBytes = Infinity) {
  assertBytes(data, maxBytes, "Uploaded PDF is empty.", "file_too_large", "Uploaded PDF");
  if (data.length < 5 || data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw imageError("PDF bytes do not have a valid PDF signature.", 400, "file_signature_mismatch");
  }
  return data;
}

export function assertAudioBytes(data, mimeType, maxBytes = Infinity) {
  assertBytes(data, maxBytes, "Uploaded audio file is empty.", "file_too_large", "Uploaded audio file");
  const startsWith = (value) => data.length >= value.length && data.subarray(0, value.length).equals(Buffer.from(value));
  let signatureOk = false;
  if (["audio/wav", "audio/x-wav"].includes(mimeType)) {
    signatureOk = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE";
  } else if (mimeType === "audio/mpeg") {
    signatureOk = startsWith("ID3") || (data.length >= 2 && data[0] === 0xff && [0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff].includes(data[1]));
  } else if (["audio/ogg", "audio/opus"].includes(mimeType)) {
    signatureOk = startsWith("OggS") || startsWith("OpusHead");
  } else if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") {
    signatureOk = data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp";
  } else if (mimeType === "audio/flac") {
    signatureOk = startsWith("fLaC");
  } else if (mimeType === "audio/aac") {
    signatureOk = data.length >= 2 && data[0] === 0xff && [0xf1, 0xf9].includes(data[1]);
  } else if (mimeType === "audio/webm") {
    signatureOk = data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (!signatureOk) throw imageError(`Audio bytes do not match declared MIME type ${mimeType}.`, 400, "audio_signature_mismatch");
  return data;
}

export function assertMediaBytes(data, mimeType, maxBytes = Infinity) {
  if (allowedImageTypes.has(mimeType)) return assertImageBytes(data, mimeType, maxBytes);
  if (allowedAudioTypes.has(mimeType)) return assertAudioBytes(data, mimeType, maxBytes);
  if (allowedDocumentTypes.has(mimeType)) return assertPdfBytes(data, maxBytes);
  throw imageError(`Unsupported media MIME type ${mimeType}.`, 400, "unsupported_mime_type");
}

function normalizeOpenAiFileUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw imageError("OpenAI file download_link must be a valid HTTPS URL.", 400, "invalid_openai_file_url"); }
  if (url.protocol === "sandbox:") {
    throw imageError(
      "ChatGPT sandbox files cannot be downloaded by WPBridge. Pass the original attached image, audio, PDF, DOCX, or ZIP through openaiFileIdRefs; do not extract or convert it in Code Interpreter first.",
      400,
      "non_downloadable_sandbox_file"
    );
  }
  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === "oaiusercontent.com" || hostname.endsWith(".oaiusercontent.com");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    const source = url.protocol === "https:" && hostname ? hostname.slice(0, 200) : url.protocol.slice(0, 30);
    throw imageError(
      `Attachment source ${source || "(missing)"} is not a downloadable OpenAI Actions file. Pass the original conversation attachment through openaiFileIdRefs.`,
      400,
      "untrusted_openai_file_url"
    );
  }
  return url.toString();
}

function safeArchiveFilename(value, mimeType) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw imageError("Archive filename must be a non-empty string no longer than 240 characters.");
  }
  const filename = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  const extension = path.extname(filename).toLowerCase();
  const archiveKind = extension === ".docx" ? "docx" : extension === ".zip" ? "zip" : null;
  if (!archiveKind) throw imageError("Conversation archives must use a .docx or .zip filename.", 400, "unsupported_archive_type");
  if (archiveKind === "docx" && mimeType !== docxMimeType && !zipMimeTypes.has(mimeType)) {
    throw imageError("DOCX MIME type does not match its filename.", 400, "archive_mime_mismatch");
  }
  if (archiveKind === "zip" && !zipMimeTypes.has(mimeType)) {
    throw imageError("ZIP MIME type does not match its filename.", 400, "archive_mime_mismatch");
  }
  return { filename, archiveKind };
}

export function normalizeOpenAiFileRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw imageError("openaiFileIdRefs must contain 1-10 conversation images, audio files, PDFs, DOCX files, or ZIP archives.", 400, "invalid_openai_file_refs");
  }
  return value.map((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw imageError("Each openaiFileIdRefs item must be the runtime file-reference object supplied by ChatGPT.", 400, "invalid_openai_file_ref");
    }
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    const mimeType = String(ref.mime_type || "").trim().toLowerCase();
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
      throw imageError("Invalid OpenAI file id.", 400, "invalid_openai_file_id");
    }
    if (allowedImageTypes.has(mimeType)) {
      const filename = safeMediaFilename(ref.name, mimeType);
      return { id, name: String(ref.name), filename, mimeType, kind: "image", downloadLink: normalizeOpenAiFileUrl(ref.download_link) };
    }
    if (allowedAudioTypes.has(mimeType) || allowedDocumentTypes.has(mimeType)) {
      const filename = safeMediaFilename(ref.name, mimeType);
      return { id, name: String(ref.name), filename, mimeType, kind: "file", downloadLink: normalizeOpenAiFileUrl(ref.download_link) };
    }
    const { filename, archiveKind } = safeArchiveFilename(ref.name, mimeType);
    return { id, name: String(ref.name), filename, mimeType, kind: "archive", archiveKind, downloadLink: normalizeOpenAiFileUrl(ref.download_link) };
  });
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw imageError(`Conversation file exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "source_image_too_large");
  if (!response.body) throw imageError("OpenAI file response had no body.", 502, "openai_file_download_failed");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw imageError(`Conversation file exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "source_image_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readBoundedArchiveEntry(zipfile, entry, maxBytes) {
  if (entry.uncompressedSize > maxBytes) {
    throw imageError(`Archive image exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "archive_image_too_large");
  }
  if (entry.isEncrypted() || !entry.canDecodeFileData()) {
    throw imageError("Encrypted or unsupported ZIP entries are not accepted.", 400, "unsupported_archive_entry");
  }
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw imageError(`Archive image exceeds MAX_SOURCE_IMAGE_BYTES (${maxBytes}).`, 413, "archive_image_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function imageMetadata(data) {
  try { return await sharp(data, { failOn: "error", limitInputPixels: 100_000_000 }).metadata(); }
  catch { throw imageError("Conversation file is not a readable supported image.", 400, "invalid_image_data"); }
}

async function extractArchiveImages(ref, data, { maxBytes, maxTotalBytes, maxEntries, maxImages }) {
  let zipfile;
  try {
    zipfile = await yauzl.fromBufferPromise(data, { validateEntrySizes: true, strictFileNames: true });
  } catch {
    throw imageError("DOCX/ZIP file is not a valid safe archive.", 400, "invalid_archive");
  }
  if (zipfile.entryCount > maxEntries) {
    throw imageError(`Archive exceeds MAX_ARCHIVE_ENTRIES (${maxEntries}).`, 413, "archive_entry_limit_exceeded");
  }
  const images = [];
  let totalBytes = 0;
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      if (ref.archiveKind === "docx" && !/^word\/media\/[^/]+$/i.test(entry.fileName)) continue;
      const extension = path.extname(entry.fileName).toLowerCase();
      const mimeType = imageTypeByExtension.get(extension);
      if (!mimeType) continue;
      if (images.length >= maxImages) {
        throw imageError(`Archive batch exceeds MAX_EXTRACTED_IMAGES (${maxImages}).`, 413, "extracted_image_limit_exceeded");
      }
      if (entry.uncompressedSize + totalBytes > maxTotalBytes) {
        throw imageError(`Expanded archive images exceed MAX_SOURCE_IMAGE_BATCH_BYTES (${maxTotalBytes}).`, 413, "archive_expanded_size_exceeded");
      }
      const image = await readBoundedArchiveEntry(zipfile, entry, maxBytes);
      assertImageBytes(image, mimeType, maxBytes);
      const metadata = await imageMetadata(image);
      totalBytes += image.length;
      const archiveStem = path.basename(ref.filename, path.extname(ref.filename));
      const entryName = path.basename(entry.fileName);
      images.push({
        ...ref,
        filename: safeUploadFilename(`${archiveStem}-${entryName}`, mimeType),
        mimeType,
        data: image,
        bytes: image.length,
        width: metadata.width || null,
        height: metadata.height || null,
        fromArchive: true,
        sourceFilename: ref.filename,
        sourcePath: entry.fileName,
      });
    }
  } catch (error) {
    if (error?.status) throw error;
    throw imageError("DOCX/ZIP image extraction failed.", 400, "invalid_archive");
  }
  if (!images.length) throw imageError("DOCX/ZIP archive contains no supported images.", 400, "archive_has_no_images");
  return { images, totalBytes };
}

export async function downloadOpenAiFiles(refs, {
  fetchImpl = globalThis.fetch,
  maxBytes,
  maxTotalBytes,
  maxArchiveEntries = 1000,
  maxExtractedImages = 50,
  timeoutMs = 15_000,
}) {
  const normalized = normalizeOpenAiFileRefs(refs);
  const files = [];
  let downloadedBytes = 0;
  let expandedBytes = 0;
  for (const ref of normalized) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let data;
    try {
      const response = await fetchImpl(ref.downloadLink, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "image/*, audio/*, application/pdf, application/zip, application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
      if (!response.ok) throw imageError(`OpenAI conversation file download failed with HTTP ${response.status}.`, 502, "openai_file_download_failed");
      const responseType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      const matchingArchiveType = ref.kind === "archive" && (responseType === docxMimeType || zipMimeTypes.has(responseType));
      const audioAlias = new Set([ref.mimeType, ...(ref.mimeType === "audio/wav" ? ["audio/x-wav"] : []), ...(ref.mimeType === "audio/x-wav" ? ["audio/wav"] : []), ...(ref.mimeType === "audio/mp4" ? ["audio/x-m4a"] : []), ...(ref.mimeType === "audio/x-m4a" ? ["audio/mp4"] : [])]);
      const genericBinary = responseType === "application/octet-stream" && ref.kind !== "archive";
      if (responseType && !audioAlias.has(responseType) && !matchingArchiveType && !genericBinary) throw imageError(`Downloaded MIME type ${responseType} does not match ${ref.mimeType}.`, 400, "file_mime_mismatch");
      data = await readBoundedResponse(response, maxBytes);
    } catch (error) {
      if (error?.name === "AbortError") throw imageError("OpenAI conversation file download timed out.", 504, "openai_file_download_timeout");
      if (error?.status) throw error;
      throw imageError("Could not download the temporary OpenAI conversation file.", 502, "openai_file_download_failed");
    } finally { clearTimeout(timer); }
    downloadedBytes += data.length;
    if (downloadedBytes > maxTotalBytes) throw imageError(`Conversation file batch exceeds MAX_SOURCE_IMAGE_BATCH_BYTES (${maxTotalBytes}).`, 413, "source_image_batch_too_large");
    if (ref.kind === "archive") {
      const extracted = await extractArchiveImages(ref, data, {
        maxBytes,
        maxTotalBytes: maxTotalBytes - expandedBytes,
        maxEntries: maxArchiveEntries,
        maxImages: maxExtractedImages - files.length,
      });
      expandedBytes += extracted.totalBytes;
      files.push(...extracted.images);
      continue;
    }
    assertMediaBytes(data, ref.mimeType, maxBytes);
    const metadata = allowedImageTypes.has(ref.mimeType) ? await imageMetadata(data) : {};
    expandedBytes += data.length;
    if (expandedBytes > maxTotalBytes) throw imageError(`Conversation media batch exceeds MAX_SOURCE_IMAGE_BATCH_BYTES (${maxTotalBytes}).`, 413, "source_image_batch_too_large");
    if (files.length >= maxExtractedImages) throw imageError(`Conversation media batch exceeds MAX_EXTRACTED_IMAGES (${maxExtractedImages}).`, 413, "extracted_image_limit_exceeded");
    files.push({ ...ref, data, bytes: data.length, width: metadata.width || null, height: metadata.height || null });
  }
  return files;
}

// Backwards-compatible export for callers that only request image files.
export const downloadOpenAiImages = downloadOpenAiFiles;

export function imageOptimizationRecommendation(file, { thresholdBytes, maxDimension }) {
  if (!allowedImageTypes.has(file.mimeType)) return null;
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
    source_filename: file.sourceFilename || null,
    archive_path: file.sourcePath || null,
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
    original: { filename: file.filename, mime_type: file.mimeType, bytes: file.bytes, width: file.width, height: file.height, source_filename: file.sourceFilename || null, archive_path: file.sourcePath || null },
  };
}

export async function transformImageForWordPress(data, mimeType, applied, { maxOutputBytes }) {
  assertImageBytes(data, mimeType);
  if (mimeType === "image/gif") {
    throw imageError(
      "The bridge fallback does not transform GIF files because doing so could discard animation.",
      400,
      "gif_transform_unsupported"
    );
  }
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mimeType)) {
    throw imageError("The bridge fallback supports JPEG, PNG, and WebP images only.", 400, "unsupported_transform_mime_type");
  }

  const rotation = applied.find((operation) => operation.type === "rotate")?.angle || 0;
  const flip = applied.find((operation) => operation.type === "flip");
  const crop = applied.find((operation) => operation.type === "crop");
  const swapFlipAxes = rotation === 90 || rotation === 270;
  const horizontalBeforeRotation = swapFlipAxes ? Boolean(flip?.vertical) : Boolean(flip?.horizontal);
  const verticalBeforeRotation = swapFlipAxes ? Boolean(flip?.horizontal) : Boolean(flip?.vertical);

  try {
    let pipeline = sharp(data, { failOn: "error", limitInputPixels: 100_000_000 }).autoOrient();
    // Sharp performs flips before rotation. Swapping the axes for quarter-turns
    // preserves WPBridge's documented rotate -> flip operation order.
    if (verticalBeforeRotation) pipeline = pipeline.flip();
    if (horizontalBeforeRotation) pipeline = pipeline.flop();
    if (rotation) pipeline = pipeline.rotate(rotation);
    let result = await pipeline.toBuffer({ resolveWithObject: true });

    if (crop) {
      const left = Math.round((result.info.width * crop.left) / 100);
      const top = Math.round((result.info.height * crop.top) / 100);
      const width = Math.min(result.info.width - left, Math.max(1, Math.round((result.info.width * crop.width) / 100)));
      const height = Math.min(result.info.height - top, Math.max(1, Math.round((result.info.height * crop.height) / 100)));
      result = await sharp(result.data, { failOn: "error", limitInputPixels: 100_000_000 })
        .extract({ left, top, width, height })
        .toBuffer({ resolveWithObject: true });
    }

    assertImageBytes(result.data, mimeType, maxOutputBytes);
    return { data: result.data, width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error?.status) throw error;
    throw imageError("The bridge could not transform this image.", 422, "image_transform_failed");
  }
}
