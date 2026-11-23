import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpAuth } from "../mcp/http-auth.js";
import { clientKey, createSecurityLog, createThrottle, parseRateLimit } from "../mcp/http-guard.js";
import { createHttpHandler } from "../mcp/server.js";
import { createGateway } from "../mcp/gateway.js";

const oauthEnv = {
  WPBRIDGE_MCP_OAUTH_ISSUER: "https://issuer.example/",
  WPBRIDGE_MCP_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
  WPBRIDGE_MCP_OAUTH_SUBJECT: "owner-123",
  WPBRIDGE_MCP_OAUTH_JWKS_URL: "https://issuer.example/jwks.json",
  WPBRIDGE_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
};
const localToken = "m".repeat(64);
const metadataUrl = "https://mcp.example.com/.well-known/oauth-protected-resource";
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard-test", version: "1.0.0" },
} });

const keys = (async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return { privateKey, jwks: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" }] }) };
})();

async function signed(claims, { aud = oauthEnv.WPBRIDGE_MCP_OAUTH_AUDIENCE } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(oauthEnv.WPBRIDGE_MCP_OAUTH_ISSUER).setAudience(aud)
    .setIssuedAt().setExpirationTime("5m").sign((await keys).privateKey);
}

function manualClock(start = 1_000_000) {
  const clock = { at: start, now: () => clock.at };
  return clock;
}

// Runs the real handler on a real loopback server. authorize() is counted so
// tests can prove that cheap rejects never reach authentication.
async function withServer({ mode = "oauth", env = {}, throttle, run }) {
  const base = mode === "oauth" ? { ...oauthEnv, ...env } : { WPBRIDGE_MCP_TOKEN: localToken, ...env };
  const realAuth = createHttpAuth(base, mode === "oauth" ? { jwks: (await keys).jwks } : {});
  const counter = { calls: 0 };
  const auth = { ...realAuth, authorize: async (header) => { counter.calls += 1; return realAuth.authorize(header); } };
  const lines = [];
  const clock = manualClock();
  const log = createSecurityLog({ write: (line) => lines.push(line), now: clock.now });
  let handler = null;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  handler = createHttpHandler({ gateway: createGateway([]), auth, port, log,
    throttle: throttle || createThrottle({ burst: 1000, perSecond: 1000 }) });
  const request = (options = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...options.headers };
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
    const req = http.request({ host: "127.0.0.1", port, method: options.method || "POST",
      path: options.path || "/mcp", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body ?? ((options.method || "POST") === "POST" ? "{}" : undefined));
  });
  try {
    await run({ request, port, counter, lines, clock });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("throttle refills over time, answers with Retry-After, and keys clients separately", () => {
  const clock = manualClock();
  const throttle = createThrottle({ burst: 3, perSecond: 2, now: clock.now });
  for (let i = 0; i < 3; i += 1) assert.deepEqual(throttle.take("a"), { ok: true });
  assert.deepEqual(throttle.take("a"), { ok: false, retryAfter: 1 });
  assert.deepEqual(throttle.take("b"), { ok: true });
  clock.at += 499;
  assert.equal(throttle.take("a").ok, false);
  clock.at += 1;
  assert.equal(throttle.take("a").ok, true);
  clock.at += 60_000;
  for (let i = 0; i < 3; i += 1) assert.equal(throttle.take("a").ok, true, "refill is capped at the burst");
  assert.equal(throttle.take("a").ok, false);
  const slow = createThrottle({ burst: 1, perSecond: 0.1, now: clock.now });
  slow.take("x");
  assert.deepEqual(slow.take("x"), { ok: false, retryAfter: 10 });
});

test("throttle memory is bounded and evicts the least recently used client", () => {
  const clock = manualClock();
  const throttle = createThrottle({ burst: 1, perSecond: 0.001, maxEntries: 3, now: clock.now });
  for (const key of ["a", "b", "c"]) throttle.take(key);
  assert.equal(throttle.take("a").ok, false, "a is now the most recently used");
  throttle.take("d");
  assert.equal(throttle.size, 3);
  assert.equal(throttle.take("a").ok, false, "a was kept");
  assert.equal(throttle.take("b").ok, true, "b was evicted and starts with a fresh bucket");
  for (let i = 0; i < 1000; i += 1) throttle.take(`flood-${i}`);
  assert.equal(throttle.size, 3);
});

test("rate-limit settings are validated", () => {
  assert.deepEqual(parseRateLimit({}), { burst: 30, perSecond: 5 });
  assert.deepEqual(parseRateLimit({ WPBRIDGE_MCP_RATE_LIMIT_BURST: "60", WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND: "0.5" }),
    { burst: 60, perSecond: 0.5 });
  for (const [name, value] of [["WPBRIDGE_MCP_RATE_LIMIT_BURST", "0"], ["WPBRIDGE_MCP_RATE_LIMIT_BURST", "2.5"],
    ["WPBRIDGE_MCP_RATE_LIMIT_BURST", "lots"], ["WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND", "0"],
    ["WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND", "-1"], ["WPBRIDGE_MCP_RATE_LIMIT_PER_SECOND", "Infinity"]]) {
    assert.throws(() => parseRateLimit({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("client key trusts Cf-Connecting-IP only from a loopback peer", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(clientKey(req("::ffff:127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(clientKey(req("::1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(clientKey(req("198.51.100.4", { "cf-connecting-ip": "203.0.113.7" })), "198.51.100.4");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "not an ip" })), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7, 203.0.113.8" })), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1")), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "2001:DB8:0:1:aaaa::1" })), "2001:db8:0:1::/64");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "2001:db8::1" })), "2001:db8:0:0::/64");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "2001:0db8:0001:0002:3:4:5:6" })), "2001:db8:1:2::/64");
  assert.equal(clientKey(req(undefined)), "unknown");
});

test("security log writes one JSON line and rate-limits identical events", () => {
  const lines = [];
  const clock = manualClock(Date.UTC(2026, 0, 1));
  const log = createSecurityLog({ write: (line) => lines.push(line), now: clock.now, windowMs: 1000 });
  log({ event: "auth_failed", reason: "x", cf_ray: "ray-1" });
  log({ event: "auth_failed", reason: "x", cf_ray: "ray-2" });
  log({ event: "auth_failed", reason: "y", cf_ray: "ray-3" });
  assert.equal(lines.length, 2);
  clock.at += 1000;
  log({ event: "auth_failed", reason: "x", cf_ray: "ray-4" });
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { time: "2026-01-01T00:00:00.000Z", event: "auth_failed", reason: "x", cf_ray: "ray-1" });
  assert.equal(JSON.parse(lines[2]).repeated, 1);
  assert.equal(JSON.parse(lines[2]).cf_ray, "ray-4");
});

test("unknown paths get 404 before Host, Origin or auth checks", async () => {
  await withServer({ run: async ({ request, counter }) => {
    for (const path of ["/", "/mcp/", "/mcp?x=1", "/.well-known/other", "/MCP"]) {
      assert.equal((await request({ path, headers: { host: "evil.example" } })).status, 404, path);
    }
    assert.equal(counter.calls, 0);
  } });
  await withServer({ mode: "local-token", run: async ({ request, counter }) => {
    assert.equal((await request({ method: "GET", path: "/.well-known/oauth-protected-resource" })).status, 404);
    assert.equal((await request({ method: "GET", path: "/.well-known/oauth-protected-resource/mcp" })).status, 404);
    assert.equal(counter.calls, 0);
  } });
});

test("Host must be the public host or loopback on the configured port", async () => {
  await withServer({ run: async ({ request, counter, port, lines }) => {
    for (const host of ["evil.example", "mcp.example.com.evil.example", `127.0.0.1:${port + 1}`, "127.0.0.1", "mcp.example.com:8443"]) {
      assert.equal((await request({ headers: { host } })).status, 403, host);
    }
    assert.equal(counter.calls, 0);
    const rejected = JSON.parse(lines[0]);
    assert.equal(rejected.event, "request_rejected");
    assert.equal(rejected.reason, "host_not_allowed");
    assert.equal(rejected.host, "evil.example");
    for (const host of ["mcp.example.com", "MCP.example.com", `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await request({ headers: { host } })).status, 401, host);
    }
    assert.equal(counter.calls, 5);
  } });
});

test("local-token mode refuses the public host and anything that came through a proxy", async () => {
  await withServer({ mode: "local-token", run: async ({ request, counter, port }) => {
    const auth = { authorization: `Bearer ${localToken}` };
    assert.equal((await request({ headers: { ...auth, host: "mcp.example.com" } })).status, 403);
    for (const header of ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded"]) {
      assert.equal((await request({ headers: { ...auth, [header]: "203.0.113.7" } })).status, 403, header);
    }
    assert.equal(counter.calls, 0);
    const ok = await request({ headers: { ...auth, accept: "application/json, text/event-stream",
      "content-type": "application/json", host: `localhost:${port}` }, body: initialize });
    assert.equal(ok.status, 200);
    const denied = await request({ headers: { authorization: "Bearer wrong" } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["www-authenticate"], "Bearer");
  } });
});

test("a present Origin must be the public origin or a loopback origin", async () => {
  await withServer({ run: async ({ request, counter, port }) => {
    for (const origin of ["https://evil.example", "null", "http://mcp.example.com", `http://127.0.0.1:${port + 1}`, "https://mcp.example.com:8443"]) {
      assert.equal((await request({ headers: { origin } })).status, 403, origin);
    }
    assert.equal(counter.calls, 0);
    for (const origin of ["https://mcp.example.com", `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      assert.equal((await request({ headers: { origin } })).status, 401, origin);
    }
    assert.equal((await request({})).status, 401, "absent Origin is allowed");
  } });
  await withServer({ mode: "local-token", run: async ({ request }) => {
    assert.equal((await request({ headers: { origin: "https://mcp.example.com" } })).status, 403);
  } });
});

test("wrong methods get 405 without running auth", async () => {
  await withServer({ run: async ({ request, counter }) => {
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const response = await request({ method, headers: { authorization: "Bearer junk" } });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, "POST");
    }
    const metadata = await request({ method: "POST", path: "/.well-known/oauth-protected-resource" });
    assert.equal(metadata.status, 405);
    assert.equal(metadata.headers.allow, "GET");
    assert.equal(counter.calls, 0);
  } });
});

test("throttling answers 429 with Retry-After before auth, per client, and recovers", async () => {
  const clock = manualClock();
  const throttle = createThrottle({ burst: 2, perSecond: 1, now: clock.now });
  await withServer({ throttle, run: async ({ request, counter, lines }) => {
    assert.equal((await request({})).status, 401);
    assert.equal((await request({})).status, 401);
    const limited = await request({});
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "1");
    assert.equal(counter.calls, 2);
    assert.equal((await request({ method: "GET", path: "/.well-known/oauth-protected-resource" })).status, 429,
      "metadata shares the bucket");
    // The test client is a loopback peer, so Cf-Connecting-IP selects the bucket.
    assert.equal((await request({ headers: { "cf-connecting-ip": "203.0.113.9" } })).status, 401);
    clock.at += 1000;
    assert.equal((await request({})).status, 401);
    assert.equal(counter.calls, 4);
    assert.ok(lines.some((line) => JSON.parse(line).reason === "rate_limited"));
  } });
});

test("protected-resource metadata is served at both well-known paths without auth", async () => {
  await withServer({ run: async ({ request, counter }) => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await request({ method: "GET", path, headers: { host: "mcp.example.com" } });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(response.body), {
        resource: "https://mcp.example.com/mcp", authorization_servers: ["https://issuer.example/"],
        bearer_methods_supported: ["header"], scopes_supported: ["wpbridge:access"],
      });
      assert.equal((await request({ method: "GET", path, headers: { host: "evil.example" } })).status, 403);
      assert.equal((await request({ method: "GET", path, headers: { origin: "https://evil.example" } })).status, 403);
    }
    assert.equal(counter.calls, 0);
  } });
  await withServer({ env: { WPBRIDGE_MCP_OAUTH_SCOPE: "" }, run: async ({ request }) => {
    const response = await request({ method: "GET", path: "/.well-known/oauth-protected-resource/mcp" });
    assert.equal("scopes_supported" in JSON.parse(response.body), false);
    assert.equal((await request({})).headers["www-authenticate"], `Bearer resource_metadata="${metadataUrl}"`);
  } });
});

test("HTTP challenges follow RFC 6750 and a valid owner token reaches MCP", async () => {
  await withServer({ run: async ({ request }) => {
    const none = await request({});
    assert.equal(none.status, 401);
    assert.equal(none.headers["www-authenticate"], `Bearer resource_metadata="${metadataUrl}", scope="wpbridge:access"`);
    assert.equal(none.headers["cache-control"], "no-store");
    const bad = await request({ headers: { authorization: "Bearer not-a-jwt" } });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers["www-authenticate"],
      `Bearer error="invalid_token", resource_metadata="${metadataUrl}", scope="wpbridge:access"`);
    const noScope = await request({ headers: { authorization: `Bearer ${await signed({ sub: "owner-123" })}` } });
    assert.equal(noScope.status, 403);
    assert.equal(noScope.headers["www-authenticate"],
      `Bearer error="insufficient_scope", scope="wpbridge:access", resource_metadata="${metadataUrl}"`);
    const otherUser = await request({ headers: { authorization: `Bearer ${await signed({ sub: "someone-else", scope: "wpbridge:access" })}` } });
    assert.equal(otherUser.status, 403);
    const ok = await request({ headers: { authorization: `Bearer ${await signed({ sub: "owner-123", scope: "wpbridge:access" })}`,
      accept: "application/json, text/event-stream", "content-type": "application/json", host: "mcp.example.com" }, body: initialize });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /"serverInfo"/);
  } });
});

test("auth failure logs carry reasons but never the token, Authorization header or sub", async () => {
  await withServer({ run: async ({ request, lines }) => {
    const token = await signed({ sub: "secret-owner-subject", scope: "wpbridge:access", email: "owner@example.com" },
      { aud: "https://another.example/mcp" });
    const response = await request({ headers: { authorization: `Bearer ${token}`, "cf-ray": "8f1e2d3c4b5a6978-AMS",
      "cf-connecting-ip": "203.0.113.50", host: "mcp.example.com" } });
    assert.equal(response.status, 401);
    const scopeless = await signed({ sub: "secret-owner-subject" });
    await request({ headers: { authorization: `Bearer ${scopeless}` } });
    await request({ headers: { authorization: `Bearer ${localToken}` } });
    await request({ headers: { authorization: "Bearer not-a-jwt" } });
    const text = lines.join("\n");
    for (const secret of [token, scopeless, localToken, "not-a-jwt", "Bearer", "secret-owner-subject", "owner@example.com",
      token.split(".")[1], token.split(".")[2]]) {
      assert.ok(!text.includes(secret), `log must not contain ${secret.slice(0, 20)}`);
    }
    assert.ok(!/authorization/i.test(text));
    const first = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(first).sort(), ["aud", "cf_ray", "client", "event", "iss", "kid", "reason", "status", "time"]);
    assert.equal(first.event, "auth_failed");
    assert.equal(first.status, 401);
    assert.equal(first.reason, "ERR_JWT_CLAIM_VALIDATION_FAILED:aud");
    assert.equal(first.cf_ray, "8f1e2d3c4b5a6978-AMS");
    assert.equal(first.client, "203.0.113.50");
    assert.equal(first.kid, "test-key");
    assert.equal(first.iss, "https://issuer.example/");
    assert.equal(first.aud, "https://another.example/mcp");
    assert.ok(lines.every((line) => !line.includes("\n")));
  } });
});
