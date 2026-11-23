import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAuth, parseAlgorithms, parseAuthorization, unverifiedTokenHints } from "../mcp/http-auth.js";

const env = {
  WPBRIDGE_MCP_OAUTH_ISSUER: "https://issuer.example/",
  WPBRIDGE_MCP_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
  WPBRIDGE_MCP_OAUTH_SUBJECT: "owner-123",
  WPBRIDGE_MCP_OAUTH_JWKS_URL: "https://issuer.example/jwks.json",
  WPBRIDGE_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
};
const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource";

const keys = (async () => {
  const rsa = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const ec = await generateKeyPair("ES256");
  const jwks = createLocalJWKSet({ keys: [
    { ...await exportJWK(rsa.publicKey), kid: "test-key", alg: "RS256" },
    { ...await exportJWK(ec.publicKey), kid: "ec-key", alg: "ES256" },
  ] });
  return { rsa, other, ec, jwks };
})();

async function signed(claims, { key, alg = "RS256", kid = "test-key", iss = env.WPBRIDGE_MCP_OAUTH_ISSUER,
  aud = env.WPBRIDGE_MCP_OAUTH_AUDIENCE, exp = "5m" } = {}) {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg, kid }).setIssuer(iss).setAudience(aud).setIssuedAt();
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign(key || (await keys).rsa.privateKey);
}

const owner = { sub: "owner-123", scope: "wpbridge:access" };

const optIn = { WPBRIDGE_MCP_LOCAL_TOKEN_HTTP: "1" };

test("local HTTP MCP mode requires a strong token and checks it", async () => {
  assert.throws(() => createHttpAuth({ ...optIn, WPBRIDGE_MCP_TOKEN: "short" }), /32 characters/);
  const token = "t".repeat(64);
  const auth = createHttpAuth({ ...optIn, WPBRIDGE_MCP_TOKEN: token });
  assert.equal(auth.mode, "local-token");
  assert.deepEqual(await auth.authorize(`Bearer ${token}`), { ok: true });
  const wrong = await auth.authorize("Bearer incorrect");
  assert.deepEqual(wrong, { ok: false, status: 401, error: null, reason: "token_mismatch", wwwAuthenticate: "Bearer" });
  assert.equal((await auth.authorize(undefined)).reason, "no_token");
  assert.equal((await auth.authorize(`Basic ${token}`)).reason, "not_bearer");
  assert.deepEqual(await auth.authorize(`Bearer ${token} extra`), {
    ok: false, status: 400, error: "invalid_request", reason: "malformed_bearer", wwwAuthenticate: 'Bearer error="invalid_request"',
  });
});

test("HTTP is OAuth-only unless local-token HTTP is explicitly enabled", () => {
  const token = "t".repeat(64);
  assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token }), /requires OAuth.*WPBRIDGE_MCP_LOCAL_TOKEN_HTTP=1/);
  assert.throws(() => createHttpAuth({}), /requires OAuth/);
  for (const value of ["true", "yes", "0", " 1", "1 "]) {
    assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, WPBRIDGE_MCP_LOCAL_TOKEN_HTTP: value }), /exactly 1/, value);
  }
  assert.equal(createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, WPBRIDGE_MCP_LOCAL_TOKEN_HTTP: "1" }).mode, "local-token");
  // An empty value, as an unfilled .env line leaves it, is the same as unset.
  assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, WPBRIDGE_MCP_LOCAL_TOKEN_HTTP: "" }), /requires OAuth/);
});

test("partial or mixed OAuth configuration refuses to start", () => {
  const token = "t".repeat(64);
  for (const name of Object.keys(env)) {
    const partial = { ...env, WPBRIDGE_MCP_TOKEN: token, ...optIn };
    delete partial.WPBRIDGE_MCP_LOCAL_TOKEN_HTTP;
    partial[name] = "  ";
    assert.throws(() => createHttpAuth(partial), new RegExp(`Incomplete OAuth configuration; also set ${name}`), name);
  }
  for (const name of Object.keys(env)) {
    assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, ...optIn, [name]: env[name] }), /cannot be combined/, name);
    assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, [name]: env[name] }), /Incomplete OAuth/, name);
  }
  for (const [name, value] of [["WPBRIDGE_MCP_OAUTH_SCOPE", "mcp:use"], ["WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM", "scp"], ["WPBRIDGE_MCP_OAUTH_ALGORITHMS", "ES256"]]) {
    assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, ...optIn, [name]: value }), /cannot be combined/, name);
    assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: token, [name]: value }), /Incomplete OAuth/, name);
  }
  assert.throws(() => createHttpAuth({ ...env, ...optIn }), /cannot be combined/);
  // A complete OAuth setup ignores a leftover local token: it is never accepted.
  assert.equal(createHttpAuth({ ...env, WPBRIDGE_MCP_TOKEN: token }).mode, "oauth");
});

test("Authorization parsing separates absent, other schemes and malformed Bearer", () => {
  assert.deepEqual(parseAuthorization(undefined), { kind: "absent" });
  assert.deepEqual(parseAuthorization(""), { kind: "absent" });
  assert.deepEqual(parseAuthorization("Basic abc"), { kind: "other_scheme" });
  assert.deepEqual(parseAuthorization("Bearerx abc"), { kind: "other_scheme" });
  assert.deepEqual(parseAuthorization("Bearer abc"), { kind: "bearer", token: "abc" });
  assert.deepEqual(parseAuthorization("bearer  abc "), { kind: "bearer", token: "abc" });
  for (const value of ["Bearer", "Bearer ", "Bearer token extra", "Bearer a	b"]) {
    assert.deepEqual(parseAuthorization(value), { kind: "malformed" }, JSON.stringify(value));
  }
  // Linear on hostile input.
  const started = Date.now();
  parseAuthorization(`Bearer ${"a ".repeat(50_000)}`);
  parseAuthorization(`Bearer ${" ".repeat(100_000)}x y`);
  assert.ok(Date.now() - started < 500);
});

test("OAuth mode requires a fixed owner and HTTPS metadata", async () => {
  const auth = createHttpAuth(env);
  assert.equal(auth.mode, "oauth");
  assert.equal(auth.publicUrl, "https://mcp.example.com/mcp");
  assert.deepEqual(auth.resourceMetadata, {
    resource: "https://mcp.example.com/mcp", authorization_servers: ["https://issuer.example/"],
    bearer_methods_supported: ["header"], scopes_supported: ["wpbridge:access"],
  });
  assert.deepEqual(auth.securitySchemes, [{ type: "oauth2", scopes: ["wpbridge:access"] }]);
  const none = await auth.authorize("");
  assert.equal(none.ok, false);
  assert.equal(none.status, 401);
  assert.equal(none.reason, "no_token");
  assert.equal(none.wwwAuthenticate, `Bearer resource_metadata="${metadata}", scope="wpbridge:access"`);
  assert.equal((await auth.authorize("Basic abc")).reason, "not_bearer");
  assert.equal((await auth.authorize("Basic abc")).status, 401);
  for (const header of ["Bearer", "Bearer token extra"]) {
    const malformed = await auth.authorize(header);
    assert.equal(malformed.status, 400, header);
    assert.equal(malformed.reason, "malformed_bearer", header);
    assert.equal(malformed.wwwAuthenticate, `Bearer error="invalid_request", resource_metadata="${metadata}", scope="wpbridge:access"`);
  }
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SUBJECT: "" }), /also set WPBRIDGE_MCP_OAUTH_SUBJECT/);
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_ISSUER: "http://issuer.example/" }), /exact owner subject/);
});

test("OAuth accepts only a signed token for this resource, owner, and scope", async () => {
  const { jwks } = await keys;
  const auth = createHttpAuth(env, { jwks });
  assert.deepEqual(await auth.authorize(`Bearer ${await signed(owner)}`), { ok: true });
  // RFC 7519 NumericDate may be fractional; a valid one is accepted.
  assert.equal((await auth.authorize(`Bearer ${await signed({ ...owner,
    exp: Math.floor(Date.now() / 1000) + 300.5 }, { exp: null })}`)).ok, true);
});

test("OAuth failures carry a reason, status and RFC 6750 challenge", async () => {
  const { jwks, other, ec } = await keys;
  const auth = createHttpAuth(env, { jwks });
  const invalid = `Bearer error="invalid_token", resource_metadata="${metadata}", scope="wpbridge:access"`;
  const insufficient = `Bearer error="insufficient_scope", scope="wpbridge:access", resource_metadata="${metadata}"`;
  const cases = [
    ["garbage", "not-a-jwt", 401, "ERR_JWS_INVALID"],
    ["bad signature", await signed(owner, { key: other.privateKey }), 401, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"],
    ["expired", await signed(owner, { exp: Math.floor(Date.now() / 1000) - 300.5 }), 401, "ERR_JWT_EXPIRED:exp"],
    ["no expiry", await signed(owner, { exp: null }), 401, "ERR_JWT_CLAIM_VALIDATION_FAILED:exp"],
    ["wrong issuer", await signed(owner, { iss: "https://other-issuer.example/" }), 401, "ERR_JWT_CLAIM_VALIDATION_FAILED:iss"],
    ["wrong audience", await signed(owner, { aud: "https://another.example/mcp" }), 401, "ERR_JWT_CLAIM_VALIDATION_FAILED:aud"],
    ["wrong algorithm", await signed(owner, { key: ec.privateKey, alg: "ES256", kid: "ec-key" }), 401, "ERR_JOSE_ALG_NOT_ALLOWED"],
    ["unknown key", await signed(owner, { kid: "rotated-away" }), 401, "ERR_JWKS_NO_MATCHING_KEY"],
    ["missing scope", await signed({ sub: "owner-123", scope: "other:access" }), 403, "scope_missing"],
    ["no scope claim", await signed({ sub: "owner-123" }), 403, "scope_missing"],
    ["sub mismatch", await signed({ sub: "someone-else", scope: "wpbridge:access" }), 403, "sub_mismatch"],
    ["no sub", await signed({ scope: "wpbridge:access" }), 403, "sub_mismatch"],
  ];
  for (const [name, token, status, reason] of cases) {
    const result = await auth.authorize(`Bearer ${token}`);
    assert.equal(result.ok, false, name);
    assert.equal(result.status, status, name);
    assert.equal(result.reason, reason, name);
    assert.equal(result.error, status === 401 ? "invalid_token" : "insufficient_scope", name);
    assert.equal(result.wwwAuthenticate, status === 401 ? invalid : insufficient, name);
  }
});

test("OAuth tolerates 30 seconds of clock drift", async () => {
  const { jwks } = await keys;
  const auth = createHttpAuth(env, { jwks });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await auth.authorize(`Bearer ${await signed(owner, { exp: now - 10 })}`)).ok, true);
  assert.equal((await auth.authorize(`Bearer ${await signed(owner, { exp: now - 60 })}`)).reason, "ERR_JWT_EXPIRED:exp");
});

test("OAuth algorithms are pinned and refuse none and HS*", async () => {
  assert.deepEqual(parseAlgorithms(undefined), ["RS256"]);
  assert.deepEqual(parseAlgorithms(""), ["RS256"]);
  assert.deepEqual(parseAlgorithms(" RS256, ES256 ,RS256"), ["RS256", "ES256"]);
  for (const bad of ["none", "HS256", "RS256,HS512", "rs256", "foo"]) {
    assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_ALGORITHMS: bad }), /asymmetric/, bad);
  }
  for (const empty of [",", ",,,", " , , "]) {
    assert.throws(() => parseAlgorithms(empty), /lists no algorithms/, empty);
    assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_ALGORITHMS: empty }), /lists no algorithms/, empty);
  }
  const { jwks, ec } = await keys;
  const auth = createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_ALGORITHMS: "RS256,ES256" }, { jwks });
  assert.equal((await auth.authorize(`Bearer ${await signed(owner, { key: ec.privateKey, alg: "ES256", kid: "ec-key" })}`)).ok, true);
});

test("OAuth scope is configurable, can be disabled, and can be read from scp", async () => {
  const { jwks } = await keys;
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE: "a b" }), /one OAuth scope token/);
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE: 'a"b' }), /one OAuth scope token/);
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM: "roles" }), /"scope" or "scp"/);

  const custom = createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE: "mcp:use" }, { jwks });
  assert.deepEqual(custom.resourceMetadata.scopes_supported, ["mcp:use"]);
  assert.equal((await custom.authorize(`Bearer ${await signed({ sub: "owner-123", scope: "openid mcp:use" })}`)).ok, true);
  assert.equal((await custom.authorize(`Bearer ${await signed(owner)}`)).reason, "scope_missing");

  const scp = createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM: "scp" }, { jwks });
  assert.equal((await scp.authorize(`Bearer ${await signed({ sub: "owner-123", scp: ["openid", "wpbridge:access"] })}`)).ok, true);
  assert.equal((await scp.authorize(`Bearer ${await signed({ sub: "owner-123", scp: "openid wpbridge:access" })}`)).ok, true);
  assert.equal((await scp.authorize(`Bearer ${await signed(owner)}`)).reason, "scope_missing", "scope claim is ignored in scp mode");

  const disabled = createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SCOPE: "" }, { jwks });
  assert.equal("scopes_supported" in disabled.resourceMetadata, false);
  assert.deepEqual(disabled.securitySchemes, [{ type: "oauth2", scopes: [] }]);
  assert.equal(disabled.challenge, `Bearer resource_metadata="${metadata}"`);
  assert.equal((await disabled.authorize(`Bearer ${await signed({ sub: "owner-123" })}`)).ok, true);
  const otherOwner = await disabled.authorize(`Bearer ${await signed({ sub: "someone-else" })}`);
  assert.equal(otherOwner.reason, "sub_mismatch");
  assert.equal(otherOwner.wwwAuthenticate, `Bearer error="insufficient_scope", resource_metadata="${metadata}"`);
  const expired = await disabled.authorize(`Bearer ${await signed({ sub: "owner-123" }, { exp: 1 })}`);
  assert.equal(expired.wwwAuthenticate, `Bearer error="invalid_token", resource_metadata="${metadata}"`);
});

test("unverified token hints expose only kid, iss and aud", async () => {
  const token = await signed({ sub: "secret-subject", scope: "wpbridge:access", email: "owner@example.com" },
    { aud: ["https://mcp.example.com/mcp", "https://other.example/"] });
  assert.deepEqual(unverifiedTokenHints(token), {
    kid: "test-key", iss: "https://issuer.example/", aud: ["https://mcp.example.com/mcp", "https://other.example/"],
  });
  assert.deepEqual(unverifiedTokenHints("not-a-jwt"), {});
});
