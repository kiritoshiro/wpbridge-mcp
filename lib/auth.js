import crypto from "node:crypto";
import { clientIp } from "./config.js";

export function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) {
    const pad = crypto.randomBytes(Math.max(aa.length, 1));
    crypto.timingSafeEqual(pad, pad);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

export function isAuthorized(req, bridgeApiKey) {
  const auth = String(req?.headers?.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const custom = String(req?.headers?.["x-bridge-key"] || "").trim();
  return Boolean(
    (bearer && safeEqual(bearer, bridgeApiKey)) ||
    (custom && safeEqual(custom, bridgeApiKey))
  );
}

export function createBridgeSecurity({ bridgeApiKey, rateLimitPerMinute, trustedProxyIps }) {
  const rateBuckets = new Map();
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [key, bucket] of rateBuckets) {
      if (bucket.started < cutoff) rateBuckets.delete(key);
    }
  }, 60_000);
  cleanup.unref();

  function authorized(req) {
    return isAuthorized(req, bridgeApiKey);
  }

  function rateLimited(req) {
    const key = clientIp(req, trustedProxyIps);
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.started >= 60_000) {
      bucket = { started: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count > rateLimitPerMinute;
  }

  return { authorized, rateLimited };
}
