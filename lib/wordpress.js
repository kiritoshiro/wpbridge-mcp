import { buildWpRestUrl } from "./config.js";

function basicAuthFor(cfg) {
  return (
    "Basic " + Buffer.from(`${cfg.wpUsername}:${cfg.wpAppPassword}`, "utf8").toString("base64")
  );
}

function sanitizeUpstreamMessage(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/<[^>]*>/g, "").slice(0, 500);
}

function upstreamNetworkError(error, operation = "WordPress request", { mayHaveMutated = false } = {}) {
  if (error?.name === "AbortError") {
    const err = new Error(
      mayHaveMutated
        ? `${operation} timed out after the write may have reached WordPress; the outcome is unknown.`
        : `${operation} timed out.`
    );
    err.status = 504;
    err.code = mayHaveMutated ? "wordpress_write_timeout_outcome_unknown" : "wordpress_timeout";
    if (mayHaveMutated) err.outcomeUnknown = true;
    return err;
  }
  const err = new Error(
    mayHaveMutated
      ? `${operation} lost connectivity after the write may have been sent; the outcome is unknown.`
      : `${operation} could not reach WordPress.`
  );
  err.status = 502;
  err.code = mayHaveMutated ? "wordpress_write_network_outcome_unknown" : "wordpress_unreachable";
  if (mayHaveMutated) err.outcomeUnknown = true;
  return err;
}

async function parseResponse(response, fallbackMessage, { mayHaveMutated = false } = {}) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw upstreamNetworkError(error, "WordPress response", { mayHaveMutated });
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) {
      const err = new Error(fallbackMessage);
      err.status = 502;
      err.code = "wordpress_invalid_response";
      if (mayHaveMutated) err.outcomeUnknown = true;
      throw err;
    }
    data = { message: fallbackMessage };
  }
  return data;
}

export function createWordPressClient(
  cfg,
  { fetchImpl = globalThis.fetch, requestTimeoutMs = 20_000, uploadTimeoutMs = 60_000 } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  const basicAuth = basicAuthFor(cfg);
  const userAgent = "SiteOne-ChatGPT-WordPress-Bridge/1.15";

  async function wpRequest(restPath, { method = "GET", body, timeoutMs } = {}) {
    if (!restPath.startsWith("/wp-json/wp/v2/")) {
      throw new Error("Internal safety check failed: disallowed WordPress REST path.");
    }
    const target = buildWpRestUrl(cfg.wpUrl, restPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: {
            authorization: basicAuth,
            accept: "application/json",
            ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
            "user-agent": userAgent,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress request", { mayHaveMutated: !["GET", "HEAD"].includes(method) });
      }

      const data = await parseResponse(response, "WordPress returned a non-JSON response.", {
        mayHaveMutated: !["GET", "HEAD"].includes(method),
      });
      if (!response.ok) {
        const err = new Error(
          sanitizeUpstreamMessage(
            data?.message,
            `WordPress request failed with HTTP ${response.status}.`
          )
        );
        err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        err.code = data?.code || "wordpress_error";
        err.outcome = "failed";
        throw err;
      }
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function wpSeoHelperRequest(restPath, { method = "GET", body, timeoutMs } = {}) {
    if (
      restPath !== "/wp-json/wpbridge/v1/seo/capabilities" &&
      !/^\/wp-json\/wpbridge\/v1\/seo\/(post|page)\/\d+$/.test(restPath)
    ) {
      throw new Error("Internal safety check failed: disallowed SEO helper REST path.");
    }
    const target = buildWpRestUrl(cfg.wpUrl, restPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: {
            authorization: basicAuth,
            accept: "application/json",
            ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
            "user-agent": userAgent,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress SEO helper request", { mayHaveMutated: !["GET", "HEAD"].includes(method) });
      }

      const data = await parseResponse(
        response,
        "WordPress SEO helper returned a non-JSON response.",
        { mayHaveMutated: !["GET", "HEAD"].includes(method) }
      );
      if (!response.ok) {
        const err = new Error(
          sanitizeUpstreamMessage(
            data?.message,
            `WordPress SEO helper request failed with HTTP ${response.status}.`
          )
        );
        err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        err.code = data?.code || "wordpress_error";
        err.outcome = "failed";
        throw err;
      }
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function wpAlpsHelperRequest(restPath, { method = "GET", body, timeoutMs } = {}) {
    if (!/^\/wp-json\/wpbridge\/v1\/alps\/(post|page)\/\d+$/.test(restPath)) {
      throw new Error("Internal safety check failed: disallowed ALPS helper REST path.");
    }
    const target = buildWpRestUrl(cfg.wpUrl, restPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: {
            authorization: basicAuth,
            accept: "application/json",
            ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
            "user-agent": userAgent,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress ALPS helper request", { mayHaveMutated: !["GET", "HEAD"].includes(method) });
      }
      const data = await parseResponse(response, "WordPress ALPS helper returned a non-JSON response.", {
        mayHaveMutated: !["GET", "HEAD"].includes(method),
      });
      if (!response.ok) {
        const err = new Error(sanitizeUpstreamMessage(data?.message, `WordPress ALPS helper request failed with HTTP ${response.status}.`));
        err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        err.code = data?.code || "wordpress_error";
        err.outcome = "failed";
        throw err;
      }
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function wpCalendarHelperRequest(restPath, { method = "GET", body, timeoutMs } = {}) {
    const [path] = String(restPath).split("?", 1);
    if (!/^\/wp-json\/wpbridge\/v1\/calendar(?:\/(?:capabilities|events(?:\/\d+)?|taxonomies\/[a-z0-9_-]+\/terms))?$/.test(path)) {
      throw new Error("Internal safety check failed: disallowed calendar helper REST path.");
    }
    const target = buildWpRestUrl(cfg.wpUrl, restPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: {
            authorization: basicAuth,
            accept: "application/json",
            ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
            "user-agent": userAgent,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress calendar helper request", { mayHaveMutated: !["GET", "HEAD"].includes(method) });
      }
      const data = await parseResponse(response, "WordPress calendar helper returned a non-JSON response.", {
        mayHaveMutated: !["GET", "HEAD"].includes(method),
      });
      if (!response.ok) {
        const err = new Error(sanitizeUpstreamMessage(data?.message, `WordPress calendar helper request failed with HTTP ${response.status}.`));
        err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        err.code = data?.code || "wordpress_error";
        err.outcome = "failed";
        throw err;
      }
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function wpImageUpload(filename, mimeType, data) {
    const target = buildWpRestUrl(cfg.wpUrl, "/wp-json/wp/v2/media");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method: "POST",
          headers: {
            authorization: basicAuth,
            accept: "application/json",
            "content-type": mimeType,
            "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
            "content-length": String(data.length),
            "user-agent": userAgent,
          },
          body: data,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress media upload", { mayHaveMutated: true });
      }

      const responseData = await parseResponse(response, "WordPress returned a non-JSON response.", {
        mayHaveMutated: true,
      });
      if (!response.ok) {
        const err = new Error(
          sanitizeUpstreamMessage(
            responseData?.message,
            `WordPress media upload failed with HTTP ${response.status}.`
          )
        );
        err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        err.code = responseData?.code || "wordpress_error";
        err.outcome = "failed";
        throw err;
      }
      return responseData;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function wpMediaDownload(sourceUrl, maxBytes, expectedMimeType) {
    let target;
    try {
      target = new URL(sourceUrl);
    } catch {
      const err = new Error("WordPress returned an invalid media source URL.");
      err.status = 502;
      err.code = "wordpress_invalid_media_source";
      throw err;
    }
    const site = new URL(cfg.wpUrl);
    if (target.protocol !== "https:" || target.origin !== site.origin || target.username || target.password || target.hash) {
      const err = new Error("WordPress media fallback is restricted to the configured site's HTTPS origin.");
      err.status = 409;
      err.code = "wordpress_media_source_not_allowed";
      throw err;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method: "GET",
          headers: {
            authorization: basicAuth,
            accept: expectedMimeType || "image/*, audio/*, application/pdf",
            "user-agent": userAgent,
          },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw upstreamNetworkError(error, "WordPress media download");
      }
      if (!response.ok) {
        const err = new Error(`WordPress media download failed with HTTP ${response.status}.`);
        err.status = 502;
        err.code = "wordpress_media_download_failed";
        throw err;
      }
      const responseType = String(response.headers.get("content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      const expectedMatches = !expectedMimeType || !responseType || responseType === "application/octet-stream"
        || (expectedMimeType.endsWith("/*")
          ? responseType.startsWith(expectedMimeType.slice(0, -1))
          : responseType === expectedMimeType);
      if (!expectedMatches) {
        const err = new Error(`WordPress media download returned MIME type ${responseType}, expected ${expectedMimeType}.`);
        err.status = 502;
        err.code = "wordpress_media_mime_mismatch";
        throw err;
      }
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > maxBytes) {
        const err = new Error(`WordPress media exceeds the configured byte limit (${maxBytes}).`);
        err.status = 413;
        err.code = "source_image_too_large";
        throw err;
      }
      if (!response.body) {
        const err = new Error("WordPress media download returned no image data.");
        err.status = 502;
        err.code = "wordpress_media_download_failed";
        throw err;
      }
      const chunks = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > maxBytes) {
            const err = new Error(`WordPress media exceeds the configured byte limit (${maxBytes}).`);
            err.status = 413;
            err.code = "source_image_too_large";
            throw err;
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error?.status) throw error;
        throw upstreamNetworkError(error, "WordPress media download");
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Backwards-compatible image-only name used by the transform fallback.
  async function wpImageDownload(sourceUrl, maxBytes) {
    return wpMediaDownload(sourceUrl, maxBytes, "image/*");
  }

  return { wpRequest, wpSeoHelperRequest, wpAlpsHelperRequest, wpCalendarHelperRequest, wpImageUpload, wpImageDownload, wpMediaDownload };
}
