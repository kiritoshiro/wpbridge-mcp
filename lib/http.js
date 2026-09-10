export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}

export async function readJson(req, maxBodyBytes) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const err = new Error("Request body too large.");
      err.status = 413;
      err.code = "request_body_too_large";
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const err = new Error("JSON body must be an object.");
      err.status = 400;
      err.code = "invalid_json_body";
      throw err;
    }
    return value;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error("Invalid JSON body.");
    err.status = 400;
    err.code = "invalid_json";
    throw err;
  }
}

export function bridgeErrorResponse(err, requestId) {
  const status =
    Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : err?.name === "AbortError"
        ? 504
        : 500;
  const safeMessage =
    status >= 500 && !err?.code
      ? "Bridge or upstream request failed."
      : String(err?.message || "Request failed.").slice(0, 500);
  return {
    status,
    body: {
      error: err?.code || "request_failed",
      message: safeMessage,
      ...(requestId ? { request_id: requestId } : {}),
      ...(err?.outcomeUnknown ? { outcome: "unknown", outcome_unknown: true } : {}),
      ...(err?.outcome === "failed" ? { outcome: "failed" } : {}),
      ...(err?.rollback_outcome ? { rollback_outcome: err.rollback_outcome } : {}),
      ...(err?.partial_update ? { partial_update: true } : {}),
      ...(err?.current_status ? { current_status: err.current_status } : {}),
      ...(err?.expected_modified_gmt !== undefined
        ? { expected_modified_gmt: err.expected_modified_gmt }
        : {}),
      ...(err?.current_modified_gmt !== undefined
        ? { current_modified_gmt: err.current_modified_gmt }
        : {}),
      ...(err?.expected_content_sha256 !== undefined
        ? { expected_content_sha256: err.expected_content_sha256 }
        : {}),
      ...(err?.current_content_sha256 !== undefined
        ? { current_content_sha256: err.current_content_sha256 }
        : {}),
      ...(Array.isArray(err?.unexpectedFields)
        ? { unexpected_fields: err.unexpectedFields.slice(0, 20).map((field) => String(field).slice(0, 100)) }
        : {}),
    },
  };
}

export function writeBridgeError(res, err, requestId) {
  const response = bridgeErrorResponse(err, requestId);
  if (err?.outcomeUnknown) res.setHeader("x-wpbridge-outcome", "unknown");
  return json(res, response.status, response.body);
}
