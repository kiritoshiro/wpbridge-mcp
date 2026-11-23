import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { safeEqual } from "../lib/auth.js";

const DEFAULT_SCOPE = "wpbridge:access";
// Asymmetric JWS algorithms only. "none" and HS* (shared-secret) are refused:
// a resource server that trusts a public JWKS must never accept them.
const ASYMMETRIC_ALGORITHMS = new Set([
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519",
]);
// RFC 6749 scope-token: printable ASCII except space, quote and backslash.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;

export function parseAlgorithms(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return ["RS256"];
  const list = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!list.length) throw new Error("WPBRIDGE_MCP_OAUTH_ALGORITHMS lists no algorithms; leave it unset for RS256.");
  for (const alg of list) {
    if (!ASYMMETRIC_ALGORITHMS.has(alg)) {
      throw new Error(`WPBRIDGE_MCP_OAUTH_ALGORITHMS accepts only asymmetric JWS algorithms (for example RS256); "${alg.slice(0, 20)}" is refused.`);
    }
  }
  return list;
}

function parseScope(env) {
  // Unset means the default scope; an explicit empty string turns the scope
  // requirement and its advertisement off (for providers without custom scopes).
  if (env.WPBRIDGE_MCP_OAUTH_SCOPE === undefined) return DEFAULT_SCOPE;
  const scope = String(env.WPBRIDGE_MCP_OAUTH_SCOPE).trim();
  if (scope && !SCOPE_TOKEN.test(scope)) throw new Error("WPBRIDGE_MCP_OAUTH_SCOPE must be one OAuth scope token without spaces or quotes.");
  return scope;
}

function parseScopeClaim(env) {
  const claim = String(env.WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM || "scope").trim();
  if (claim !== "scope" && claim !== "scp") throw new Error('WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM must be "scope" or "scp".');
  return claim;
}

// Providers send scopes as a space-separated string (RFC 8693/9068 "scope")
// or as an array ("scp" at some providers); accept both shapes.
function grantedScopes(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? value.split(/\s+/) : [];
}

// RFC 6750 section 3.1: no credentials or another scheme is a plain challenge;
// a Bearer attempt that is not exactly one token is invalid_request (400).
// lib/auth.js bearerToken() stays as is for the bridge. Each regex is anchored
// with disjoint classes, so matching stays linear on hostile headers.
export function parseAuthorization(header) {
  const text = typeof header === "string" ? header : "";
  if (!text.trim()) return { kind: "absent" };
  if (!/^Bearer(?:\s|$)/i.test(text)) return { kind: "other_scheme" };
  const token = text.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  return token ? { kind: "bearer", token } : { kind: "malformed" };
}

// Names only, never values: these appear in startup error messages.
const REQUIRED_REMOTE_VARS = [
  "WPBRIDGE_MCP_OAUTH_ISSUER", "WPBRIDGE_MCP_OAUTH_AUDIENCE", "WPBRIDGE_MCP_OAUTH_SUBJECT",
  "WPBRIDGE_MCP_OAUTH_JWKS_URL", "WPBRIDGE_MCP_PUBLIC_URL",
];
const OPTIONAL_REMOTE_VARS = ["WPBRIDGE_MCP_OAUTH_SCOPE", "WPBRIDGE_MCP_OAUTH_SCOPE_CLAIM", "WPBRIDGE_MCP_OAUTH_ALGORITHMS"];
export const LOCAL_TOKEN_HTTP = "WPBRIDGE_MCP_LOCAL_TOKEN_HTTP";
export const LOCAL_TOKEN_WARNING = "WARNING: HTTP MCP is running in local-token mode. Never route this port through a tunnel or reverse proxy; the loopback Host and proxy-header checks reduce that risk but cannot remove it. Use OAuth for anything remote.";

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

// HTTP is OAuth-only unless the operator explicitly opts in to the static local
// token. Header checks cannot prove that a loopback peer is not a tunnel, so
// the static token must be a deliberate, loopback-only choice. A partial OAuth
// setup, or OAuth together with the opt-in, refuses to start rather than
// falling back to the weaker mode.
export function httpAuthMode(env) {
  const requiredSet = REQUIRED_REMOTE_VARS.filter((name) => isSet(env[name]));
  const optionalSet = OPTIONAL_REMOTE_VARS.filter((name) => isSet(env[name]));
  const optIn = env[LOCAL_TOKEN_HTTP];
  if (requiredSet.length || optionalSet.length) {
    if (isSet(optIn)) throw new Error(`${LOCAL_TOKEN_HTTP} cannot be combined with OAuth settings; remove one of them.`);
    const missing = REQUIRED_REMOTE_VARS.filter((name) => !requiredSet.includes(name));
    if (missing.length) throw new Error(`Incomplete OAuth configuration; also set ${missing.join(", ")}.`);
    return "oauth";
  }
  if (isSet(optIn) && optIn !== "1") throw new Error(`${LOCAL_TOKEN_HTTP} must be exactly 1 to enable local-token HTTP.`);
  if (optIn !== "1") {
    throw new Error(`HTTP MCP requires OAuth (see MCP-SETUP.md section 4). For loopback-only local testing, set ${LOCAL_TOKEN_HTTP}=1 and WPBRIDGE_MCP_TOKEN; never route that port through a tunnel or proxy.`);
  }
  return "local-token";
}

function clip(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

// Unverified decode for diagnostics only: kid, iss and aud, never other claims.
export function unverifiedTokenHints(token) {
  const hints = {};
  try {
    const header = decodeProtectedHeader(token);
    if (typeof header.kid === "string") hints.kid = clip(header.kid);
  } catch { /* not a JWS */ }
  try {
    const payload = decodeJwt(token);
    if (typeof payload.iss === "string") hints.iss = clip(payload.iss);
    if (typeof payload.aud === "string") hints.aud = clip(payload.aud);
    else if (Array.isArray(payload.aud)) hints.aud = payload.aud.slice(0, 5).map((item) => clip(String(item)));
  } catch { /* not a JWT */ }
  return hints;
}

function joseReason(error) {
  const code = typeof error?.code === "string" && error.code.startsWith("ERR_") ? error.code : "verify_failed";
  const claim = typeof error?.claim === "string" && error.claim !== "unspecified" ? error.claim : "";
  return claim ? `${code}:${claim.slice(0, 40)}` : code;
}

export function createHttpAuth(env = process.env, { jwks: suppliedJwks } = {}) {
  const mode = httpAuthMode(env);
  const issuer = String(env.WPBRIDGE_MCP_OAUTH_ISSUER || "");
  if (mode === "oauth") {
    const audience = env.WPBRIDGE_MCP_OAUTH_AUDIENCE;
    const subject = env.WPBRIDGE_MCP_OAUTH_SUBJECT;
    const publicUrl = env.WPBRIDGE_MCP_PUBLIC_URL;
    const jwksUrl = env.WPBRIDGE_MCP_OAUTH_JWKS_URL;
    if (!audience || !subject || !publicUrl || !jwksUrl ||
        !issuer.startsWith("https://") || !publicUrl.startsWith("https://") || !jwksUrl.startsWith("https://")) {
      throw new Error("OAuth requires HTTPS issuer, public URL, JWKS URL, audience, and exact owner subject.");
    }
    const resource = new URL(publicUrl);
    if (resource.pathname !== "/mcp" || resource.search || resource.hash) throw new Error("WPBRIDGE_MCP_PUBLIC_URL must end in /mcp.");
    const algorithms = parseAlgorithms(env.WPBRIDGE_MCP_OAUTH_ALGORITHMS);
    const scope = parseScope(env);
    const scopeClaim = parseScopeClaim(env);
    const jwks = suppliedJwks || createRemoteJWKSet(new URL(jwksUrl));
    const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource`;

    // RFC 6750 section 3: no error code when the request carried no token.
    function challenge(error) {
      const parts = [];
      if (error) parts.push(`error="${error}"`);
      if (error === "insufficient_scope") {
        if (scope) parts.push(`scope="${scope}"`);
        parts.push(`resource_metadata="${metadataUrl}"`);
      } else {
        parts.push(`resource_metadata="${metadataUrl}"`);
        if (scope) parts.push(`scope="${scope}"`);
      }
      return `Bearer ${parts.join(", ")}`;
    }
    const fail = (status, error, reason, unverified) => ({
      ok: false, status, error, reason, wwwAuthenticate: challenge(error), ...(unverified ? { unverified } : {}),
    });

    return {
      mode: "oauth",
      publicUrl: resource.toString(),
      securitySchemes: [{ type: "oauth2", scopes: scope ? [scope] : [] }],
      resourceMetadata: {
        resource: resource.toString(), authorization_servers: [issuer],
        bearer_methods_supported: ["header"], ...(scope ? { scopes_supported: [scope] } : {}),
      },
      challenge: challenge(null),
      async authorize(header) {
        const parsed = parseAuthorization(header);
        if (parsed.kind === "malformed") return fail(400, "invalid_request", "malformed_bearer");
        if (parsed.kind !== "bearer") return fail(401, null, parsed.kind === "absent" ? "no_token" : "not_bearer");
        const { token } = parsed;
        let payload;
        try {
          ({ payload } = await jwtVerify(token, jwks, {
            issuer, audience, algorithms, clockTolerance: 30, requiredClaims: ["exp"],
          }));
        } catch (error) {
          return fail(401, "invalid_token", joseReason(error), unverifiedTokenHints(token));
        }
        if (payload.sub !== subject) return fail(403, "insufficient_scope", "sub_mismatch", unverifiedTokenHints(token));
        if (scope && !grantedScopes(payload[scopeClaim]).includes(scope)) {
          return fail(403, "insufficient_scope", "scope_missing", unverifiedTokenHints(token));
        }
        return { ok: true };
      },
    };
  }
  const token = env.WPBRIDGE_MCP_TOKEN || "";
  if (token.length < 32) throw new Error("WPBRIDGE_MCP_TOKEN must contain at least 32 characters.");
  return {
    mode: "local-token", publicUrl: null, securitySchemes: null, resourceMetadata: null, challenge: "Bearer",
    // The static token is never decoded or logged; failures get a plain challenge.
    authorize: async (header) => {
      const parsed = parseAuthorization(header);
      if (parsed.kind === "malformed") {
        return { ok: false, status: 400, error: "invalid_request", reason: "malformed_bearer", wwwAuthenticate: 'Bearer error="invalid_request"' };
      }
      const presented = parsed.kind === "bearer" ? parsed.token : "";
      if (safeEqual(presented, token)) return { ok: true };
      const reason = presented ? "token_mismatch" : (parsed.kind === "absent" ? "no_token" : "not_bearer");
      return { ok: false, status: 401, error: null, reason, wwwAuthenticate: "Bearer" };
    },
  };
}
