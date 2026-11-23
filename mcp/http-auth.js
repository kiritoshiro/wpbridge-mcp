import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { bearerToken, safeEqual } from "../lib/auth.js";

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
  const issuer = String(env.WPBRIDGE_MCP_OAUTH_ISSUER || "");
  if (issuer) {
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
      securitySchemes: [scope ? { type: "oauth2", scopes: [scope] } : { type: "oauth2" }],
      resourceMetadata: {
        resource: resource.toString(), authorization_servers: [issuer],
        bearer_methods_supported: ["header"], ...(scope ? { scopes_supported: [scope] } : {}),
      },
      challenge: challenge(null),
      async authorize(header) {
        const token = bearerToken(header);
        if (!token) return fail(401, null, header ? "not_bearer" : "no_token");
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
      const presented = bearerToken(header);
      if (safeEqual(presented, token)) return { ok: true };
      return { ok: false, status: 401, error: null, reason: presented ? "token_mismatch" : "no_token", wwwAuthenticate: "Bearer" };
    },
  };
}
