import net from "node:net";

// Cheap checks that run before any authentication or JWT work on the HTTP MCP
// transport: path, Host, Origin, method, then a per-client token bucket.

export const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
// A reverse proxy or tunnel adds at least one of these. The local static token
// must never be reachable through one, even if the proxy rewrites Host.
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded"];

function normalizeIp(value) {
  let ip = String(value || "").trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

function isLoopbackIp(ip) {
  return ip === "::1" || (net.isIP(ip) === 4 && ip.startsWith("127."));
}

// IPv6 clients usually control a whole /64, so they share one bucket.
function ipv6Prefix64(ip) {
  const [head, tail] = ip.split("::");
  const count = (part) => (part ? part.split(":").reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0) : 0);
  const headGroups = head ? head.split(":") : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(Math.max(0, 8 - count(head) - count(tail))).fill("0")];
  const prefix = [...groups, "0", "0", "0", "0"].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

// The server binds to loopback only, so a loopback peer is cloudflared (or a
// local process). Cf-Connecting-IP is trusted only from such a peer.
export function clientKey(req) {
  const remote = normalizeIp(req?.socket?.remoteAddress);
  let ip = remote;
  if (isLoopbackIp(remote)) {
    const forwarded = normalizeIp(req?.headers?.["cf-connecting-ip"]);
    if (net.isIP(forwarded)) ip = forwarded;
  }
  if (!ip) return "unknown";
  return net.isIP(ip) === 6 && !isLoopbackIp(ip) ? ipv6Prefix64(ip) : ip;
}

function parseLimit(env, name, fallback, { min, max, integer }) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

export function parseRateLimit(env = process.env) {
  return {
    burst: parseLimit(env, "WPBRIDGE_MCP_RATE_LIMIT_BURST", 30, { min: 1, max: 10_000, integer: true }),
    perSecond: parseLimit(env, "WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND", 5, { min: 0.01, max: 10_000 }),
  };
}

// Token bucket per client key. The map is bounded: when it is full the least
// recently used entry is dropped, which at worst gives that client a fresh bucket.
export function createThrottle({ burst = 30, perSecond = 5, maxEntries = 10_000, now = Date.now } = {}) {
  const buckets = new Map();
  return {
    get size() { return buckets.size; },
    take(key, cost = 1) {
      const at = now();
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key);
        bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, at - bucket.at) / 1000 * perSecond);
        bucket.at = at;
      } else {
        bucket = { tokens: burst, at };
        while (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value);
      }
      buckets.set(key, bucket);
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { ok: true };
      }
      return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - bucket.tokens) / perSecond)) };
    },
  };
}

// One JSON line per event on stderr (stdout carries MCP in stdio mode).
// Identical events within the window (ignoring the per-request Cf-Ray) are
// counted instead of repeated; the next emitted line reports the count.
export function createSecurityLog({ write = (line) => process.stderr.write(`${line}\n`), now = Date.now, windowMs = 60_000, maxKeys = 1000 } = {}) {
  const recent = new Map();
  return function log(fields) {
    const { cf_ray: _ray, ...identity } = fields;
    const key = JSON.stringify(identity);
    const at = now();
    const seen = recent.get(key);
    if (seen && at - seen.at < windowMs) { seen.suppressed += 1; return; }
    recent.delete(key);
    while (recent.size >= maxKeys) recent.delete(recent.keys().next().value);
    recent.set(key, { at, suppressed: 0 });
    write(JSON.stringify({ time: new Date(at).toISOString(), ...fields, ...(seen?.suppressed ? { repeated: seen.suppressed } : {}) }));
  };
}

function headerText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function cfRay(req) {
  const value = req?.headers?.["cf-ray"];
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined;
}

export function createRequestGuard({ auth, port, throttle, log = () => {} }) {
  const withPort = (name) => (port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]);
  const hosts = new Set(LOOPBACK_HOSTNAMES.flatMap(withPort));
  const origins = new Set(LOOPBACK_HOSTNAMES.flatMap((name) => withPort(name).map((host) => `http://${host}`)));
  if (auth.mode === "oauth") {
    const publicUrl = new URL(auth.publicUrl);
    hosts.add(publicUrl.host);
    origins.add(publicUrl.origin);
  }
  const reject = (status, reason, headers = {}, details = null) => {
    if (details) log({ event: "request_rejected", status, reason, ...details });
    return { ok: false, status, reason, headers };
  };

  return {
    hosts, origins,
    check(req) {
      const route = req.url === "/mcp" ? "mcp" : (auth.resourceMetadata && METADATA_PATHS.has(req.url) ? "metadata" : null);
      if (!route) return reject(404, "path_not_found");
      const host = String(req.headers.host || "").toLowerCase();
      if (!hosts.has(host)) {
        return reject(403, "host_not_allowed", {}, { host: headerText(req.headers.host, 100) ?? null, cf_ray: cfRay(req), client: clientKey(req) });
      }
      if (auth.mode !== "oauth" && PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) {
        return reject(403, "proxied_request", {}, { cf_ray: cfRay(req), client: clientKey(req) });
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
        return reject(403, "origin_not_allowed", {}, { origin: headerText(origin, 100), cf_ray: cfRay(req), client: clientKey(req) });
      }
      const method = route === "mcp" ? "POST" : "GET";
      if (req.method !== method) return reject(405, "method_not_allowed", { allow: method });
      const client = clientKey(req);
      const taken = throttle.take(client);
      if (!taken.ok) {
        return reject(429, "rate_limited", { "retry-after": String(taken.retryAfter) }, { cf_ray: cfRay(req), client });
      }
      return { ok: true, route, client };
    },
  };
}
