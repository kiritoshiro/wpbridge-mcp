import net from "node:net";

// Cheap checks that run before any authentication or JWT work on the HTTP MCP
// transport: path, duplicate headers, Host, proxy headers, Origin, method, then
// a per-client token bucket.

export const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
// A reverse proxy or tunnel adds at least one of these. A request that names a
// loopback Host must not carry them: the proxy should pass the public Host
// through, and the local static token must not be reached through a proxy.
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded"];
// Headers whose repetition would let different parsers disagree about a
// security decision; a request repeating any of them is refused.
const SINGLE_HEADERS = ["host", "authorization", "origin", "cf-connecting-ip", "cf-ray"];
const DEFAULT_PORTS = { "https:": "443", "http:": "80" };

// Canonical form of an address: { family: 4, ip } or { family: 6, groups }
// with all eight 16-bit groups. IPv4-mapped IPv6 (::ffff:a.b.c.d or
// ::ffff:xxxx:xxxx) is treated as IPv4. Returns null for anything else.
export function canonicalIp(value) {
  let text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const family = net.isIP(text);
  if (family === 4) return { family: 4, ip: text };
  if (family !== 6) return null;
  text = text.split("%")[0];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (net.isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (part) => (part ? part.split(":") : []);
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...rest];
  if (parts.length !== 8 || !parts.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const groups = parts.map((group) => parseInt(group, 16));
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { family: 4, ip: [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".") };
  }
  return { family: 6, groups };
}

function isLoopback(addr) {
  if (!addr) return false;
  if (addr.family === 4) return addr.ip.startsWith("127.");
  return addr.groups.slice(0, 7).every((group) => group === 0) && addr.groups[7] === 1;
}

// IPv6 clients usually control a whole /64, so they share one bucket.
function addressKey(addr) {
  if (addr.family === 4) return addr.ip;
  if (isLoopback(addr)) return "::1";
  return `${addr.groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

// Values of one header as a list: repeated headers stay separate.
function headerValues(req, name) {
  const distinct = req?.headersDistinct?.[name];
  if (Array.isArray(distinct)) return distinct;
  const raw = req?.rawHeaders;
  if (Array.isArray(raw)) {
    const values = [];
    for (let i = 0; i + 1 < raw.length; i += 2) if (String(raw[i]).toLowerCase() === name) values.push(raw[i + 1]);
    return values;
  }
  const value = req?.headers?.[name];
  return value === undefined ? [] : [].concat(value);
}

// The client IP from exactly one valid Cf-Connecting-IP header, or null.
function forwardedClient(req) {
  const values = headerValues(req, "cf-connecting-ip");
  return values.length === 1 ? canonicalIp(values[0]) : null;
}

// The server binds to loopback only, so a loopback peer is cloudflared (or a
// local process). Cf-Connecting-IP is used only from such a peer, and the
// guard passes trustForwarded only for requests to the public host.
export function clientKey(req, trustForwarded = true) {
  const remote = canonicalIp(req?.socket?.remoteAddress);
  if (!remote) return "unknown";
  if (trustForwarded && isLoopback(remote)) {
    const forwarded = forwardedClient(req);
    if (forwarded) return addressKey(forwarded);
  }
  return addressKey(remote);
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

// C0 and C1 controls (which include U+0085), DEL, the Unicode line and
// paragraph separators, and bidi overrides are escaped as \uXXXX text so an
// attacker-supplied value cannot split or disguise a log record.
const UNSAFE_LOG_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function sanitizeLogValue(value) {
  if (typeof value === "string") {
    return value.replace(UNSAFE_LOG_CHARS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  return value;
}

// One JSON line per event on stderr (stdout carries MCP in stdio mode).
// Events with the same event, reason, client and status within the window are
// counted instead of repeated; the next line emitted for that identity reports
// the count as `repeated`. The identity never includes attacker-chosen values
// such as Host, Origin or token hints. On top of that, at most
// maxLinesPerWindow lines are written per window; the rest are dropped and
// counted. There is no timer: the log_suppressed line with that count is
// written when the next event arrives after the window has rolled over, so it
// never appears if logging stops.
export function createSecurityLog({
  write = (line) => process.stderr.write(`${line}\n`), now = Date.now, windowMs = 60_000, maxKeys = 1000, maxLinesPerWindow = 100,
} = {}) {
  const recent = new Map();
  let windowStart = null;
  let emitted = 0;
  let dropped = 0;
  const emit = (at, fields) => {
    const clean = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, sanitizeLogValue(value)]));
    write(JSON.stringify({ time: new Date(at).toISOString(), ...clean }));
  };
  return function log(fields) {
    const at = now();
    if (windowStart === null || at - windowStart >= windowMs) {
      if (dropped) emit(at, { event: "log_suppressed", dropped });
      windowStart = at;
      emitted = 0;
      dropped = 0;
    }
    const key = [fields.event, fields.reason, fields.client, fields.status].map((part) => String(part ?? "")).join("|");
    const seen = recent.get(key);
    if (seen && at - seen.at < windowMs) { seen.suppressed += 1; return; }
    if (emitted >= maxLinesPerWindow) { dropped += 1; return; }
    emitted += 1;
    recent.delete(key);
    while (recent.size >= maxKeys) recent.delete(recent.keys().next().value);
    recent.set(key, { at, suppressed: 0 });
    emit(at, { ...fields, ...(seen?.suppressed ? { repeated: seen.suppressed } : {}) });
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
  const loopbackHosts = new Set(LOOPBACK_HOSTNAMES.flatMap(withPort));
  const publicHosts = new Set();
  const origins = new Set(LOOPBACK_HOSTNAMES.flatMap((name) => withPort(name).map((host) => `http://${host}`)));
  if (auth.mode === "oauth") {
    const publicUrl = new URL(auth.publicUrl);
    publicHosts.add(publicUrl.host);
    // URL drops a default port, so also accept it spelled out (host:443).
    if (!publicUrl.port) publicHosts.add(`${publicUrl.hostname}:${DEFAULT_PORTS[publicUrl.protocol]}`);
    origins.add(publicUrl.origin);
  }
  const hosts = new Set([...loopbackHosts, ...publicHosts]);

  const limited = (req, client, retryAfter) => {
    log({ event: "request_rejected", status: 429, reason: "rate_limited", cf_ray: cfRay(req), client });
    return { ok: false, status: 429, reason: "rate_limited", headers: { "retry-after": String(retryAfter) } };
  };
  // Rejections driven by attacker-chosen headers (duplicate headers, Host,
  // proxy headers, Origin) spend a throttle token before they are logged, so a
  // flood is answered with 429 and logs are bounded. Only these and 429 are
  // logged here; the 404 for an unknown path and the 405 for a wrong method
  // are returned without logging or spending a token.
  const deny = (req, client, status, reason, details = {}) => {
    const taken = throttle.take(client);
    if (!taken.ok) return limited(req, client, taken.retryAfter);
    log({ event: "request_rejected", status, reason, cf_ray: cfRay(req), client, ...details });
    return { ok: false, status, reason, headers: {} };
  };

  return {
    hosts, origins,
    check(req) {
      const route = req.url === "/mcp" ? "mcp" : (auth.resourceMetadata && METADATA_PATHS.has(req.url) ? "metadata" : null);
      if (!route) return { ok: false, status: 404, reason: "path_not_found", headers: {} };
      const socketClient = clientKey(req, false);
      if (SINGLE_HEADERS.some((name) => headerValues(req, name).length > 1)) {
        return deny(req, socketClient, 400, "duplicate_header");
      }
      const host = String(req.headers.host || "").toLowerCase();
      if (!hosts.has(host)) {
        return deny(req, socketClient, 403, "host_not_allowed", { host: headerText(req.headers.host, 100) ?? null });
      }
      let client = socketClient;
      if (loopbackHosts.has(host)) {
        if (PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) return deny(req, socketClient, 403, "proxied_request");
      } else if (isLoopback(canonicalIp(req.socket?.remoteAddress))) {
        // Public Host from a loopback peer: this came through the tunnel, which
        // must name the real client. Without it every client would share the
        // tunnel's bucket, so fail closed.
        const forwarded = forwardedClient(req);
        if (!forwarded) return deny(req, socketClient, 403, "proxy_client_ip_missing");
        client = addressKey(forwarded);
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
        return deny(req, client, 403, "origin_not_allowed", { origin: headerText(origin, 100) });
      }
      const method = route === "mcp" ? "POST" : "GET";
      if (req.method !== method) return { ok: false, status: 405, reason: "method_not_allowed", headers: { allow: method } };
      const taken = throttle.take(client);
      if (!taken.ok) return limited(req, client, taken.retryAfter);
      return { ok: true, route, client };
    },
  };
}
