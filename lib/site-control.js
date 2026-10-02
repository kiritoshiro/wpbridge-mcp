import crypto from "node:crypto";
import { safeEqual } from "./auth.js";
import { buildWpRestUrl } from "./config.js";
import { json, readJson } from "./http.js";

const routes = {
  "GET /v1/site-control/site": "/wp-json/wpbridge-control/v1/site",
  "POST /v1/site-control/site": "/wp-json/wpbridge-control/v1/site",
  "GET /v1/site-control/plugins": "/wp-json/wpbridge-control/v1/plugins",
  "POST /v1/site-control/plugins/update": "/wp-json/wpbridge-control/v1/plugins/update",
};

export function createSiteControlHandler({
  cfg, security, fetchImpl = globalThis.fetch,
  controlKey = process.env.SITE_CONTROL_API_KEY || "",
  controlUsername = process.env.WP_CONTROL_USERNAME || "",
  controlAppPassword = process.env.WP_CONTROL_APP_PASSWORD || "",
}) {
  return async function siteControl(req, res) {
    const requestId = crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    if (security.rateLimited(req)) return json(res, 429, { error: "rate_limited", request_id: requestId });
    if (controlKey.length < 32 || !controlUsername || !controlAppPassword) {
      return json(res, 503, { error: "site_control_not_configured", request_id: requestId });
    }
    const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
    if (!safeEqual(bearer, controlKey)) return json(res, 401, { error: "unauthorized", request_id: requestId });
    const route = routes[`${req.method} ${req.url}`];
    if (!route) return json(res, 404, { error: "not_found", request_id: requestId });
    const isWrite = req.method === "POST";
    const body = isWrite ? await readJson(req, cfg.maxBodyBytes) : undefined;
    const target = buildWpRestUrl(cfg.wpUrl, route);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isWrite ? 90_000 : 20_000);
    try {
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers: {
          authorization: `Basic ${Buffer.from(`${controlUsername}:${controlAppPassword}`).toString("base64")}`,
          accept: "application/json",
          ...(isWrite ? { "content-type": "application/json" } : {}),
        },
        ...(isWrite ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      if (!(upstream.headers.get("content-type") || "").includes("application/json")) {
        throw new Error("WordPress companion returned a non-JSON response.");
      }
      const result = await upstream.json();
      return json(res, upstream.status, result, { "x-request-id": requestId });
    } catch (error) {
      const unavailable = new Error(isWrite
        ? "Site-control write may have reached WordPress; read current state before retrying."
        : "WordPress companion is unavailable.");
      unavailable.status = 502;
      unavailable.code = isWrite ? "site_control_outcome_unknown" : "site_control_unavailable";
      unavailable.outcomeUnknown = isWrite;
      throw unavailable;
    } finally {
      clearTimeout(timer);
    }
  };
}
