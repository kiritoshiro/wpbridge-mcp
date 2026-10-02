import { createRemoteJWKSet, jwtVerify } from "jose";
import { safeEqual } from "../lib/auth.js";

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
    const jwks = suppliedJwks || createRemoteJWKSet(new URL(jwksUrl));
    const scope = "wpbridge:access";
    return {
      mode: "oauth",
      securitySchemes: [{ type: "oauth2", scopes: [scope] }],
      resourceMetadata: {
        resource: resource.toString(), authorization_servers: [issuer],
        bearer_methods_supported: ["header"], scopes_supported: [scope],
      },
      challenge: `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource", scope="${scope}"`,
      async authorized(header) {
        const token = String(header || "").match(/^Bearer\s+(.+)$/i)?.[1];
        if (!token) return false;
        try {
          const { payload } = await jwtVerify(token, jwks, { issuer, audience });
          return Number.isInteger(payload.exp) && payload.sub === subject &&
            String(payload.scope || "").split(/\s+/).includes(scope);
        } catch { return false; }
      },
    };
  }
  const token = env.WPBRIDGE_MCP_TOKEN || "";
  if (token.length < 32) throw new Error("WPBRIDGE_MCP_TOKEN must contain at least 32 characters.");
  return {
    mode: "local-token", securitySchemes: null, resourceMetadata: null, challenge: "Bearer",
    authorized: async (header) => {
      const bearer = String(header || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
      return safeEqual(bearer, token);
    },
  };
}
