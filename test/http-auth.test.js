import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAuth } from "../mcp/http-auth.js";

test("local HTTP MCP mode requires a strong token and checks it", async () => {
  assert.throws(() => createHttpAuth({ WPBRIDGE_MCP_TOKEN: "short" }), /32 characters/);
  const token = "t".repeat(64);
  const auth = createHttpAuth({ WPBRIDGE_MCP_TOKEN: token });
  assert.equal(auth.mode, "local-token");
  assert.equal(await auth.authorized(`Bearer ${token}`), true);
  assert.equal(await auth.authorized("Bearer incorrect"), false);
});

test("OAuth mode requires a fixed owner and HTTPS metadata", async () => {
  const env = {
    WPBRIDGE_MCP_OAUTH_ISSUER: "https://issuer.example/",
    WPBRIDGE_MCP_OAUTH_AUDIENCE: "https://mcp.example/mcp",
    WPBRIDGE_MCP_OAUTH_SUBJECT: "owner-123",
    WPBRIDGE_MCP_OAUTH_JWKS_URL: "https://issuer.example/jwks.json",
    WPBRIDGE_MCP_PUBLIC_URL: "https://mcp.example/mcp",
  };
  const auth = createHttpAuth(env);
  assert.equal(auth.mode, "oauth");
  assert.equal(auth.resourceMetadata.resource, "https://mcp.example/mcp");
  assert.deepEqual(auth.resourceMetadata.authorization_servers, ["https://issuer.example/"]);
  assert.equal(await auth.authorized(""), false);
  assert.throws(() => createHttpAuth({ ...env, WPBRIDGE_MCP_OAUTH_SUBJECT: "" }), /exact owner subject/);
});

test("OAuth accepts only a signed token for this resource, owner, and scope", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const env = {
    WPBRIDGE_MCP_OAUTH_ISSUER: "https://issuer.example/",
    WPBRIDGE_MCP_OAUTH_AUDIENCE: "https://mcp.example/mcp",
    WPBRIDGE_MCP_OAUTH_SUBJECT: "owner-123",
    WPBRIDGE_MCP_OAUTH_JWKS_URL: "https://issuer.example/jwks.json",
    WPBRIDGE_MCP_PUBLIC_URL: "https://mcp.example/mcp",
  };
  const auth = createHttpAuth(env, { jwks });
  async function signed(claims) {
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(env.WPBRIDGE_MCP_OAUTH_ISSUER).setAudience(env.WPBRIDGE_MCP_OAUTH_AUDIENCE)
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }
  assert.equal(await auth.authorized(`Bearer ${await signed({ sub: "owner-123", scope: "wpbridge:access" })}`), true);
  assert.equal(await auth.authorized(`Bearer ${await signed({ sub: "someone-else", scope: "wpbridge:access" })}`), false);
  assert.equal(await auth.authorized(`Bearer ${await signed({ sub: "owner-123", scope: "other:access" })}`), false);
  const noExpiry = await new SignJWT({ sub: "owner-123", scope: "wpbridge:access" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(env.WPBRIDGE_MCP_OAUTH_ISSUER)
    .setAudience(env.WPBRIDGE_MCP_OAUTH_AUDIENCE).setIssuedAt().sign(privateKey);
  assert.equal(await auth.authorized(`Bearer ${noExpiry}`), false);
  const wrongAudience = await new SignJWT({ sub: "owner-123", scope: "wpbridge:access" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(env.WPBRIDGE_MCP_OAUTH_ISSUER)
    .setAudience("https://another.example/mcp").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  assert.equal(await auth.authorized(`Bearer ${wrongAudience}`), false);
});
